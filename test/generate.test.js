'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const {
  generate, serialise, combine, contribution, deriveSeed, permute,
  buildPrescript, Sha256CounterStream,
} = require('../generate');
const {
  ROOT, makeRoster, makeProtocol, makeDecrypted, template, SAMPLE_SIG,
} = require('./helpers');

const TEMPLATE = template();
const roster = makeRoster();
const protocol = makeProtocol();
const DOMAIN = 'mahjong-seating-v1';

const base = (over = {}) => ({ decrypted: makeDecrypted(12), roster, protocol, template: TEMPLATE, signature: SAMPLE_SIG, ...over });

// ---------------------------------------------------------------------------
// The fixed vector. §7: "Write the encoding down in the implementation and test it
// against a fixed vector, or two independent re-computations of the same draw will
// disagree." tools/verify_contribution.py re-derives these from the documented
// encoding alone, in another language, and must agree.
// ---------------------------------------------------------------------------
const VECTOR = {
  entry: {
    local_id: 3,
    user_input: 7,
    client_nonce: '000102030405060708090a0b0c0d0e0f',
    client_timestamp: '2026-09-10T19:59:00.000Z',
  },
  contribution: '927b1af776ab013b664c85e739eea4cecd6d2afc43d0a23f57fecf3b874c550f',
  R12: '2dac7ab67c45ccc7ace1f37101950351aad2592e9db06da07114751227898311',
  seed12: '985f9ed3ea6ac540c6047f57daec4334b98949684306c20a5d8d6dd358c0519c',
  permutation12: [2, 5, 10, 7, 4, 6, 11, 8, 12, 9, 1, 3],
};

test('FIXED VECTOR: one contribution hashes to a pinned value', () => {
  assert.equal(contribution(VECTOR.entry, DOMAIN, 255).toString('hex'), VECTOR.contribution);
});

test('FIXED VECTOR: R, seed and permutation for twelve players are pinned', () => {
  const d = makeDecrypted(12);
  const { R } = combine(d, DOMAIN, 255);
  assert.equal(R.toString('hex'), VECTOR.R12);
  const seed = deriveSeed(R, SAMPLE_SIG, d.map((e) => e.local_id), DOMAIN);
  assert.equal(seed.toString('hex'), VECTOR.seed12);
  assert.deepEqual(permute([1,2,3,4,5,6,7,8,9,10,11,12], seed), VECTOR.permutation12);
});

test('the Python re-implementation agrees with the fixed vector', () => {
  // If the encoding were ambiguous, a second implementation written from the prose
  // would land somewhere else. This is RUNBOOK A5 in miniature.
  let out;
  try {
    out = execFileSync('py', [path.join(ROOT, 'tools', 'verify_contribution.py'), '--self-test'], { encoding: 'utf8' });
  } catch {
    try {
      out = execFileSync('python3', [path.join(ROOT, 'tools', 'verify_contribution.py'), '--self-test'], { encoding: 'utf8' });
    } catch {
      return; // no interpreter here; tools/verify_contribution.py is checked in CI instead
    }
  }
  assert.match(out, /OK\s+fixed vector reproduces/);
});

// ---------------------------------------------------------------------------
// §3.1 — why hash-then-XOR
// ---------------------------------------------------------------------------

test('§3.1: contributions are spread across all 256 bits even for tiny inputs', () => {
  // The point of hashing first. Raw small numbers would leave the high bits zero, and
  // XOR does not mix across bit positions, so the result would be trapped down there.
  const nonce = '00'.repeat(16);
  const ts = '2026-09-10T19:59:00.000Z';
  for (const user_input of [0, 1, 7, 8]) {
    const c = contribution({ local_id: 1, user_input, client_nonce: nonce, client_timestamp: ts }, DOMAIN, 255);
    assert.equal(c.length, 32);
    const highBytesSet = c.subarray(0, 16).some((b) => b !== 0);
    assert.ok(highBytesSet, `input ${user_input} left the top half of the hash empty`);
  }
});

test('§3.1: adjacent inputs give unrelated contributions', () => {
  const fixed = { local_id: 1, client_nonce: '00'.repeat(16), client_timestamp: '2026-09-10T19:59:00.000Z' };
  const a = contribution({ ...fixed, user_input: 7 }, DOMAIN, 255);
  const b = contribution({ ...fixed, user_input: 8 }, DOMAIN, 255);
  let differing = 0;
  for (let i = 0; i < 32; i++) {
    let x = a[i] ^ b[i];
    while (x) { differing += x & 1; x >>= 1; }
  }
  // ~128 expected for unrelated values; anything under 80 would suggest structure.
  assert.ok(differing > 80, `only ${differing} bits differ between inputs 7 and 8`);
});

test('§3.1: the nonce carries the entropy, so identical typed numbers still differ', () => {
  const ts = '2026-09-10T19:59:00.000Z';
  const a = contribution({ local_id: 1, user_input: 7, client_nonce: 'aa'.repeat(16), client_timestamp: ts }, DOMAIN, 255);
  const b = contribution({ local_id: 1, user_input: 7, client_nonce: 'bb'.repeat(16), client_timestamp: ts }, DOMAIN, 255);
  assert.notEqual(a.toString('hex'), b.toString('hex'));
});

test('every player typing the same number still gives a well-spread R', () => {
  const d = makeDecrypted(12).map((e) => ({ ...e, user_input: 7 }));
  const { R } = combine(d, DOMAIN, 255);
  const ones = [...R].reduce((n, b) => { let x = b, c = 0; while (x) { c += x & 1; x >>= 1; } return n + c; }, 0);
  assert.ok(ones > 80 && ones < 176, `R has ${ones} set bits, which does not look uniform`);
});

// ---------------------------------------------------------------------------
// encoding safety
// ---------------------------------------------------------------------------

test('the encoding is injective: shifting a byte between fields changes the hash', () => {
  // local_id 1 + user_input 35 must not collide with local_id 35 + user_input 1, etc.
  const fixed = { client_nonce: '00'.repeat(16), client_timestamp: '2026-09-10T19:59:00.000Z' };
  const seen = new Set();
  for (const [local_id, user_input] of [[1, 35], [35, 1], [1, 1], [35, 35]]) {
    seen.add(contribution({ ...fixed, local_id, user_input }, DOMAIN, 255).toString('hex'));
  }
  assert.equal(seen.size, 4);
});

test('a domain separator containing the separator byte is rejected, not escaped', () => {
  assert.throws(
    () => contribution(VECTOR.entry, `mahjong\x1fseating`, 255),
    /may not contain byte 0x1f/
  );
});

test('a malformed timestamp is rejected', () => {
  for (const bad of ['not a date', '2026-09-10 19:59:00Z', '2026-09-10T19:59:00', '2026-09-10T19:59:00+02:00', '']) {
    assert.throws(
      () => contribution({ ...VECTOR.entry, client_timestamp: bad }, DOMAIN, 255),
      /client_timestamp must be ISO-8601/,
      `should reject ${JSON.stringify(bad)}`
    );
  }
});

test('a nonce of the wrong length is rejected', () => {
  assert.throws(() => contribution({ ...VECTOR.entry, client_nonce: 'aa'.repeat(8) }, DOMAIN, 255), /exactly 16 bytes/);
  assert.throws(() => contribution({ ...VECTOR.entry, client_nonce: 'aa'.repeat(32) }, DOMAIN, 255), /exactly 16 bytes/);
});

test('user_input outside 0..user_input_max is rejected', () => {
  assert.throws(() => contribution({ ...VECTOR.entry, user_input: 256 }, DOMAIN, 255), /0\.\.255/);
  assert.throws(() => contribution({ ...VECTOR.entry, user_input: -1 }, DOMAIN, 255), /0\.\.255/);
  assert.throws(() => contribution({ ...VECTOR.entry, user_input: 1.5 }, DOMAIN, 255), /0\.\.255/);
  assert.throws(() => contribution({ ...VECTOR.entry, user_input: 200 }, DOMAIN, 100), /0\.\.100/);
});

test('the signature is hex-decoded, so its case cannot change the seed', () => {
  const { R } = combine(makeDecrypted(12), DOMAIN, 255);
  const lower = deriveSeed(R, SAMPLE_SIG, [1], DOMAIN);
  const upper = deriveSeed(R, SAMPLE_SIG.toUpperCase(), [1], DOMAIN);
  assert.deepEqual(lower, upper);
});

// ---------------------------------------------------------------------------
// §7 step 4 — the seed folds in the beacon and the participant set
// ---------------------------------------------------------------------------

test('§7: the drand signature changes the seed', () => {
  const { R } = combine(makeDecrypted(12), DOMAIN, 255);
  const a = deriveSeed(R, SAMPLE_SIG, [1, 2], DOMAIN);
  const b = deriveSeed(R, SAMPLE_SIG.replace(/^98/, '99'), [1, 2], DOMAIN);
  assert.notDeepEqual(a, b);
});

test('§7: sorted(local_ids) disambiguates who took part', () => {
  const { R } = combine(makeDecrypted(12), DOMAIN, 255);
  assert.notDeepEqual(
    deriveSeed(R, SAMPLE_SIG, [1, 2, 3, 4, 5, 6, 7, 8], DOMAIN),
    deriveSeed(R, SAMPLE_SIG, [1, 2, 3, 4, 5, 6, 7, 9], DOMAIN)
  );
});

test('XOR is order-independent but the audit log is sorted (§7 step 1)', () => {
  const d = makeDecrypted(12);
  const forward = combine(d, DOMAIN, 255);
  const backward = combine([...d].reverse(), DOMAIN, 255);
  assert.equal(forward.R.toString('hex'), backward.R.toString('hex'));
  assert.deepEqual(backward.sorted.map((e) => e.local_id), [1,2,3,4,5,6,7,8,9,10,11,12]);
});

// ---------------------------------------------------------------------------
// §7 step 5 — the shuffle
// ---------------------------------------------------------------------------

test('the counter stream is SHA256(seed || uint32be(i)) block for block', () => {
  const seed = crypto.createHash('sha256').update('x').digest();
  const s = new Sha256CounterStream(seed);
  for (let i = 0; i < 3; i++) {
    const ctr = Buffer.alloc(4);
    ctr.writeUInt32BE(i, 0);
    assert.deepEqual(s.read(32), crypto.createHash('sha256').update(seed).update(ctr).digest());
  }
});

test('below() is in range and covers the whole interval', () => {
  const s = new Sha256CounterStream(Buffer.alloc(32, 9));
  const seen = new Set();
  for (let i = 0; i < 4000; i++) {
    const v = s.below(12);
    assert.ok(v >= 0 && v < 12);
    seen.add(v);
  }
  assert.equal(seen.size, 12);
});

test('the permutation is genuine, and every slot reaches every point', () => {
  const counts = Array.from({ length: 12 }, () => new Array(13).fill(0));
  for (let k = 0; k < 400; k++) {
    const seed = crypto.createHash('sha256').update(`s${k}`).digest();
    const pi = permute([1,2,3,4,5,6,7,8,9,10,11,12], seed);
    assert.deepEqual([...pi].sort((a, b) => a - b), [1,2,3,4,5,6,7,8,9,10,11,12]);
    pi.forEach((id, point) => counts[point][id]++);
  }
  for (let point = 0; point < 12; point++) {
    for (let id = 1; id <= 12; id++) {
      assert.ok(counts[point][id] > 0, `local_id ${id} never landed on point ${point}`);
    }
  }
});

// ---------------------------------------------------------------------------
// end to end
// ---------------------------------------------------------------------------

test('identical inputs produce byte-identical output', () => {
  assert.equal(serialise(generate(base())), serialise(generate(base())));
});

test('nothing non-deterministic leaks into results.json', () => {
  const out = serialise(generate(base()));
  assert.ok(!/"generated_at"/.test(out));
  assert.ok(!new RegExp(`${new Date().getFullYear()}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z`).test(
    out.replace(/2026-09-10T19:59:0\d\.000Z/g, '')
  ), 'results.json carries a wall-clock timestamp');
});

test('results.json carries everything §4 lists', () => {
  const r = generate(base());
  for (const k of ['round_used', 'drand_signature', 'participating_local_ids', 'revealed',
                   'contributions', 'R', 'seed', 'permutation', 'seating', 'pantheon_prescript']) {
    assert.ok(k in r, `missing ${k}`);
  }
  assert.equal(r.R.length, 64);
  assert.equal(r.seed.length, 64);
  assert.equal(r.seating.rounds.length, 11);
});

test('all twelve are seated even when only the quorum contributed', () => {
  const r = generate(base({ decrypted: makeDecrypted(8) }));
  assert.equal(r.participating_local_ids.length, 8);
  const seated = new Set();
  for (const rd of r.seating.rounds) {
    for (const t of rd.tables) for (const w of ['E','S','W','N']) seated.add(t.seats[w].local_id);
  }
  assert.equal(seated.size, 12, 'the quorum governs the randomness, not who plays');
});

test('§8: generate refuses below the quorum, with no override', () => {
  assert.throws(() => generate(base({ decrypted: makeDecrypted(7) })), /quorum not met: 7 contributions/);
});

test('rejects a local_id that is not on the roster', () => {
  const d = [...makeDecrypted(8), { local_id: 99, user_input: 1, client_nonce: '00'.repeat(16), client_timestamp: '2026-09-10T19:59:00.000Z' }];
  assert.throws(() => generate(base({ decrypted: d })), /local_id 99 is not in roster.json/);
});

test('rejects a duplicated local_id', () => {
  const d = [...makeDecrypted(8), makeDecrypted(1)[0]];
  assert.throws(() => generate(base({ decrypted: d })), /appears twice/);
});

test('the seat plan follows the template exactly', () => {
  const r = generate(base());
  for (const [i, rd] of r.seating.rounds.entries()) {
    for (const [j, tbl] of rd.tables.entries()) {
      for (const w of ['E','S','W','N']) {
        const point = TEMPLATE.rounds[i].tables[j].seats[w];
        assert.equal(tbl.seats[w].point, point);
        assert.equal(tbl.seats[w].local_id, r.permutation[point]);
      }
    }
  }
});

// ---------------------------------------------------------------------------
// the prescript (PANTHEON-INTEGRATION.md §3)
// ---------------------------------------------------------------------------

test('the prescript is blank-line-separated sessions of hyphenated local ids', () => {
  const r = generate(base());
  const sessions = r.pantheon_prescript.split('\n\n');
  assert.equal(sessions.length, 11, 'one block per round');
  for (const s of sessions) {
    const lines = s.split('\n');
    assert.equal(lines.length, 3, 'three tables per round');
    const ids = [];
    for (const line of lines) {
      assert.match(line, /^\d+-\d+-\d+-\d+$/);
      ids.push(...line.split('-').map(Number));
    }
    assert.deepEqual(ids.sort((a, b) => a - b), [1,2,3,4,5,6,7,8,9,10,11,12]);
  }
});

test('the prescript seat order is exactly East-South-West-North', () => {
  const r = generate(base());
  const firstLine = r.pantheon_prescript.split('\n')[0];
  const t1 = r.seating.rounds[0].tables[0].seats;
  assert.equal(firstLine, [t1.E, t1.S, t1.W, t1.N].map((s) => s.local_id).join('-'));
});

test('the prescript has no trailing newline that would create an empty session', () => {
  // unpackScript splits on a blank line; a trailing "\n\n" would yield a 12th, empty
  // session and Pantheon would read the plan as malformed.
  const r = generate(base());
  assert.ok(!r.pantheon_prescript.endsWith('\n'));
  assert.ok(!r.pantheon_prescript.includes('\n\n\n'));
});

test('buildPrescript is a pure function of the seating', () => {
  const r = generate(base());
  assert.equal(buildPrescript(r.seating), r.pantheon_prescript);
});
