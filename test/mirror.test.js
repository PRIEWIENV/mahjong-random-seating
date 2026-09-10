'use strict';

/**
 * Mirroring (server/mirror.js).
 *
 * This is the module the fairness argument leans on hardest and the last one without a
 * test. PROTOCOL.md §5: the ciphertexts become public the moment they arrive,
 * timestamped by a third party the organiser does not control, which is what stops the
 * organiser quietly dropping an inconvenient submission after seeing the outcome.
 *
 * The GitHub round trip itself needs a PAT and is out of reach here. Everything that
 * decides whether a ciphertext reaches GitHub does not: the queue, the retry, the point
 * at which it gives up, and the guarantee that none of it can fail a player's
 * submission. Those are the parts that would be wrong quietly.
 *
 * `fetch` is a global, so it can be replaced for the duration of a test.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Mirror, writeLocal } = require('../server/mirror');

const QUIET = { info() {}, warn() {}, error() {} };
const ENV = { MIRROR_REPO: 'someone/seating', MIRROR_BRANCH: 'main', MIRROR_TOKEN: 'ghp_test' };

/** Replace global fetch for one test, and put it back afterwards. */
async function withFetch(impl, fn) {
  const saved = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), method: init?.method, init });
    return impl(String(url), init, calls.length);
  };
  try {
    return await fn(calls);
  } finally {
    globalThis.fetch = saved;
  }
}

const json = (status, body) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json' },
});

/**
 * Wait until nothing is in flight.
 *
 * enqueue() starts a flush and deliberately does not return it — a player's submission
 * must not wait on GitHub. That means a test which only awaits drain() can leave a
 * flush running, and when the stub is put back it goes to the real api.github.com. So
 * every test that enqueues ends here.
 */
async function settle(m, ms = 5_000) {
  m.queue.length = 0;
  const deadline = Date.now() + ms;
  while (m.flushing && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
  assert.equal(m.flushing, false, 'a flush was still running when the test ended');
}

/** GitHub's answers: 404 for a path that does not exist yet, 200 for a write. */
const happyGitHub = (url, init) =>
  init?.method === 'GET' ? json(404, { message: 'Not Found' }) : json(201, { content: { sha: 'abc' } });

// ---------------------------------------------------------------------------
// switched off
// ---------------------------------------------------------------------------

test('without a repo and a token it is disabled, and says so once', () => {
  const said = [];
  const m = new Mirror({}, { ...QUIET, warn: (s) => said.push(s) });
  assert.equal(m.enabled, false);
  assert.equal(said.length, 1);
  assert.match(said[0], /Submissions are still stored locally/);
});

test('a repo without a token is not half-enabled', () => {
  assert.equal(new Mirror({ MIRROR_REPO: 'a/b' }, QUIET).enabled, false);
  assert.equal(new Mirror({ MIRROR_TOKEN: 'x' }, QUIET).enabled, false);
  assert.equal(new Mirror(ENV, QUIET).enabled, true);
});

test('disabled, it queues nothing and touches no network', async () => {
  await withFetch(() => { throw new Error('a disabled mirror must not call out'); }, async (calls) => {
    const m = new Mirror({}, QUIET);
    m.enqueue('events/submissions/1.json', '{}', 'add 1');
    await m.flush();
    assert.equal(calls.length, 0);
    assert.deepEqual(await m.put('x', 'y', 'z'), { skipped: true });
  });
});

// ---------------------------------------------------------------------------
// the ordinary path
// ---------------------------------------------------------------------------

test('a queued ciphertext is written to the configured repo and branch', async () => {
  await withFetch(happyGitHub, async (calls) => {
    const m = new Mirror(ENV, QUIET, { retryBaseMs: 5 });
    await m.put('events/submissions/3.json', '{"local_id":3}', 'submission 3');

    const [look, write] = calls;
    assert.equal(look.method, 'GET');
    assert.match(look.url, /\/repos\/someone\/seating\/contents\/events\/submissions\/3\.json\?ref=main$/);
    assert.equal(write.method, 'PUT');

    const body = JSON.parse(write.init.body);
    assert.equal(body.branch, 'main');
    assert.equal(body.message, 'submission 3');
    assert.equal(Buffer.from(body.content, 'base64').toString('utf8'), '{"local_id":3}');
    // No sha: the file did not exist, and sending one would be a lie GitHub rejects.
    assert.equal('sha' in body, false);
    assert.match(write.init.headers.authorization, /^Bearer ghp_test$/);
  });
});

test('an existing path is updated with its sha rather than refused as a conflict', async () => {
  await withFetch((url, init) => (
    init?.method === 'GET' ? json(200, { sha: 'deadbeef' }) : json(200, {})
  ), async (calls) => {
    const m = new Mirror(ENV, QUIET, { retryBaseMs: 5 });
    await m.put('events/snapshot.json', '{}', 'snapshot');
    assert.equal(JSON.parse(calls[1].init.body).sha, 'deadbeef');
  });
});

test('a directory listing is not mistaken for a file sha', async () => {
  // GitHub answers a directory path with an array. Passing its "sha" would be nonsense.
  await withFetch((url, init) => (
    init?.method === 'GET' ? json(200, [{ sha: 'x', name: 'a.json' }]) : json(201, {})
  ), async (calls) => {
    const m = new Mirror(ENV, QUIET, { retryBaseMs: 5 });
    await m.put('events/submissions', '{}', 'msg');
    assert.equal('sha' in JSON.parse(calls[1].init.body), false);
  });
});

test('the queue drains in the order it was filled', async () => {
  await withFetch(happyGitHub, async (calls) => {
    const m = new Mirror(ENV, QUIET, { retryBaseMs: 5 });
    for (const n of [1, 2, 3]) m.enqueue(`events/submissions/${n}.json`, `${n}`, `add ${n}`);
    assert.ok(await m.drain(5_000), 'the queue did not drain');

    const written = calls.filter((c) => c.method === 'PUT').map((c) => JSON.parse(c.init.body).message);
    assert.deepEqual(written, ['add 1', 'add 2', 'add 3']);
    await settle(m);
  });
});

// ---------------------------------------------------------------------------
// when GitHub is having a bad day
// ---------------------------------------------------------------------------

test('a submission never fails because mirroring did', async () => {
  // The header comment's promise. enqueue() is called from the request handler, so it
  // must not throw and must not be awaited into the player's response.
  await withFetch(() => { throw new TypeError('network down'); }, async () => {
    const m = new Mirror(ENV, QUIET, { retryBaseMs: 5 });
    assert.doesNotThrow(() => m.enqueue('events/submissions/1.json', '{}', 'add 1'));
    await m.drain(2_000);
    await settle(m);
  });
});

test('a failure is retried, and the second attempt is what succeeds', async () => {
  let seen = 0;
  await withFetch((url, init) => {
    if (init?.method === 'GET') return json(404, {});
    seen += 1;
    return seen === 1 ? json(502, { message: 'Bad gateway' }) : json(201, {});
  }, async () => {
    const m = new Mirror(ENV, QUIET, { retryBaseMs: 5 });
    m.enqueue('events/submissions/1.json', '{}', 'add 1');
    assert.ok(await m.drain(5_000));
    assert.equal(seen, 2);
    assert.equal(m.queue.length, 0);
    await settle(m);
  });
});

test('after five attempts it gives up loudly and stops holding the queue', async () => {
  // Blocking forever on one bad file would strand every ciphertext behind it, which is
  // worse than losing this one — the local copy and SQLite still have it.
  const errors = [];
  await withFetch(() => json(500, { message: 'boom' }), async () => {
    const m = new Mirror(ENV, { ...QUIET, error: (s) => errors.push(s) }, { retryBaseMs: 5 });
    m.enqueue('events/submissions/1.json', '{}', 'add 1');
    m.enqueue('events/submissions/2.json', '{}', 'add 2');
    assert.ok(await m.drain(10_000), 'a permanently failing file blocked the queue');
    await settle(m);
  });
  const gaveUp = errors.filter((e) => /giving up on/.test(e));
  assert.equal(gaveUp.length, 2);
  assert.match(gaveUp[0], /mirror it by hand before publishing results/);
});

test('the error names the file, the attempt and what GitHub said', async () => {
  const errors = [];
  await withFetch(() => json(403, { message: 'API rate limit exceeded' }), async () => {
    const m = new Mirror(ENV, { ...QUIET, error: (s) => errors.push(s) }, { retryBaseMs: 5 });
    m.enqueue('events/submissions/7.json', '{}', 'add 7');
    await m.drain(10_000);
    await settle(m);
  });
  assert.match(errors[0], /events\/submissions\/7\.json failed \(attempt 1\)/);
  assert.match(errors[0], /403/);
  assert.match(errors[0], /API rate limit exceeded/);
});

test('drain reports failure rather than hanging when the timeout runs out', async () => {
  await withFetch(async () => {
    await new Promise((r) => setTimeout(r, 50));
    return json(500, { message: 'slow and broken' });
  }, async () => {
    const m = new Mirror(ENV, QUIET, { retryBaseMs: 30 });
    m.enqueue('events/submissions/1.json', '{}', 'add 1');
    const t0 = Date.now();
    assert.equal(await m.drain(10), false);
    assert.ok(Date.now() - t0 < 2_000, 'drain ignored its own deadline');
    await settle(m);
  });
});

test('two flushes do not run the same job twice', async () => {
  await withFetch(async (url, init) => {
    await new Promise((r) => setTimeout(r, 10));
    return init?.method === 'GET' ? json(404, {}) : json(201, {});
  }, async (calls) => {
    const m = new Mirror(ENV, QUIET, { retryBaseMs: 5 });
    m.enqueue('events/submissions/1.json', '{}', 'add 1');
    await Promise.all([m.flush(), m.flush(), m.drain(5_000)]);
    assert.equal(calls.filter((c) => c.method === 'PUT').length, 1);
    await settle(m);
  });
});

// ---------------------------------------------------------------------------
// the copy that exists with no PAT at all
// ---------------------------------------------------------------------------

test('writeLocal lays out the repository path under the root, creating directories', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mahjong-mirror-'));
  try {
    const dest = writeLocal(dir, 'events/submissions/4.json', '{"local_id":4}');
    assert.equal(dest, path.join(dir, 'events', 'submissions', '4.json'));
    assert.equal(fs.readFileSync(dest, 'utf8'), '{"local_id":4}');

    // Rewriting the same path replaces it: a resubmission is not an append.
    writeLocal(dir, 'events/submissions/4.json', '{"local_id":4,"v":2}');
    assert.equal(fs.readFileSync(dest, 'utf8'), '{"local_id":4,"v":2}');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
