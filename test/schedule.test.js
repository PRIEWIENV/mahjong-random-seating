'use strict';

/**
 * The server running the draw on a clock (server/schedule.js).
 *
 * The draw is a separate program on purpose (§9: nothing an outsider can poke may
 * trigger or re-time it), and for a while the only documented way to run it on a
 * schedule was a systemd timer. That needs root, and on Windows it does not exist at
 * all, so the realistic outcome was a deployment that served the page perfectly and
 * never drew: twelve people watching a countdown reach zero and stop.
 *
 * These tests are about the two things that have to be true for the server to own that
 * schedule without giving anything away: it must spawn the same command a cron would,
 * and it must never have two draws in flight at once.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');

const { startScheduler, JOB } = require('../server/schedule');

const QUIET = { info() {}, warn() {}, error() {} };
const cfgFor = (seconds = 60) => ({ root: '/somewhere', runtime: { server: { finalise_interval_seconds: seconds } } });

/** A stand-in for a spawned process, with the streams the scheduler reads. */
function fakeChild() {
  const c = new EventEmitter();
  c.stdout = new PassThrough();
  c.stderr = new PassThrough();
  c.finish = (code = 0) => { c.stdout.end(); c.stderr.end(); c.emit('exit', code); };
  return c;
}

/** Lets the initial setTimeout(…, 0) fire. */
const settle = () => new Promise((r) => setTimeout(r, 5));

test('it runs the same command a cron would, in the right directory', async () => {
  const calls = [];
  const child = fakeChild();
  const s = startScheduler({
    cfg: cfgFor(), log: QUIET, intervalMs: 60_000,
    spawnFn: (exe, args, opts) => { calls.push({ exe, args, opts }); return child; },
  });
  await settle();
  s.stop();

  assert.equal(calls.length, 1, 'it has to draw at boot, not one interval later');
  assert.equal(calls[0].exe, process.execPath);
  assert.deepEqual(calls[0].args, [JOB, '--no-wait']);
  // --no-wait matters: the scheduler ticks again shortly, so a job that blocked until
  // the beacon appeared would hold the slot for the whole interval between cutoff and
  // round, and every tick in it would be skipped.
  assert.equal(calls[0].opts.cwd, '/somewhere');
});

test('a draw already in flight is never joined by a second one', async () => {
  // Two concurrent draws would agree — the job is deterministic — but they would stamp
  // the roll twice and write to Pantheon twice, and external side effects are worth
  // not doing twice.
  const children = [];
  const warns = [];
  const s = startScheduler({
    cfg: cfgFor(), log: { ...QUIET, warn: (m) => warns.push(m) }, intervalMs: 60_000,
    spawnFn: () => { const c = fakeChild(); children.push(c); return c; },
  });
  await settle();
  assert.equal(s.running, true);

  s.tick(); s.tick();
  assert.equal(children.length, 1, 'a second job was started while the first was running');
  assert.equal(s.skipped, 2);
  assert.ok(warns.some((w) => /still running/.test(w)));

  children[0].finish(0);
  s.tick();
  assert.equal(children.length, 2, 'once the first finished, the next tick must draw');
  s.stop();
});

test('stop() means stop, including a tick already scheduled', async () => {
  const children = [];
  const s = startScheduler({
    cfg: cfgFor(), log: QUIET, intervalMs: 10,
    spawnFn: () => { const c = fakeChild(); children.push(c); return c; },
  });
  s.stop();
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(children.length, 0, 'the scheduler kept firing after it was stopped');
});

test('the job\'s own log lines reach the server log unchanged', async () => {
  // So that a deployment reads the same whether the timer is here or in cron: the job
  // already prefixes its lines, and re-wrapping them would make the two look different.
  const lines = [];
  const child = fakeChild();
  const s = startScheduler({
    cfg: cfgFor(), log: { ...QUIET, info: (m) => lines.push(m) }, intervalMs: 60_000,
    spawnFn: () => child,
  });
  await settle();
  child.stdout.write('[finalise] cutoff is 3 minute(s) away; nothing to do\n[finalise] done\n');
  await settle();
  s.stop();
  assert.deepEqual(lines, [
    '[finalise] cutoff is 3 minute(s) away; nothing to do',
    '[finalise] done',
  ]);
});

test('a job that cannot be started is reported, and the server carries on', async () => {
  // The alternative is an exception inside a timer callback, which takes the whole
  // server down and with it the page that would have explained what happened.
  const errors = [];
  const s = startScheduler({
    cfg: cfgFor(), log: { ...QUIET, error: (m) => errors.push(m) }, intervalMs: 60_000,
    spawnFn: () => { throw new Error('ENOENT'); },
  });
  await settle();
  assert.ok(errors.some((e) => /could not start/.test(e)));
  assert.equal(s.running, false, 'a failed spawn must not leave the slot occupied');
  s.stop();
});

test('a non-zero exit is reported rather than swallowed', async () => {
  const errors = [];
  const child = fakeChild();
  const s = startScheduler({
    cfg: cfgFor(), log: { ...QUIET, error: (m) => errors.push(m) }, intervalMs: 60_000,
    spawnFn: () => child,
  });
  await settle();
  child.finish(1);
  assert.ok(errors.some((e) => /exited 1/.test(e)));
  assert.equal(s.running, false);
  s.stop();
});

test('the interval comes from the runtime settings when none is passed', async () => {
  const s = startScheduler({ cfg: cfgFor(5), log: QUIET, spawnFn: () => fakeChild() });
  await settle();
  assert.equal(s.runs, 1);
  s.stop();
});

// ---------------------------------------------------------------------------
// one draw at a time, across processes
// ---------------------------------------------------------------------------

/**
 * The guard above is a variable in one process's memory, which decides nothing once two
 * processes exist. That is no longer hypothetical: the draw job now survives the signal
 * that stops the unit, so `systemctl restart` during a draw routinely leaves the old job
 * running while a new server starts and schedules another. Both would compute the same
 * seat plan, from the same fixed beacon and the same fixed snapshot, and then race each
 * other over the Pantheon prescript and the mirror queue.
 *
 * The opposite failure is worse and shapes every case below: a lock nobody holds must
 * never be able to stop the draw for good. An event that never draws at all is not an
 * improvement on a race nobody has hit.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { takeLock, releaseLock, lockPath } = require('../server/finalise');

const tempRoot = () => ({ root: fs.mkdtempSync(path.join(os.tmpdir(), 'mahjong-lock-')) });

test('the second draw job finds the lock taken and leaves', () => {
  const cfg = tempRoot();
  try {
    const held = takeLock(cfg);
    assert.ok(held, 'the first job must get the lock');
    assert.equal(takeLock(cfg), null, 'the second job must not');
    releaseLock(held);
    assert.ok(takeLock(cfg), 'and the next one gets it once the first is done');
  } finally {
    fs.rmSync(cfg.root, { recursive: true, force: true });
  }
});

test('a lock left by a process that is gone is taken over', () => {
  // A SIGKILL, an OOM, a power cut: the file outlives the process that wrote it. Every
  // subsequent run refusing to draw would turn one lost process into a lost event.
  const cfg = tempRoot();
  try {
    fs.mkdirSync(path.dirname(lockPath(cfg)), { recursive: true });
    // A pid that cannot be running: the kernel does not hand out 0x7FFFFFFF.
    fs.writeFileSync(lockPath(cfg), JSON.stringify({ pid: 2147483647, at: new Date().toISOString() }));
    assert.ok(takeLock(cfg), 'a dead holder must not hold anything');
    assert.equal(JSON.parse(fs.readFileSync(lockPath(cfg), 'utf8')).pid, process.pid);
  } finally {
    fs.rmSync(cfg.root, { recursive: true, force: true });
  }
});

test('a lock older than any real draw is taken over, whoever holds it', () => {
  // Pids are reused. Without an age ceiling, a lock whose number has been handed to some
  // unrelated long-lived process would refuse the draw forever.
  const cfg = tempRoot();
  try {
    fs.mkdirSync(path.dirname(lockPath(cfg)), { recursive: true });
    const hourAgo = new Date(Date.now() - 3_600_000).toISOString();
    fs.writeFileSync(lockPath(cfg), JSON.stringify({ pid: process.pid, at: hourAgo }));
    assert.ok(takeLock(cfg), 'an hour-old lock is not a running draw');
  } finally {
    fs.rmSync(cfg.root, { recursive: true, force: true });
  }
});

test('a lock this process really does hold, taken moments ago, is respected', () => {
  const cfg = tempRoot();
  try {
    fs.mkdirSync(path.dirname(lockPath(cfg)), { recursive: true });
    fs.writeFileSync(lockPath(cfg), JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
    assert.equal(takeLock(cfg), null);
  } finally {
    fs.rmSync(cfg.root, { recursive: true, force: true });
  }
});

test('a half-written lock file is not a claim', () => {
  const cfg = tempRoot();
  try {
    fs.mkdirSync(path.dirname(lockPath(cfg)), { recursive: true });
    fs.writeFileSync(lockPath(cfg), '{"pid":12');
    assert.ok(takeLock(cfg), 'unparseable is not held');
  } finally {
    fs.rmSync(cfg.root, { recursive: true, force: true });
  }
});
