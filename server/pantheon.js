'use strict';

/**
 * The Pantheon boundary (PANTHEON-INTEGRATION.md).
 *
 * Everything the rest of the app needs from Pantheon goes through this one interface:
 *
 *   verifyToken(person_id, auth_token) -> bool         Frey  QuickAuthorize
 *   getEventRoster(event_id)           -> RegisteredPlayer[]  Mimir GetAllRegisteredPlayers
 *   getPrescript(event_id)             -> {prescript, next_session_index}
 *   setPrescript(event_id, prescript)  -> void         Mimir UpdatePrescriptedEventConfig
 *
 * Two implementations satisfy it:
 *
 *   TwirpPantheon — the real thing. Written from the method names and message shapes
 *     in PANTHEON-INTEGRATION.md §5, which were read off Common/proto on master.
 *     ** NOT YET VERIFIED against a running instance. ** That document opens by saying
 *     to confirm the field names against the instance you actually run, because they
 *     are the details most likely to drift, and no instance was available here. The
 *     Twirp path template and every field name are therefore configurable rather than
 *     baked in, so drift is a config change and not a code change.
 *
 *   StubPantheon — an in-process fake with the same contract, used by the tests and by
 *     `PANTHEON_MODE=stub` for local runs. It is what lets the draw, the API and the UI
 *     be built and tested end to end without a Pantheon deployment.
 *
 * The sign-in path and the sync path use different credentials on purpose
 * (§3: "never mixed with the player sign-in path"). Only the sync needs admin rights.
 */

const fs = require('node:fs');

const DEFAULT_TWIRP_PATH = '/twirp/{service}/{method}';

class PantheonError extends Error {
  constructor(message, opts = {}) {
    super(message);
    this.name = 'PantheonError';
    this.status = opts.status;
    this.retryable = opts.retryable ?? false;
  }
}

// ---------------------------------------------------------------------------
// real client
// ---------------------------------------------------------------------------
class TwirpPantheon {
  /**
   * @param {object} cfg protocol.json's `pantheon` block
   * @param {object} env process.env — carries the admin credentials for the sync
   */
  constructor(cfg = {}, env = process.env, opts = {}) {
    this.freyBase = String(cfg.frey_base_url || 'http://localhost:4001').replace(/\/+$/, '');
    this.mimirBase = String(cfg.mimir_base_url || 'http://localhost:4002').replace(/\/+$/, '');
    this.pathTemplate = cfg.twirp_path_template || DEFAULT_TWIRP_PATH;
    this.freyService = cfg.frey_service || 'frey.Frey';
    this.mimirService = cfg.mimir_service || 'mimir.Mimir';
    // Admin credentials for the sync step only. §3: kept in the environment, never in
    // the repository, and never used on the sign-in path.
    this.adminPersonId = env.PANTHEON_ADMIN_PERSON_ID ? Number(env.PANTHEON_ADMIN_PERSON_ID) : null;
    this.adminToken = env.PANTHEON_ADMIN_TOKEN || null;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.fetch = opts.fetch || globalThis.fetch;
  }

  #url(base, service, method) {
    return base + this.pathTemplate.replace('{service}', service).replace('{method}', method);
  }

  async #call(base, service, method, body, { admin = false } = {}) {
    const headers = { 'content-type': 'application/json', accept: 'application/json' };
    if (admin) {
      if (!this.adminToken || !this.adminPersonId) {
        throw new PantheonError(
          'PANTHEON_ADMIN_PERSON_ID and PANTHEON_ADMIN_TOKEN are not set; the seat-plan sync needs an admin account'
        );
      }
      // Header names differ between Pantheon versions; these are the documented ones.
      headers['x-auth-token'] = this.adminToken;
      headers['x-current-person-id'] = String(this.adminPersonId);
    }

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.timeoutMs);
    let res;
    try {
      res = await this.fetch(this.#url(base, service, method), {
        method: 'POST',
        headers,
        body: JSON.stringify(body ?? {}),
        signal: ac.signal,
      });
    } catch (err) {
      throw new PantheonError(`${method}: ${err.message}`, { retryable: true });
    } finally {
      clearTimeout(timer);
    }

    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* twirp errors are JSON, but be tolerant */ }
    if (!res.ok) {
      throw new PantheonError(`${method} -> ${res.status} ${json?.msg || json?.message || text.slice(0, 200)}`, {
        status: res.status,
        retryable: res.status >= 500 || res.status === 429,
      });
    }
    return json ?? {};
  }

  /** Frey QuickAuthorize — confirm a {person_id, auth_token} pair the browser obtained. */
  async verifyToken(personId, authToken) {
    const out = await this.#call(this.freyBase, this.freyService, 'QuickAuthorize', {
      person_id: personId,
      auth_token: authToken,
    });
    // Twirp JSON may report either a boolean field or an empty success body.
    if (typeof out.authorized === 'boolean') return out.authorized;
    if (typeof out.success === 'boolean') return out.success;
    return true;
  }

  /** Mimir GetAllRegisteredPlayers — the live event roster, with local ids. */
  async getEventRoster(eventId) {
    const out = await this.#call(this.mimirBase, this.mimirService, 'GetAllRegisteredPlayers', {
      event_ids: [eventId],
    });
    const players = out.players || out.registered_players || [];
    return players.map((p) => ({
      person_id: p.id ?? p.person_id,
      title: p.title,
      local_id: p.local_id ?? null,
      ignore_seating: Boolean(p.ignore_seating),
    }));
  }

  async getPrescript(eventId) {
    const out = await this.#call(this.mimirBase, this.mimirService, 'GetPrescriptedEventConfig',
      { event_id: eventId }, { admin: true });
    return {
      event_id: out.event_id ?? eventId,
      next_session_index: out.next_session_index ?? 0,
      prescript: out.prescript ?? '',
    };
  }

  /** Mimir UpdatePrescriptedEventConfig. §3: next_session_index = 1 for a fresh plan. */
  async setPrescript(eventId, prescript, nextSessionIndex = 1) {
    await this.#call(this.mimirBase, this.mimirService, 'UpdatePrescriptedEventConfig', {
      event_id: eventId,
      next_session_index: nextSessionIndex,
      prescript,
    }, { admin: true });
  }
}

// ---------------------------------------------------------------------------
// stub
// ---------------------------------------------------------------------------
/**
 * In-process fake with the same contract.
 *
 * Seeded from the frozen roster so the happy path works out of the box, plus whatever
 * extra accounts a test wants in order to exercise the refusal path — an account that
 * is genuinely valid in Pantheon but not registered to the event (UI-SPEC §3's second
 * failure message) is a case that only exists if the fake can represent it.
 */
class StubPantheon {
  /**
   * @param {object} o
   * @param {object} o.roster            frozen roster.json, used to seed the event
   * @param {Array}  [o.extraAccounts]   [{person_id, auth_token, title}] valid but unregistered
   * @param {Map}    [o.tokens]          person_id -> auth_token (defaults to "token-<person_id>")
   */
  constructor({ roster, extraAccounts = [], eventId } = {}) {
    this.eventId = eventId ?? roster?.pantheon_event_id ?? 42;
    this.registered = (roster?.players || []).map((p) => ({
      person_id: p.person_id, title: p.title, local_id: p.local_id,
      // Carried through rather than forced false: someone attending but not playing is
      // a case RUNBOOK step 8 names explicitly, and a stub that cannot represent one
      // cannot rehearse the roster snapshot that has to filter them out.
      ignore_seating: Boolean(p.ignore_seating),
    }));
    this.accounts = new Map();
    for (const p of this.registered) this.accounts.set(p.person_id, `token-${p.person_id}`);
    for (const a of extraAccounts) this.accounts.set(a.person_id, a.auth_token || `token-${a.person_id}`);
    this.prescript = '';
    this.nextSessionIndex = 0;
    this.calls = [];
    this.failNext = null; // set to an Error to exercise the sync-failure path
  }

  async verifyToken(personId, authToken) {
    this.calls.push(['verifyToken', personId]);
    return this.accounts.get(personId) === authToken;
  }

  async getEventRoster(eventId) {
    this.calls.push(['getEventRoster', eventId]);
    return eventId === this.eventId ? [...this.registered] : [];
  }

  async getPrescript(eventId) {
    this.calls.push(['getPrescript', eventId]);
    return { event_id: eventId, next_session_index: this.nextSessionIndex, prescript: this.prescript };
  }

  async setPrescript(eventId, prescript, nextSessionIndex = 1) {
    this.calls.push(['setPrescript', eventId]);
    if (this.failNext) { const e = this.failNext; this.failNext = null; throw e; }
    this.prescript = prescript;
    this.nextSessionIndex = nextSessionIndex;
  }
}

/**
 * Where Pantheon lives is operational (§4.2) — runtime.json, never the freeze. What the
 * sync is allowed to write is not: wind_shuffle_mode stays in the frozen protocol.json,
 * because any other value silently discards most of what the template guarantees.
 */
function createPantheon(cfg, env = process.env, opts = {}) {
  // Defaults to the real client. The stub has to be asked for explicitly, so a
  // misconfigured deployment fails to reach Pantheon rather than quietly authorising
  // everybody against an in-process fake.
  const mode = env.PANTHEON_MODE || 'twirp';
  if (mode === 'stub') {
    // A stub seeded from the frozen roster can only ever agree with it, which makes it
    // useless for rehearsing the one step whose job is to write that file. This points
    // the stub at a separate "Pantheon side" of the world — a registration list that the
    // repository has not seen — so RUNBOOK step 10 and its refusals can be exercised
    // without a Pantheon deployment. tools/rehearse.js is the caller.
    const seed = env.PANTHEON_STUB_ROSTER
      ? JSON.parse(fs.readFileSync(env.PANTHEON_STUB_ROSTER, 'utf8'))
      : cfg?.roster;
    return new StubPantheon({ roster: seed, ...opts });
  }
  return new TwirpPantheon(cfg?.runtime?.pantheon || {}, env, opts);
}

module.exports = { TwirpPantheon, StubPantheon, PantheonError, createPantheon, DEFAULT_TWIRP_PATH };
