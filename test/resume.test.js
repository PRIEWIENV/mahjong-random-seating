'use strict';

/**
 * What the finalisation job does when it wakes up on an already-finished draw.
 *
 * The timer fires every five minutes for the life of the deployment, so "the draw is
 * over" is by far the state it will most often find itself in. Two things have to hold
 * there: it must never undo a published result, and it must finish the one step that
 * can legitimately still be outstanding.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { run, phaseOf, KEY_PHASE, KEY_SYNC, KEY_TICK, KEY_PUBLISHED } = require('../server/finalise');
const { load } = require('../server/config');
const { Store } = require('../server/db');
const { StubPantheon } = require('../server/pantheon');
const { generate, serialise } = require('../generate');
const { makeDataDir, makeDecrypted, template, SAMPLE_SIG, fakeCiphertext, cleanup } = require('./helpers');

const QUIET = { info() {}, warn() {}, error() {} };
const PAST = () => new Date(Date.now() - 3_600_000).toISOString();

/** A finished draw: results.json on disk, nothing else. */
function finished(opts = {}) {
  const fx = makeDataDir({ protocol: { submission_cutoff_utc: PAST(), ...opts.protocol } });
  const cfg = load({ dataDir: fx.dataDir });
  cfg.root = fx.dir;
  const results = generate({
    decrypted: makeDecrypted(12),
    roster: fx.roster,
    protocol: cfg.protocol,
    template: template(),
    signature: SAMPLE_SIG,
  });
  fs.writeFileSync(path.join(fx.dir, 'results.json'), serialise(results));

  const mirrored = [];
  return {
    fx, cfg, results, mirrored,
    store: new Store(':memory:'),
    pantheon: new StubPantheon({ roster: fx.roster }),
    mirror: {
      enabled: false,
      enqueue: (p, body) => mirrored.push(p),
      flush: async () => {},
      drain: async () => true,
    },
    // Any call to drand would mean the job decided to draw again.
    drand: { round: async () => { throw new Error('the job tried to re-draw'); } },
  };
}

const invoke = (c, over = {}) => run({
  cfg: c.cfg, store: c.store, mirror: c.mirror, pantheon: c.pantheon, drand: c.drand,
  wait: false, log: QUIET, ...over,
});

// ---------------------------------------------------------------------------
// never undo a published result
// ---------------------------------------------------------------------------

test('a lost database does not turn a published draw into a void round', async () => {
  // The RUNBOOK says var/ is expendable. Restored onto a fresh database, an empty
  // submissions table past the cutoff is indistinguishable from a quorum failure, and
  // the job used to publish events/void.json over a draw that had already happened.
  const c = finished();
  const out = await invoke(c);
  assert.equal(out.phase, 'done');
  assert.equal(fs.existsSync(path.join(c.fx.dir, 'events', 'void.json')), false);
  assert.ok(!c.mirrored.includes('events/void.json'), 'a void notice must never be mirrored');
  cleanup(c.fx.dir);
});

test('the job reconciles the database with the published file', async () => {
  const c = finished();
  await invoke(c);
  assert.equal(c.store.get(KEY_PHASE), 'done');
  cleanup(c.fx.dir);
});

test('results.json outranks a phase of void already written into the database', async () => {
  // Once something has recorded 'void', reading the persisted key first would keep
  // answering void forever, which is the state players would see.
  const c = finished();
  c.store.set(KEY_PHASE, 'void');
  assert.equal(phaseOf(c.cfg, c.store), 'done');
  const out = await invoke(c);
  assert.equal(out.phase, 'done');
  cleanup(c.fx.dir);
});

test('the result is served from disk when the database no longer holds it', async () => {
  const c = finished();
  const out = await invoke(c);
  assert.equal(out.results.R, c.results.R);
  assert.deepEqual(out.results.permutation, c.results.permutation);
  cleanup(c.fx.dir);
});

// ---------------------------------------------------------------------------
// finish the sync, but only when it was never recorded
// ---------------------------------------------------------------------------

test('a sync that never ran is completed on the next tick', async () => {
  // The crash window: results.json published and the phase already 'done', with the
  // process dying before the sync. Nothing used to pick this up.
  const c = finished();
  const out = await invoke(c);
  assert.equal(out.resumed, true);
  assert.equal(out.sync.status, 'ok');
  assert.equal(c.pantheon.prescript, c.results.pantheon_prescript);

  const written = JSON.parse(fs.readFileSync(path.join(c.fx.dir, 'events', 'sync.json'), 'utf8'));
  assert.equal(written.status, 'ok');
  assert.equal(written.round_used, c.results.round_used);
  assert.ok(c.mirrored.includes('events/sync.json'));
  cleanup(c.fx.dir);
});

test('a recorded failure is left alone — it carries a manual remedy', async () => {
  // Retrying every five minutes forever would bury the remedy under mirror noise and
  // fight an operator who has already pasted the prescript in by hand.
  const c = finished();
  c.store.set(KEY_SYNC, { status: 'failed', at: '2026-09-09T00:00:00.000Z', attempts: 3 });
  const calls = [];
  c.pantheon.setPrescript = async () => calls.push('setPrescript');

  const out = await invoke(c);
  assert.equal(out.resumed, undefined);
  assert.deepEqual(calls, []);
  assert.equal(c.store.get(KEY_SYNC).status, 'failed', 'the recorded outcome must survive');
  cleanup(c.fx.dir);
});

test('an already published events/sync.json stops it running again', async () => {
  const c = finished();
  fs.mkdirSync(path.join(c.fx.dir, 'events'), { recursive: true });
  fs.writeFileSync(path.join(c.fx.dir, 'events', 'sync.json'), JSON.stringify({ status: 'ok' }));
  const calls = [];
  c.pantheon.setPrescript = async () => calls.push('setPrescript');

  const out = await invoke(c);
  assert.equal(out.resumed, undefined);
  assert.deepEqual(calls, [], 'the database may be gone, but the published record is not');
  cleanup(c.fx.dir);
});

test('a resumed sync that fails is recorded, and still never re-draws', async () => {
  const c = finished();
  c.pantheon.setPrescript = async () => { throw new Error('mimir down'); };
  const out = await invoke(c, { sync: { attempts: 2, baseDelayMs: 1 } });
  assert.equal(out.sync.status, 'failed');
  assert.match(out.sync.remedy, /Do NOT re-run the draw/);
  assert.equal(out.phase, 'done');
  assert.equal(fs.existsSync(path.join(c.fx.dir, 'events', 'void.json')), false);
  cleanup(c.fx.dir);
});

test('the resumed sync never touches results.json', async () => {
  const c = finished();
  const before = fs.readFileSync(path.join(c.fx.dir, 'results.json'), 'utf8');
  await invoke(c);
  const after = fs.readFileSync(path.join(c.fx.dir, 'results.json'), 'utf8');
  assert.equal(after, before, 'results.json is written once and never rewritten (§4.3)');
  assert.equal(JSON.parse(after).pantheon_sync, undefined);
  cleanup(c.fx.dir);
});

// ---------------------------------------------------------------------------
// the other terminal state: a void round
// ---------------------------------------------------------------------------

/** A round that is past its cutoff with n submissions and nothing published yet. */
function belowQuorum(n) {
  const fx = makeDataDir({ protocol: { submission_cutoff_utc: PAST() } });
  const cfg = load({ dataDir: fx.dataDir });
  cfg.root = fx.dir;
  const store = new Store(':memory:');
  const receivedAt = cfg.protocol.cutoff_ms - 60_000;
  for (let i = 1; i <= n; i++) {
    store.insertSubmission(i, fakeCiphertext(cfg.protocol.target_round, cfg.protocol.chain_hash), receivedAt);
  }
  const mirrored = [];
  return {
    fx, cfg, store, mirrored,
    pantheon: new StubPantheon({ roster: fx.roster }),
    mirror: { enabled: false, enqueue: (p) => mirrored.push(p), flush: async () => {}, drain: async () => true },
    drand: { round: async () => { throw new Error('the job tried to draw below quorum'); } },
  };
}

test('a round below quorum actually publishes its void notice', async () => {
  // The guard added for the restore case originally used the DERIVED phase, which
  // already answers 'void' for a round whose notice has not been written yet. That made
  // the job return early and publish nothing: the round was void in the API and
  // invisible in the repository. Guarding on a published file rather than a prediction
  // is what fixes it, and this is the test that says so.
  const c = belowQuorum(7);
  const out = await invoke(c);
  assert.equal(out.phase, 'void');
  assert.ok(out.notice, 'run() must return the notice it published');
  assert.equal(fs.existsSync(path.join(c.fx.dir, 'events', 'void.json')), true);
  assert.ok(c.mirrored.includes('events/void.json'), 'the notice has to reach the repository');

  const notice = JSON.parse(fs.readFileSync(path.join(c.fx.dir, 'events', 'void.json'), 'utf8'));
  assert.deepEqual(notice.submitted_local_ids, [1, 2, 3, 4, 5, 6, 7]);
  assert.match(notice.remedy, /ALL 12 players submit again/);
  cleanup(c.fx.dir);
});

test('a published void notice is not rewritten on the next tick', async () => {
  const c = belowQuorum(7);
  await invoke(c);
  const first = fs.readFileSync(path.join(c.fx.dir, 'events', 'void.json'), 'utf8');
  c.mirrored.length = 0;

  const out = await invoke(c);
  assert.equal(out.phase, 'void');
  assert.equal(fs.readFileSync(path.join(c.fx.dir, 'events', 'void.json'), 'utf8'), first);
  assert.deepEqual(c.mirrored, []);
  cleanup(c.fx.dir);
});

test('a void notice survives a lost database without being rewritten emptier', async () => {
  // Recomputing the notice from a database that no longer holds the submissions would
  // replace a true record of who had submitted with an empty one.
  const c = belowQuorum(7);
  await invoke(c);
  const first = JSON.parse(fs.readFileSync(path.join(c.fx.dir, 'events', 'void.json'), 'utf8'));

  c.store = new Store(':memory:');
  c.mirrored.length = 0;
  const out = await invoke(c);
  assert.equal(out.phase, 'void');
  const again = JSON.parse(fs.readFileSync(path.join(c.fx.dir, 'events', 'void.json'), 'utf8'));
  assert.deepEqual(again.submitted_local_ids, first.submitted_local_ids);
  assert.deepEqual(c.mirrored, []);
  cleanup(c.fx.dir);
});

test('phaseOf reports void from the published notice alone', async () => {
  const c = belowQuorum(7);
  await invoke(c);
  assert.equal(phaseOf(c.cfg, new Store(':memory:')), 'void');
  cleanup(c.fx.dir);
});

// ---------------------------------------------------------------------------
// leaving evidence that it ran at all
// ---------------------------------------------------------------------------

test('every run records that the job ran, including the ones that do nothing', async () => {
  // The web server does not draw, so "the beacon is out and the phase has not moved"
  // has two explanations with opposite remedies: drand is late, or nobody ever
  // installed the timer. Nothing could tell them apart, and the page said "Drawing"
  // through both. The heartbeat is what separates them, which means it has to be
  // written by the no-op runs too — before the cutoff, the no-op IS every run.
  const fx = makeDataDir({ protocol: { submission_cutoff_utc: new Date(Date.now() + 3_600_000).toISOString() } });
  const cfg = load({ dataDir: fx.dataDir });
  cfg.root = fx.dir;
  const store = new Store(':memory:');
  assert.ok(!store.get(KEY_TICK), 'nothing should have run yet');

  const out = await run({
    cfg, store, wait: false, log: QUIET,
    mirror: { enabled: false, enqueue() {}, drain: async () => true },
    pantheon: new StubPantheon(cfg),
    drand: { round: async () => { throw new Error('nothing should be drawn before the cutoff'); } },
  });
  assert.equal(out.phase, 'open', 'before the cutoff the job is a no-op');
  const tick = store.get(KEY_TICK);
  assert.ok(tick, 'a no-op run still has to leave proof it ran');
  assert.ok(Math.abs(Date.now() - Date.parse(tick.at)) < 60_000);
  cleanup(fx.dir);
});

test('the heartbeat is written before the work, so a crash still proves the job fired', async () => {
  // Recording it on success would make a job that runs and then dies look exactly like
  // one that was never installed, which is the failure this key exists to rule out.
  const c = finished();
  c.pantheon = { getPrescript: async () => { throw new Error('Pantheon is down'); },
                 setPrescript: async () => { throw new Error('Pantheon is down'); } };
  await invoke(c).catch(() => {});
  assert.ok(c.store.get(KEY_TICK), 'the run left no trace');
  cleanup(c.fx.dir);
});

// ---------------------------------------------------------------------------
// the push that never happened
// ---------------------------------------------------------------------------

/**
 * results.json is written to disk and queued for the mirror in the same breath, but the
 * queue lives in memory and the push happens at the end of the run, with the Pantheon
 * sync in between. A process that dies in that gap leaves the result on the organiser's
 * disk and absent from the public repository — and that file is exactly what the README
 * tells a player to verify against. Nothing noticed, because the next tick sees
 * results.json on disk and reports "already done".
 */

/** The same fixture, with a mirror that is switched on and records what it is given. */
function finishedWithMirror(opts = {}) {
  const c = finished(opts);
  const pushed = [];
  c.pushed = pushed;
  c.mirror = {
    enabled: true,
    enqueue: (p, body, msg) => pushed.push({ p, body, msg }),
    flush: async () => {},
    drain: async () => opts.drains !== false,
  };
  return c;
}

test('a draw whose push never completed is re-mirrored on the next tick', async () => {
  const c = finishedWithMirror();
  const out = await invoke(c);
  assert.equal(out.phase, 'done');
  assert.equal(out.republished, true);

  const paths = c.pushed.map((x) => x.p);
  assert.ok(paths.includes('results.json'), `results.json was not re-pushed: ${paths.join(', ')}`);

  // The bytes must be the ones on disk. What the store holds has the derived statistics
  // merged in, and pushing those would publish a file that does not reproduce (§4.3).
  const onDisk = fs.readFileSync(path.join(c.fx.dir, 'results.json'), 'utf8');
  assert.equal(c.pushed.find((x) => x.p === 'results.json').body, onDisk);
  cleanup(c.fx.dir);
});

test('and once it has been pushed, it is not pushed again every minute', async () => {
  const c = finishedWithMirror();
  await invoke(c);
  const after = c.pushed.length;
  await invoke(c);
  assert.equal(c.pushed.length, after, 'the second tick re-pushed a settled draw');
  cleanup(c.fx.dir);
});

test('a queue that will not drain leaves the job knowing it still owes a push', async () => {
  // Recording success on a drain that failed would be worse than not recording at all:
  // the one run that could still fix it would decide there was nothing to fix.
  const c = finishedWithMirror({ drains: false });
  const out = await invoke(c);
  assert.ok(!out.republished, 'a drain that failed is not a push that happened');
  assert.ok(!c.store.get(KEY_PUBLISHED), 'a failed drain must not count as published');
  cleanup(c.fx.dir);
});

test('with no mirror configured there is nothing outstanding to re-push', async () => {
  const c = finished(); // mirror.enabled === false
  await invoke(c);
  assert.equal(c.store.get(KEY_PUBLISHED), true, 'nothing to push is not the same as unpushed');
  assert.ok(!c.mirrored.includes('results.json'), 'there is nowhere to re-push it to');
  cleanup(c.fx.dir);
});

test('a results.json that cannot be parsed is said out loud, not swallowed', async () => {
  // Unreachable now that the file is renamed into place, so reaching it means an editor
  // or a failing disk. It used to end here in silence: phase done, no result, and every
  // player getting a 500 from /api/result forever.
  const c = finished();
  fs.writeFileSync(path.join(c.fx.dir, 'results.json'), '{"seating": [tru');
  const errors = [];
  const out = await invoke(c, { log: { info() {}, warn() {}, error: (m) => errors.push(m) } });
  assert.equal(out.phase, 'done');
  assert.equal(out.results, null);
  assert.match(errors.join('\n'), /could not be parsed/);
  assert.match(errors.join('\n'), /draw again/, 'the message has to say what to do about it');
  cleanup(c.fx.dir);
});

/**
 * The same gap, on the two files where it costs more.
 *
 * `events/snapshot.json` is written once at the cutoff and guarded against ever being
 * written again, so a push lost between that write and the end of the run was lost for
 * good — and that file is the whole of PROTOCOL §9: the roll is public before the beacon,
 * or it proves nothing. `events/void.json` had the same shape, on the path where a round
 * is void in the API and invisible in the repository.
 */

/** A mirror that records what it is given and can be told the queue did not empty. */
const watcher = (opts = {}) => {
  const pushed = [];
  return {
    pushed,
    mirror: {
      enabled: true,
      enqueue: (p, body) => pushed.push({ p, body }),
      flush: async () => {},
      drain: async () => opts.drains !== false,
    },
  };
};

test('a void round works the queue before the process is allowed to exit', async () => {
  // publishVoid enqueued and returned. enqueue starts a flush it does not await, and the
  // command-line entry point calls process.exit as soon as run() resolves, so on a real
  // void round the notice was raced against the exit and usually lost.
  const c = belowQuorum(7);
  const w = watcher();
  c.mirror = w.mirror;
  let drained = 0;
  c.mirror.drain = async () => { drained += 1; return true; };

  const out = await invoke(c);
  assert.equal(out.phase, 'void');
  assert.ok(w.pushed.some((x) => x.p === 'events/void.json'));
  assert.ok(drained >= 1, 'the void path returned without working the queue');
  assert.equal(c.store.get(KEY_PUBLISHED), true);

  // And the write itself marked the repository behind, so that a process dying between
  // the write and the drain leaves a record for the next run rather than a stale 'done'.
  const c2 = belowQuorum(7);
  c2.mirror = watcher().mirror;
  c2.store.set(KEY_PUBLISHED, true);          // a previous run had caught up
  c2.mirror.drain = async () => { throw new Error('killed before the queue was worked'); };
  await invoke(c2).catch(() => {});
  assert.ok(!c2.store.get(KEY_PUBLISHED), 'writing the notice must mark the repository behind');
  cleanup(c2.fx.dir);
  cleanup(c.fx.dir);
});

test('a roll published at the cutoff and never pushed is offered again next tick', async () => {
  const c = belowQuorum(12);           // quorum met, so the job takes the roll and waits
  const w = watcher();
  c.mirror = w.mirror;
  // No beacon yet: the run publishes the roll and returns awaiting_round. That return is
  // the common one, and it is where the snapshot used to be abandoned in the queue.
  c.drand = { round: async () => { throw new Error('not out yet'); } };

  const first = await invoke(c, { maxWaitMs: 0 });
  assert.equal(first.phase, 'awaiting_round');
  assert.ok(w.pushed.some((x) => x.p === 'events/snapshot.json'), 'the roll was never queued');
  assert.ok(fs.existsSync(path.join(c.fx.dir, 'events', 'snapshot.json')));

  // Now simulate the process having died before the queue emptied: the file is on disk,
  // nothing recorded a push.
  c.store.set(KEY_PUBLISHED, false);
  w.pushed.length = 0;

  await invoke(c, { maxWaitMs: 0 });
  assert.ok(
    w.pushed.some((x) => x.p === 'events/snapshot.json'),
    'the next tick left the roll unpublished, and nothing else ever writes it again');
  cleanup(c.fx.dir);
});

test('the roll is offered before the result, so a reader never finds one without the other', async () => {
  const c = finished();
  fs.mkdirSync(path.join(c.fx.dir, 'events'), { recursive: true });
  fs.writeFileSync(path.join(c.fx.dir, 'events', 'snapshot.json'), '{"local_ids":[1]}');
  const w = watcher();
  c.mirror = w.mirror;

  await invoke(c);
  const order = w.pushed.map((x) => x.p);
  assert.ok(
    order.indexOf('events/snapshot.json') < order.indexOf('results.json'),
    `the result went out before the file needed to audit it: ${order.join(', ')}`);
  cleanup(c.fx.dir);
});
