'use strict';

/**
 * The freeze, as a command (RUNBOOK steps 8-11).
 *
 * Every refusal here corresponds to a failure that would otherwise surface after the
 * draw, when nothing can be changed. A missing `local_id` is the sharpest example: it
 * blocks the seat-plan sync, and the sync runs once the seat plan already exists.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { snapshotRoster, FROZEN } = require('../tools/freeze');
const { load } = require('../server/config');
const { makeDataDir, cleanup } = require('./helpers');

/** A Pantheon that returns exactly what the test asks for. */
const fake = (players) => ({ getEventRoster: async () => players });

function fixture() {
  const fx = makeDataDir();
  const cfg = load({ dataDir: fx.dataDir });
  cfg.root = fx.dir;
  return { fx, cfg };
}

const registered = (cfg, over = (p) => p) =>
  cfg.roster.players.map((p) => over({
    person_id: p.person_id, title: p.title, local_id: p.local_id, ignore_seating: false,
  }));

test('a matching roster snapshots cleanly', async () => {
  const { fx, cfg } = fixture();
  const problems = [];
  const snap = await snapshotRoster(cfg, problems, fake(registered(cfg)));
  assert.deepEqual(problems, []);
  assert.equal(snap.pantheon_event_id, 42);
  assert.equal(snap.players.length, 12);
  assert.deepEqual(snap.players.map((p) => p.local_id), [1,2,3,4,5,6,7,8,9,10,11,12]);
  cleanup(fx.dir);
});

test('a player without a local_id is refused, by name', async () => {
  // It blocks the seat-plan sync, and the sync happens after the draw.
  const { fx, cfg } = fixture();
  const problems = [];
  await snapshotRoster(cfg, problems, fake(registered(cfg, (p) =>
    p.local_id === 5 ? { ...p, local_id: null } : p)));
  assert.equal(problems.length, 1);
  assert.match(problems[0], /no usable local_id for:/);
  assert.match(problems[0], new RegExp(cfg.roster.players[4].title));
  assert.match(problems[0], /blocks the sync/);
  cleanup(fx.dir);
});

test('a thirteenth registration is refused — it changes who is in the draw', async () => {
  const { fx, cfg } = fixture();
  const problems = [];
  await snapshotRoster(cfg, problems, fake([
    ...registered(cfg),
    { person_id: 9999, title: 'Gatecrasher', local_id: 13, ignore_seating: false },
  ]));
  assert.match(problems.join('\n'), /13 seated players, protocol\.json says 12/);
  cleanup(fx.dir);
});

test('players marked ignore_seating are left out rather than counted', async () => {
  const { fx, cfg } = fixture();
  const problems = [];
  const snap = await snapshotRoster(cfg, problems, fake([
    ...registered(cfg),
    { person_id: 9999, title: 'Referee', local_id: 13, ignore_seating: true },
  ]));
  assert.deepEqual(problems, []);
  assert.equal(snap.players.length, 12);
  cleanup(fx.dir);
});

test('one account registered twice is refused — it could submit twice', async () => {
  const { fx, cfg } = fixture();
  const problems = [];
  const dup = registered(cfg);
  dup[3].person_id = dup[2].person_id;
  await snapshotRoster(cfg, problems, fake(dup));
  assert.match(problems.join('\n'), /registered twice/);
  cleanup(fx.dir);
});

test('a local_id outside the one-byte encoding is refused', async () => {
  // §7 encodes local_id as a single unsigned byte, so 256 is not a large number, it is
  // an unrepresentable one.
  const { fx, cfg } = fixture();
  const problems = [];
  await snapshotRoster(cfg, problems, fake(registered(cfg, (p) =>
    p.local_id === 1 ? { ...p, local_id: 256 } : p)));
  assert.match(problems.join('\n'), /no usable local_id/);
  cleanup(fx.dir);
});

test('Pantheon being unreachable is reported, not swallowed', async () => {
  const { fx, cfg } = fixture();
  const problems = [];
  const snap = await snapshotRoster(cfg, problems, {
    getEventRoster: async () => { throw new Error('connect ECONNREFUSED'); },
  });
  assert.equal(snap, null);
  assert.match(problems.join('\n'), /Pantheon did not answer for event 42/);
  cleanup(fx.dir);
});

test('the snapshot is ordered by local_id, so two freezes of one roster agree', async () => {
  const { fx, cfg } = fixture();
  const shuffled = [...registered(cfg)].reverse();
  const snap = await snapshotRoster(cfg, [], fake(shuffled));
  assert.deepEqual(snap.players.map((p) => p.local_id), [1,2,3,4,5,6,7,8,9,10,11,12]);
  cleanup(fx.dir);
});

test('the frozen set is exactly the four PROTOCOL.md §4 names', () => {
  // Adding a fifth here would silently widen the freeze; dropping one would silently
  // narrow it. Both are the kind of change that should have to argue with a test.
  assert.deepEqual(FROZEN, [
    'data/roster.json',
    'data/protocol.json',
    'data/schedule_template.json',
    'generate.js',
  ]);
  for (const f of FROZEN) {
    assert.ok(
      fs.existsSync(path.join(__dirname, '..', f)) || f === 'data/roster.json' || f === 'data/protocol.json',
      `${f} should exist in the repository`
    );
  }
});
