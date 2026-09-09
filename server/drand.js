'use strict';

/**
 * Minimal drand HTTP client (PROTOCOL.md §9).
 *
 * The one live dependency of the whole protocol is that drand publishes the
 * signature for target_round. §9 makes the point that this is verifiable through
 * any public mirror rather than a single endpoint, so every call is tried against
 * each configured mirror in turn and the results are cross-checked: if two mirrors
 * disagree about the signature for a round, that is a stop-everything event, not
 * something to paper over by taking the first answer.
 */

const DEFAULT_MIRRORS = [
  'https://api.drand.sh',
  'https://api2.drand.sh',
  'https://api3.drand.sh',
  'https://drand.cloudflare.com',
];

class DrandError extends Error {}

async function getJson(url, timeoutMs = 10_000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ac.signal, headers: { accept: 'application/json' } });
    if (!res.ok) throw new DrandError(`${url} -> HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

class Drand {
  /**
   * @param {string} chainHash 64 hex chars
   * @param {string[]} mirrors base URLs; the protocol's drand_api is put first
   */
  constructor(chainHash, mirrors = []) {
    this.chainHash = chainHash;
    const seen = new Set();
    this.mirrors = [...mirrors, ...DEFAULT_MIRRORS].filter((m) => {
      const u = String(m).replace(/\/+$/, '');
      if (!u || seen.has(u)) return false;
      seen.add(u);
      return true;
    }).map((m) => String(m).replace(/\/+$/, ''));
  }

  /** Fetch a path from every mirror; return {value, agreed, answers}. */
  async #fromMirrors(pathname, pick) {
    const answers = [];
    const errors = [];
    for (const base of this.mirrors) {
      try {
        const json = await getJson(`${base}/${this.chainHash}${pathname}`);
        answers.push({ mirror: base, json });
      } catch (err) {
        errors.push(`${base}: ${err.message}`);
      }
    }
    if (answers.length === 0) {
      throw new DrandError(`no drand mirror answered ${pathname}\n  ${errors.join('\n  ')}`);
    }
    const keys = answers.map((a) => pick(a.json));
    const agreed = keys.every((k) => k === keys[0]);
    return { value: answers[0].json, agreed, answers, errors };
  }

  /** Chain parameters: genesis_time, period, public_key. */
  async info() {
    if (this._info) return this._info;
    const { value, agreed } = await this.#fromMirrors('/info', (j) => j.public_key);
    if (!agreed) throw new DrandError('drand mirrors disagree about the chain public key — stop and investigate');
    if (value.hash && value.hash !== this.chainHash) {
      throw new DrandError(`drand returned chain hash ${value.hash}, protocol.json says ${this.chainHash}`);
    }
    this._info = value;
    return value;
  }

  /** UTC ms at which `round` is emitted. */
  async roundTimeMs(round) {
    const { genesis_time, period } = await this.info();
    return (genesis_time + (round - 1) * period) * 1000;
  }

  /** Round emitted at or before `ms`. */
  async roundAt(ms) {
    const { genesis_time, period } = await this.info();
    const elapsed = Math.floor(ms / 1000) - genesis_time;
    if (elapsed < 0) return 0;
    return Math.floor(elapsed / period) + 1;
  }

  /**
   * The signature for a round, cross-checked across mirrors.
   * Throws if the round has not been emitted yet (every mirror 404s).
   */
  async round(round) {
    const { value, agreed, answers } = await this.#fromMirrors(`/public/${round}`, (j) => j.signature);
    if (!agreed) {
      const seen = answers.map((a) => `${a.mirror} -> ${a.json.signature}`).join('\n  ');
      throw new DrandError(`drand mirrors disagree about round ${round} — DO NOT DRAW.\n  ${seen}`);
    }
    if (value.round !== round) {
      throw new DrandError(`asked for round ${round}, mirror answered with round ${value.round}`);
    }
    return {
      round: value.round,
      signature: value.signature,
      randomness: value.randomness,
      mirrors: answers.map((a) => a.mirror),
    };
  }

  async latest() {
    const { value } = await this.#fromMirrors('/public/latest', (j) => j.round);
    return value;
  }

  /** True once the target round has been emitted (and is fetchable). */
  async isAvailable(round) {
    try {
      await this.round(round);
      return true;
    } catch {
      return false;
    }
  }
}

module.exports = { Drand, DrandError, DEFAULT_MIRRORS };
