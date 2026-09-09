'use strict';

/**
 * Loads and validates the frozen artefacts (PROTOCOL.md §4).
 *
 * Every failure here is fatal. A backend that starts against a malformed roster is
 * worse than one that refuses to start, because the players cannot tell the difference
 * until the draw is already wrong.
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const HEX64 = /^[0-9a-f]{64}$/;

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
    if (!Number.isInteger(p.local_id) || p.local_id < 1 || p.local_id > 255) {
      throw new Error(`roster.json: local_id must be an integer in 1..255, got ${JSON.stringify(p.local_id)}`);
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

function validateProtocol(p) {
  const required = [
    'drand_chain', 'chain_hash', 'drand_api', 'target_round',
    'submission_cutoff_utc', 'quorum', 'total_slots', 'seed_domain_separation',
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
  // Not listed in §4, but required in practice: drand-client verifies a chain only when
  // BOTH the hash and the public key are pinned (isValidInfo in drand-client checks them
  // together). Pin the hash alone and verification silently does nothing, because the
  // comparison against an undefined publicKey fails for every real chain — at which point
  // the natural "fix" is to drop verification entirely. See docs/IMPLEMENTATION_NOTES.md.
  if (!/^[0-9a-f]{96}$|^[0-9a-f]{192}$/.test(String(p.chain_public_key || ''))) {
    throw new Error(
      'protocol.json: chain_public_key must be the drand chain public key in lowercase hex ' +
        '(96 or 192 chars). Fetch it from <drand_api>/<chain_hash>/info. Without it the client ' +
        'cannot verify it is talking to the right chain.'
    );
  }
  if (!Number.isInteger(p.total_slots) || p.total_slots < 1) throw new Error('protocol.json: bad total_slots');
  if (!Number.isInteger(p.quorum) || p.quorum < 1 || p.quorum > p.total_slots) {
    throw new Error(`protocol.json: quorum must be in 1..${p.total_slots}`);
  }
  if (p.user_input_max !== undefined && (!Number.isInteger(p.user_input_max) || p.user_input_max < 1 || p.user_input_max > 255)) {
    throw new Error('protocol.json: user_input_max must be an integer in 1..255');
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
  const roster = validateRoster(readJson(path.join(dataDir, 'roster.json')), protocol.total_slots);
  const template = validateTemplate(readJson(path.join(dataDir, 'schedule_template.json')), protocol.total_slots);

  const byPersonId = new Map(roster.players.map((p) => [p.person_id, p]));
  const byLocalId = new Map(roster.players.map((p) => [p.local_id, p]));

  return {
    root: ROOT,
    dataDir,
    protocol,
    roster,
    template,
    byPersonId,
    byLocalId,
    userInputMax: Number.isInteger(protocol.user_input_max) ? protocol.user_input_max : 255,
  };
}

module.exports = { load, readJson, ROOT };
