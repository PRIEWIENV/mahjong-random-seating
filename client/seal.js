/**
 * Sealing a submission (PROTOCOL.md §3, UI-SPEC.md §4).
 *
 * The plaintext number never leaves this file. It is combined with a fresh 16-byte
 * nonce and the browser's clock, sealed with tlock against the chain and round from
 * the frozen protocol.json, and only the ciphertext is posted.
 *
 * That is what makes "pick a value that favours me" not a move anyone can make: at the
 * moment a player submits, every other submission is still sealed, so the information
 * needed to choose a favourable number does not exist yet — for anyone, including
 * whoever runs the server.
 */

import { timelockEncrypt, HttpChainClient, HttpCachingChain, Buffer } from 'tlock-js';

/** 16 bytes from the browser CSPRNG, as lowercase hex. */
export function makeNonce() {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

/**
 * UI-SPEC §4's "Roll for me" — a uniform draw, not Math.random.
 *
 * `max` is required. A default here would be a second copy of a frozen parameter
 * living in the bundle, free to disagree with the protocol.json the draw is tagged to.
 */
export function rollNumber(max) {
  if (!Number.isInteger(max) || max < 1) throw new Error('rollNumber: user_input_max is required');
  const bound = max + 1;
  const limit = Math.floor(0x100000000 / bound) * bound;
  const buf = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(buf);
    if (buf[0] < limit) return buf[0] % bound;
  }
}

/**
 * @param {{chain_hash: string, chain_public_key: string, api: string}} chain
 *
 * chain_hash and chain_public_key come from the frozen, git-tagged protocol.json. `api`
 * does not: it is where that chain is reached right now, served in /api/status out of
 * runtime.json (PROTOCOL.md §4.2). Keeping it out of the freeze is safe for exactly the
 * reason the other two are in it — drand-client's isValidInfo compares the hash AND the
 * public key and requires both, so an endpoint that served a different chain would fail
 * the check rather than quietly substitute one. Pin only the hash and publicKey is
 * undefined, the comparison fails against every real chain, and the tempting "fix" is to
 * turn verification off.
 */
function chainClient(chain) {
  if (!chain?.chain_hash || !chain?.chain_public_key || !chain?.api) {
    throw new Error('drand chain is not fully pinned — refusing to seal');
  }
  const params = { chainHash: chain.chain_hash, publicKey: chain.chain_public_key };
  const base = String(chain.api).replace(/\/+$/, '');
  const caching = new HttpCachingChain(`${base}/${chain.chain_hash}`, { chainVerificationParams: params });
  return new HttpChainClient(caching, { chainVerificationParams: params });
}

/**
 * Build and seal {user_input, client_nonce, client_timestamp}.
 *
 * Every bound and every chain parameter is passed in. Nothing frozen is defaulted in
 * this file, because a default here is a second copy of a tagged value, free to drift
 * away from the protocol.json the draw is actually committed to.
 *
 * @param {number} userInput
 * @param {{chain_hash, chain_public_key, api, target_round}} chain
 * @param {number} max protocol.json's user_input_max, via /api/status
 * @returns {{ciphertext: string, payload: object}} — payload is for local display only
 */
export async function sealSubmission(userInput, chain, max) {
  if (!Number.isInteger(max) || max < 1) throw new Error('sealSubmission: user_input_max is required');
  if (!Number.isInteger(chain?.target_round)) throw new Error('sealSubmission: target_round is required');
  if (!Number.isInteger(userInput) || userInput < 0 || userInput > max) {
    throw new Error(`Enter a whole number from 0 to ${max}.`);
  }
  const payload = {
    user_input: userInput,
    client_nonce: makeNonce(),
    // §3: the timestamp need not be trustworthy. A client that lies about its clock
    // only alters its own contribution, which it could equally do by typing a
    // different number, so nothing rests on it.
    client_timestamp: new Date().toISOString(),
  };
  const client = chainClient(chain);
  const ciphertext = await timelockEncrypt(
    chain.target_round,
    Buffer.from(JSON.stringify(payload), 'utf8'),
    client
  );
  return { ciphertext, payload };
}
