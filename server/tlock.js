'use strict';

/**
 * tlock-js wrapper (PROTOCOL.md §3, §5).
 *
 * What is sealed is the payload {user_input, client_nonce, client_timestamp}, not a
 * bare number — §3. All three become public at the reveal, which is what makes every
 * step recomputable by anyone.
 *
 * tlock-js is ESM-shaped from this CommonJS tree's point of view, so it is pulled in
 * with a dynamic import. Its named exports are checked once at load time rather than
 * assumed, so an upstream rename surfaces at startup instead of at finalisation.
 *
 * The backend only ever DECRYPTS, and only after the target round has landed. The
 * decryption key is drand's round signature: public, and unobtainable by the server a
 * moment earlier than by anyone else. Encryption happens in the player's browser.
 */

const { DEFAULTS } = require('./runtime');

let _mod = null;

async function mod() {
  if (_mod) return _mod;
  let m;
  try {
    m = await import('tlock-js');
  } catch (err) {
    throw new Error(`cannot load tlock-js — run "npm install". (${err.message})`);
  }
  for (const name of ['timelockEncrypt', 'timelockDecrypt', 'HttpChainClient', 'HttpCachingChain']) {
    if (typeof m[name] !== 'function') {
      throw new Error(
        `tlock-js does not export ${name}; its API has changed. Re-read its docs and update server/tlock.js. ` +
          `Exports seen: ${Object.keys(m).join(', ')}`
      );
    }
  }
  _mod = m;
  return m;
}

/**
 * A chain client bound to the exact chain named in the frozen protocol.json, reached
 * through whatever endpoint runtime.json currently points at.
 *
 * BOTH chainHash and publicKey go into chainVerificationParams. drand-client's
 * isValidInfo() checks them together (`hash === … && public_key === …`), so passing
 * only the hash leaves publicKey undefined, the comparison fails against every real
 * chain, and the tempting "fix" is to drop verification altogether.
 *
 * Pinning both is also precisely why the endpoint itself need not be frozen (§4.1): a
 * swapped or hostile drand.api cannot substitute a chain, only fail loudly.
 *
 * @param {{protocol: object, runtime?: object}} cfg
 * @param {object} [opts]
 * @param {object} [opts.tlock] stand in for the tlock-js module, so a test can read
 *   back the verification parameters without reaching a chain to do it.
 */
async function chainClient(cfg, opts = {}) {
  const { protocol, runtime } = cfg;
  const m = opts.tlock || await mod();
  const base = String(runtime?.drand?.api || DEFAULTS.drand.api).replace(/\/+$/, '');
  const params = { chainHash: protocol.chain_hash, publicKey: protocol.chain_public_key };
  const chain = new m.HttpCachingChain(`${base}/${protocol.chain_hash}`, {
    chainVerificationParams: params,
    disableBeaconVerification: false,
    noCache: false,
  });
  return new m.HttpChainClient(chain, { chainVerificationParams: params });
}

const MAX_PAYLOAD_BYTES = 512;

/** Encrypt one payload for `round`. Used by the test harness; players do this in-browser. */
async function encryptPayload(payload, round, cfg) {
  const m = await mod();
  const client = await chainClient(cfg);
  const json = JSON.stringify({
    user_input: payload.user_input,
    client_nonce: payload.client_nonce,
    client_timestamp: payload.client_timestamp,
  });
  return await m.timelockEncrypt(round, m.Buffer.from(json, 'utf8'), client);
}

/**
 * What a decrypted ciphertext has to be, before anything downstream sees it.
 *
 * Separate from the decryption on purpose. This is the gate between "somebody sealed
 * some bytes" and "this is a contribution", and it is the only thing standing between a
 * hand-crafted POST and generate.js — which would otherwise reject the payload after
 * the round had already been consumed, when the remedy is to exclude a player in public.
 * Pure, synchronous and exported, so every refusal can be exercised without a chain.
 *
 * @param {Buffer|Uint8Array|string} plaintext what tlock handed back
 * @param {object} protocol the frozen protocol.json
 */
function parsePayload(plaintext, protocol) {
  const buf = Buffer.from(plaintext);
  if (buf.length > MAX_PAYLOAD_BYTES) {
    throw new Error(`decrypted payload is ${buf.length} bytes, expected at most ${MAX_PAYLOAD_BYTES}`);
  }

  let obj;
  try {
    obj = JSON.parse(buf.toString('utf8'));
  } catch {
    throw new Error('decrypted payload is not JSON');
  }
  // An array parses as JSON and then reads every field as undefined, so the refusals
  // below would each fire on their own. Saying it once, by name, is the difference
  // between "user_input must be an integer" and a message someone can act on.
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new Error('decrypted payload is not a JSON object');
  }
  // No fallback: config.js requires user_input_max, so an absent one means this was
  // handed something that never went through validation.
  const max = protocol.user_input_max;
  if (!Number.isInteger(obj.user_input) || obj.user_input < 0 || obj.user_input > max) {
    throw new Error(`user_input must be an integer in 0..${max}`);
  }
  if (typeof obj.client_nonce !== 'string' || !/^[0-9a-f]{32}$/i.test(obj.client_nonce)) {
    throw new Error('client_nonce must be 16 bytes of hex');
  }
  if (typeof obj.client_timestamp !== 'string') throw new Error('client_timestamp missing');
  return {
    user_input: obj.user_input,
    client_nonce: obj.client_nonce.toLowerCase(),
    client_timestamp: obj.client_timestamp,
  };
}

/**
 * Decrypt one ciphertext back to {user_input, client_nonce, client_timestamp}.
 *
 * Validates shape rather than trusting it downstream — see parsePayload.
 */
async function decryptPayload(ciphertext, cfg) {
  const m = await mod();
  const client = await chainClient(cfg);
  return parsePayload(await m.timelockDecrypt(ciphertext, client), cfg.protocol);
}

module.exports = { chainClient, encryptPayload, decryptPayload, parsePayload, mod, MAX_PAYLOAD_BYTES };
