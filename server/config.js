'use strict';

/**
 * Loads and validates the frozen artefacts (PROTOCOL.md §4).
 *
 * Every failure here is fatal. A backend that starts against a malformed roster is
 * worse than one that refuses to start, because the players cannot tell the difference
 * until the draw is already wrong.
 *
 * This file owns one half of the §4.1 boundary: what is frozen. runtime.js owns the
 * other. The bounds on local_id and user_input are not repeated here — they come from
 * generate.js, which is where the byte encoding that imposes them is defined.
 */

const fs = require('node:fs');
const path = require('node:path');

const { loadRuntime, OPERATIONAL_KEYS } = require('./runtime');
const { ENCODING_LIMITS } = require('../generate.js');

const ROOT = path.join(__dirname, '..');
// Below a minute the interval is theatre: nobody can take a roll, publish its digest
// and get it timestamped in that time. PROTOCOL.md section 9.
const MIN_REVEAL_GAP_SECONDS = 60;
const HEX64 = /^[0-9a-f]{64}$/;
const HEX_PUBKEY = /^[0-9a-f]{96}$|^[0-9a-f]{192}$/; // G1 or G2 group key

/**
 * The remedy for a frozen file that is not there.
 *
 * "Copy the .example file and fill it in" is right on the machine where the event is
 * being prepared and wrong everywhere else, and the file is missing in both places for
 * the same reason: protocol.json and roster.json are gitignored, and RUNBOOK step 11 is
 * the only thing that ever commits them. So a deployment box cloning the default branch
 * gets no event at all — and an operator who follows the old advice there hand-writes a
 * protocol that matches no tag, which is not a freeze, it is a draw nobody can check.
 * Both paths, named, and the wrong one named as wrong.
 */
const FROZEN_REMEDY = (rel) =>
  `${rel} is written by the freeze (RUNBOOK step 11) and is gitignored until then, so a `
  + 'clone of the default branch does not have it.\n'
  + '  Deploying:   git fetch --tags && git checkout <tag>   ("git tag -l" lists them)\n'
  + '  Preparing:   start from the .example file, then tools/pick-round.js and tools/freeze.js\n'
  + `  Not this:    writing ${rel} by hand on the box. A protocol that is not the one in `
  + 'the tag is not frozen, and players are given the tag.';

function readJson(p, remedy = null) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') {
      const rel = path.relative(ROOT, p).split(path.sep).join('/');
      throw new Error(remedy ? `missing ${rel}\n\n${remedy(rel)}`
        : `missing ${rel} — copy the .example file, fill it in, and freeze it`);
    }
    throw new Error(`${path.relative(ROOT, p)}: ${err.message}`);
  }
}

function validateRoster(roster, totalSlots) {
  if (!roster || !Array.isArray(roster.players)) throw new Error('roster.json: missing "players" array');
  if (roster.players.length !== totalSlots) {
    throw new Error(`roster.json: ${roster.players.length} players, protocol.json says ${totalSlots}`);
  }
  if (!Number.isInteger(roster.pantheon_event_id) || roster.pantheon_event_id < 1) {
    throw new Error('roster.json: pantheon_event_id must be a positive integer — the sign-in gate is scoped to it');
  }

  const localIds = new Set();
  const personIds = new Set();
  for (const p of roster.players) {
    // RUNBOOK step 8: the seat plan is written back in local ids, so a missing one
    // blocks the sync — and it blocks it after the draw, when nothing can be changed.
    const { local_id_min: lo, local_id_max: hi } = ENCODING_LIMITS;
    if (!Number.isInteger(p.local_id) || p.local_id < lo || p.local_id > hi) {
      throw new Error(
        `roster.json: local_id must be an integer in ${lo}..${hi} (§7 encodes it as one byte), ` +
          `got ${JSON.stringify(p.local_id)}`
      );
    }
    if (localIds.has(p.local_id)) throw new Error(`roster.json: duplicate local_id ${p.local_id}`);
    localIds.add(p.local_id);

    if (!Number.isInteger(p.person_id) || p.person_id < 1) {
      throw new Error(`roster.json: local_id ${p.local_id} has no valid person_id (Pantheon account id)`);
    }
    if (personIds.has(p.person_id)) {
      // Two slots sharing an account means one person could submit twice.
      throw new Error(`roster.json: person_id ${p.person_id} appears twice`);
    }
    personIds.add(p.person_id);

    if (typeof p.title !== 'string' || p.title.trim() === '') {
      throw new Error(`roster.json: local_id ${p.local_id} has no title`);
    }
  }
  return roster;
}

function assertNoOperationalKeys(p) {
  // §4.1: the split only survives if it is enforced. An operational value that drifts
  // back into protocol.json gets frozen by accident, and then a routine change to it —
  // a dead mirror, a moved Pantheon — needs a re-tag or, worse, gets edited under the
  // tag. Name the offender and say where it goes instead.
  for (const [key, where] of Object.entries(OPERATIONAL_KEYS)) {
    const [head, tail] = key.split('.');
    const present = tail ? p[head] && p[head][tail] !== undefined : p[key] !== undefined;
    if (present) {
      throw new Error(
        `protocol.json: "${key}" is an operational setting and must not be frozen. ` +
          `Move it to ${where} (PROTOCOL.md §4.1). protocol.json holds only values that ` +
          `could change or steer the outcome.`
      );
    }
  }
}

function validateProtocol(p) {
  assertNoOperationalKeys(p);

  const required = [
    'drand_chain', 'chain_hash', 'chain_public_key', 'target_round',
    'target_round_utc', 'reveal_gap_seconds',
    'submission_cutoff_utc', 'quorum', 'total_slots', 'user_input_max',
    'seed_domain_separation',
  ];
  // These two arrived after the first protocol.json files were written, and every one
  // of those is missing them. The remedy is a command, so the error names it.
  const WRITTEN_BY_PICK_ROUND = new Set(['target_round_utc', 'reveal_gap_seconds']);
  for (const k of required) {
    if (p[k] === undefined || p[k] === null || p[k] === '') {
      throw new Error(
        `protocol.json: missing "${k}"` +
        (WRITTEN_BY_PICK_ROUND.has(k)
          ? '. Run this to write it, with target_round and submission_cutoff_utc, in one go:'
            + ' node tools/pick-round.js --in 72h --write'
          : '')
      );
    }
  }
  if (!Number.isInteger(p.target_round) || p.target_round < 1) {
    throw new Error(`protocol.json: target_round must be a positive integer, got ${JSON.stringify(p.target_round)}`);
  }
  if (!HEX64.test(String(p.chain_hash))) {
    throw new Error('protocol.json: chain_hash must be 64 lowercase hex chars — confirm it against the drand API');
  }
  // §4: the hash alone is not a pin. drand-client's isValidInfo compares the hash AND
  // the public key and requires both; pass only the hash and publicKey is undefined,
  // the comparison fails against every real chain, and the tempting "fix" is to switch
  // verification off entirely — leaving the client trusting whatever the endpoint claims.
  if (!HEX_PUBKEY.test(String(p.chain_public_key))) {
    throw new Error(
      'protocol.json: chain_public_key must be the drand chain public key in lowercase hex ' +
        '(96 or 192 chars). Fetch it from <drand.api>/<chain_hash>/info. Without it the client ' +
        'cannot verify it is talking to the right chain.'
    );
  }
  if (!Number.isInteger(p.total_slots) || p.total_slots < 1) throw new Error('protocol.json: bad total_slots');
  if (!Number.isInteger(p.quorum) || p.quorum < 1 || p.quorum > p.total_slots) {
    throw new Error(`protocol.json: quorum must be in 1..${p.total_slots}`);
  }
  // §8 fixes the rule before anyone can see who is missing, so that it cannot be argued
  // down afterwards. A quorum at or below half the field would not survive that argument.
  if (p.quorum * 2 <= p.total_slots) {
    throw new Error(
      `protocol.json: quorum ${p.quorum} of ${p.total_slots} is not a majority — §8 intends a ` +
        'two-thirds rule, and a minority quorum is not a rule anyone would agree to in advance.'
    );
  }
  const { user_input_min: umin, user_input_max: umax } = ENCODING_LIMITS;
  if (!Number.isInteger(p.user_input_max) || p.user_input_max < 1 || p.user_input_max > umax) {
    throw new Error(
      `protocol.json: user_input_max must be an integer in 1..${umax} — §7 encodes user_input ` +
        `as one unsigned byte, so ${umax} is what fits rather than a tunable ceiling ` +
        `(the floor of the range players draw from is ${umin})`
    );
  }
  if (String(p.seed_domain_separation).includes('\x1f')) {
    throw new Error('protocol.json: seed_domain_separation may not contain byte 0x1f (it is the field separator)');
  }
  const cutoff = Date.parse(p.submission_cutoff_utc);
  if (Number.isNaN(cutoff)) throw new Error('protocol.json: submission_cutoff_utc is not a parseable timestamp');
  p.cutoff_ms = cutoff;

  // The interval between the roll being taken and the decryption key existing
  // (PROTOCOL.md section 9). Submissions close at submission_cutoff_utc; the beacon
  // that opens them is emitted reveal_gap_seconds later, at target_round_utc.
  //
  // The two were the same instant until this field existed, and that left nowhere to
  // stand: a timestamp on the roll of who submitted was simultaneous with the key, so
  // it could not show the roll had been settled before anyone could work out which
  // late submission would be useful. The interval is what makes publishing the roll
  // mean something.
  if (!Number.isInteger(p.reveal_gap_seconds) || p.reveal_gap_seconds < MIN_REVEAL_GAP_SECONDS) {
    throw new Error(
      'protocol.json: reveal_gap_seconds must be a whole number of seconds, at least ' +
      `${MIN_REVEAL_GAP_SECONDS}; got ${JSON.stringify(p.reveal_gap_seconds)}. ` +
      'Run: node tools/pick-round.js --in 72h --write'
    );
  }
  const roundMs = Date.parse(p.target_round_utc);
  if (Number.isNaN(roundMs)) {
    throw new Error(`protocol.json: target_round_utc is not a parseable timestamp: ${JSON.stringify(p.target_round_utc)}`);
  }
  // The three are written together by tools/pick-round.js so they cannot disagree.
  // This checks them because a hand-edited file is exactly where they would.
  if (roundMs - cutoff !== p.reveal_gap_seconds * 1000) {
    throw new Error(
      `protocol.json: target_round_utc is ${(roundMs - cutoff) / 1000}s after submission_cutoff_utc, ` +
      `but reveal_gap_seconds says ${p.reveal_gap_seconds}. These three fields are written ` +
      'together: node tools/pick-round.js --write'
    );
  }
  p.target_round_ms = roundMs;

  const mode = p.pantheon?.wind_shuffle_mode;
  if (mode && mode !== 'WIND_SHUFFLE_MODE_PRESCRIPTED') {
    // Hard rule 5 / PANTHEON-INTEGRATION.md §3. Any other mode re-randomises the winds
    // at the table, discarding conditions 3 and 6 — precisely what the template spent
    // its optimisation budget on. Silent when it happens, so it is caught here instead.
    throw new Error(
      `protocol.json: pantheon.wind_shuffle_mode must be WIND_SHUFFLE_MODE_PRESCRIPTED, got ${mode}. ` +
        'Any other mode re-randomises winds and throws away the wind and upstream/downstream balance.'
    );
  }
  return p;
}

function validateTemplate(t, totalSlots) {
  if (t.n_players !== totalSlots) {
    throw new Error(`schedule_template.json: ${t.n_players} points, protocol.json says ${totalSlots} slots`);
  }
  if (!Array.isArray(t.rounds) || t.rounds.length !== t.n_rounds) {
    throw new Error('schedule_template.json: rounds array does not match n_rounds');
  }
  // Structural check only. tools/verify_template.py is the real verification and is what
  // participants run; re-deriving its proofs here would just be a second place to get
  // them wrong.
  for (const rd of t.rounds) {
    const seen = [];
    for (const tbl of rd.tables) for (const w of t.seat_order) seen.push(tbl.seats[w]);
    const sorted = [...seen].sort((a, b) => a - b);
    for (let i = 0; i < totalSlots; i++) {
      if (sorted[i] !== i) throw new Error(`schedule_template.json: round ${rd.round} is not a partition of 0..${totalSlots - 1}`);
    }
  }
  return t;
}

/**
 * Every failure in here is a deployment to fix, not a bug to report.
 *
 * A file that is not there, a value outside its bounds, an operational key inside the
 * frozen half: each of those is something the person holding the terminal has to change,
 * and each already carries a message saying what. `operator` is what lets the entry
 * points print that message and nothing else. Without it, a new operator whose clone had
 * no freeze in it got the one paragraph telling them to check out the tag delivered in
 * the middle of a ten-frame stack trace.
 */
function load(opts = {}) {
  try {
    return loadFrozen(opts);
  } catch (err) {
    throw Object.assign(err, { operator: true });
  }
}

function loadFrozen(opts) {
  const dataDir = opts.dataDir || path.join(ROOT, 'data');
  const protocol = validateProtocol(readJson(path.join(dataDir, 'protocol.json'), FROZEN_REMEDY));
  // Not frozen, not tagged, optional (§4.2). Loaded here so every consumer reads both
  // halves of the configuration off one object.
  const runtime = opts.runtime || loadRuntime(dataDir, opts.env || process.env);

  // rosterOptional exists for tools/freeze.js and for nothing else. Writing
  // data/roster.json out of Pantheon is what RUNBOOK step 10 does, so the one command
  // that creates the file cannot also refuse to start without it — before this, a first
  // freeze stopped at "copy the .example file, fill it in", which is exactly the twelve
  // rows of retyping the tool exists to remove. Everything else — the server, the
  // finalisation job, generate.js — takes the strict path, where an absent or malformed
  // roster is a startup failure.
  let roster = null;
  let rosterError = null;
  try {
    roster = validateRoster(readJson(path.join(dataDir, 'roster.json'), FROZEN_REMEDY), protocol.total_slots);
  } catch (err) {
    if (!opts.rosterOptional) throw err;
    rosterError = err;
  }
  const template = validateTemplate(readJson(path.join(dataDir, 'schedule_template.json')), protocol.total_slots);

  const byPersonId = new Map((roster?.players || []).map((p) => [p.person_id, p]));
  const byLocalId = new Map((roster?.players || []).map((p) => [p.local_id, p]));

  return {
    root: ROOT,
    dataDir,
    protocol,
    runtime,
    roster,
    // null only under rosterOptional, and then this says why.
    rosterError,
    template,
    byPersonId,
    byLocalId,
    // Required and validated above, so no fallback here: an absent value is a startup
    // failure, not a silent 255 that may disagree with what the tag actually says.
    userInputMax: protocol.user_input_max,
  };
}

/**
 * Read `.env` from the checkout root, the way the systemd unit's `EnvironmentFile=` does.
 *
 * `deploy/README.md` §2 has the operator write that file, and it holds everything that
 * makes a deployment a real one rather than a demo: the Pantheon base URLs and admin
 * credentials, the mirror repository and its token, `ADMIN_TOKEN`, `NODE_ENV`. Only
 * systemd was reading it. Every other way of starting the process that the same document
 * recommends — tmux, nohup, a `@reboot` crontab, `node server/server.js` at a prompt —
 * started a server that had never seen any of it, and the symptom is not a crash. It is
 * a relay that serves the right pages, accepts submissions, and mirrors none of them,
 * which removes the one property (§5) that stops the organiser dropping an inconvenient
 * ciphertext after the fact.
 *
 * Node's own loader, so this costs no dependency. A variable already in the environment
 * wins over the file, which keeps `PORT=9000 node server/server.js` behaving as written.
 *
 * Absence is normal and silent: development runs have no `.env`, and the freeze does not
 * contain one.
 */
function loadEnvFile(root = ROOT, log = console) {
  const file = path.join(root, '.env');
  if (!fs.existsSync(file)) return null;
  try {
    process.loadEnvFile(file);
    return file;
  } catch (err) {
    // A malformed .env is worth dying on. Continuing means running with half the
    // settings, and the half that goes missing is not announced anywhere.
    log.error?.(`[config] ${file} could not be read: ${err.message}`);
    throw err;
  }
}

module.exports = { MIN_REVEAL_GAP_SECONDS, load, readJson, loadEnvFile, ROOT, ENCODING_LIMITS };
