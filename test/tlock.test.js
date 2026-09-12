'use strict';

/**
 * The gate between "somebody sealed some bytes" and "this is a contribution".
 *
 * server/tlock.js had no test of its own. Everything it does was covered only by
 * test/e2e.js, which needs the network, waits out a real drand round, and is in neither
 * `npm test` nor CI — so the refusals below, which are the only thing standing between a
 * hand-crafted POST and generate.js, were carried by reading.
 *
 * They matter more than their size suggests. server/server.js admits a ciphertext
 * without opening it (it cannot open it), so the first moment anybody can tell what is
 * inside one is here, after the cutoff, with the beacon already out. A payload that got
 * past this and failed in generate.js would fail at a point where the only remedy left
 * is to exclude a player in public.
 *
 * The tlock call itself is not re-tested here. It is tlock-js's, it needs a chain, and
 * e2e.js exercises it end to end against a real round. What is testable offline is
 * everything this file adds around it, and that is what this covers.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { parsePayload, chainClient, MAX_PAYLOAD_BYTES } = require('../server/tlock');
const { QUICKNET_HASH, QUICKNET_PK, makeProtocol } = require('./helpers');

const protocol = makeProtocol();
const NONCE = '0123456789abcdef0123456789abcdef';
const TS = '2026-09-11T12:00:00.000Z';

const sealed = (over = {}) =>
  Buffer.from(JSON.stringify({ user_input: 7, client_nonce: NONCE, client_timestamp: TS, ...over }), 'utf8');

test('a well-formed payload comes back as the three fields and nothing else', () => {
  const out = parsePayload(sealed(), protocol);
  assert.deepEqual(out, { user_input: 7, client_nonce: NONCE, client_timestamp: TS });
  assert.deepEqual(Object.keys(out), ['user_input', 'client_nonce', 'client_timestamp'],
    'anything extra would travel into generate.js and into the published result');
});

test('a nonce in upper case is accepted and normalised', () => {
  // §7 hex-decodes the nonce, so case cannot change a contribution — but it would change
  // the `revealed` block of results.json, and that block is compared byte for byte.
  const out = parsePayload(sealed({ client_nonce: NONCE.toUpperCase() }), protocol);
  assert.equal(out.client_nonce, NONCE);
});

test('the two ends of the user_input range are in it', () => {
  assert.equal(parsePayload(sealed({ user_input: 0 }), protocol).user_input, 0);
  assert.equal(parsePayload(sealed({ user_input: 255 }), protocol).user_input, 255);
});

for (const [what, payload, expected] of [
  ['above user_input_max', sealed({ user_input: 256 }), /user_input must be an integer in 0\.\.255/],
  ['a negative number', sealed({ user_input: -1 }), /user_input must be an integer/],
  ['a fraction', sealed({ user_input: 1.5 }), /user_input must be an integer/],
  ['a numeric string', sealed({ user_input: '7' }), /user_input must be an integer/],
  ['no user_input at all', sealed({ user_input: undefined }), /user_input must be an integer/],
  ['a short nonce', sealed({ client_nonce: 'abcd' }), /client_nonce must be 16 bytes of hex/],
  ['a non-hex nonce', sealed({ client_nonce: 'z'.repeat(32) }), /client_nonce must be 16 bytes of hex/],
  ['a nonce that is not a string', sealed({ client_nonce: 12345 }), /client_nonce must be 16 bytes of hex/],
  ['no timestamp', sealed({ client_timestamp: undefined }), /client_timestamp missing/],
  ['a timestamp that is not a string', sealed({ client_timestamp: 0 }), /client_timestamp missing/],
  ['bytes that are not JSON', Buffer.from('not json at all'), /not JSON/],
  ['a JSON array', Buffer.from('[1,2,3]'), /not a JSON object/],
  ['JSON null', Buffer.from('null'), /not a JSON object/],
  ['a bare JSON number', Buffer.from('7'), /not a JSON object/],
]) {
  test(`a payload carrying ${what} is refused`, () => {
    assert.throws(() => parsePayload(payload, protocol), expected);
  });
}

test('an implausibly large payload is refused before it is parsed', () => {
  // One byte of plaintext is what this seals. Anything at this size arrived some other
  // way, and JSON.parse on it is work done on behalf of whoever sent it.
  const fat = Buffer.alloc(MAX_PAYLOAD_BYTES + 1, 0x61);
  assert.throws(() => parsePayload(fat, protocol), /decrypted payload is 513 bytes, expected at most 512/);
});

/**
 * user_input_max is frozen, and this reads it from the protocol it was handed rather
 * than from a default. A default here would be a second copy of a tagged value, free to
 * disagree with the protocol.json the draw is committed to.
 */
test('the ceiling comes from the frozen protocol, not from this file', () => {
  const narrow = { ...protocol, user_input_max: 9 };
  assert.equal(parsePayload(sealed({ user_input: 9 }), narrow).user_input, 9);
  assert.throws(() => parsePayload(sealed({ user_input: 10 }), narrow), /in 0\.\.9/);
});

/**
 * Both halves of the pin, in both places drand-client looks.
 *
 * isValidInfo() compares the hash AND the public key and requires both. Pass only the
 * hash and publicKey is undefined, the comparison fails against every real chain, and
 * the tempting fix is to switch verification off — which is what makes the endpoint
 * safe to leave out of the freeze in the first place (§4.1).
 */
test('the chain client pins the hash and the public key, on the chain and on the client', async () => {
  const seen = { chain: null, client: null, url: null };
  const fake = {
    HttpCachingChain: class { constructor(url, o) { seen.url = url; seen.chain = o; } },
    HttpChainClient: class { constructor(chain, o) { seen.client = o; } },
  };
  await chainClient({ protocol, runtime: { drand: { api: 'https://api.example/' } } }, { tlock: fake });

  assert.equal(seen.url, `https://api.example/${QUICKNET_HASH}`, 'the trailing slash must not double up');
  for (const [where, o] of [['chain', seen.chain], ['client', seen.client]]) {
    assert.equal(o.chainVerificationParams.chainHash, QUICKNET_HASH, `${where} is missing the hash`);
    assert.equal(o.chainVerificationParams.publicKey, QUICKNET_PK, `${where} is missing the public key`);
  }
  assert.equal(seen.chain.disableBeaconVerification, false, 'beacon verification must stay on');
});

test('with no runtime the client still falls back to a real endpoint, not to nothing', async () => {
  let url = null;
  const fake = {
    HttpCachingChain: class { constructor(u) { url = u; } },
    HttpChainClient: class {},
  };
  await chainClient({ protocol }, { tlock: fake });
  assert.match(url, /^https:\/\/\S+\/52db9ba7/);
});
