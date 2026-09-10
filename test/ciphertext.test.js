'use strict';

/**
 * The admission gate (server/ciphertext.js).
 *
 * Everything this accepts is written to events/submissions/ and mirrored to a public
 * repository, so it is the boundary of the archive. Everything it rejects is rejected
 * while the player is still looking at the page — which is the only moment the problem
 * is cheap. After the cutoff, a ciphertext locked to the wrong round has already been
 * counted towards the quorum and cannot be resubmitted.
 *
 * So each refusal is worth pinning individually. A rule that stops firing does not
 * announce itself; it just lets something into the archive that should not be there.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseTlockHeader, assertAdmissible, CiphertextError, MAX_CIPHERTEXT_BYTES,
} = require('../server/ciphertext');
const { QUICKNET_HASH, fakeCiphertext } = require('./helpers');

const ROUND = 1_000_000;
const PROTOCOL = { chain_hash: QUICKNET_HASH, target_round: ROUND };

const ARMOR_BEGIN = '-----BEGIN AGE ENCRYPTED FILE-----';
const ARMOR_END = '-----END AGE ENCRYPTED FILE-----';

/** Wrap raw bytes the way age armours them. */
function armour(raw) {
  const b64 = Buffer.from(raw, 'binary').toString('base64').replace(/(.{64})/g, '$1\n');
  return `${ARMOR_BEGIN}\n${b64}\n${ARMOR_END}`;
}

/** A structurally valid age file, with any part of it replaceable. */
function ageFile({
  version = 'age-encryption.org/v1',
  stanza = `-> tlock ${ROUND} ${QUICKNET_HASH}`,
  payloadBytes = 64,
} = {}) {
  return armour(`${version}\n${stanza}\nZmlsZWtleQ==\n--- bWFj\n${'x'.repeat(payloadBytes)}`);
}

/** Assert that a call is refused, and by which rule. */
function refuses(fn, pattern) {
  assert.throws(fn, (err) => {
    assert.ok(err instanceof CiphertextError, `threw ${err.constructor.name}, not CiphertextError`);
    assert.match(err.message, pattern);
    return true;
  });
}

// ---------------------------------------------------------------------------
// what gets in
// ---------------------------------------------------------------------------

test('a well-formed tlock ciphertext is admitted and reports what it is locked to', () => {
  const out = assertAdmissible(ageFile(), PROTOCOL);
  assert.deepEqual(out, { round: ROUND, chainHash: QUICKNET_HASH });
});

test('the ciphertext the rest of the suite generates is admissible', () => {
  // If this ever diverges, the fixture and the gate disagree about what a submission
  // looks like, and every other test that submits one is testing a fiction.
  const out = assertAdmissible(fakeCiphertext(ROUND, QUICKNET_HASH), PROTOCOL);
  assert.equal(out.round, ROUND);
});

test('armour whitespace is not significant', () => {
  // Line breaks in base64 armour are a formatting choice, and CRLF happens when a
  // ciphertext makes a round trip through something Windows touched.
  const crlf = ageFile().replace(/\n/g, '\r\n');
  assert.equal(assertAdmissible(crlf, PROTOCOL).round, ROUND);
  const padded = `\n\n  ${ageFile()}  \n`;
  assert.equal(assertAdmissible(padded, PROTOCOL).round, ROUND);
});

// ---------------------------------------------------------------------------
// what does not
// ---------------------------------------------------------------------------

test('a non-string is refused before anything else looks at it', () => {
  for (const bad of [null, undefined, 42, {}, [], Buffer.from('x')]) {
    refuses(() => parseTlockHeader(bad), /must be a string/);
  }
});

test('an empty or blank submission is refused', () => {
  refuses(() => parseTlockHeader(''), /is empty/);
  refuses(() => parseTlockHeader('   \n\t '), /is empty/);
});

test('an implausibly large body is refused rather than parked in SQLite', () => {
  // The bound is on the armoured text, and it is checked before any parsing, so the
  // refusal costs nothing even for a body of megabytes.
  const huge = ageFile({ payloadBytes: MAX_CIPHERTEXT_BYTES * 2 });
  assert.ok(Buffer.byteLength(huge) > MAX_CIPHERTEXT_BYTES);
  refuses(() => parseTlockHeader(huge), /implausibly large/);
});

test('the size bound admits what is just under it', () => {
  // A real one-byte payload is a few hundred bytes, so this only proves the check is a
  // bound and not an accidental cap on ordinary submissions.
  const ok = ageFile({ payloadBytes: 32 });
  assert.ok(Buffer.byteLength(ok) < MAX_CIPHERTEXT_BYTES);
  assert.equal(assertAdmissible(ok, PROTOCOL).round, ROUND);
});

test('anything not wrapped in the age armour lines is refused', () => {
  refuses(() => parseTlockHeader('hello'), /not an armoured age file/);
  refuses(() => parseTlockHeader(`${ARMOR_BEGIN}\nZm9v`), /not an armoured age file/);
  refuses(() => parseTlockHeader(`Zm9v\n${ARMOR_END}`), /not an armoured age file/);
});

test('armour that is not base64 is refused before it is decoded', () => {
  refuses(() => parseTlockHeader(`${ARMOR_BEGIN}\nnot base64!!\n${ARMOR_END}`), /not valid base64/);
});

test('a file that is not age v1 is refused', () => {
  refuses(() => parseTlockHeader(ageFile({ version: 'age-encryption.org/v2' })), /not an age v1 file/);
  refuses(() => parseTlockHeader(ageFile({ version: 'something else entirely' })), /not an age v1 file/);
});

test('a recipient that is not tlock is refused, and says why in the player\'s terms', () => {
  // An age file encrypted to a public key is well-formed and completely useless here:
  // nothing would ever open it, and the quorum would still have counted it.
  refuses(
    () => parseTlockHeader(ageFile({ stanza: '-> X25519 aBcDeF' })),
    /not addressed to a tlock recipient/
  );
  refuses(() => parseTlockHeader(ageFile({ stanza: '-> scrypt abc 18' })), /not addressed to a tlock recipient/);
});

test('a malformed tlock stanza is refused as such', () => {
  const cases = [
    '-> tlock',                                  // no arguments
    `-> tlock ${QUICKNET_HASH}`,                 // hash where the round goes
    `-> tlock abc ${QUICKNET_HASH}`,             // round is not a number
    `-> tlock ${ROUND} ${QUICKNET_HASH.slice(0, 32)}`, // truncated chain hash
    `-> tlock ${ROUND} ${QUICKNET_HASH.toUpperCase()}`, // hex must be lower case
    `-> tlock ${ROUND} ${QUICKNET_HASH} extra`,  // trailing junk
  ];
  for (const stanza of cases) {
    refuses(() => parseTlockHeader(ageFile({ stanza })), /not addressed to a tlock recipient/);
  }
});

// ---------------------------------------------------------------------------
// the two that need the frozen protocol to decide
// ---------------------------------------------------------------------------

test('a ciphertext locked to a different drand chain is refused, naming both', () => {
  const other = 'a'.repeat(64);
  const ct = ageFile({ stanza: `-> tlock ${ROUND} ${other}` });
  // Well-formed: the gate has to reach the comparison, not fail parsing.
  assert.deepEqual(parseTlockHeader(ct), { round: ROUND, chainHash: other });
  refuses(() => assertAdmissible(ct, PROTOCOL), new RegExp(`locked to drand chain ${other}`));
  refuses(() => assertAdmissible(ct, PROTOCOL), new RegExp(`this draw uses ${QUICKNET_HASH}`));
});

test('a ciphertext for another round is refused, and the message covers the void case', () => {
  // §8: a voided round is exactly when a player has a stale page open, and "your
  // ciphertext is for round N" means nothing to them without the instruction.
  const ct = ageFile({ stanza: `-> tlock ${ROUND - 1} ${QUICKNET_HASH}` });
  refuses(() => assertAdmissible(ct, PROTOCOL), /locked to round 999999/);
  refuses(() => assertAdmissible(ct, PROTOCOL), /reload the page and submit again/);
});

test('the chain is checked before the round', () => {
  // Both are wrong here. The chain is the more fundamental mismatch and the one whose
  // remedy is not "reload and try again", so it must not be masked by the round.
  const ct = ageFile({ stanza: `-> tlock ${ROUND + 5} ${'b'.repeat(64)}` });
  refuses(() => assertAdmissible(ct, PROTOCOL), /locked to drand chain/);
});
