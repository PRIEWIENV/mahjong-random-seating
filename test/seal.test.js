'use strict';

/**
 * The browser's half of PROTOCOL.md §3, which nothing tested.
 *
 * client/seal.js is the file a player's plaintext number actually passes through. Its
 * own header says the number never leaves it, the freeze commits the bundle it is
 * compiled into precisely because of that, and the admin dashboard shows a digest of
 * that bundle on every page load. It was imported by one component and referenced by no
 * test and no tool — the single most consequential file here, and the only one with no
 * assertion anywhere.
 *
 * What that left uncovered is not theoretical. `sealSubmission` builds the payload the
 * whole byte encoding is defined over, and generate.js accepts a client_timestamp only
 * if it matches a deliberately narrow grammar. A browser emitting a timestamp outside it
 * would produce ciphertexts that seal, post, store, mirror and decrypt perfectly — and
 * are then rejected one at a time after the cutoff, with the beacon already out, when
 * the only remedy left is to exclude twelve players in public. Nothing anywhere would
 * have caught that before the day.
 *
 * HOW THIS LOADS THE FILE. client/seal.js is an ES module inside a CommonJS package, so
 * Node will not require() it. It is copied verbatim into var/ under an .mjs name and
 * imported from there — inside the tree, so `tlock-js` still resolves, and byte-checked
 * against the original below so the test cannot drift onto a stale copy. The
 * alternatives were worse: marking client/ as a module changes what esbuild emits, and
 * changing the frozen bundle to make a test possible is the wrong way round.
 *
 * OFFLINE. tlock needs the chain parameters to encrypt, and nothing else — no beacon,
 * since the whole point is that the key does not exist yet. So a local server answers
 * /info with the real quicknet values and the seal is genuine, unmocked and offline.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const { ROOT, QUICKNET_HASH, QUICKNET_PK, makeProtocol } = require('./helpers');
const { assertAdmissible } = require('../server/ciphertext');
const { contribution, ENCODING_LIMITS } = require('../generate.js');

const SOURCE = path.join(ROOT, 'client', 'seal.js');
const COPY = path.join(ROOT, 'var', 'seal.under-test.mjs');
const ROUND = 1_000_000;

/** The real quicknet parameters, so what is sealed here is sealed for real. */
const CHAIN_INFO = {
  public_key: QUICKNET_PK,
  period: 3,
  genesis_time: 1_692_803_367,
  hash: QUICKNET_HASH,
  groupHash: 'f477d5c89f21a17c863a7f937c6a6d15859414d2be09cd448d4279af331c5d3e',
  schemeID: 'bls-unchained-g1-rfc9380',
  metadata: { beaconID: 'quicknet' },
};

let seal;
let server;
let api;
/** Sealing takes most of a second, so one real seal is shared by everything that reads it. */
let sealed;

test.before(async () => {
  fs.mkdirSync(path.dirname(COPY), { recursive: true });
  const source = fs.readFileSync(SOURCE);
  fs.writeFileSync(COPY, source);
  assert.ok(fs.readFileSync(COPY).equals(source), 'the copy under test is not the file that ships');
  seal = await import(pathToFileURL(COPY).href);

  server = http.createServer((req, res) => {
    if (!req.url.endsWith('/info')) {
      // Encryption must never need a beacon: the key for the target round does not
      // exist when a player submits, and if this is ever reached it means it did.
      res.writeHead(410, { 'content-type': 'text/plain' });
      res.end('a submission must not need anything but the chain parameters');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(CHAIN_INFO));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  api = `http://127.0.0.1:${server.address().port}`;

  sealed = await seal.sealSubmission(7, chain(), 255);
});

test.after(() => {
  server?.close();
  try { fs.rmSync(COPY); } catch { /* never written */ }
});

const chain = (over = {}) => ({
  chain_hash: QUICKNET_HASH,
  chain_public_key: QUICKNET_PK,
  api,
  target_round: ROUND,
  ...over,
});

// ---------------------------------------------------------------------------
// sealSubmission
// ---------------------------------------------------------------------------

/**
 * The cross-check that closes the loop. The browser seals, and the server's admission
 * gate — which parses the age recipient stanza without decrypting anything — has to
 * accept it against the same frozen protocol. These two files never referred to each
 * other and nothing compared them.
 */
test('what the browser seals is what the server admits', () => {
  const admitted = assertAdmissible(sealed.ciphertext, makeProtocol({ target_round: ROUND }));
  assert.equal(admitted.round, ROUND);
  assert.equal(admitted.chainHash, QUICKNET_HASH);
});

test('a ciphertext sealed for one round is refused for another', () => {
  assert.throws(
    () => assertAdmissible(sealed.ciphertext, makeProtocol({ target_round: ROUND + 1 })),
    /locked to round 1000000/
  );
});

/**
 * The narrow one. generate.js validates client_timestamp against a deliberately strict
 * grammar, because the field is attacker-chosen and a loose one would blur the byte
 * encoding. Whether the browser satisfies it was a property of Date.prototype.toISOString
 * that nothing anywhere asserted.
 */
test('the timestamp the browser writes is one generate.js will accept', () => {
  assert.match(sealed.payload.client_timestamp, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/);
  // And end to end, through the real hash, rather than against a copy of the pattern.
  assert.doesNotThrow(() => contribution(
    { local_id: 1, ...sealed.payload }, 'mahjong-seating-v1', 255
  ));
});

test('the nonce is 16 bytes of lowercase hex, as the encoding requires', () => {
  assert.match(sealed.payload.client_nonce, /^[0-9a-f]{32}$/);
  assert.equal(Buffer.from(sealed.payload.client_nonce, 'hex').length, ENCODING_LIMITS.nonce_bytes);
});

test('the payload carries the three fields and nothing else', () => {
  // Anything extra would be sealed, revealed at the draw, and published in results.json.
  assert.deepEqual(Object.keys(sealed.payload).sort(),
    ['client_nonce', 'client_timestamp', 'user_input']);
  assert.equal(sealed.payload.user_input, 7);
});

test('two submissions of the same number seal differently', () => {
  // The nonce is what makes a contribution unguessable from the number alone (§3).
  const a = seal.makeNonce();
  const b = seal.makeNonce();
  assert.notEqual(a, b);
});

test('both ends of the permitted range seal', async () => {
  for (const n of [0, 255]) {
    const out = await seal.sealSubmission(n, chain(), 255);
    assert.equal(out.payload.user_input, n);
    assert.equal(assertAdmissible(out.ciphertext, makeProtocol({ target_round: ROUND })).round, ROUND);
  }
});

for (const [what, input] of [
  ['above the maximum', 256],
  ['negative', -1],
  ['a fraction', 1.5],
  ['a string', '7'],
  ['nothing at all', undefined],
  ['not a number', NaN],
]) {
  test(`a number that is ${what} is refused before anything is sealed`, async () => {
    await assert.rejects(seal.sealSubmission(input, chain(), 255), /Enter a whole number from 0 to 255/);
  });
}

/**
 * Every frozen value is passed in. A default in this file would be a second copy of a
 * tagged parameter, living inside a hash-pinned bundle and free to drift away from the
 * protocol.json the draw is committed to.
 */
test('nothing frozen is defaulted: the bound and the round are both required', async () => {
  await assert.rejects(seal.sealSubmission(7, chain(), undefined), /user_input_max is required/);
  await assert.rejects(seal.sealSubmission(7, chain({ target_round: undefined }), 255),
    /target_round is required/);
});

test('a chain that is not fully pinned is refused rather than sealed against', async () => {
  for (const missing of ['chain_hash', 'chain_public_key', 'api']) {
    await assert.rejects(
      seal.sealSubmission(7, chain({ [missing]: undefined }), 255),
      /drand chain is not fully pinned/,
      `sealing went ahead without ${missing}`
    );
  }
});

// ---------------------------------------------------------------------------
// rollNumber
// ---------------------------------------------------------------------------

test('rollNumber refuses to invent a bound', () => {
  // UI-SPEC §4's "Roll for me" draws from the frozen range, and 255 is not a constant
  // this file is allowed to know.
  for (const bad of [undefined, 0, -1, 1.5, '255']) {
    assert.throws(() => seal.rollNumber(bad), /user_input_max is required/);
  }
});

test('rollNumber stays inside the range and reaches both ends of it', () => {
  const seen = new Set();
  for (let i = 0; i < 4000; i += 1) {
    const v = seal.rollNumber(3);
    assert.ok(Number.isInteger(v) && v >= 0 && v <= 3, `drew ${v}`);
    seen.add(v);
  }
  assert.deepEqual([...seen].sort(), [0, 1, 2, 3], 'some value in the range is unreachable');
});

/**
 * The rejection sampling itself, deterministically.
 *
 * `rollNumber` takes 32 bits and discards anything at or above the largest multiple of
 * the bound, because `% bound` on the whole range would favour the low values — for a
 * bound of 3, by one part in 1.4 billion. That is invisible in any sample you could
 * draw, so a statistical test here would pass on a broken implementation. Feeding the
 * generator the one value that must be discarded is what actually pins the behaviour.
 */
test('a draw that would bias the result is discarded and taken again', () => {
  const real = globalThis.crypto.getRandomValues.bind(globalThis.crypto);
  //  bound = 3, limit = floor(2^32 / 3) * 3 = 4294967295, so 0xFFFFFFFF is the one
  //  32-bit value that has to be thrown away.
  const feed = [0xFFFFFFFF, 5];
  let taken = 0;
  globalThis.crypto.getRandomValues = (buf) => {
    if (!(buf instanceof Uint32Array)) return real(buf);
    buf[0] = feed[taken] ?? 0;
    taken += 1;
    return buf;
  };
  try {
    assert.equal(seal.rollNumber(2), 2, '5 % 3 = 2');
    assert.equal(taken, 2, 'the biasing value was used instead of being rejected');
  } finally {
    globalThis.crypto.getRandomValues = real;
  }
});

test('a range that is a power of two never needs a second draw', () => {
  const real = globalThis.crypto.getRandomValues.bind(globalThis.crypto);
  let taken = 0;
  globalThis.crypto.getRandomValues = (buf) => {
    if (!(buf instanceof Uint32Array)) return real(buf);
    buf[0] = 0xFFFFFFFF;
    taken += 1;
    return buf;
  };
  try {
    // 0..255 is 256 values, which divides 2^32 exactly, so nothing is ever rejected and
    // the largest possible draw is a legitimate 255.
    assert.equal(seal.rollNumber(255), 255);
    assert.equal(taken, 1);
  } finally {
    globalThis.crypto.getRandomValues = real;
  }
});
