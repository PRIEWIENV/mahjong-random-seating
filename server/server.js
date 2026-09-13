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

const { load, loadEnvFile } = require('./config');
const { Store } = require('./db');
const { assertAdmissible, CiphertextError } = require('./ciphertext');
const { Mirror, writeLocal } = require('./mirror');
const { phaseOf, stateIsFromAnotherRound, refuseStaleState, KEY_RESULT, KEY_ROLL, KEY_SYNC, KEY_TICK } = require('./finalise');
const { startScheduler } = require('./schedule');
const { EventHub } = require('./events');
const { Drand } = require('./drand');
const { createPantheon } = require('./pantheon');
const { readIndex, attemptsInThisRun, ROUNDS_DIR } = require('./rounds');
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
  // The database has to be about the round that is frozen, or the first page a player
  // opens is the previous event's result. Refused here rather than reported later: this
  // runs before the socket is listening, so it is a deployment that did not start rather
  // than one that started wrong.
  const elsewhere = stateIsFromAnotherRound(cfg, store);
  if (elsewhere) throw refuseStaleState(elsewhere);
  const mirror = opts.mirror || new Mirror(process.env, log);
  const pantheon = opts.pantheon || createPantheon(cfg, process.env);
  const drand = opts.drand || new Drand(cfg.protocol.chain_hash, cfg.runtime.drand.mirrors);
  const hub = opts.hub || new EventHub({ heartbeatMs: cfg.runtime.server.sse_heartbeat_ms });
  const publicDir = opts.publicDir || path.join(cfg.root, 'public');
  const limiter = new RateLimiter(opts.rateLimit ?? cfg.runtime.server.rate_limit_per_minute, opts.rateWindowMs ?? 60_000);
  const nowFn = opts.now || (() => Date.now());
  // Sessions outlive a round on purpose — §8 changes the round, not who the players are
  // — so nothing else ever removes an expired one. getSession drops a row when that same
  // token comes back, which by definition never happens for a browser that does not
  // return. The method was here with no caller at all; a restart is its moment.
  store.purgeExpiredSessions(nowFn());
  const secureCookie = opts.secureCookie ?? process.env.NODE_ENV === 'production';
  /**
   * Whether a request came over TLS. This process never terminates TLS itself; whatever
   * is in front does, and both configurations in deploy/ say so in X-Forwarded-Proto.
   *
   * Read whether or not trust_proxy is set, because the only party a forged value can
   * hurt is the one forging it: claim https over http and the browser drops the cookie
   * you were issued; claim http over https and you are refused. Nothing here is decided
   * for anyone else by it.
   */
  function overTls(req) {
    const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
    return proto === 'https';
  }
  // The dashboard exists only when a token is configured. Unset means the route is not
  // there at all, rather than there and asking for a password: an organiser who never
  // set one has not accidentally published a roster and a submission timeline.
  const adminToken = opts.adminToken ?? process.env.ADMIN_TOKEN ?? null;
  const isStub = pantheon.constructor?.name === 'StubPantheon';

  // ---- the event's name, fetched once ------------------------------------
  /**
   * What Mimir calls this event, shown in the page title (UI-SPEC §1).
   *
   * A label, not a parameter: no value it can take changes who sits where, so it is
   * read from Pantheon rather than frozen, and a deployment that cannot reach Mimir
   * falls back to the generic title rather than failing. runtime.json wins when it is
   * set, because an operator who typed a name meant it.
   *
   * Fetched on a slow retry rather than per request: twelve waiting browsers poll this
   * status, and an event's name does not change during a draw.
   */
  let eventTitle = cfg.runtime.pantheon.event_title || null;
  let titleTimer = null;
  async function refreshEventTitle() {
    if (cfg.runtime.pantheon.event_title) return; // configured; nothing to ask
    const eventId = cfg.roster.pantheon_event_id;
    if (!Number.isFinite(eventId) || typeof pantheon.getEventTitle !== 'function') return;
    try {
      const title = await pantheon.getEventTitle(eventId);
      if (title) {
        eventTitle = title;
        if (titleTimer) { clearInterval(titleTimer); titleTimer = null; }
      }
    } catch (err) {
      // Never fatal, and never noisy: the page works without a name.
      log.warn?.(`[server] could not read the event name from Pantheon: ${err.message}`);
    }
  }

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

  if (opts.eventTitlePollMs !== 0) {
    refreshEventTitle();
    // A Pantheon that is down at boot comes back; the name appears when it does.
    titleTimer = setInterval(refreshEventTitle, opts.eventTitlePollMs ?? 5 * 60_000);
    titleTimer.unref?.();
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
  /**
   * One line per ciphertext held: who sent it, when, and its SHA-256.
   *
   * §9 forbids exposing what a player submitted before the reveal. This does not: the
   * ciphertext itself is public the moment it arrives — mirrored to the repository with
   * a commit time, precisely so the organiser cannot drop one later (PROTOCOL.md §5) —
   * and a digest of a public value discloses strictly less than the value. Nothing here
   * helps anyone open anything early; only the beacon does that.
   *
   * What it buys is that a player can watch their own envelope land and keep the
   * fingerprint of it, rather than being told "9 of 12" and taking our word for the
   * rest. The digests are also what the published roll is built from, so twelve people
   * comparing them are comparing the same evidence.
   *
   * Cached by arrival time: twelve browsers poll this, and a ciphertext never changes
   * once stored.
   */
  const digestCache = new Map(); // local_id -> {received_ms, digest}
  function submissionDigests() {
    const rows = store.listSubmissions();
    return rows.map((r) => {
      const hit = digestCache.get(r.local_id);
      let digest = hit && hit.received_ms === r.received_ms ? hit.digest : null;
      if (!digest) {
        digest = crypto.createHash('sha256').update(r.ciphertext, 'utf8').digest('hex');
        digestCache.set(r.local_id, { received_ms: r.received_ms, digest });
      }
      return { local_id: r.local_id, digest, received_at: r.received_at };
    });
  }

  /** What has been published about the roll: digest, when, and whether it is anchored. */
  function rollStatus() {
    const r = store.get(KEY_ROLL);
    if (!r) return null;
    return {
      digest: r.digest,
      published_at: r.published_at,
      submitted_count: (r.local_ids || []).length,
      // The proof itself is a file to download, not something to put in a status
      // payload. This says only whether it exists and who witnessed it.
      anchored: Boolean(r.ots && !r.ots.failed),
      calendars: r.ots && !r.ots.failed ? r.ots.calendars : null,
    };
  }

  /**
   * Whether the draw is merely pending or actually late.
   *
   * This process never draws. server/finalise.js does, on a timer (deploy/README.md
   * §3), so a gap between the beacon landing and the result appearing is normal: up to
   * one timer interval of it. Past that, the page must stop animating and say what is
   * true, because the two states look identical from a chair and have opposite
   * meanings. The outcome is not in doubt either way — the snapshot was frozen at the
   * cutoff — but "being computed" and "nobody is computing it" are not the same news.
   */
  function drawStatus(phase, now) {
    if (phase !== 'awaiting_round') return null;
    const dueMs = cfg.protocol.target_round_ms;
    if (!Number.isFinite(dueMs) || now < dueMs) return null;
    const secondsLate = Math.floor((now - dueMs) / 1000);
    // Two intervals, not one. The first covers a timer that fired a moment before the
    // beacon landed, so the earliest tick that could possibly have drawn is a whole
    // interval away. The second covers the job's own work, which is a dozen tlock
    // decryptions and a round trip to Pantheon. Past both, this is not a schedule, it
    // is a silence.
    const grace = cfg.runtime.server.finalise_interval_seconds * 2;
    return {
      round_due_utc: cfg.protocol.target_round_utc,
      seconds_late: secondsLate,
      grace_seconds: grace,
      overdue: secondsLate > grace,
    };
  }

  function status() {
    const submitted = store.submittedLocalIds();
    const previous = attemptsInThisRun(readIndex(cfg));
    const now = nowFn();
    const phase = phaseOf(cfg, store, now);
    return {
      phase,
      // Null until the beacon is out and the phase has not moved; see drawStatus.
      draw: drawStatus(phase, now),
      submitted_count: submitted.length,
      quorum: cfg.protocol.quorum,
      total_slots: cfg.protocol.total_slots,
      // Who, not what (§9). The titles come from the frozen roster, never from a payload.
      submitted_local_ids: submitted,
      // The same set with the fingerprint of each sealed envelope. See submissionDigests:
      // a digest of an already-public ciphertext, never its contents.
      submissions: submissionDigests(),
      players: cfg.roster.players.map((p) => ({ local_id: p.local_id, title: p.title })),
      cutoff_utc: cfg.protocol.submission_cutoff_utc,
      // Submissions close at cutoff_utc; the beacon that opens them arrives
      // reveal_gap_seconds later, at target_round_utc. The page needs both, because
      // the interval between them is not dead time: it is when the roll of who
      // submitted is published, while the outcome is still unknowable (PROTOCOL.md §9).
      target_round_utc: cfg.protocol.target_round_utc,
      // The roll, once it has been taken. Its digest is the value twelve people are
      // asked to compare with each other while the beacon does not yet exist
      // (PROTOCOL.md §9); an anchor nobody can check against anybody is not evidence.
      roll: rollStatus(),
      reveal_gap_seconds: cfg.protocol.reveal_gap_seconds,
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
      // Where the ciphertexts, the roll and the result are published (PROTOCOL.md §5).
      // Public by construction — the whole argument rests on anyone being able to fetch
      // it — and the one thing the result page needs in order to tell a player how to
      // check the draw, which it could not say before. Null when mirroring is off, and
      // then the page names no repository rather than inventing one.
      mirror_repo: mirror?.enabled ? mirror.repo : null,
      // Tells the sign-in stage which path to use. "stub" means no real Frey is
      // reachable and the dev stand-in is in play; it can never be true in production.
      auth_mode: isStub ? 'stub' : 'pantheon',
      // What Mimir calls this event, so the page says which draw this is. Null until
      // Pantheon answers, and null forever where it cannot be reached — the page then
      // shows its generic title rather than a blank.
      event_title: eventTitle,
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
      // The round now open is itself in `previous` from the moment it is declared void,
      // so counting it would title the screen announcing that attempt 2 failed "attempt 3".
      attempt: previous.filter((a) => a.target_round !== cfg.protocol.target_round).length + 1,
      previous_rounds: previous,
      // UI-SPEC §5: the countdown is driven by this, so it never drifts. The same
      // instant the phase and the lateness above were read at, or a page could show a
      // countdown and a lateness that disagree by a tick.
      server_time_utc: new Date(now).toISOString(),
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

    // In production the cookie below is marked Secure, and a browser will not keep a
    // Secure cookie that arrived over http. The old behaviour was to issue it anyway:
    // sign-in answered 200, the page moved on, and the first thing to fail was the
    // submission, after the player had sealed a number, with a 401 they did nothing to
    // cause. That is what the first production deployment hit, on a domain with no
    // certificate yet. Refused here, before Pantheon is asked anything, with the fix in
    // the message.
    if (secureCookie && !overTls(req)) {
      return sendJson(res, 400, {
        error: 'plain_http',
        message: 'This page reached the draw server over plain http. In production the sign-in ' +
          'cookie is marked Secure and no browser will keep it, so sign in at https:// instead. ' +
          'If TLS is already in front of this server, the proxy is not sending X-Forwarded-Proto: https.',
      });
    }

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
      production: secureCookie,
      overTls: overTls(req),
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
  const ROLL_FILES = new Set(['snapshot.json', 'snapshot.json.ots']);

  /**
   * Who to charge a request to, for rate limiting.
   *
   * Behind a reverse proxy every connection arrives from 127.0.0.1, so the socket
   * address makes the per-IP limiter one shared allowance — twelve people signing in at
   * once can exhaust it between them. X-Forwarded-For fixes that and is also a header
   * any caller can invent, so it is believed only when runtime.json says a proxy is in
   * front (§4.2).
   *
   * The RIGHTMOST entry is the one to take. Both proxies in deploy/ append the address
   * they actually saw to whatever the client sent — nginx's $proxy_add_x_forwarded_for
   * is literally "$http_x_forwarded_for, $remote_addr" — so a forged prefix ends up to
   * the left of the truth and taking the last element steps over it.
   */
  const trustProxy = opts.trustProxy ?? cfg.runtime.server.trust_proxy;
  function clientIp(req) {
    if (trustProxy) {
      const fwd = req.headers['x-forwarded-for'];
      if (typeof fwd === 'string' && fwd.trim() !== '') {
        const last = fwd.split(',').pop().trim();
        if (last) return last;
      }
    }
    return req.socket.remoteAddress || 'unknown';
  }

  const server = http.createServer(async (req, res) => {
    const ip = clientIp(req);
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

      // The roll and its OpenTimestamps proof, served from the same origin as the page
      // that names them (PROTOCOL.md §9). A player is asked to compare a digest during
      // the interval; these are what they check it against, and what they keep if they
      // would rather not depend on the organiser's repository still being there.
      // Public by construction: every ciphertext in the roll is already public, and the
      // point of the file is that anybody can hold a copy.
      if (ROLL_FILES.has(dataName)) {
        const f = path.join(cfg.root, 'events', dataName);
        if (!fs.existsSync(f)) return send(res, 404, 'Not found', { 'content-type': 'text/plain; charset=utf-8' });
        return serveFile(res, f);
      }

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
    if (titleTimer) clearInterval(titleTimer);
    hub.close();
    if (!opts.store) store.close();
  });

  return { server, cfg, store, mirror, hub, pantheon, status, pushStatus, refreshDrand };
}

module.exports = { createServer, RateLimiter, COOKIE, parseCookies };

/**
 * Where to listen: a flag if given, else the environment, else the default.
 *
 * The flag exists because 8080 is a popular port and "something else already has it" is
 * not a reason to go and edit a file — least of all on the day, on a box that is also
 * running Pantheon. `--port 9000` is the shape people reach for first.
 */
function listenOn(argv = process.argv.slice(2), env = process.env) {
  // A flag that is present takes whatever follows it, including something that looks
  // like another flag. Skipping those and quietly falling back to the default would
  // mean `--port -1` starts on 8080, which is the opposite of what was asked for.
  const flag = (...names) => {
    for (const n of names) {
      const i = argv.indexOf(n);
      if (i > -1) return argv[i + 1] ?? '';
      const inline = argv.find((a) => a.startsWith(`${n}=`));
      if (inline) return inline.slice(n.length + 1);
    }
    return undefined;
  };
  const rawPort = flag('--port', '-p') ?? env.PORT ?? '8080';
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`--port must be a whole number between 1 and 65535, got ${JSON.stringify(rawPort)}`);
  }
  // Caddy or nginx terminates TLS in front (§10), so loopback is the right default and
  // 0.0.0.0 is a deliberate act.
  return { port, host: flag('--host') ?? env.HOST ?? '127.0.0.1' };
}

module.exports.listenOn = listenOn;

// Long enough for a submission that is already in flight to finish writing, short
// enough that nobody standing at the terminal concludes it has hung.
const SHUTDOWN_GRACE_MS = 3000;

/**
 * Stop, on the first Ctrl+C.
 *
 * `server.close()` refuses to call back until every open connection has ended, and the
 * waiting stage holds a stream that by design never ends (server/events.js). Those
 * streams are released by `hub.close()` — which runs on the server's own 'close' event,
 * the very event that is waiting for them. The two waited for each other, so Ctrl+C did
 * nothing at all: a handler was installed, which also cost us Node's default of exiting
 * on the signal, and the only ways out were Ctrl+Break and the task manager. The same
 * cycle held for SIGTERM, so `systemctl restart` sat there until systemd lost patience
 * and sent SIGKILL ninety seconds later.
 *
 * Ending the streams first is therefore not tidiness, it is what breaks the cycle. Then
 * the sockets they leave behind: a browser keeps a spare connection open, and an idle
 * keep-alive socket holds the close open exactly as firmly as a live request does.
 *
 * Whatever is still attached after the grace period is not going to finish on its own,
 * and somebody pressing Ctrl+C has not asked to wait for it.
 *
 * The draw child, if one is mid-flight, is deliberately left alone — a half-published
 * round is worse than an orphaned process, and server/schedule.js says why.
 *
 * The mirror queue is waited for, though, and that requirement arrived with the fix
 * above. A ciphertext is accepted, stored, and queued for the repository, and the push
 * happens a moment later; while stopping took forever the queue always emptied on the
 * way out by accident. Now that it takes milliseconds, a submission taken seconds before
 * a restart would be durable locally and absent from the repository — and PROTOCOL.md §5
 * is exactly the claim that it is not: public the moment it arrives, timestamped by
 * somebody the organiser does not control.
 */
function shutdown(o) {
  const { server, hub, scheduler, mirror, log = console, graceMs = SHUTDOWN_GRACE_MS, exit = process.exit } = o;
  let grace = null;
  let done = false;
  let socketsClosed = false;
  let queueSettled = false;
  // Both paths below can arrive, and on the second signal `close` calls back with an
  // ERR_SERVER_NOT_RUNNING it would rather we ignored. One exit, whoever gets here.
  const finish = () => {
    if (done) return;
    done = true;
    if (grace) clearTimeout(grace);
    exit(0);
  };
  const finishIfReady = () => { if (socketsClosed && queueSettled) finish(); };

  scheduler?.stop();
  hub?.close();
  server.close(() => { socketsClosed = true; finishIfReady(); });
  server.closeIdleConnections?.();

  if (typeof mirror?.drain === 'function') {
    // Bounded by the same grace: an unreachable GitHub must not be able to hold the
    // process open. What is left is named, because the ciphertexts are still in var/ and
    // under events/, so an operator who is told can push them by hand.
    Promise.resolve(mirror.drain(graceMs))
      .then((ok) => {
        if (ok === false) {
          log.warn?.('[server] some submissions were still queued for the repository and did not go out; ' +
            'they are on disk under events/submissions — mirror them by hand (PROTOCOL.md §5)');
        }
      })
      .catch((err) => log.warn?.(`[server] the mirror queue could not be settled: ${err.message}`))
      .then(() => { queueSettled = true; finishIfReady(); });
  } else {
    queueSettled = true;
  }

  grace = setTimeout(() => {
    log.warn?.(`[server] still connected after ${graceMs}ms; dropping what is left and exiting`);
    server.closeAllConnections?.();
    finish();
  }, graceMs);
  // If the sockets do go on their own, `finish` gets there first and this timer must not
  // be the reason the process is still running.
  grace.unref?.();
  return grace;
}

module.exports.shutdown = shutdown;

if (require.main === module) {
  // Before anything reads the environment, `listenOn` included. deploy/README.md §2 has
  // the operator put the deployment's whole configuration in .env, and until now only
  // the systemd unit was reading it.
  const envFile = loadEnvFile();
  let port;
  let host;
  try {
    ({ port, host } = listenOn());
  } catch (err) {
    console.error(`[server] ${err.message}`);
    process.exit(2);
  }
  let boot;
  try {
    boot = createServer();
  } catch (err) {
    // A refusal meant for whoever is holding the terminal, not a crash. The message is
    // four lines that say what to run; a stack trace would bury them.
    if (!err.operator) throw err;
    console.error(`[server] ${err.message}`);
    process.exit(2);
  }
  const { server, cfg, pantheon, store, hub, mirror } = boot;
  let scheduler = null;
  let stopping = false;
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      // A second press means the first one did not look to the operator like it worked.
      // Take them at their word; 130 is what a shell reports for a program killed by
      // Ctrl+C, which is what this now is.
      if (stopping) {
        console.warn('[server] second signal — exiting now');
        process.exit(130);
      }
      stopping = true;
      console.info('[server] stopping');
      shutdown({ server, hub, scheduler, mirror, log: console });
    });
  }
  server.on('error', (err) => {
    // The one failure an organiser will actually hit, and a raw stack trace answers
    // none of the three questions it raises.
    if (err.code === 'EADDRINUSE') {
      console.error(
        `[server] port ${port} is already in use on ${host}. Something else has it — on a box ` +
        'that also runs Pantheon that is likely. Choose another: node server/server.js --port 9000, ' +
        'or set PORT in .env. Remember to point the reverse proxy at the same number.');
      process.exit(1);
    }
    if (err.code === 'EACCES') {
      console.error(`[server] not allowed to listen on port ${port}. Ports below 1024 need ` +
        'privileges; put the app on a high port and let the reverse proxy hold 80 and 443.');
      process.exit(1);
    }
    throw err;
  });
  server.listen(port, host, () => {
    console.info(`[server] listening on http://${host}:${port}`);
    console.info(`[server] event ${cfg.roster.pantheon_event_id}, ${cfg.protocol.total_slots} slots, ` +
      `quorum ${cfg.protocol.quorum}, round ${cfg.protocol.target_round}, cutoff ${cfg.protocol.submission_cutoff_utc}`);
    console.info(`[server] pantheon: ${pantheon.constructor.name}`);
    // Said out loud either way. A deployment whose .env was never read looks entirely
    // healthy from here — it serves, it accepts submissions, it mirrors nothing — and
    // this line is the only place that difference is visible before the event.
    console.info(envFile
      ? `[server] configuration read from ${path.relative(cfg.root, envFile)}`
      : '[server] no .env found; using the environment as given');
    // The browser is told where Frey is, and then calls it itself. A loopback or
    // private address works from here and from nowhere a player will ever be, and the
    // symptom is a sign-in page reporting a wrong password. Say it at boot rather than
    // letting twelve people discover it at once.
    // Listening only on loopback means something is proxying, and then every request
    // carries the proxy's address. The limiter is not broken so much as scoped wrong:
    // one allowance for the whole event instead of one per player.
    const loopback = host === '127.0.0.1' || host === '::1' || host === 'localhost';
    if (loopback && !cfg.runtime.server.trust_proxy) {
      console.warn(
        `[server] note: rate limiting is by source address, and behind a proxy every request ` +
        `looks like ${host}. Set server.trust_proxy in data/runtime.json once the proxy sets ` +
        'X-Forwarded-For, or the limit of ' +
        `${cfg.runtime.server.rate_limit_per_minute}/minute is shared by everybody.`
      );
    }
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
    // Serving the page and running the draw are two different programs. This one starts
    // the other on a timer unless told not to, because the failure it replaces is
    // silent: the countdown reaches zero and nothing happens.
    if (cfg.runtime.server.run_finalise) {
      scheduler = startScheduler({ cfg, log: console });
      const every = cfg.runtime.server.finalise_interval_seconds;
      console.info(`[server] running server/finalise.js every ${every}s (server.run_finalise)`);
    } else if (!store.get(KEY_TICK)) {
      // Switched off and never run: something else is supposed to be doing it, and so
      // far nothing has. The key is written by every run of the job, so this clears
      // itself as soon as whatever it is fires once.
      console.warn(
        '[server] WARNING: server.run_finalise is off and server/finalise.js has never ' +
        'run against this database. Nothing will draw. Either set it back to true in ' +
        'data/runtime.json, or make sure the schedule you set up elsewhere is running.'
      );
    }
  });
}
