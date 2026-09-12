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
 *   TwirpPantheon — the real thing. Written from the method names and message shapes in
 *     PANTHEON-INTEGRATION.md §5, and since run against a live instance (Pantheon
 *     cdda3fc, Docker under WSL 2): sign-in, the event roster, and writing the prescript
 *     and reading it back all pass, after six of its assumptions turned out to be wrong.
 *     IMPLEMENTATION_NOTES.md §6f lists them; none announced itself. `getEventTitle` is
 *     the one call not in that set, and it is the one that fails soft — the page shows
 *     its generic title and the draw is unaffected.
 *
 *     One instance of one commit is not the same as the instance you will run. That is
 *     why the Twirp path template and every field name are configuration rather than
 *     code: drift is a runtime.json change, not a rebuild of a hash-pinned bundle.
 *
 *   StubPantheon — an in-process fake with the same contract, used by the tests and by
 *     `PANTHEON_MODE=stub` for local runs. It is what lets the draw, the API and the UI
 *     be built and tested end to end without a Pantheon deployment.
 *
 * The sign-in path and the sync path use different credentials on purpose
 * (§3: "never mixed with the player sign-in path"). Only the sync needs admin rights.
 */

const fs = require('node:fs');

const DEFAULT_TWIRP_PATH = '/v2/{service}/{method}';

/**
 * Read a protobuf JSON field under either spelling.
 *
 * Requests may be written in snake_case — both Pantheon services accept it — but the
 * responses come back in lowerCamelCase, which is what the protobuf JSON mapping
 * specifies and what a live instance actually emits: `{"personId":1,"authToken":"..."}`,
 * `{"authSuccess":true}`, `{"tenhouId":"..."}`. Reading only snake_case meant every
 * field this client cared about came back undefined.
 *
 * The other half of that mapping matters just as much: a field holding its default is
 * omitted entirely. An unset `local_id` is not null, it is absent; `ignore_seating:
 * false` is absent; and `auth_success: false` is absent. Absent therefore has to read as
 * the default rather than as "the server did not say".
 */
function field(obj, snakeName) {
  if (obj == null || typeof obj !== 'object') return undefined;
  if (obj[snakeName] !== undefined) return obj[snakeName];
  return obj[snakeName.replace(/_([a-z])/g, (_, c) => c.toUpperCase())];
}

/**
 * Twirp codes that mean "no", as opposed to "ask again later".
 *
 * Frey answers a bad credential pair with an error rather than with a false: a wrong
 * token is 400 invalid_argument "Password check failed", an unknown person is 404
 * not_found. Treating those as transport failures reported a mistyped password to the
 * player as "Cannot reach Pantheon right now" — a 503 where UI-SPEC §3 requires a
 * distinguishable 401. 429 is deliberately not in this set: it is a rate limit, and
 * retrying is the right response to it.
 */
const REFUSAL_STATUSES = new Set([400, 401, 403, 404]);

class PantheonError extends Error {
  constructor(message, opts = {}) {
    super(message);
    this.name = 'PantheonError';
    this.status = opts.status;
    this.retryable = opts.retryable ?? false;
    if (opts.cause) this.cause = opts.cause;
  }
}

// ---------------------------------------------------------------------------
// real client
// ---------------------------------------------------------------------------
/**
 * What actually went wrong, out of a `fetch failed`.
 *
 * Node reports every transport failure as those same two words and puts the reason in
 * `err.cause` — sometimes nested a second time. Passing `err.message` on therefore gave
 * an operator `GetAllRegisteredPlayers: fetch failed`, which does not say which host was
 * tried, or whether the name failed to resolve, the port refused the connection, or a
 * firewall swallowed it. Those have nothing to do with each other and nothing in common
 * but that sentence, and it is read on the day, at RUNBOOK step 10, by someone who
 * cannot fix what they cannot name.
 *
 * The URL is always included, because "which address did it even try" is the first
 * question and the answer is assembled from four settings across two files.
 */
function transportReason(err, url, timeoutMs) {
  const chain = [];
  for (let e = err; e && chain.length < 6; e = e.cause) chain.push(e);
  const code = chain.map((e) => e.code).find(Boolean);
  const detail = chain.map((e) => e.message).filter(Boolean).pop() || String(err);
  const host = (() => { try { return new URL(url).host; } catch { return url; } })();

  const say = (line, ...hints) => [`${url}\n    ${line}`, ...hints.map((h) => `    ${h}`)].join('\n');

  if (err?.name === 'AbortError' || err?.name === 'TimeoutError') {
    return say(`no answer within ${timeoutMs}ms (${detail}).`,
      'Something accepted the connection and then did not reply in time. Check the',
      'service is healthy rather than merely listening.');
  }
  switch (code) {
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return say(`the name ${host.split(':')[0]} does not resolve (${detail}).`,
        'Pantheon answers on names, not addresses: both container nginx configs match on',
        'server_name and both have a catch-all that 404s, so an IP will not do. Give the',
        'box running this an /etc/hosts entry (or a DNS record) pointing that name at the',
        'machine Pantheon runs on, or set pantheon.mimir_base_url and pantheon.frey_base_url',
        'in data/runtime.json to names it can already resolve.');
    case 'ECONNREFUSED':
      return say(`nothing is listening on ${host} (${detail}).`,
        'The name resolved, so this is the service and not the DNS. Pantheon\u2019s compose',
        'publishes Mimir on 4001 and Frey on 4004; check the containers are up and that the',
        'port is published on the interface this address reaches, not only on loopback',
        'inside the container network.');
    case 'ETIMEDOUT':
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
      return say(`${host} is not reachable from here (${detail}).`,
        'The connection was not refused, it went unanswered \u2014 which is what a firewall or a',
        'missing route looks like, rather than a service that is down.');
    case 'ECONNRESET':
    case 'EPIPE':
      return say(`${host} closed the connection (${detail}).`,
        'Something is listening but did not speak HTTP. A TLS port addressed as http://, or',
        'a proxy in front of Pantheon, both look like this.');
    case 'DEPTH_ZERO_SELF_SIGNED_CERT':
    case 'SELF_SIGNED_CERT_IN_CHAIN':
    case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
    case 'CERT_HAS_EXPIRED':
      return say(`the TLS certificate for ${host} was rejected (${detail}).`,
        'Trust the issuing CA on this box. Do not disable verification: this call carries the',
        'admin token that writes the seat plan.');
    default:
      return say(`${detail}${code ? ` (${code})` : ''}.`);
  }
}

class TwirpPantheon {
  /**
   * @param {object} cfg protocol.json's `pantheon` block
   * @param {object} env process.env — carries the admin credentials for the sync
   */
  constructor(cfg = {}, env = process.env, opts = {}) {
    // The fallbacks match server/runtime.js's defaults, which are the values a live
    // Pantheon answers to. Two copies of a wrong guess is how the first set survived.
    this.freyBase = String(cfg.frey_base_url || 'http://frey.pantheon.local:4004').replace(/\/+$/, '');
    this.mimirBase = String(cfg.mimir_base_url || 'http://mimir.pantheon.local:4001').replace(/\/+$/, '');
    this.pathTemplate = cfg.twirp_path_template || DEFAULT_TWIRP_PATH;
    this.freyService = cfg.frey_service || 'common.Frey';
    this.mimirService = cfg.mimir_service || 'common.Mimir';
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

  async #call(base, service, method, body, { admin = false, eventId = null } = {}) {
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
      // Mimir scopes admin and referee rights per event and reads the scope from this
      // header (Meta.php). Without it an event admin is not recognised as one, and the
      // prescript write — which runs after the draw, when nothing can be changed — is
      // refused.
      if (eventId != null) headers['x-current-event-id'] = String(eventId);
    }

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.timeoutMs);
    const url = this.#url(base, service, method);
    let res;
    try {
      res = await this.fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body ?? {}),
        signal: ac.signal,
      });
    } catch (err) {
      throw new PantheonError(`${method}: ${transportReason(err, url, this.timeoutMs)}`, { retryable: true, cause: err });
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
    let out;
    try {
      out = await this.#call(this.freyBase, this.freyService, 'QuickAuthorize', {
        person_id: personId,
        auth_token: authToken,
      });
    } catch (err) {
      // A refusal is an answer, not an outage. See REFUSAL_STATUSES.
      if (REFUSAL_STATUSES.has(err.status)) return false;
      throw err;
    }
    // A bool that is true is always present in protobuf JSON, because true is not the
    // default; false is always absent. So "present and true" is the whole test, and an
    // unrecognisable body is a refusal rather than — as it was — an implicit yes.
    const ok = field(out, 'auth_success') ?? out.authorized ?? out.success;
    return ok === true;
  }

  /**
   * Mimir GetEventsById — the event's own name, for the page title.
   *
   * A label and nothing more: it names the draw a player is looking at, and no value
   * it could take changes who sits where. So it is fetched rather than frozen, it is
   * allowed to fail, and a deployment that cannot reach Mimir simply shows the generic
   * title. Never let this throw into a request path.
   */
  async getEventTitle(eventId) {
    const out = await this.#call(this.mimirBase, this.mimirService, 'GetEventsById', {
      ids: [eventId],
    });
    const events = out.events || field(out, 'event_data') || [];
    const ev = Array.isArray(events) ? events[0] : events;
    const title = ev?.title ?? field(ev || {}, 'event_title');
    return typeof title === 'string' && title.trim() !== '' ? title.trim() : null;
  }

  /** Mimir GetAllRegisteredPlayers — the live event roster, with local ids. */
  async getEventRoster(eventId) {
    const out = await this.#call(this.mimirBase, this.mimirService, 'GetAllRegisteredPlayers', {
      event_ids: [eventId],
    });
    const players = out.players || field(out, 'registered_players') || [];
    return players.map((p) => ({
      person_id: p.id ?? field(p, 'person_id'),
      title: p.title,
      // Absent means unassigned, which is what tools/freeze.js refuses to freeze over.
      local_id: field(p, 'local_id') ?? null,
      ignore_seating: field(p, 'ignore_seating') === true,
    }));
  }

  async getPrescript(eventId) {
    const out = await this.#call(this.mimirBase, this.mimirService, 'GetPrescriptedEventConfig',
      { event_id: eventId }, { admin: true, eventId });
    return {
      event_id: field(out, 'event_id') ?? eventId,
      next_session_index: field(out, 'next_session_index') ?? 0,
      prescript: out.prescript ?? '',
    };
  }

  /** Mimir UpdatePrescriptedEventConfig. §3: next_session_index = 1 for a fresh plan. */
  async setPrescript(eventId, prescript, nextSessionIndex = 1) {
    await this.#call(this.mimirBase, this.mimirService, 'UpdatePrescriptedEventConfig', {
      event_id: eventId,
      next_session_index: nextSessionIndex,
      prescript,
    }, { admin: true, eventId });
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
   * @param {number} [o.eventId]        the event these players are registered to
   * @param {string} [o.eventTitle]     what Mimir would call the event
   *
   * Tokens default to "token-<person_id>"; a test that needs a specific one writes it
   * into `accounts` after construction.
   */
  constructor({ roster, extraAccounts = [], eventId, eventTitle } = {}) {
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
    this.eventTitle = eventTitle ?? null;
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

  async getEventTitle(eventId) {
    this.calls.push(['getEventTitle', eventId]);
    return eventId === this.eventId ? this.eventTitle : null;
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
    return new StubPantheon({
      roster: seed,
      // Mimir's answer, stood in for. The class defaults this to null because a unit
      // test needs to be able to say "Pantheon told us nothing", but that default made
      // stub mode the one configuration where the event's name could never appear — so
      // the single piece of the page that depends on Mimir was the single piece stub
      // mode could not show. It says "Stub" because it is not a real event's name and
      // nobody should be able to mistake it for one; PANTHEON_STUB_EVENT_TITLE replaces
      // it, and an operator's runtime.json still wins over both.
      eventTitle: env.PANTHEON_STUB_EVENT_TITLE
        || `Stub event ${seed?.pantheon_event_id ?? 42}`,
      ...opts,
    });
  }
  return new TwirpPantheon(cfg?.runtime?.pantheon || {}, env, opts);
}

module.exports = {
  TwirpPantheon, StubPantheon, PantheonError, createPantheon, DEFAULT_TWIRP_PATH, field, transportReason,
};
