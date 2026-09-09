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
const HEX64 = /^[0-9a-f]{64}$/;
const HEX_PUBKEY = /^[0-9a-f]{96}$|^[0-9a-f]{192}$/; // G1 or G2 group key

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new Error(`missing ${path.relative(ROOT, p)} — copy the .example file, fill it in, and freeze it`);
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
    'submission_cutoff_utc', 'quorum', 'total_slots', 'user_input_max',
    'seed_domain_separation',
  ];
  for (const k of required) {
    if (p[k] === undefined || p[k] === null || p[k] === '') throw new Error(`protocol.json: missing "${k}"`);
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

function load(opts = {}) {
  const dataDir = opts.dataDir || path.join(ROOT, 'data');
  const protocol = validateProtocol(readJson(path.join(dataDir, 'protocol.json')));
  // Not frozen, not tagged, optional (§4.2). Loaded here so every consumer reads both
  // halves of the configuration off one object.
  const runtime = opts.runtime || loadRuntime(dataDir, opts.env || process.env);
  const roster = validateRoster(readJson(path.join(dataDir, 'roster.json')), protocol.total_slots);
  const template = validateTemplate(readJson(path.join(dataDir, 'schedule_template.json')), protocol.total_slots);

  const byPersonId = new Map(roster.players.map((p) => [p.person_id, p]));
  const byLocalId = new Map(roster.players.map((p) => [p.local_id, p]));

  return {
    root: ROOT,
    dataDir,
    protocol,
    runtime,
    roster,
    template,
    byPersonId,
    byLocalId,
    // Required and validated above, so no fallback here: an absent value is a startup
    // failure, not a silent 255 that may disagree with what the tag actually says.
    userInputMax: protocol.user_input_max,
  };
}

module.exports = { load, readJson, ROOT, ENCODING_LIMITS };
