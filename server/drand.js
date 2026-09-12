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

// The mirror set is operational, not frozen (§4.2), so it is configured in
// runtime.json and defaulted there rather than duplicated here.
const { DEFAULTS } = require('./runtime');

/**
 * @param {object} [opts]
 * @param {boolean} [opts.disagreement] the mirrors gave different answers for one round
 *
 * The flag is here because the caller has to act on that case and on no other. Every
 * other failure in this file means "ask again in a moment"; mirrors disagreeing means
 * stop. The draw job used to tell them apart by looking for the word "disagree" in the
 * message, which made the one unrecoverable branch in this system depend on a sentence
 * nobody was allowed to rewrite.
 */
class DrandError extends Error {
  constructor(message, opts = {}) {
    super(message);
    this.name = 'DrandError';
    this.disagreement = opts.disagreement === true;
  }
}

async function getJson(url, { timeoutMs = 10_000, fetchImpl = fetch } = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { signal: ac.signal, headers: { accept: 'application/json' } });
    if (!res.ok) throw new DrandError(`${url} -> HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

class Drand {
  /**
   * @param {string} chainHash 64 hex chars, from the frozen protocol.json
   * @param {string[]} mirrors base URLs, from runtime.json; the configured api goes first
   * @param {object} [opts]
   * @param {Function} [opts.fetch] injected, the way the Pantheon client and the mirror
   *   already take theirs. Without it the cross-check below could only be exercised by
   *   finding two real mirrors that disagree, so the one branch in this system that
   *   stops a draw outright had never been executed by anything.
   * @param {number} [opts.timeoutMs]
   */
  constructor(chainHash, mirrors = [], opts = {}) {
    this.chainHash = chainHash;
    this.fetchOpts = { fetchImpl: opts.fetch || fetch, timeoutMs: opts.timeoutMs ?? 10_000 };
    const seen = new Set();
    const configured = mirrors.length ? mirrors : DEFAULTS.drand.mirrors;
    this.mirrors = configured.filter((m) => {
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
        const json = await getJson(`${base}/${this.chainHash}${pathname}`, this.fetchOpts);
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
    if (!agreed) {
      throw new DrandError('drand mirrors disagree about the chain public key — stop and investigate',
        { disagreement: true });
    }
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

  /**
   * The signature for a round, cross-checked across mirrors.
   * Throws if the round has not been emitted yet (every mirror 404s).
   */
  async round(round) {
    const { value, agreed, answers } = await this.#fromMirrors(`/public/${round}`, (j) => j.signature);
    if (!agreed) {
      const seen = answers.map((a) => `${a.mirror} -> ${a.json.signature}`).join('\n  ');
      throw new DrandError(`drand mirrors disagree about round ${round} — DO NOT DRAW.\n  ${seen}`,
        { disagreement: true });
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
}

module.exports = { Drand, DrandError };
