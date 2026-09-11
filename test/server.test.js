'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');

const { createServer, listenOn, shutdown } = require('../server/server');
const { load } = require('../server/config');
const { Store } = require('../server/db');
const { StubPantheon } = require('../server/pantheon');
const { makeDataDir, fakeCiphertext, cleanup, ROOT } = require('./helpers');

const QUIET = { info() {}, warn() {}, error() {} };

async function boot(opts = {}) {
  const fx = makeDataDir({ protocol: opts.protocol, runtime: opts.runtime });
  const cfg = load({ dataDir: fx.dataDir });
  cfg.root = fx.dir; // keep events/ out of the working tree
  const store = new Store(':memory:');
  const mirrored = [];
  const mirror = { enabled: false, enqueue: (p, c) => mirrored.push({ p, c }), flush: async () => {}, drain: async () => true };
  const pantheon = opts.pantheon || new StubPantheon({
    roster: fx.roster,
    eventTitle: opts.eventTitle,
    // A genuinely valid Pantheon account that is NOT in the event — UI-SPEC §3's
    // second failure message only exists if the fake can represent this case.
    extraAccounts: [{ person_id: 9999, auth_token: 'token-9999' }],
  });
  const { server, hub } = createServer({
    cfg, store, mirror, pantheon,
    publicDir: path.join(ROOT, 'public'),
    now: opts.now, rateLimit: opts.rateLimit, trustProxy: opts.trustProxy,
    drand: { latest: async () => ({ round: 123 }) },
    drandPollMs: 0,
    eventTitlePollMs: opts.eventTitlePollMs,
    log: opts.log || QUIET,
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const call = async (p, init = {}) => {
    const res = await fetch(base + p, init);
    return { status: res.status, headers: res.headers, body: await res.json().catch(() => null) };
  };
  const signIn = async (personId) => {
    const res = await fetch(base + '/api/session', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ person_id: personId, auth_token: `token-${personId}` }),
    });
    const body = await res.json().catch(() => null);
    const setCookie = res.headers.getSetCookie?.()[0];
    return { status: res.status, body, cookie: setCookie ? setCookie.split(';')[0] : null };
  };

  return {
    base, fx, cfg, store, mirrored, pantheon, hub, server, call, signIn,
    get: (p, cookie) => call(p, cookie ? { headers: { cookie } } : {}),
    submit: (cookie, ciphertext) => call('/api/submit', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      body: JSON.stringify({ ciphertext }),
    }),
    async close() {
      await new Promise((r) => server.close(r));
      store.close();
      cleanup(fx.dir);
    },
  };
}

const ct = (protocol) => fakeCiphertext(protocol.target_round, protocol.chain_hash);

/**
 * The Pantheon auth_token is password-equivalent (PROTOCOL.md §9): Frey derives it as
 * sha384(password + salt) and keeps accepting it until the password changes. So it may
 * be verified and then must vanish — no row, no log line, no response. This test uses a
 * token distinctive enough that a single grep over everything the server wrote settles
 * whether that held.
 */
test('the Pantheon token is verified and then exists nowhere', async () => {
  const lines = [];
  const capture = {
    info: (...a) => lines.push(a.join(' ')),
    warn: (...a) => lines.push(a.join(' ')),
    error: (...a) => lines.push(a.join(' ')),
  };
  const t = await boot({ log: capture });
  try {
  const personId = t.fx.roster.players[0].person_id;
  const SECRET = 'zzsha384-password-equivalent-do-not-keep-zz';
  t.pantheon.accounts.set(personId, SECRET);

  const res = await fetch(`${t.base}/api/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ person_id: personId, auth_token: SECRET }),
  });
  const body = await res.text();
  const cookie = res.headers.getSetCookie()[0];
  assert.equal(res.status, 200);

  // It was actually used, or the rest of this proves nothing.
  assert.ok(t.pantheon.calls.some(([m, id]) => m === 'verifyToken' && id === personId));

  // Not in the response, and not the cookie either.
  assert.ok(!body.includes(SECRET), 'the sign-in response echoed the token');
  assert.ok(!cookie.includes(SECRET), 'the session cookie is derived from the token');

  // Not in any log line.
  assert.ok(!lines.some((l) => l.includes(SECRET)), `a log line carried the token: ${lines.find((l) => l.includes(SECRET))}`);

  // Not in the database. Every table, not just sessions: a future column would be
  // caught here rather than by someone reading a backup.
  const tables = t.store.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
  for (const { name } of tables) {
    const rows = t.store.db.prepare(`SELECT * FROM "${name}"`).all();
    assert.ok(!JSON.stringify(rows).includes(SECRET), `table ${name} stored the token`);
  }

  // And the session still works, so none of the above was achieved by not signing in.
  const me = await t.get('/api/me', cookie.split(';')[0]);
  assert.equal(me.status, 200);
  assert.equal(me.body.local_id, t.fx.roster.players[0].local_id);
  } finally {
    // A failing assertion must not leave the listener open, or the runner hangs on the
    // handle instead of reporting which invariant broke.
    await t.close();
  }
});

// ---------------------------------------------------------------------------
// sign-in (§6, PANTHEON-INTEGRATION.md §2)
// ---------------------------------------------------------------------------

test('a registered account signs in and gets an httpOnly cookie', async () => {
  const s = await boot();
  const r = await s.signIn(1001);
  assert.equal(r.status, 200);
  assert.equal(r.body.local_id, 1);
  const setCookie = r.cookie;
  assert.ok(setCookie.startsWith('mjs_session='));
  await s.close();
});

test('the session cookie is httpOnly and SameSite=Strict', async () => {
  const s = await boot();
  const res = await fetch(s.base + '/api/session', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ person_id: 1001, auth_token: 'token-1001' }),
  });
  const raw = res.headers.getSetCookie()[0];
  assert.match(raw, /HttpOnly/i);
  assert.match(raw, /SameSite=Strict/i);
  await s.close();
});

test('wrong credentials and not-registered are DIFFERENT answers (UI-SPEC §3)', async () => {
  const s = await boot();
  const bad = await s.call('/api/session', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ person_id: 1001, auth_token: 'wrong' }),
  });
  assert.equal(bad.status, 401);
  assert.equal(bad.body.error, 'bad_credentials');
  assert.match(bad.body.message, /did not recognise/);

  // Valid Pantheon account, simply not in the event.
  const outsider = await s.signIn(9999);
  assert.equal(outsider.status, 403);
  assert.equal(outsider.body.error, 'not_registered');
  assert.match(outsider.body.message, /isn't registered for this event/);

  assert.notEqual(bad.body.message, outsider.body.message);
  await s.close();
});

test('an account in live Pantheon but not in the frozen roster is refused', async () => {
  // PANTHEON-INTEGRATION.md §2: the frozen check is what stops a roster edit made
  // after the freeze from quietly enlarging the field of twelve.
  const s = await boot();
  s.pantheon.registered.push({ person_id: 4242, title: 'Added later', local_id: 13 });
  s.pantheon.accounts.set(4242, 'token-4242');
  const r = await s.signIn(4242);
  assert.equal(r.status, 403);
  assert.equal(r.body.error, 'not_registered');
  await s.close();
});

test('an account in the frozen roster but removed from live Pantheon is refused', async () => {
  const s = await boot();
  s.pantheon.registered = s.pantheon.registered.filter((p) => p.person_id !== 1001);
  const r = await s.signIn(1001);
  assert.equal(r.status, 403);
  await s.close();
});

test('the server never receives a password field', async () => {
  // §2: "Do not let this app handle Pantheon passwords." Sending one must not help.
  const s = await boot();
  const r = await s.call('/api/session', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ person_id: 1001, email: 'a@b.c', password: 'hunter2' }),
  });
  assert.equal(r.status, 400, 'a password instead of an auth_token must not authenticate');
  await s.close();
});

// ---------------------------------------------------------------------------
// /api/me and /api/submit
// ---------------------------------------------------------------------------

test('/api/me needs a session and reports submitted state', async () => {
  const s = await boot();
  assert.equal((await s.get('/api/me')).status, 401);
  const { cookie } = await s.signIn(1003);
  const me = await s.get('/api/me', cookie);
  assert.equal(me.status, 200);
  assert.deepEqual(me.body, { local_id: 3, title: s.fx.roster.players[2].title, submitted: false });

  assert.equal((await s.submit(cookie, ct(s.cfg.protocol))).status, 201);
  assert.equal((await s.get('/api/me', cookie)).body.submitted, true);
  await s.close();
});

test('submitting without a session is refused', async () => {
  const s = await boot();
  const r = await s.submit(null, ct(s.cfg.protocol));
  assert.equal(r.status, 401);
  await s.close();
});

test('a second submission from the same player is refused', async () => {
  const s = await boot();
  const { cookie } = await s.signIn(1005);
  assert.equal((await s.submit(cookie, ct(s.cfg.protocol))).status, 201);
  const second = await s.submit(cookie, ct(s.cfg.protocol));
  assert.equal(second.status, 409);
  assert.equal(second.body.error, 'already_submitted');
  assert.equal((await s.get('/api/status')).body.submitted_count, 1);
  await s.close();
});

test('concurrent duplicate submissions store exactly one', async () => {
  const s = await boot();
  const { cookie } = await s.signIn(1007);
  const rs = await Promise.all(Array.from({ length: 8 }, () => s.submit(cookie, ct(s.cfg.protocol))));
  assert.equal(rs.filter((r) => r.status === 201).length, 1);
  assert.equal((await s.get('/api/status')).body.submitted_count, 1);
  await s.close();
});

test('a ciphertext for the wrong round is refused at submission time', async () => {
  // §8 counts submissions, not valid ones. Caught at the door, it is a reload; caught
  // at finalisation, that player can no longer resubmit.
  const s = await boot();
  const { cookie } = await s.signIn(1001);
  const r = await s.submit(cookie, fakeCiphertext(s.cfg.protocol.target_round + 1, s.cfg.protocol.chain_hash));
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'bad_ciphertext');
  assert.equal((await s.get('/api/status')).body.submitted_count, 0);
  await s.close();
});

test('§8: submissions at or after the cutoff are refused', async () => {
  let now = Date.now();
  const s = await boot({ protocol: { submission_cutoff_utc: new Date(now + 1000).toISOString() }, now: () => now });
  const { cookie } = await s.signIn(1001);
  now += 5000;
  const r = await s.submit(cookie, ct(s.cfg.protocol));
  assert.equal(r.status, 409);
  assert.equal(r.body.error, 'closed');
  await s.close();
});

// ---------------------------------------------------------------------------
// §9 non-negotiable: what anyone submitted is never exposed before the reveal
// ---------------------------------------------------------------------------

test('/api/status reports who submitted, never what', async () => {
  const s = await boot();
  const { cookie } = await s.signIn(1002);
  await s.submit(cookie, ct(s.cfg.protocol));
  const { status, body } = await s.get('/api/status');
  assert.equal(status, 200);
  assert.deepEqual(body.submitted_local_ids, [2]);
  const raw = JSON.stringify(body);
  for (const leak of ['ciphertext', 'user_input"', 'client_nonce', 'AGE ENCRYPTED', 'person_id']) {
    assert.ok(!raw.includes(leak), `/api/status leaked ${leak}`);
  }
  await s.close();
});

/**
 * UI-SPEC §5 asks the waiting view to show real state. "9 of 12" is real but
 * unverifiable: it is our count of our own rows. The digest of each ciphertext is what
 * a player can keep and check afterwards, and it discloses nothing — the ciphertext it
 * hashes is already public the moment it arrives (PROTOCOL.md §5), and only the beacon
 * opens it. So this test pins both halves: the digest is right, and the thing it is a
 * digest OF never appears.
 */
test('the status carries a fingerprint of each sealed envelope, never its contents', async () => {
  const s = await boot();
  const { cookie } = await s.signIn(1002);
  const ciphertext = ct(s.cfg.protocol);
  await s.submit(cookie, ciphertext);

  const { body } = await s.get('/api/status');
  assert.equal(body.submissions.length, 1);
  const [only] = body.submissions;
  assert.equal(only.local_id, 2);
  assert.equal(only.digest, crypto.createHash('sha256').update(ciphertext, 'utf8').digest('hex'));
  assert.ok(Date.parse(only.received_at) > 0, 'received_at is a real instant');
  assert.ok(!JSON.stringify(body).includes('AGE ENCRYPTED'), 'the status leaked a ciphertext');
  await s.close();
});

test('every player who has not submitted is absent from the fingerprints', async () => {
  const s = await boot();
  for (const pid of [1001, 1003, 1007]) {
    const { cookie } = await s.signIn(pid);
    await s.submit(cookie, ct(s.cfg.protocol));
  }
  const { body } = await s.get('/api/status');
  assert.deepEqual(body.submissions.map((x) => x.local_id), [1, 3, 7]);
  assert.equal(new Set(body.submissions.map((x) => x.digest)).size, 3, 'digests are distinct');
  await s.close();
});

/**
 * The event's name is a label. It is fetched rather than frozen precisely because no
 * value it can take changes anything, and the page has to work when Pantheon is down —
 * which is the state every other test here leaves it in.
 */
test('the event name is read from Pantheon and served to the page', async () => {
  const s = await boot({ eventTitle: '2026 春季赛' });
  // The fetch is fired at construction and is a promise; give it the event loop.
  for (let i = 0; i < 20 && (await s.get('/api/status')).body.event_title == null; i += 1) {
    await new Promise((r) => setTimeout(r, 10));
  }
  const { body } = await s.get('/api/status');
  assert.equal(body.event_title, '2026 春季赛');
  await s.close();
});

test('a Pantheon that answers nothing leaves the page its generic title', async () => {
  const s = await boot();
  const { body } = await s.get('/api/status');
  assert.equal(body.event_title, null);
  await s.close();
});

test('an event name configured in runtime.json is not asked of Pantheon at all', async () => {
  const s = await boot({
    eventTitle: 'what Mimir would say',
    runtime: { pantheon: { event_title: 'what the operator typed' } },
  });
  const { body } = await s.get('/api/status');
  assert.equal(body.event_title, 'what the operator typed');
  assert.ok(
    !s.pantheon.calls.some(([m]) => m === 'getEventTitle'),
    'a configured title should not send a request'
  );
  await s.close();
});

test('no endpoint returns a ciphertext before the reveal', async () => {
  const s = await boot();
  const { cookie } = await s.signIn(1002);
  await s.submit(cookie, ct(s.cfg.protocol));
  for (const p of ['/api/status', '/api/me', '/api/result']) {
    const r = await s.get(p, cookie);
    const raw = JSON.stringify(r.body || {});
    assert.ok(!raw.includes('AGE ENCRYPTED'), `${p} leaked a ciphertext`);
    assert.ok(!raw.includes('client_nonce'), `${p} leaked a nonce`);
  }
  await s.close();
});

test('response headers carry no submission data', async () => {
  const s = await boot();
  const { cookie } = await s.signIn(1002);
  const res = await fetch(s.base + '/api/submit', {
    method: 'POST', headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ ciphertext: ct(s.cfg.protocol) }),
  });
  for (const [k, v] of res.headers) {
    assert.ok(!/nonce|user_input|ciphertext/i.test(`${k}${v}`), `header ${k} leaked something`);
  }
  await s.close();
});

// ---------------------------------------------------------------------------
// status shape and phases
// ---------------------------------------------------------------------------

test('/api/status carries everything the waiting view needs (§6)', async () => {
  const s = await boot();
  const { body } = await s.get('/api/status');
  for (const k of ['phase', 'submitted_count', 'quorum', 'total_slots', 'submitted_local_ids',
                   'cutoff_utc', 'target_round', 'drand', 'server_time_utc']) {
    assert.ok(k in body, `missing ${k}`);
  }
  for (const k of ['latest_round', 'healthy', 'last_seen_utc']) assert.ok(k in body.drand, `drand.${k} missing`);
  await s.close();
});

test('phase goes open -> void below quorum and open -> awaiting_round at or above it', async () => {
  let now = Date.now();
  const s = await boot({ protocol: { submission_cutoff_utc: new Date(now + 1000).toISOString() }, now: () => now });
  for (let i = 1; i <= 7; i++) {
    const { cookie } = await s.signIn(1000 + i);
    await s.submit(cookie, ct(s.cfg.protocol));
  }
  assert.equal((await s.get('/api/status')).body.phase, 'open');
  now += 5000;
  assert.equal((await s.get('/api/status')).body.phase, 'void');

  let now2 = Date.now();
  const s2 = await boot({ protocol: { submission_cutoff_utc: new Date(now2 + 1000).toISOString() }, now: () => now2 });
  for (let i = 1; i <= 8; i++) {
    const { cookie } = await s2.signIn(1000 + i);
    await s2.submit(cookie, ct(s2.cfg.protocol));
  }
  now2 += 5000;
  assert.equal((await s2.get('/api/status')).body.phase, 'awaiting_round');
  await s.close(); await s2.close();
});

test('the status separates a draw that is pending from one that is not happening', async () => {
  // This process never draws; server/finalise.js does, on a timer. A gap between the
  // beacon landing and the result appearing is therefore normal, and the page used to
  // render that gap and a dead timer identically, as "Drawing", forever. The status has
  // to be able to tell them apart or the page cannot.
  let now = Date.now();
  const gap = 600;
  const s = await boot({
    protocol: { submission_cutoff_utc: new Date(now + 1000).toISOString(), reveal_gap_seconds: gap },
    now: () => now,
  });
  for (let i = 1; i <= 8; i++) {
    const { cookie } = await s.signIn(1000 + i);
    await s.submit(cookie, ct(s.cfg.protocol));
  }

  // Before the cutoff there is nothing to be late for.
  assert.equal((await s.get('/api/status')).body.draw, null);

  // Inside the interval: sealed, but the beacon does not exist yet, so still nothing.
  now += 5000;
  assert.equal((await s.get('/api/status')).body.phase, 'awaiting_round');
  assert.equal((await s.get('/api/status')).body.draw, null);

  // The beacon's round has passed. Late, but not yet longer than the timer needs to
  // notice and do the work.
  now += gap * 1000;
  const pending = (await s.get('/api/status')).body.draw;
  assert.equal(pending.overdue, false, 'grace, because the timer may have fired just before the beacon');
  assert.equal(pending.grace_seconds, 120, 'two runs of the one-minute timer');
  assert.ok(pending.seconds_late >= 0);

  // Past the grace: the job is not running, and the page is entitled to say so.
  now += 121_000;
  const late = (await s.get('/api/status')).body.draw;
  assert.equal(late.overdue, true);
  assert.ok(late.seconds_late > 120);
  assert.equal(late.round_due_utc, s.cfg.protocol.target_round_utc);
  await s.close();
});

// ---------------------------------------------------------------------------
// mirroring, SSE, static, misc
// ---------------------------------------------------------------------------

test('the ciphertext is mirrored to events/submissions/<local_id>.json (§4)', async () => {
  const s = await boot();
  const { cookie } = await s.signIn(1004);
  await s.submit(cookie, ct(s.cfg.protocol));
  assert.equal(s.mirrored.length, 1);
  assert.equal(s.mirrored[0].p, 'events/submissions/4.json');
  const rec = JSON.parse(s.mirrored[0].c);
  assert.equal(rec.local_id, 4);
  assert.ok(rec.ciphertext.startsWith('-----BEGIN AGE'));
  await s.close();
});

test('the SSE stream opens and pushes a status frame', async () => {
  const s = await boot();
  const res = await fetch(s.base + '/api/events', { headers: { accept: 'text/event-stream' } });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/event-stream/);
  const reader = res.body.getReader();
  const chunk = new TextDecoder().decode((await reader.read()).value);
  assert.match(chunk, /retry:|event: status/);
  await reader.cancel();
  await s.close();
});

test('the frozen public files are served', async () => {
  const s = await boot();
  for (const f of ['/protocol.json', '/roster.json', '/schedule_template.json']) {
    assert.equal((await s.get(f)).status, 200, `${f} should be served`);
  }
  await s.close();
});

test('roster.json exposes no secrets — there are none to expose', async () => {
  const s = await boot();
  const { body } = await s.get('/roster.json');
  for (const p of body.players) {
    assert.deepEqual(Object.keys(p).sort(), ['local_id', 'person_id', 'title']);
  }
  await s.close();
});

test('an unknown path serves the SPA rather than 404 (one route, §8/UI-SPEC §2)', async () => {
  const s = await boot();
  const res = await fetch(s.base + '/anything?player=3');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  await s.close();
});

test('path traversal out of public/ is refused', async () => {
  const s = await boot();
  for (const p of ['/../package.json', '/../../etc/passwd']) {
    const res = await fetch(s.base + p);
    const text = await res.text();
    assert.ok(!text.includes('"dependencies"'), `${p} leaked package.json`);
  }
  await s.close();
});

test('the dev-authorize stand-in is absent in production', async () => {
  const prev = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  const s = await boot();
  const r = await s.call('/api/dev-authorize', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ person_id: 1001 }),
  });
  assert.equal(r.status, 404, 'a password-free sign-in shortcut must not exist in production');
  process.env.NODE_ENV = prev;
  await s.close();
});

test('a malformed body is a 400, not a crash', async () => {
  const s = await boot();
  const res = await fetch(s.base + '/api/submit', { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'not json' });
  assert.ok(res.status === 400 || res.status === 401);
  assert.equal((await s.get('/api/status')).status, 200, 'server still healthy');
  await s.close();
});

test('the rate limiter caps repeated sign-in attempts', async () => {
  const s = await boot({ rateLimit: 5 });
  const codes = [];
  for (let i = 0; i < 9; i++) {
    const r = await s.call('/api/session', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ person_id: 1001, auth_token: 'wrong' }),
    });
    codes.push(r.status);
  }
  assert.ok(codes.includes(429), `expected a 429 among ${codes.join(',')}`);
  await s.close();
});

/** Repeatedly fail sign-in, optionally claiming a forwarded address. */
async function attempts(s, n, forwardedFor) {
  const codes = [];
  for (let i = 0; i < n; i++) {
    const r = await s.call('/api/session', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(forwardedFor ? { 'x-forwarded-for': forwardedFor } : {}),
      },
      body: JSON.stringify({ person_id: 1001, auth_token: 'wrong' }),
    });
    codes.push(r.status);
  }
  return codes;
}

test('behind a proxy the limit is per player, not one shared between them', async () => {
  // Every request arrives from the proxy, so without trust_proxy twelve people signing
  // in at the same moment spend one allowance between them.
  const s = await boot({ rateLimit: 3, trustProxy: true });
  try {
    // What nginx sends for a client at 203.0.113.7 that forwarded nothing itself:
    // $proxy_add_x_forwarded_for appends the address IT saw, which is the client's.
    assert.equal((await attempts(s, 3, '203.0.113.7')).includes(429), false);
    assert.ok((await attempts(s, 2, '203.0.113.7')).includes(429), 'that address was not capped');
    // A different player is unaffected by the first one hitting the wall.
    assert.equal((await attempts(s, 3, '203.0.113.8')).includes(429), false);
  } finally { await s.close(); }
});

test('a forged X-Forwarded-For cannot buy a fresh allowance', async () => {
  // Both proxies in deploy/ append the address they saw, so the rightmost entry is the
  // one they observed and anything to the left of it is the caller's own claim.
  const s = await boot({ rateLimit: 3, trustProxy: true });
  try {
    // The same client, at 203.0.113.9, first honest and then inventing a prefix. The
    // proxy appends what it saw either way, so the real address stays on the right.
    await attempts(s, 3, '203.0.113.9');
    const spoofed = await attempts(s, 2, '198.51.100.1, 203.0.113.9');
    assert.ok(spoofed.includes(429), 'a forged prefix bought a fresh allowance');
  } finally { await s.close(); }
});

test('with trust_proxy off the header is ignored entirely', async () => {
  // The default. Nothing sets that header in front of this server, so believing it
  // would hand every caller an allowance of its own just for inventing an address.
  const s = await boot({ rateLimit: 4, trustProxy: false });
  try {
    const codes = [];
    for (let i = 0; i < 6; i++) codes.push(...await attempts(s, 1, `198.51.100.${i}`));
    assert.ok(codes.includes(429), `every invented address got its own allowance: ${codes.join(',')}`);
  } finally { await s.close(); }
});

test('trust_proxy with no header falls back to the socket address', async () => {
  // A direct request to the app while the setting is on — a health check, or a proxy
  // that was not configured to forward. It must still be limited, not exempt.
  const s = await boot({ rateLimit: 3, trustProxy: true });
  try {
    const codes = await attempts(s, 5);
    assert.ok(codes.includes(429), `unforwarded requests went unlimited: ${codes.join(',')}`);
  } finally { await s.close(); }
});

test('the port comes from a flag, then the environment, then the default', () => {
  // 8080 is a popular port, and "something else already has it" should not send an
  // organiser into a config file on the day.
  assert.deepEqual(listenOn([], {}), { port: 8080, host: '127.0.0.1' });
  assert.equal(listenOn([], { PORT: '9001' }).port, 9001);
  assert.equal(listenOn(['--port', '9002'], { PORT: '9001' }).port, 9002, 'the flag must win');
  assert.equal(listenOn(['--port=9003'], {}).port, 9003);
  assert.equal(listenOn(['-p', '9004'], {}).port, 9004);
  assert.equal(listenOn(['--host', '0.0.0.0'], {}).host, '0.0.0.0');
  // Loopback by default: a reverse proxy terminates TLS in front (§10), and binding
  // every interface is a decision, not something to arrive at by omission.
  assert.equal(listenOn(['--port', '9005'], {}).host, '127.0.0.1');
});

/**
 * The waiting stage holds a stream that never ends, and `server.close()` waits for every
 * connection to end. Before the hub was closed first, those two waited for each other and
 * Ctrl+C did nothing whatever — no message, no exit, and no default behaviour to fall back
 * on, because installing the handler is what removed it. The operator's way out was
 * Ctrl+Break or the task manager, and `systemctl restart` sat there for the full ninety
 * seconds before systemd gave up and sent SIGKILL.
 *
 * Note the failure mode of this test if it regresses: it does not fail, it hangs. That is
 * the bug, faithfully.
 */
test('Ctrl+C stops the server with a waiting page attached', async () => {
  const s = await boot();
  const res = await fetch(s.base + '/api/events', { headers: { accept: 'text/event-stream' } });
  const reader = res.body.getReader();
  await reader.read(); // attached, and holding — one player sitting on the waiting page
  assert.equal(s.hub.size, 1);

  const warned = [];
  const codes = [];
  const t0 = Date.now();
  await new Promise((done) => {
    shutdown({
      server: s.server,
      hub: s.hub,
      log: { warn: (m) => warned.push(m) },
      exit: (c) => { codes.push(c); done(); },
    });
  });

  assert.deepEqual(codes, [0], 'shutdown must exit exactly once, cleanly');
  // Nowhere near the grace period: the streams were released rather than timed out. A
  // browser also keeps a spare keep-alive socket, and that counts as much as this one.
  const ms = Date.now() - t0;
  assert.ok(ms < 1000, `took ${ms}ms — something waited that should not have`);
  assert.deepEqual(warned, [], `shutdown had to force something: ${warned.join(' / ')}`);

  await reader.cancel().catch(() => {});
  await s.close();
});

test('and a stream nothing releases cannot hold it open indefinitely', async () => {
  // The same shutdown with the hub withheld, which is the old behaviour exactly: the
  // stream stays up, closeIdleConnections cannot touch a connection that is mid-response,
  // and the grace period is the only thing left between the operator and a hang. Forty
  // milliseconds here; three seconds in the program.
  const s = await boot();
  const res = await fetch(s.base + '/api/events', { headers: { accept: 'text/event-stream' } });
  const reader = res.body.getReader();
  await reader.read();

  const warned = [];
  const codes = [];
  await new Promise((done) => {
    shutdown({
      server: s.server,
      log: { warn: (m) => warned.push(m) },
      graceMs: 40,
      exit: (c) => { codes.push(c); done(); },
    });
  });

  assert.deepEqual(codes, [0]);
  assert.match(warned.join('\n'), /still connected/, 'the forced drop must say so out loud');

  await reader.cancel().catch(() => {});
  s.hub.close();
  await s.close();
});

test('a port that is not a port is refused before anything opens a socket', () => {
  // Number('') is 0 and Number('http') is NaN; both used to become a listen() call with
  // whatever Node made of them, and 0 binds a random port nobody knows.
  for (const bad of ['0', 'http', '-1', '70000', '80.5', '']) {
    assert.throws(() => listenOn(['--port', bad], {}), /--port must be a whole number/, `accepted ${bad}`);
  }
  assert.throws(() => listenOn([], { PORT: 'nope' }), /--port must be a whole number/);
});

/**
 * The queue has to empty before the process does, and that requirement arrived with the
 * fix above. A ciphertext is accepted, stored, and queued for the repository, and the
 * push happens a moment later. While stopping took forever the queue emptied on the way
 * out by accident; now that it takes milliseconds, a submission taken seconds before a
 * restart would be durable locally and absent from the repository — which is the one
 * claim PROTOCOL §5 makes about it.
 */
test('a submission still queued for the repository is not abandoned by the shutdown', async () => {
  const s = await boot();
  let drainedWith = null;
  let released = null;
  const mirror = {
    enabled: true,
    drain: (ms) => { drainedWith = ms; return new Promise((r) => { released = r; }); },
  };

  const codes = [];
  let exited = false;
  const stopped = new Promise((done) => {
    shutdown({
      server: s.server,
      hub: s.hub,
      mirror,
      log: { warn() {} },
      exit: (c) => { codes.push(c); exited = true; done(); },
    });
  });

  // The sockets are long gone by now; the queue is what is left.
  await new Promise((r) => setImmediate(r));
  assert.equal(exited, false, 'the process left while a ciphertext was still queued');
  assert.equal(typeof drainedWith, 'number', 'the drain must be bounded, or GitHub can hold it open');

  released(true);
  await stopped;
  assert.deepEqual(codes, [0]);
  await s.close();
});

test('and an unreachable repository still cannot hold the process open', async () => {
  const s = await boot();
  const warned = [];
  const codes = [];
  await new Promise((done) => {
    shutdown({
      server: s.server,
      hub: s.hub,
      // Never settles: GitHub is down, or the network is gone.
      mirror: { enabled: true, drain: () => new Promise(() => {}) },
      log: { warn: (m) => warned.push(m) },
      graceMs: 40,
      exit: (c) => { codes.push(c); done(); },
    });
  });
  assert.deepEqual(codes, [0]);
  await s.close();
});
