#!/usr/bin/env node
/**
 * generate.js — PROTOCOL.md §7
 *
 * Turns the decrypted submissions plus the drand signature into the seat plan.
 *
 * FROZEN, and git-tagged with roster.json, protocol.json and schedule_template.json.
 * It depends on nothing but node:crypto and node:fs so that a participant can read it
 * end to end and re-run it offline.
 *
 * Determinism is the whole point: the same inputs MUST produce byte-identical output.
 * Nothing here may read the clock, the environment, or the network.
 *
 * ---------------------------------------------------------------------------
 * THE BYTE ENCODING
 *
 * §7 warns that fixing the encoding matters as much as fixing the algorithm, because
 * two independent re-computations that disagree about the bytes will disagree about
 * the seat plan. So the encoding is written out here, enforced by validation, and
 * pinned by a fixed test vector in test/vectors.json.
 *
 *   SEP = 0x1F (ASCII unit separator)
 *
 *   contribution_i = SHA256(
 *       DOMAIN            utf8, no SEP (validated)
 *     ‖ SEP ‖ "contrib"   ascii
 *     ‖ SEP ‖ local_id    1 byte,  1..255
 *     ‖ SEP ‖ user_input  1 byte,  0..user_input_max
 *     ‖ SEP ‖ nonce       exactly 16 raw bytes
 *     ‖ SEP ‖ timestamp   ascii ISO-8601, no SEP (validated)
 *   )
 *
 *   R    = contribution_1 XOR … XOR contribution_n        (32 bytes, untruncated)
 *
 *   seed = SHA256(
 *       DOMAIN ‖ SEP ‖ "seed"
 *     ‖ SEP ‖ R           32 raw bytes
 *     ‖ SEP ‖ signature   raw bytes, hex-decoded (not the hex text — no case ambiguity)
 *     ‖ SEP ‖ local_ids   1 byte each, ascending
 *   )
 *
 * Why this is unambiguous: every field is either fixed-width (local_id, user_input,
 * nonce, R) or is validated to contain no SEP (DOMAIN, timestamp), and the one
 * variable-count field (local_ids) is last. So no two distinct inputs can produce the
 * same byte string. The separators are belt-and-braces on top of that, exactly as §7
 * asks; the validation is what actually earns the guarantee, which is why a field
 * that could smuggle a SEP is rejected rather than escaped.
 * ---------------------------------------------------------------------------
 *
 * CLI:
 *   node generate.js --decrypted <file> --signature <hex> [--round <n>]
 *                    [--roster data/roster.json] [--protocol data/protocol.json]
 *                    [--template data/schedule_template.json] [--out results.json]
 *
 *   node generate.js --verify results.json      # recompute from the file's own
 *                                               # revealed payloads, diff byte for byte
 *
 * --decrypted takes [{local_id, user_input, client_nonce, client_timestamp}, ...].
 */

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const SEP = 0x1f;
const SEAT_ORDER = ['E', 'S', 'W', 'N'];
const NONCE_BYTES = 16;
const HASH_BYTES = 32;

// Strict ISO-8601 with milliseconds optional and a mandatory Z. Deliberately narrow:
// the timestamp is attacker-chosen (§3 — "it need not be trustworthy"), and a narrow
// grammar is what keeps it from carrying bytes that would blur the encoding.
const ISO8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/;

// ---------------------------------------------------------------------------
// encoding primitives
// ---------------------------------------------------------------------------

const sep = () => Buffer.from([SEP]);
const u8 = (n) => Buffer.from([n]);

function assertNoSep(buf, what) {
  if (buf.includes(SEP)) throw new Error(`${what} may not contain byte 0x1f`);
  return buf;
}

function domainBytes(domain) {
  if (typeof domain !== 'string' || domain.length === 0) {
    throw new Error('seed_domain_separation must be a non-empty string');
  }
  return assertNoSep(Buffer.from(domain, 'utf8'), 'seed_domain_separation');
}

function nonceBytes(nonce) {
  // Accept hex or base64 so the transport format can change without changing the hash.
  let buf;
  if (Buffer.isBuffer(nonce)) buf = nonce;
  else if (typeof nonce === 'string' && /^[0-9a-f]{32}$/i.test(nonce)) buf = Buffer.from(nonce, 'hex');
  else if (typeof nonce === 'string') buf = Buffer.from(nonce, 'base64');
  else throw new Error('client_nonce must be a hex or base64 string');
  if (buf.length !== NONCE_BYTES) {
    throw new Error(`client_nonce must be exactly ${NONCE_BYTES} bytes, got ${buf.length}`);
  }
  return buf;
}

function timestampBytes(ts) {
  if (typeof ts !== 'string' || !ISO8601.test(ts)) {
    throw new Error(`client_timestamp must be ISO-8601 UTC (e.g. 2026-09-10T19:59:00.000Z), got ${JSON.stringify(ts)}`);
  }
  return assertNoSep(Buffer.from(ts, 'ascii'), 'client_timestamp');
}

function signatureBytes(sig) {
  if (typeof sig !== 'string' || !/^[0-9a-fA-F]+$/.test(sig) || sig.length % 2 !== 0) {
    throw new Error('drand_signature must be a hex string');
  }
  return Buffer.from(sig, 'hex');
}

// ---------------------------------------------------------------------------
// §7 steps 2-4
// ---------------------------------------------------------------------------

/** §7 step 2: one player's 256-bit contribution. */
function contribution(entry, domain, userInputMax) {
  const { local_id, user_input } = entry;
  if (!Number.isInteger(local_id) || local_id < 1 || local_id > 255) {
    throw new Error(`local_id must be an integer in 1..255, got ${JSON.stringify(local_id)}`);
  }
  if (!Number.isInteger(user_input) || user_input < 0 || user_input > userInputMax) {
    throw new Error(`local_id ${local_id}: user_input must be an integer in 0..${userInputMax}, got ${JSON.stringify(user_input)}`);
  }
  return crypto
    .createHash('sha256')
    .update(domainBytes(domain))
    .update(sep()).update(Buffer.from('contrib', 'ascii'))
    .update(sep()).update(u8(local_id))
    .update(sep()).update(u8(user_input))
    .update(sep()).update(nonceBytes(entry.client_nonce))
    .update(sep()).update(timestampBytes(entry.client_timestamp))
    .digest();
}

/**
 * §7 steps 1-3: sort by local_id, hash each payload, XOR the hashes.
 *
 * Hash first, XOR second — §3.1. XOR does not mix across bit positions, so XORing the
 * raw numbers would leave the result confined to the low bits that everybody's small
 * number occupies. Hashing spreads each input across all 256 bits first.
 */
function combine(decrypted, domain, userInputMax) {
  if (!Array.isArray(decrypted) || decrypted.length === 0) {
    throw new Error('decrypted must be a non-empty array');
  }
  const seen = new Set();
  const sorted = [...decrypted].sort((a, b) => a.local_id - b.local_id);

  const contributions = {};
  const R = Buffer.alloc(HASH_BYTES);
  for (const entry of sorted) {
    if (seen.has(entry.local_id)) throw new Error(`local_id ${entry.local_id} appears twice`);
    seen.add(entry.local_id);
    const c = contribution(entry, domain, userInputMax);
    contributions[entry.local_id] = c.toString('hex');
    for (let i = 0; i < HASH_BYTES; i++) R[i] ^= c[i];
  }
  return { sorted, contributions, R };
}

/** §7 step 4: fold in the beacon and the participant set. */
function deriveSeed(R, signature, localIds, domain) {
  if (!Buffer.isBuffer(R) || R.length !== HASH_BYTES) throw new Error('R must be 32 bytes');
  const ids = [...localIds].sort((a, b) => a - b);
  const h = crypto
    .createHash('sha256')
    .update(domainBytes(domain))
    .update(sep()).update(Buffer.from('seed', 'ascii'))
    .update(sep()).update(R)
    .update(sep()).update(signatureBytes(signature))
    .update(sep());
  // §7: including sorted(local_ids) removes any ambiguity about who took part when n < 12.
  for (const id of ids) h.update(u8(id));
  return h.digest();
}

// ---------------------------------------------------------------------------
// §7 step 5 — CSPRNG and shuffle
// ---------------------------------------------------------------------------

/** SHA-256 in counter mode: block(i) = SHA256(seed ‖ uint32be(i)), concatenated. */
class Sha256CounterStream {
  constructor(seed) {
    this.seed = Buffer.from(seed);
    this.counter = 0;
    this.buf = Buffer.alloc(0);
    this.offset = 0;
  }

  read(n) {
    while (this.buf.length - this.offset < n) {
      const ctr = Buffer.alloc(4);
      ctr.writeUInt32BE(this.counter >>> 0, 0);
      const block = crypto.createHash('sha256').update(this.seed).update(ctr).digest();
      this.buf = Buffer.concat([this.buf.subarray(this.offset), block]);
      this.offset = 0;
      this.counter += 1;
    }
    const out = this.buf.subarray(this.offset, this.offset + n);
    this.offset += n;
    return out;
  }

  /** §7: rejection sampling, not modulo, so the shuffle is exactly uniform. */
  below(bound) {
    if (bound < 1 || bound > 0x100000000) throw new RangeError(`bad bound ${bound}`);
    const limit = Math.floor(0x100000000 / bound) * bound;
    for (;;) {
      const v = this.read(4).readUInt32BE(0);
      if (v < limit) return v % bound;
    }
  }
}

/**
 * Descending ("modern") Fisher-Yates over the roster's local_ids, ascending.
 *
 *   permutation[k] = the local_id seated on abstract point k   (k = 0..11)
 *
 * That is the direction §7 step 6 means by "map roster slots onto abstract points by
 * pi". results.json states it in a note so no verifier has to guess.
 */
function permute(localIds, seed) {
  const a = [...localIds];
  const rng = new Sha256CounterStream(seed);
  for (let i = a.length - 1; i >= 1; i--) {
    const j = rng.below(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ---------------------------------------------------------------------------
// §7 steps 6-8 — seat plan and prescript
// ---------------------------------------------------------------------------

function buildSeating(template, permutation, roster) {
  const byLocalId = new Map(roster.players.map((p) => [p.local_id, p]));
  const atPoint = permutation.map((localId, point) => {
    const p = byLocalId.get(localId);
    if (!p) throw new Error(`permutation names unknown local_id ${localId} at point ${point}`);
    return { local_id: p.local_id, title: p.title, person_id: p.person_id, point };
  });

  return {
    seat_order: SEAT_ORDER,
    rounds: template.rounds.map((rd) => ({
      round: rd.round,
      tables: rd.tables.map((tbl) => {
        const seats = {};
        for (const w of SEAT_ORDER) {
          const point = tbl.seats[w];
          if (!Number.isInteger(point) || point < 0 || point >= atPoint.length) {
            throw new Error(`round ${rd.round} table ${tbl.table} seat ${w}: bad point ${point}`);
          }
          const who = atPoint[point];
          seats[w] = { point, local_id: who.local_id, title: who.title };
        }
        return { table: tbl.table, seats };
      }),
    })),
  };
}

/**
 * §7 step 8 / PANTHEON-INTEGRATION.md §3 — the prescript string.
 *
 * Sessions separated by a blank line, tables within a session by a newline, the four
 * players by hyphens, in local ids, in seat order East-South-West-North.
 *
 * This is the one output whose format is dictated by another system's parser
 * (EventPrescript::unpackScript), so it is generated here rather than in the sync
 * code: it belongs to the frozen, reproducible result, not to the delivery step that
 * may be retried or done by hand.
 */
function buildPrescript(seating) {
  return seating.rounds
    .map((rd) => rd.tables.map((t) => SEAT_ORDER.map((w) => t.seats[w].local_id).join('-')).join('\n'))
    .join('\n\n');
}

// ---------------------------------------------------------------------------
// the whole of §7, as one pure function
// ---------------------------------------------------------------------------
function generate({ decrypted, roster, protocol, template, signature, round }) {
  const players = roster.players;
  if (!Array.isArray(players) || players.length !== protocol.total_slots) {
    throw new Error(`roster.json holds ${players?.length} players, protocol says ${protocol.total_slots}`);
  }
  if (template.n_players !== protocol.total_slots) {
    throw new Error(`template is for ${template.n_players} points, protocol says ${protocol.total_slots} slots`);
  }

  const domain = protocol.seed_domain_separation;
  const userInputMax = Number.isInteger(protocol.user_input_max) ? protocol.user_input_max : 255;
  if (userInputMax < 0 || userInputMax > 255) throw new Error('user_input_max must be in 0..255');

  const { sorted, contributions, R } = combine(decrypted, domain, userInputMax);

  // §8 — the quorum is frozen. There is deliberately no flag to override this: a rule
  // that can be sidestepped by running the script by hand is not frozen.
  if (sorted.length < protocol.quorum) {
    throw new Error(
      `quorum not met: ${sorted.length} contributions, quorum is ${protocol.quorum}. ` +
        `Per PROTOCOL.md §8 this round is void; announce a new target_round and have all ` +
        `${protocol.total_slots} submit again.`
    );
  }
  const known = new Set(players.map((p) => p.local_id));
  for (const e of sorted) {
    if (!known.has(e.local_id)) throw new Error(`local_id ${e.local_id} is not in roster.json`);
  }

  const participating = sorted.map((e) => e.local_id);
  const seed = deriveSeed(R, signature, participating, domain);
  const localIds = players.map((p) => p.local_id).sort((a, b) => a - b);
  const permutation = permute(localIds, seed);
  const seating = buildSeating(template, permutation, roster);

  const revealed = {};
  for (const e of sorted) {
    revealed[e.local_id] = {
      user_input: e.user_input,
      client_nonce: nonceBytes(e.client_nonce).toString('hex'),
      client_timestamp: e.client_timestamp,
    };
  }

  return {
    round_used: Number.isInteger(round) ? round : protocol.target_round,
    drand_signature: signature,
    participating_local_ids: participating,
    revealed,
    contributions,
    R: R.toString('hex'),
    seed: seed.toString('hex'),
    permutation,
    permutation_note:
      'permutation[k] is the local_id seated on abstract point k of schedule_template.json',
    encoding_note:
      'contribution = SHA256(DOMAIN 1f "contrib" 1f u8(local_id) 1f u8(user_input) 1f nonce16 1f ascii(timestamp)); ' +
      'seed = SHA256(DOMAIN 1f "seed" 1f R 1f hexdecode(signature) 1f u8(local_id)...) — see generate.js',
    seed_domain_separation: domain,
    schedule_template_ref: protocol.schedule_template_ref,
    generate_script_ref: protocol.generate_script_ref,
    pantheon_event_id: roster.pantheon_event_id,
    seating,
    pantheon_prescript: buildPrescript(seating),
  };
}

/** The one canonical serialisation. "Byte for byte" is only meaningful if this is fixed. */
function serialise(results) {
  return JSON.stringify(results, null, 2) + '\n';
}

/**
 * Fields that §4 puts in results.json but that generate.js does not produce.
 *
 * They are written afterwards by the finalisation job and are NOT reproducible:
 * `pantheon_sync` records the outcome of a network call and carries a wall-clock
 * timestamp; `excluded_local_ids` describes submissions that never decrypted, so
 * nothing in the file can regenerate them.
 *
 * They belong in the file — §4 lists pantheon_sync, and an exclusion must be visible —
 * but they cannot be part of the byte-for-byte claim. So `--verify` checks the
 * reproducible core and states plainly which fields it set aside, rather than either
 * failing on them or quietly pretending they were verified.
 */
const ANNOTATIONS = ['pantheon_sync', 'excluded_local_ids'];

function splitAnnotations(published) {
  const core = { ...published };
  const found = [];
  for (const k of ANNOTATIONS) {
    if (k in core) { found.push(k); delete core[k]; }
  }
  return { core, found };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) throw new Error(`unexpected argument: ${a}`);
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else { out[key] = next; i++; }
  }
  return out;
}

function main(argv) {
  const args = parseArgs(argv);
  const root = __dirname;
  const pick = (v, d) => (typeof v === 'string' ? v : path.join(root, d));

  const roster = readJson(pick(args.roster, 'data/roster.json'));
  const protocol = readJson(pick(args.protocol, 'data/protocol.json'));
  const template = readJson(pick(args.template, 'data/schedule_template.json'));

  if (typeof args.verify === 'string') {
    const parsed = JSON.parse(fs.readFileSync(args.verify, 'utf8'));

    // A verifier who points this at the wrong protocol.json gets a byte mismatch in a
    // *_ref field, which reads like a tampered result rather than like "you are holding
    // the wrong file". Say which it is, before doing any of the real work.
    for (const k of ['schedule_template_ref', 'generate_script_ref', 'seed_domain_separation']) {
      if (parsed[k] !== undefined && protocol[k] !== undefined && parsed[k] !== protocol[k]) {
        process.stderr.write(
          `  ERROR ${args.verify} was produced under a different protocol.json.\n` +
            `        ${k}\n          in results: ${parsed[k]}\n          in protocol: ${protocol[k]}\n` +
            `        Check out the tag this draw was frozen at, or pass --protocol explicitly.\n`
        );
        return 2;
      }
    }

    const { core, found } = splitAnnotations(parsed);
    const published = serialise(core);
    const decrypted = Object.entries(parsed.revealed).map(([local_id, v]) => ({
      local_id: Number(local_id),
      user_input: v.user_input,
      client_nonce: v.client_nonce,
      client_timestamp: v.client_timestamp,
    }));
    const recomputed = serialise(
      generate({
        decrypted, roster, protocol, template,
        signature: parsed.drand_signature,
        round: parsed.round_used,
      })
    );
    if (recomputed === published) {
      process.stdout.write(`  OK    ${args.verify} reproduces byte for byte from its own revealed payloads\n`);
      if (found.length) {
        process.stdout.write(
          `        (not covered, and not reproducible by design: ${found.join(', ')} — ` +
            `written after the draw by the finalisation job)\n`
        );
      }
      return 0;
    }
    process.stderr.write(`  FAIL  ${args.verify} does NOT reproduce\n`);
    const a = published.split('\n');
    const b = recomputed.split('\n');
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      if (a[i] !== b[i]) {
        process.stderr.write(`  line ${i + 1}\n    published:  ${a[i]}\n    recomputed: ${b[i]}\n`);
        break;
      }
    }
    return 1;
  }

  if (typeof args.decrypted !== 'string' || typeof args.signature !== 'string') {
    process.stderr.write(
      'usage: node generate.js --decrypted <file> --signature <hex> [--round <n>] [--out results.json]\n' +
        '       node generate.js --verify results.json\n'
    );
    return 2;
  }

  const results = generate({
    decrypted: readJson(args.decrypted),
    roster, protocol, template,
    signature: args.signature,
    round: typeof args.round === 'string' ? Number(args.round) : undefined,
  });

  const dest = typeof args.out === 'string' ? args.out : path.join(root, 'results.json');
  fs.writeFileSync(dest, serialise(results));
  process.stdout.write(
    `  OK    ${dest}\n` +
      `        R  = ${results.R}\n` +
      `        pi = [${results.permutation.join(', ')}] from ${results.participating_local_ids.length} contributions\n`
  );
  return 0;
}

module.exports = {
  generate, serialise, combine, contribution, deriveSeed, permute,
  buildSeating, buildPrescript, Sha256CounterStream, SEAT_ORDER,
  ANNOTATIONS, splitAnnotations,
};

if (require.main === module) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (err) {
    process.stderr.write(`  ERROR ${err.message}\n`);
    process.exit(1);
  }
}
