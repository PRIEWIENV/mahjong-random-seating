'use strict';

/**
 * The organiser's dashboard (RUNBOOK C and D).
 *
 * Two things are worth pinning here above everything else:
 *
 *   1. it is unreachable without the token, and absent entirely without one configured
 *   2. it shows WHEN each player submitted and never WHAT
 *
 * The second is §9's non-negotiable — "not in an endpoint, not in a payload, not in a
 * debug header" — and this page is the easiest place in the codebase to break it by
 * accident, because it is the one screen whose whole job is to show the organiser more
 * than a player sees.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');

const { createServer } = require('../server/server');
const { collect } = require('../server/admin');
const { load } = require('../server/config');
const { Store } = require('../server/db');
const { StubPantheon } = require('../server/pantheon');
const { makeDataDir, fakeCiphertext, cleanup, ROOT } = require('./helpers');

const QUIET = { info() {}, warn() {}, error() {} };
const TOKEN = 'a-token-of-some-length';

/** A live server with n of the twelve already submitted. */
async function boot(opts = {}) {
  const fx = makeDataDir();
  const cfg = load({ dataDir: fx.dataDir });
  cfg.root = fx.dir;
  const store = new Store(':memory:');
  const ciphertexts = new Map();
  for (let i = 1; i <= (opts.submitted ?? 7); i++) {
    const ct = fakeCiphertext(cfg.protocol.target_round, cfg.protocol.chain_hash);
    ciphertexts.set(i, ct);
    store.insertSubmission(i, ct, Date.now() - i * 60_000);
  }
  const { server } = createServer({
    cfg, store,
    mirror: { enabled: false, enqueue: () => {}, flush: async () => {}, drain: async () => true },
    pantheon: new StubPantheon({ roster: fx.roster }),
    publicDir: path.join(ROOT, 'public'),
    adminToken: 'adminToken' in opts ? opts.adminToken : TOKEN,
    drand: { latest: async () => ({ round: 123 }) },
    drandPollMs: 0,
    log: QUIET,
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  // agent: false — Node's global agent keeps sockets alive by default, and a live
  // socket makes server.close() wait forever.
  const get = (p, headers = {}) => new Promise((res) => {
    http.get({ host: '127.0.0.1', port, path: p, headers, agent: false }, (r) => {
      let b = '';
      r.on('data', (d) => { b += d; });
      r.on('end', () => res({ status: r.statusCode, headers: r.headers, body: b }));
    });
  });

  const request = (method, p) => new Promise((res) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method, agent: false }, (r) => {
      let b = '';
      r.on('data', (d) => { b += d; });
      r.on('end', () => res({ status: r.statusCode, body: b }));
    });
    req.end();
  });

  return {
    fx, cfg, store, get, request, ciphertexts,
    close: async () => { await new Promise((r) => server.close(r)); cleanup(fx.dir); },
  };
}

// ---------------------------------------------------------------------------
// reachability
// ---------------------------------------------------------------------------

test('/admin is absent entirely when no token is configured', async () => {
  // Not 401. An organiser who never set ADMIN_TOKEN has not accidentally published a
  // roster and a submission timeline behind a prompt someone can hammer.
  const s = await boot({ adminToken: null });
  assert.equal((await s.get('/admin')).status, 404);
  assert.equal((await s.get(`/admin?token=${TOKEN}`)).status, 404);
  await s.close();
});

test('/admin is 404 without the token, and with a wrong one', async () => {
  const s = await boot();
  assert.equal((await s.get('/admin')).status, 404);
  assert.equal((await s.get('/admin?token=wrong')).status, 404);
  // Same length as the real one, so this exercises the comparison rather than the
  // length guard in front of it.
  assert.equal((await s.get(`/admin?token=${'x'.repeat(TOKEN.length)}`)).status, 404);
  await s.close();
});

test('the token in the URL is exchanged for a cookie', async () => {
  // So it stops being in the address bar, the history and any referrer.
  const s = await boot();
  const first = await s.get(`/admin?token=${TOKEN}`);
  assert.equal(first.status, 200);
  const setCookie = String(first.headers['set-cookie']);
  assert.match(setCookie, /^mjs_admin=/);
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Strict/);

  const withCookie = await s.get('/admin', { cookie: `mjs_admin=${TOKEN}` });
  assert.equal(withCookie.status, 200);
  await s.close();
});

test('the page refuses to be framed or indexed', async () => {
  const s = await boot();
  const r = await s.get(`/admin?token=${TOKEN}`);
  assert.match(r.headers['content-security-policy'], /frame-ancestors 'none'/);
  assert.match(r.headers['x-robots-tag'], /noindex/);
  assert.equal(r.headers['referrer-policy'], 'no-referrer');
  await s.close();
});

// ---------------------------------------------------------------------------
// what it must never show
// ---------------------------------------------------------------------------

test('no ciphertext reaches the page or the JSON', async () => {
  const s = await boot({ submitted: 7 });
  const page = await s.get(`/admin?token=${TOKEN}`);
  const json = await s.get(`/admin/data.json?token=${TOKEN}`);

  for (const [localId, ct] of s.ciphertexts) {
    // The armour lines are the same for every ciphertext; the body is what identifies one.
    const body = ct.split('\n').slice(1, -1).join('');
    assert.ok(!page.body.includes(body), `local_id ${localId} ciphertext leaked into the page`);
    assert.ok(!json.body.includes(body), `local_id ${localId} ciphertext leaked into data.json`);
  }
  assert.doesNotMatch(page.body, /BEGIN AGE ENCRYPTED/);
  assert.doesNotMatch(json.body, /BEGIN AGE ENCRYPTED/);
  await s.close();
});

test('it shows when each player submitted, never what', async () => {
  const s = await boot({ submitted: 3 });
  const m = JSON.parse((await s.get(`/admin/data.json?token=${TOKEN}`)).body);
  const row = m.roster.find((r) => r.local_id === 1);
  assert.equal(row.submitted, true);
  assert.match(row.received_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(Object.keys(row).sort(), ['local_id', 'received_at', 'submitted', 'title']);

  const missing = m.roster.find((r) => r.local_id === 12);
  assert.equal(missing.submitted, false);
  assert.equal(missing.received_at, null);
  await s.close();
});

// ---------------------------------------------------------------------------
// the model
// ---------------------------------------------------------------------------

test('the chase list is who has not submitted (RUNBOOK 13)', async () => {
  const s = await boot({ submitted: 9 });
  const m = JSON.parse((await s.get(`/admin/data.json?token=${TOKEN}`)).body);
  assert.equal(m.submitted_count, 9);
  assert.deepEqual(m.roster.filter((r) => !r.submitted).map((r) => r.local_id), [10, 11, 12]);
  await s.close();
});

test('the frozen artefacts are fingerprinted', async () => {
  const s = await boot();
  const m = JSON.parse((await s.get(`/admin/data.json?token=${TOKEN}`)).body);
  for (const k of ['data/protocol.json', 'data/roster.json', 'data/schedule_template.json',
    'public/app.js + app.css']) {
    assert.match(m.artefacts[k], /^[0-9a-f]{64}$/, k);
  }
  await s.close();
});

test('an artefact that is not where it should be reads as missing, not as blank', async () => {
  // The fixture root has no generate.js, which is exactly the shape of the problem
  // worth surfacing: a frozen artefact the server cannot find must say so on the page
  // rather than render an empty cell an operator will skim past.
  const s = await boot();
  const m = JSON.parse((await s.get(`/admin/data.json?token=${TOKEN}`)).body);
  assert.equal(m.artefacts['generate.js'], null);
  const page = (await s.get(`/admin?token=${TOKEN}`)).body;
  assert.match(page, /generate\.js<\/dt><dd><span class="mono">缺失/);
  await s.close();
});

// ---------------------------------------------------------------------------
// the checks, in the configurations that matter
// ---------------------------------------------------------------------------

function checksFor(over) {
  const fx = makeDataDir();
  const cfg = load({ dataDir: fx.dataDir });
  cfg.root = fx.dir;
  const model = collect({
    cfg,
    store: new Store(':memory:'),
    status: { phase: 'open', submitted_count: 0, drand: { healthy: true, latest_round: 1 } },
    syncOutcome: null,
    publicDir: path.join(ROOT, 'public'),
    now: Date.now(),
    isStub: false,
    mirror: { enabled: true, repo: 'me/repo', branch: 'main' },
    production: true,
    ...over,
  });
  cleanup(fx.dir);
  return Object.fromEntries(model.checks.map((c) => [c.label, c.level]));
}

test('a clean production configuration is all green', () => {
  const c = checksFor({});
  assert.deepEqual([...new Set(Object.values(c))], ['ok'], JSON.stringify(c, null, 2));
});

test('the stub in production is a failure, on a laptop only a warning', () => {
  // The difference is the whole point: the same setting is correct in one place and
  // authorises everybody in the other.
  assert.equal(checksFor({ isStub: true, production: true })['Pantheon adapter is the STUB'], 'fail');
  assert.equal(checksFor({ isStub: true, production: false })['Pantheon adapter is the STUB'], 'warn');
});

test('mirroring switched off is a failure', () => {
  // The ciphertexts being timestamped by a third party is what stops the organiser
  // quietly dropping one. Without the mirror that argument is gone.
  const c = checksFor({ mirror: { enabled: false } });
  assert.equal(c['Mirroring to the repository'], 'fail');
});

test('an unreachable drand is a warning before the cutoff and a failure after', () => {
  // §8: a late beacon is a delay, not a failure — the snapshot is already frozen. It
  // only becomes urgent once the round it is holding up has arrived.
  const soon = { status: { phase: 'open', submitted_count: 0, drand: { healthy: false } } };
  assert.equal(checksFor(soon)['drand is reachable'], 'warn');
  assert.equal(checksFor({ ...soon, now: Date.now() + 86_400_000 })['drand is reachable'], 'fail');
});

// ---------------------------------------------------------------------------
// it cannot change anything
// ---------------------------------------------------------------------------

test('the dashboard answers nothing but GET', async () => {
  // §9 keeps the draw off HTTP so that nothing an outsider can poke may trigger, retry
  // or re-time it. A write route here would hand that straight back, so there is no
  // write route — even holding the token.
  const s = await boot();
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
    const r = await s.request(method, `/admin?token=${TOKEN}`);
    assert.equal(r.status, 405, `${method} /admin`);
  }
  await s.close();
});
