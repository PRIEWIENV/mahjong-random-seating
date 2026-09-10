'use strict';

/**
 * The backend (PROTOCOL.md §6).
 *
 *   POST /api/session   {person_id, auth_token} -> httpOnly session cookie
 *   GET  /api/me        {local_id, title, submitted}
 *   POST /api/submit    {ciphertext}
 *   GET  /api/status    public; everything the waiting view needs
 *   GET  /api/result    after the draw: results.json + precomputed stats
 *   GET  /api/events    SSE stream of status changes
 *   GET  /admin         the organiser's read-only dashboard, behind ADMIN_TOKEN
 *
 * Node's own http module, no framework: this process is a relay for opaque blobs, and
 * the smaller its dependency tree, the less an auditor has to take on faith.
 *
 * What it must not be able to do, and cannot:
 *   - decrypt a submission before the target round (it holds no key; drand does)
 *   - learn what anyone submitted at submission time (the browser seals it first)
 *   - reveal what anyone submitted before the reveal — §9's non-negotiable, enforced
 *     by never putting a payload in a response, a broadcast, or a header
 *   - change the roster, quorum or target round (read-only frozen files)
 *
 * The server never sees a Pantheon password: the browser authenticates against Frey
 * directly and posts only the resulting token pair (PANTHEON-INTEGRATION.md §2).
 *
 * That token is not a session token, though, and the distinction decides how it has to
 * be handled here. Frey derives it as sha384(password + account_salt) and goes on
 * accepting it until the password changes, so it is password-equivalent. It is
 * therefore verified once and dropped: never stored (createSession takes local_id and
 * person_id, nothing else), never logged, never echoed back. The cookie issued in
 * exchange is 32 unrelated random bytes kept as a hash, so var/ holds nothing that can
 * be turned back into a Pantheon credential.
 */

const crypto = require('node:crypto');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const { load } = require('./config');
const { Store } = require('./db');
const { assertAdmissible, CiphertextError } = require('./ciphertext');
const { Mirror, writeLocal } = require('./mirror');
const { phaseOf, KEY_RESULT, KEY_SYNC } = require('./finalise');
const { EventHub } = require('./events');
const { Drand } = require('./drand');
const { createPantheon } = require('./pantheon');
const { readIndex, ROUNDS_DIR } = require('./rounds');
const { freyPublicUrl, freyPublicUrlIsLocal } = require('./runtime');

/** How long before the cutoff the page switches to its lively cadence. */
const LIVELY_BEFORE_CUTOFF_MS = 3 * 60_000;
const { computeStats } = require('./stats');
const { collect, render } = require('./admin');

const MAX_BODY = 64 * 1024;
const COOKIE = 'mjs_session';
const ADMIN_COOKIE = 'mjs_admin';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

function send(res, status, body, headers = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
  res.writeHead(status, {
    'content-length': buf.length,
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    ...headers,
  });
  res.end(buf);
}

const sendJson = (res, status, obj, headers = {}) =>
  send(res, status, JSON.stringify(obj), { 'content-type': MIME['.json'], 'cache-control': 'no-store', ...headers });

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('request body too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/** Not a security control — the token is the credential — but it stops a loop filling the disk. */
class RateLimiter {
  constructor(limit = 30, windowMs = 60_000) {
    this.limit = limit; this.windowMs = windowMs; this.hits = new Map();
  }
  allow(key, now = Date.now()) {
    const arr = (this.hits.get(key) || []).filter((t) => now - t < this.windowMs);
    arr.push(now);
    this.hits.set(key, arr);
    if (this.hits.size > 10_000) this.hits.clear();
    return arr.length <= this.limit;
  }
}

function createServer(opts = {}) {
  const log = opts.log || console;
  const cfg = opts.cfg || load(opts);
  const store = opts.store || new Store(opts.dbFile || path.join(cfg.root, 'var', 'state.sqlite'));
  const mirror = opts.mirror || new Mirror(process.env, log);
  const pantheon = opts.pantheon || createPantheon(cfg, process.env);
  const drand = opts.drand || new Drand(cfg.protocol.chain_hash, cfg.runtime.drand.mirrors);
  const hub = opts.hub || new EventHub({ heartbeatMs: cfg.runtime.server.sse_heartbeat_ms });
  const publicDir = opts.publicDir || path.join(cfg.root, 'public');
  const limiter = new RateLimiter(opts.rateLimit ?? cfg.runtime.server.rate_limit_per_minute, opts.rateWindowMs ?? 60_000);
  const nowFn = opts.now || (() => Date.now());
  const secureCookie = opts.secureCookie ?? process.env.NODE_ENV === 'production';
  // The dashboard exists only when a token is configured. Unset means the route is not
  // there at all, rather than there and asking for a password: an organiser who never
  // set one has not accidentally published a roster and a submission timeline.
  const adminToken = opts.adminToken ?? process.env.ADMIN_TOKEN ?? null;
  const isStub = pantheon.constructor?.name === 'StubPantheon';

  // ---- drand health, refreshed in the background --------------------------
  // /api/status is polled by every waiting client; it must not make an upstream call
  // per request. UI-SPEC §5 asks for real liveness, so this is cached, not invented.
  let drandHealth = { latest_round: null, healthy: false, last_seen_utc: null };
  let healthTimer = null;
  async function refreshDrand() {
    try {
      const latest = await drand.latest();
      drandHealth = {
        latest_round: latest.round,
        healthy: true,
        last_seen_utc: new Date(nowFn()).toISOString(),
      };
    } catch {
      drandHealth = { ...drandHealth, healthy: false };
    }
  }
  /**
   * How close the draw is, which is what decides how lively this page has to look.
   *
   * Away from the cutoff nothing changes for hours and a slow cadence is right. In the
   * last minutes before it, and until the result lands, the page is the only thing a
   * player is looking at: a beacon round that has not moved in half a minute reads as a
   * hung page, and quicknet produces one every three seconds.
   */
  function nearTheDraw() {
    const phase = phaseOf(cfg, store, nowFn());
    if (phase === 'done' || phase === 'void') return false;
    return nowFn() > cfg.protocol.cutoff_ms - LIVELY_BEFORE_CUTOFF_MS;
  }

  /** A timer that re-chooses its own interval each tick. */
  function pace(fn, slowMs, fastMs) {
    if (slowMs === 0) return null;
    let timer = null;
    const tick = () => {
      try { fn(); } catch (err) { log.error?.(`[server] ${err.message}`); }
      timer = setTimeout(tick, nearTheDraw() ? fastMs : slowMs);
      timer.unref?.();
    };
    timer = setTimeout(tick, 0);
    timer.unref?.();
    return () => { if (timer) clearTimeout(timer); };
  }

  if (opts.drandPollMs !== 0) {
    refreshDrand();
    healthTimer = pace(
      refreshDrand,
      opts.drandPollMs ?? cfg.runtime.drand.health_poll_ms,
      cfg.runtime.drand.health_poll_fast_ms
    );
  }

  // ---- GET /api/status ----------------------------------------------------
  function status() {
    const submitted = store.submittedLocalIds();
    const previous = readIndex(cfg);
    return {
      phase: phaseOf(cfg, store, nowFn()),
      submitted_count: submitted.length,
      quorum: cfg.protocol.quorum,
      total_slots: cfg.protocol.total_slots,
      // Who, not what (§9). The titles come from the frozen roster, never from a payload.
      submitted_local_ids: submitted,
      players: cfg.roster.players.map((p) => ({ local_id: p.local_id, title: p.title })),
      cutoff_utc: cfg.protocol.submission_cutoff_utc,
      target_round: cfg.protocol.target_round,
      user_input_max: cfg.userInputMax,
      drand: {
        // The two frozen fields pin the chain; api is merely where it is reached right
        // now (§4.2). The browser needs all three to seal against the right chain.
        chain_hash: cfg.protocol.chain_hash,
        chain_public_key: cfg.protocol.chain_public_key,
        api: cfg.runtime.drand.api,
        latest_round: drandHealth.latest_round,
        expected_round_at_cutoff: cfg.protocol.target_round,
        healthy: drandHealth.healthy,
        last_seen_utc: drandHealth.last_seen_utc,
      },
      // Tells the sign-in stage which path to use. "stub" means no real Frey is
      // reachable and the dev stand-in is in play; it can never be true in production.
      auth_mode: isStub ? 'stub' : 'pantheon',
      // The BROWSER's Frey, which is not always the backend's. See runtime.js:
      // localhost is this machine here and the player's own device there.
      frey_base_url: freyPublicUrl(cfg.runtime),
      // The path too, not just the host. Which URL Frey answers on is operational
      // (§4.2) and it moved: a live instance serves /v2/common.Frey/Authorize, not the
      // /twirp/frey.Frey/... the protos suggested. Serving it keeps the correction a
      // config change rather than a rebuild of a hash-pinned bundle.
      frey_authorize_path: cfg.runtime.pantheon.twirp_path_template
        .replace('{service}', cfg.runtime.pantheon.frey_service)
        .replace('{method}', 'Authorize'),
      // UI-SPEC §5's fallback cadence, served rather than compiled into the bundle, so
      // it can be changed without a rebuild and without touching anything frozen.
      status_poll_interval_ms: cfg.runtime.ui.status_poll_interval_ms,
      // §8: a run can take more than one attempt. Players who were told a round was
      // void need to see that this is a new one and where the last one's evidence is,
      // or being asked for a number a second time looks like the rules moving.
      attempt: previous.length + 1,
      previous_rounds: previous,
      // UI-SPEC §5: the countdown is driven by this, so it never drifts.
      server_time_utc: new Date(nowFn()).toISOString(),
    };
  }

  let lastPhase = null;
  function pushStatus() {
    const s = status();
    hub.broadcast(s);
    if (s.phase !== lastPhase) { lastPhase = s.phase; log.info?.(`[server] phase -> ${s.phase}`); }
    return s;
  }

  /**
   * Push the status on a clock, not only when somebody submits.
   *
   * Before this, `pushStatus` had exactly one caller — the submit handler — so a client
   * holding an open SSE stream heard nothing between submissions. Two things followed,
   * and a player hit both: the waiting screen sat frozen for the whole window, and when
   * the finalisation job wrote results.json in a *different process*, nothing told the
   * page. It stayed on the countdown after the draw was finished and published.
   *
   * The phase is derived from files on disk (§4.3), so polling it here is what makes a
   * result reach the browser at all. The job does not talk to this process and should
   * not have to: the files are the interface.
   */
  const statusTimer = pace(pushStatus, cfg.runtime.server.status_push_ms, cfg.runtime.server.status_push_fast_ms);

  // ---- POST /api/session --------------------------------------------------
  async function session(req, res, ip) {
    if (!limiter.allow(ip)) return sendJson(res, 429, { error: 'rate_limited', message: 'Too many attempts; wait a minute.' });

    let body;
    try { body = JSON.parse(await readBody(req)); }
    catch (err) { return sendJson(res, err.status || 400, { error: 'bad_request', message: 'Body must be JSON.' }); }

    const personId = Number(body?.person_id);
    const authToken = body?.auth_token;
    if (!Number.isInteger(personId) || personId < 1 || typeof authToken !== 'string' || !authToken) {
      return sendJson(res, 400, { error: 'bad_request', message: 'person_id and auth_token are required.' });
    }

    // 1. is the token pair genuine?
    let ok = false;
    try { ok = await pantheon.verifyToken(personId, authToken); }
    catch (err) {
      log.error?.(`[session] Pantheon unreachable: ${err.message}`);
      return sendJson(res, 503, { error: 'pantheon_unavailable', message: 'Cannot reach Pantheon right now. Try again shortly.' });
    }
    if (!ok) {
      // UI-SPEC §3: distinct, non-confusable from the not-registered case below.
      return sendJson(res, 401, { error: 'bad_credentials', message: 'Pantheon did not recognise that email and password.' });
    }

    // 2. registered to the event, live? 3. and in the frozen roster?
    // Both checks on purpose (PANTHEON-INTEGRATION.md §2): the live one is the
    // authorisation, the frozen one stops a post-freeze roster edit quietly changing
    // the field of twelve.
    let live = [];
    try { live = await pantheon.getEventRoster(cfg.roster.pantheon_event_id); }
    catch (err) {
      log.error?.(`[session] roster lookup failed: ${err.message}`);
      return sendJson(res, 503, { error: 'pantheon_unavailable', message: 'Cannot reach Pantheon right now. Try again shortly.' });
    }
    const inLive = live.some((p) => p.person_id === personId);
    const frozen = cfg.byPersonId.get(personId);
    if (!inLive || !frozen) {
      return sendJson(res, 403, {
        error: 'not_registered',
        message: "That account isn't registered for this event, so it can't take part in the draw.",
      });
    }

    const token = store.createSession(frozen.local_id, personId, nowFn());
    log.info?.(`[session] local_id ${frozen.local_id} (${frozen.title}) signed in`);
    return sendJson(res, 200, { local_id: frozen.local_id, title: frozen.title, submitted: Boolean(store.getSubmission(frozen.local_id)) }, {
      'set-cookie': `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${30 * 24 * 3600}${secureCookie ? '; Secure' : ''}`,
    });
  }

  function currentSession(req) {
    const token = parseCookies(req.headers.cookie)[COOKIE];
    return token ? store.getSession(token, nowFn()) : null;
  }

  // ---- POST /api/submit ---------------------------------------------------
  async function submit(req, res, ip) {
    if (!limiter.allow(ip)) return sendJson(res, 429, { error: 'rate_limited', message: 'Too many attempts; wait a minute.' });

    const sess = currentSession(req);
    if (!sess) return sendJson(res, 401, { error: 'no_session', message: 'Sign in first.' });

    let body;
    try { body = JSON.parse(await readBody(req)); }
    catch (err) { return sendJson(res, err.status || 400, { error: 'bad_request', message: 'Body must be JSON.' }); }

    const now = nowFn();
    // §8: the cutoff is exact. Refused rather than stored, so nobody is left believing
    // they are in.
    if (now >= cfg.protocol.cutoff_ms) {
      return sendJson(res, 409, {
        error: 'closed',
        message: `Submissions closed at ${cfg.protocol.submission_cutoff_utc}.`,
        phase: phaseOf(cfg, store, now),
      });
    }

    let admitted;
    try { admitted = assertAdmissible(body?.ciphertext, cfg.protocol); }
    catch (err) {
      if (err instanceof CiphertextError) return sendJson(res, 400, { error: 'bad_ciphertext', message: err.message });
      throw err;
    }

    const existing = store.getSubmission(sess.local_id);
    if (existing) {
      return sendJson(res, 409, {
        error: 'already_submitted',
        message: 'You have already sealed a number. A submission is final by design.',
        received_at: existing.received_at,
      });
    }

    const stored = store.insertSubmission(sess.local_id, body.ciphertext.trim(), now);
    if (!stored.stored) return sendJson(res, 409, { error: 'already_submitted', message: 'One submission per player.' });

    // §4: mirrored into the repository as it arrives. Ciphertexts are safe to publish,
    // and a third-party timestamp is what stops a submission being quietly dropped later.
    const record = {
      local_id: sess.local_id,
      ciphertext: body.ciphertext.trim(),
      received_at: stored.received_at,
      target_round: admitted.round,
      chain_hash: admitted.chainHash,
    };
    const repoPath = `events/submissions/${sess.local_id}.json`;
    const content = JSON.stringify(record, null, 2) + '\n';
    writeLocal(cfg.root, repoPath, content);
    mirror.enqueue(repoPath, content, `submission from local_id ${sess.local_id}`);

    log.info?.(`[submit] local_id ${sess.local_id} accepted at ${stored.received_at}`);
    const s = pushStatus();
    return sendJson(res, 201, { ok: true, local_id: sess.local_id, received_at: stored.received_at, status: s });
  }

  // ---- GET /api/result ----------------------------------------------------
  //
  // A composed VIEW, not the artefact. results.json holds exactly what generate.js
  // produces, so that it reproduces byte for byte with no carve-out (§4.3); the derived
  // statistics and the Pantheon sync outcome are computed or recorded elsewhere and
  // joined on here, because the UI wants all three in one payload. Anyone verifying the
  // draw should use the files, not this.
  function syncOutcome() {
    const stored = store.get(KEY_SYNC);
    if (stored) return stored;
    // Restored onto a fresh database after a completed draw: fall back to the published
    // file, the same way phaseOf trusts results.json over the table.
    const f = path.join(cfg.root, 'events', 'sync.json');
    if (fs.existsSync(f)) {
      try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { /* report as unknown */ }
    }
    return null;
  }

  function result(res) {
    const stored = store.get(KEY_RESULT);
    if (stored) {
      const stats = stored.stats || computeStats(stored.seating, cfg.roster.players);
      return sendJson(res, 200, { ...stored, stats, pantheon_sync: syncOutcome() });
    }
    const p = path.join(cfg.root, 'results.json');
    if (fs.existsSync(p)) {
      const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
      return sendJson(res, 200, {
        ...parsed,
        stats: computeStats(parsed.seating, cfg.roster.players),
        pantheon_sync: syncOutcome(),
      });
    }
    return sendJson(res, 404, { error: 'not_yet', phase: phaseOf(cfg, store, nowFn()) });
  }

  // ---- /admin -------------------------------------------------------------
  //
  // Read-only, by design. §9 keeps the finalisation job off HTTP so that nothing an
  // outsider can poke may trigger, retry or re-time the draw; a button here would give
  // that away for a convenience nobody needs, since the organiser is already on the box
  // when they run tools/new-round.js.
  function adminAuthorised(req, url) {
    if (!adminToken) return false;
    const supplied = url.searchParams.get('token') || parseCookies(req.headers.cookie)[ADMIN_COOKIE];
    if (typeof supplied !== 'string' || supplied.length !== adminToken.length) return false;
    // Constant time, so the page cannot be used as an oracle for guessing the token.
    return crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(adminToken));
  }

  function admin(req, res, url) {
    if (!adminAuthorised(req, url)) {
      // 404, not 401: an unauthenticated probe learns nothing, not even that the page
      // is here. The organiser has the link; nobody else needs to know it exists.
      return send(res, 404, 'Not found', { 'content-type': 'text/plain; charset=utf-8' });
    }
    const model = collect({
      cfg, store, status: status(), syncOutcome: syncOutcome(),
      isStub, mirror, publicDir, now: nowFn(),
      production: process.env.NODE_ENV === 'production',
    });
    if (url.pathname === '/admin/data.json') return sendJson(res, 200, model);

    const headers = {
      'content-type': 'text/html; charset=utf-8',
      // Nothing here loads anything, and nothing here should ever be framed or indexed.
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
      'referrer-policy': 'no-referrer',
      'x-robots-tag': 'noindex, nofollow',
    };
    // Move the token out of the URL on first use, so it stops being in the address bar,
    // in the history, and in any referrer.
    if (url.searchParams.get('token')) {
      headers['set-cookie'] =
        `${ADMIN_COOKIE}=${adminToken}; HttpOnly; SameSite=Strict; Path=/admin; Max-Age=43200` +
        (secureCookie ? '; Secure' : '');
    }
    return send(res, 200, render(model), headers);
  }

  // ---- static -------------------------------------------------------------
  function serveFile(res, abs) {
    let data;
    try { data = fs.readFileSync(abs); }
    catch { return send(res, 404, 'Not found', { 'content-type': 'text/plain; charset=utf-8' }); }
    send(res, 200, data, {
      'content-type': MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'no-store',
    });
  }

  const DATA_FILES = new Set(['protocol.json', 'roster.json', 'schedule_template.json']);

  const server = http.createServer(async (req, res) => {
    const ip = req.socket.remoteAddress || 'unknown';
    let url;
    try { url = new URL(req.url, 'http://localhost'); }
    catch { return send(res, 400, 'Bad request', { 'content-type': 'text/plain' }); }
    const p = decodeURIComponent(url.pathname);

    try {
      if (req.method === 'POST' && p === '/api/session') return await session(req, res, ip);
      if (req.method === 'POST' && p === '/api/submit') return await submit(req, res, ip);

      if (req.method === 'DELETE' && p === '/api/session') {
        store.deleteSession(parseCookies(req.headers.cookie)[COOKIE]);
        return sendJson(res, 200, { ok: true }, { 'set-cookie': `${COOKIE}=; HttpOnly; Path=/; Max-Age=0` });
      }

      if (req.method === 'GET' && p === '/api/status') return sendJson(res, 200, status());

      if (req.method === 'GET' && (p === '/admin' || p === '/admin/data.json')) {
        // Rate-limited like sign-in: the token is the only thing in front of a roster
        // and a submission timeline.
        if (!limiter.allow(`admin:${ip}`, nowFn())) {
          return send(res, 429, 'Too many requests', { 'content-type': 'text/plain; charset=utf-8' });
        }
        return admin(req, res, url);
      }

      /**
       * DEV ONLY. PANTHEON-INTEGRATION.md §2 has the browser authenticate against Frey
       * directly, so that this app never handles a Pantheon password. That is the real
       * path and it is unchanged. But with no Frey to reach, the sign-in stage could
       * not be built or exercised at all, so the stub exposes this stand-in.
       *
       * It exists only when the Pantheon adapter is the stub, and it refuses outright
       * under NODE_ENV=production — a password-accepting endpoint on the real
       * deployment is precisely the thing §2 is written to prevent.
       */
      if (req.method === 'POST' && p === '/api/dev-authorize') {
        if (!isStub || process.env.NODE_ENV === 'production') {
          return sendJson(res, 404, { error: 'not_found' });
        }
        let body;
        try { body = JSON.parse(await readBody(req)); }
        catch { return sendJson(res, 400, { error: 'bad_request' }); }
        const personId = Number(body?.person_id);
        const token = pantheon.accounts?.get(personId);
        if (!token) return sendJson(res, 401, { error: 'bad_credentials', message: 'Pantheon did not recognise that email and password.' });
        return sendJson(res, 200, { person_id: personId, auth_token: token });
      }

      if (req.method === 'GET' && p === '/api/me') {
        const sess = currentSession(req);
        if (!sess) return sendJson(res, 401, { error: 'no_session' });
        const who = cfg.byLocalId.get(sess.local_id);
        return sendJson(res, 200, {
          local_id: sess.local_id,
          title: who?.title,
          submitted: Boolean(store.getSubmission(sess.local_id)),
        });
      }

      if (req.method === 'GET' && p === '/api/result') return result(res);

      if (req.method === 'GET' && p === '/api/events') {
        hub.add(res, req);
        hub.broadcast(status());
        return;
      }

      if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'method_not_allowed' });

      // The frozen public files, served straight from data/ so the page and the
      // repository cannot drift apart.
      const dataName = p.replace(/^\//, '');
      if (DATA_FILES.has(dataName)) return serveFile(res, path.join(cfg.dataDir, dataName));

      // The archived attempts (§8). Public by construction: every ciphertext in there is
      // safe to publish, and the whole point of keeping them is that anyone can check
      // the void was honest. Read-only, and confined to events/rounds/ — the containment
      // check is belt and braces on top of the URL parser, which already folds away dot
      // segments before this sees the path.
      if (req.method === 'GET' && p.startsWith(`/${ROUNDS_DIR}/`)) {
        const roundsRoot = path.join(cfg.root, ROUNDS_DIR);
        const target = path.join(cfg.root, p.slice(1));
        if (target.startsWith(roundsRoot + path.sep) && fs.existsSync(target) && fs.statSync(target).isFile()) {
          return serveFile(res, target);
        }
        return send(res, 404, 'Not found', { 'content-type': 'text/plain; charset=utf-8' });
      }

      // SPA: one route. Any non-asset path renders the app, which derives its stage.
      const abs = path.join(publicDir, p);
      if (abs.startsWith(publicDir + path.sep) && fs.existsSync(abs) && fs.statSync(abs).isFile()) {
        return serveFile(res, abs);
      }
      const index = path.join(publicDir, 'index.html');
      if (fs.existsSync(index)) return serveFile(res, index);
      return send(res, 404, 'Not found', { 'content-type': 'text/plain; charset=utf-8' });
    } catch (err) {
      log.error?.(`[server] ${req.method} ${p}: ${err.stack || err.message}`);
      return sendJson(res, 500, { error: 'internal' });
    }
  });

  server.on('close', () => {
    // Both are paced timers now, so they are stopped by calling what pace() returned.
    healthTimer?.();
    statusTimer?.();
    hub.close();
    if (!opts.store) store.close();
  });

  return { server, cfg, store, mirror, hub, pantheon, status, pushStatus, refreshDrand };
}

module.exports = { createServer, RateLimiter, COOKIE, parseCookies };

if (require.main === module) {
  const port = Number(process.env.PORT || 8080);
  const host = process.env.HOST || '127.0.0.1'; // Caddy terminates TLS in front (§10)
  const { server, cfg, pantheon } = createServer();
  server.listen(port, host, () => {
    console.info(`[server] listening on http://${host}:${port}`);
    console.info(`[server] event ${cfg.roster.pantheon_event_id}, ${cfg.protocol.total_slots} slots, ` +
      `quorum ${cfg.protocol.quorum}, round ${cfg.protocol.target_round}, cutoff ${cfg.protocol.submission_cutoff_utc}`);
    console.info(`[server] pantheon: ${pantheon.constructor.name}`);
    // The browser is told where Frey is, and then calls it itself. A loopback or
    // private address works from here and from nowhere a player will ever be, and the
    // symptom is a sign-in page reporting a wrong password. Say it at boot rather than
    // letting twelve people discover it at once.
    if (pantheon.constructor.name !== 'StubPantheon' && freyPublicUrlIsLocal(cfg.runtime)) {
      console.warn(
        `[server] WARNING: browsers are told Frey is at ${freyPublicUrl(cfg.runtime)}, which is ` +
        'not an address they can reach. Set pantheon.frey_public_url in data/runtime.json ' +
        'to the URL players resolve, and add that origin to the CSP connect-src of the proxy.'
      );
    }
    console.info(
      process.env.ADMIN_TOKEN
        ? `[server] admin dashboard at /admin?token=… (RUNBOOK C/D)`
        : '[server] admin dashboard disabled (set ADMIN_TOKEN to enable /admin)'
    );
  });
}
