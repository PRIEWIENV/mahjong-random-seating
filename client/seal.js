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

/** UI-SPEC §4's "Roll for me" — a uniform draw, not Math.random. */
export function rollNumber(max = 255) {
  const bound = max + 1;
  const limit = Math.floor(0x100000000 / bound) * bound;
  const buf = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(buf);
    if (buf[0] < limit) return buf[0] % bound;
  }
}

function chainClient(protocol) {
  // Both the chain hash and the public key are pinned from the frozen protocol.json.
  // drand-client checks the two together; pinning only the hash disables the check.
  const params = { chainHash: protocol.chain_hash, publicKey: protocol.chain_public_key };
  const base = String(protocol.drand_api).replace(/\/+$/, '');
  const chain = new HttpCachingChain(`${base}/${protocol.chain_hash}`, { chainVerificationParams: params });
  return new HttpChainClient(chain, { chainVerificationParams: params });
}

/**
 * Build and seal {user_input, client_nonce, client_timestamp}.
 * @returns {{ciphertext: string, payload: object}} — payload is for local display only
 */
export async function sealSubmission(userInput, protocol) {
  const max = Number.isInteger(protocol.user_input_max) ? protocol.user_input_max : 255;
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
  const client = chainClient(protocol);
  const ciphertext = await timelockEncrypt(
    protocol.target_round,
    Buffer.from(JSON.stringify(payload), 'utf8'),
    client
  );
  return { ciphertext, payload };
}
