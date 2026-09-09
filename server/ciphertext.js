'use strict';

/**
 * Ciphertext admission checks.
 *
 * PROTOCOL.md §5 has the backend accept ciphertexts blindly, and it is right that
 * it cannot read them. But it can still confirm that what it is being handed is a
 * tlock ciphertext addressed to the frozen chain and the frozen target round,
 * without decrypting anything: a tlock ciphertext is an age file, and an age file's
 * recipient stanza is plaintext.
 *
 *     age-encryption.org/v1
 *     -> tlock <round> <chain_hash>
 *     <base64 file key>
 *     --- <mac>
 *     <binary payload>
 *
 * armoured as base64 between BEGIN/END lines.
 *
 * This matters because §7's quorum counts submissions, not valid submissions. A
 * ciphertext locked to some other round would sit in the snapshot, count towards
 * the quorum, and then fail to decrypt after the cutoff — when it is far too late
 * to ask that player to resubmit. Rejecting it at the door is the only point at
 * which the problem is still cheap to fix.
 */

const ARMOR_BEGIN = '-----BEGIN AGE ENCRYPTED FILE-----';
const ARMOR_END = '-----END AGE ENCRYPTED FILE-----';

// One byte of plaintext produces a ciphertext of a few hundred bytes. This bound is
// generous but keeps a POST from parking megabytes in SQLite.
const MAX_CIPHERTEXT_BYTES = 8 * 1024;

class CiphertextError extends Error {}

/**
 * Parse the tlock recipient stanza. Returns {round, chainHash}.
 * Throws CiphertextError with a player-readable message on anything malformed.
 */
function parseTlockHeader(armored) {
  if (typeof armored !== 'string') throw new CiphertextError('ciphertext must be a string');
  const text = armored.trim();
  if (text.length === 0) throw new CiphertextError('ciphertext is empty');
  if (Buffer.byteLength(text, 'utf8') > MAX_CIPHERTEXT_BYTES) {
    throw new CiphertextError('ciphertext is implausibly large for a one-byte payload');
  }
  if (!text.startsWith(ARMOR_BEGIN) || !text.endsWith(ARMOR_END)) {
    throw new CiphertextError('ciphertext is not an armoured age file');
  }

  const body = text.slice(ARMOR_BEGIN.length, text.length - ARMOR_END.length).replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(body)) throw new CiphertextError('ciphertext armour is not valid base64');

  const raw = Buffer.from(body, 'base64').toString('binary');
  const lines = raw.split('\n');
  if (lines[0] !== 'age-encryption.org/v1') {
    throw new CiphertextError('ciphertext is not an age v1 file');
  }
  const stanza = lines[1] || '';
  const m = /^-> tlock (\d+) ([0-9a-f]{64})$/.exec(stanza);
  if (!m) {
    throw new CiphertextError('ciphertext is not addressed to a tlock recipient — it was not produced by this page');
  }
  return { round: Number(m[1]), chainHash: m[2] };
}

/**
 * Full admission check against the frozen protocol.
 * @returns {{round:number, chainHash:string}}
 */
function assertAdmissible(armored, protocol) {
  const { round, chainHash } = parseTlockHeader(armored);
  if (chainHash !== protocol.chain_hash) {
    throw new CiphertextError(
      `ciphertext is locked to drand chain ${chainHash}, this draw uses ${protocol.chain_hash}`
    );
  }
  if (round !== protocol.target_round) {
    throw new CiphertextError(
      `ciphertext is locked to round ${round}, this draw uses round ${protocol.target_round}. ` +
        `If the previous round was declared void, reload the page and submit again.`
    );
  }
  return { round, chainHash };
}

module.exports = { parseTlockHeader, assertAdmissible, CiphertextError, MAX_CIPHERTEXT_BYTES };
