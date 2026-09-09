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

const { run, phaseOf, KEY_PHASE, KEY_SYNC } = require('../server/finalise');
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
