'use strict';

/**
 * The freeze, as a command (RUNBOOK steps 10-11).
 *
 * Every refusal here corresponds to a failure that would otherwise surface after the
 * draw, when nothing can be changed. A missing `local_id` is the sharpest example: it
 * blocks the seat-plan sync, and the sync runs once the seat plan already exists.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { snapshotRoster, applyRosterSnapshot, alignTagRefs, FROZEN } = require('../tools/freeze');
const { load } = require('../server/config');
const { createPantheon } = require('../server/pantheon');
const { makeDataDir, makeRoster, cleanup } = require('./helpers');

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

test('an unreachable Pantheon is named down to the address and the reason', async () => {
  // What an operator got at step 10 on a server with no /etc/hosts entry for
  // mimir.pantheon.local was "GetAllRegisteredPlayers: fetch failed" and nothing else.
  // Node's fetch puts the reason in err.cause, and the client passed on only the message,
  // so a name that does not resolve and a port nobody listens on read identically. Run
  // through the real client, so what is tested is the unwrapping, not a fake that already
  // says the right thing.
  const { TwirpPantheon } = require('../server/pantheon');
  const url = 'http://mimir.pantheon.local:4001/v2/common.Mimir/GetAllRegisteredPlayers';
  const failing = (code, message) => async () => {
    throw new TypeError('fetch failed', { cause: Object.assign(new Error(message), { code }) });
  };
  const cases = [
    ['ENOTFOUND', 'getaddrinfo ENOTFOUND mimir.pantheon.local',
      ['the name mimir.pantheon.local does not resolve', '/etc/hosts']],
    ['ECONNREFUSED', 'connect ECONNREFUSED 127.0.0.1:4001',
      ['nothing is listening on mimir.pantheon.local:4001', 'The name resolved']],
  ];
  for (const [code, message, expected] of cases) {
    const { fx, cfg } = fixture();
    const problems = [];
    const pantheon = new TwirpPantheon(
      { mimir_base_url: 'http://mimir.pantheon.local:4001' }, {}, { fetch: failing(code, message) });
    const snap = await snapshotRoster(cfg, problems, pantheon);
    const said = problems.join('\n');
    assert.equal(snap, null);
    assert.ok(said.includes(url), `${code}: the URL that was tried must be named:\n${said}`);
    for (const phrase of expected) assert.ok(said.includes(phrase), `${code}: expected "${phrase}" in:\n${said}`);
    assert.ok(!said.includes('fetch failed'), `${code}: the wrapper's two words are not a reason:\n${said}`);
    cleanup(fx.dir);
  }
});

test('the snapshot is ordered by local_id, so two freezes of one roster agree', async () => {
  const { fx, cfg } = fixture();
  const shuffled = [...registered(cfg)].reverse();
  const snap = await snapshotRoster(cfg, [], fake(shuffled));
  assert.deepEqual(snap.players.map((p) => p.local_id), [1,2,3,4,5,6,7,8,9,10,11,12]);
  cleanup(fx.dir);
});

// ---------------------------------------------------------------------------
// the first freeze of an event, when data/roster.json does not exist yet

test('the roster can be snapshotted before data/roster.json exists', async () => {
  // The state every event starts in, and the one the command could not handle: writing
  // that file is step 10's whole job, so the event id has to come from somewhere else.
  const fx = makeDataDir();
  fs.rmSync(path.join(fx.dataDir, 'roster.json'));
  const cfg = load({ dataDir: fx.dataDir, rosterOptional: true });
  cfg.root = fx.dir;

  const players = makeRoster(12, 4242).players.map((p) => ({ ...p, ignore_seating: false }));
  const problems = [];
  const snap = await snapshotRoster(cfg, problems, fake(players), 4242);

  assert.deepEqual(problems, []);
  assert.equal(snap.pantheon_event_id, 4242);
  assert.equal(snap.players.length, 12);
  cleanup(fx.dir);
});

test('with no roster and no event id, the refusal says how to give it one', async () => {
  const fx = makeDataDir();
  fs.rmSync(path.join(fx.dataDir, 'roster.json'));
  const cfg = load({ dataDir: fx.dataDir, rosterOptional: true });
  const problems = [];
  assert.equal(await snapshotRoster(cfg, problems, fake([])), null);
  assert.match(problems.join('\n'), /--event <id>/);
  cleanup(fx.dir);
});

test('a roster already in the file wins over --event, so a freeze cannot switch events', async () => {
  // The event id is scoped to the sign-in gate. Letting a flag override a roster that is
  // already frozen would let one command quietly re-point the draw at another event.
  const fx = makeDataDir();
  const cfg = load({ dataDir: fx.dataDir });
  const problems = [];
  const snap = await snapshotRoster(cfg, problems, fake(registered(cfg)), 4242);
  assert.equal(snap.pantheon_event_id, 42);
  cleanup(fx.dir);
});

test('an attendee marked ignore_seating is left out of the twelve', async () => {
  // RUNBOOK step 8 names this case: present at the event, not in the draw. Counting them
  // would make the roster thirteen and fail the total_slots check for the wrong reason.
  const fx = makeDataDir();
  const cfg = load({ dataDir: fx.dataDir });
  const withScorer = [...registered(cfg), { person_id: 9099, title: '记录员', local_id: 0, ignore_seating: true }];
  const problems = [];
  const snap = await snapshotRoster(cfg, problems, fake(withScorer));
  assert.deepEqual(problems, []);
  assert.equal(snap.players.length, 12);
  assert.ok(!snap.players.some((p) => p.person_id === 9099));
  cleanup(fx.dir);
});

test('the stub can be pointed at a roster the repository has not seen', async () => {
  // Seeded from cfg.roster, a stub can only ever agree with the file — which makes it
  // useless for rehearsing the step whose job is to write that file. Two differences
  // here that a real Pantheon would also show: a different event, and a thirteenth
  // registration that is not playing.
  const fx = makeDataDir();
  fs.rmSync(path.join(fx.dataDir, 'roster.json'));   // as at a first freeze
  const cfg = load({ dataDir: fx.dataDir, rosterOptional: true });
  const file = path.join(fx.dir, 'pantheon-event.json');
  fs.writeFileSync(file, JSON.stringify({
    pantheon_event_id: 4242,
    players: [
      ...makeRoster(12, 4242).players,
      { local_id: 0, person_id: 9099, title: '记录员', ignore_seating: true },
    ],
  }));

  const pantheon = createPantheon(cfg, { PANTHEON_MODE: 'stub', PANTHEON_STUB_ROSTER: file });
  const roster = await pantheon.getEventRoster(4242);
  assert.equal(roster.length, 13);
  assert.equal(roster.filter((p) => !p.ignore_seating).length, 12);
  assert.deepEqual(await pantheon.getEventRoster(42), [], 'a different event must be empty');

  const problems = [];
  const snap = await snapshotRoster(cfg, problems, pantheon, 4242);
  assert.deepEqual(problems, []);
  assert.equal(snap.players.length, 12);
  cleanup(fx.dir);
});

// ---------------------------------------------------------------------------
// what a refused freeze is allowed to leave behind

test('a refused freeze writes no roster at all', async () => {
  // snapshotRoster reports what is wrong with the registrations and still returns what
  // it read, so this guard is the only thing standing between a refusal and a
  // data/roster.json built from a registration list that was just refused. The run after
  // that one would find a file where there had been none and compare against it.
  const fx = makeDataDir();
  fs.rmSync(path.join(fx.dataDir, 'roster.json'));
  const cfg = load({ dataDir: fx.dataDir, rosterOptional: true });

  const players = makeRoster(12, 4242).players.map((p, i) => ({
    ...p, ignore_seating: false, local_id: i === 6 ? null : p.local_id,
  }));
  const problems = [];
  const lines = [];
  const snap = await snapshotRoster(cfg, problems, fake(players), 4242);
  assert.equal(problems.length, 1, 'the missing local_id must be reported');

  const after = applyRosterSnapshot({ cfg, snapshot: snap, problems, lines, write: true });
  assert.equal(after.roster, null);
  assert.ok(!fs.existsSync(path.join(fx.dataDir, 'roster.json')), 'nothing may be written');
  assert.match(lines.join('\n'), /not written/);
  cleanup(fx.dir);
});

test('a clean snapshot is written, and re-read strictly before the checks run', async () => {
  const fx = makeDataDir();
  fs.rmSync(path.join(fx.dataDir, 'roster.json'));
  const cfg = load({ dataDir: fx.dataDir, rosterOptional: true });
  const players = makeRoster(12, 4242).players.map((p) => ({ ...p, ignore_seating: false }));
  const problems = [];
  const snap = await snapshotRoster(cfg, problems, fake(players), 4242);

  const after = applyRosterSnapshot({ cfg, snapshot: snap, problems, lines: [], write: true });
  assert.deepEqual(problems, []);
  assert.equal(after.roster.players.length, 12, 'the returned config must be the strict re-read');
  assert.equal(after.rosterError, null);
  assert.equal(after.byPersonId.size, 12);
  cleanup(fx.dir);
});

test('without --write nothing is written, however clean the snapshot is', async () => {
  const fx = makeDataDir();
  fs.rmSync(path.join(fx.dataDir, 'roster.json'));
  const cfg = load({ dataDir: fx.dataDir, rosterOptional: true });
  const players = makeRoster(12, 4242).players.map((p) => ({ ...p, ignore_seating: false }));
  const lines = [];
  const snap = await snapshotRoster(cfg, [], fake(players), 4242);
  applyRosterSnapshot({ cfg, snapshot: snap, problems: [], lines, write: false });
  assert.ok(!fs.existsSync(path.join(fx.dataDir, 'roster.json')));
  assert.match(lines.join('\n'), /re-run with --write/);
  cleanup(fx.dir);
});

/**
 * The tag, written into the file that names it.
 *
 * schedule_template_ref and generate_script_ref say which tag the other three frozen
 * artefacts come from. They are the one part of protocol.json that config.js cannot
 * check at load time, because the tag does not exist until the freeze creates it, and
 * the only check there was asked whether they contained an "@".
 *
 * So they stayed at whatever data/protocol.example.json shipped, which was a tag name
 * invented in a document. That is not inert metadata: the result stage reads the tag out
 * of generate_script_ref and prints it to twelve players as the thing to check out, and
 * generate.js compares the two refs to decide whether a verifier is holding the wrong
 * protocol.json. An organiser who tagged anything else shipped a result page naming a
 * tag that has never existed anywhere.
 */
test('the tag being created is written into the protocol that names it', () => {
  const { fx, cfg } = fixture();
  const lines = [];
  const problems = [];

  const next = alignTagRefs(cfg, 'spring-2026-r3', lines, problems);
  assert.deepEqual(problems, []);

  const written = JSON.parse(fs.readFileSync(path.join(fx.dataDir, 'protocol.json'), 'utf8'));
  assert.equal(written.schedule_template_ref, 'data/schedule_template.json@spring-2026-r3');
  assert.equal(written.generate_script_ref, 'generate.js@spring-2026-r3');
  // And handed back re-loaded, so everything downstream checks the file that will be
  // committed rather than the object this process happened to be holding.
  assert.equal(next.protocol.generate_script_ref, 'generate.js@spring-2026-r3');
  assert.match(lines.join('\n'), /tag references set to @spring-2026-r3/);
  cleanup(fx.dir);
});

test('what it changed is printed, because it edited a frozen file to do it', () => {
  const { fx, cfg } = fixture();
  const lines = [];
  alignTagRefs(cfg, 'autumn-open', lines, []);
  const out = lines.join('\n');
  assert.match(out, /generate_script_ref/);
  assert.match(out, /generate\.js@test/, 'the value it replaced should be visible');
  cleanup(fx.dir);
});

test('a protocol that already names the tag is left alone', () => {
  const { fx, cfg } = fixture();
  const file = path.join(fx.dataDir, 'protocol.json');
  const before = fs.readFileSync(file);
  const lines = [];
  alignTagRefs(cfg, 'test', lines, []);
  assert.ok(fs.readFileSync(file).equals(before), 'a file with nothing to change was rewritten');
  assert.match(lines.join('\n'), /already names the tag/);
  cleanup(fx.dir);
});

test('the rewritten protocol still loads, and still parses as JSON with a trailing newline', () => {
  const { fx, cfg } = fixture();
  alignTagRefs(cfg, 'club-night-1', [], []);
  const raw = fs.readFileSync(path.join(fx.dataDir, 'protocol.json'), 'utf8');
  assert.ok(raw.endsWith('\n'), 'data/*.json is committed verbatim; it needs its newline');
  assert.doesNotThrow(() => JSON.parse(raw));
  assert.doesNotThrow(() => load({ dataDir: fx.dataDir }));
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

// A freeze commits and tags, and what lands in the tag is what twelve people are told to
// check out. .gitignore is the only thing deciding what does not land there, so its rules
// are part of the freeze rather than housekeeping.
//
// A pattern ending in `/` matches directories only, and a symbolic link is a file to git,
// not a directory. `node_modules/` therefore did not stop `git add -A` from committing a
// symlink named node_modules — which is exactly how tools/rehearse.js attaches the
// sandbox to this tree, so the rehearsal tagged a link into the operator's home directory
// and fell over three minutes later cloning that tag. It only ever happened on Linux: the
// same call on Windows makes a junction, which git does read as a directory.
//
// None of the names in that file is ever a file this repository wants to keep, so the
// rule is simply that none of them carries the slash. `secrets` is the one where the cost
// of being wrong is not a failed rehearsal.
test('no ignore rule is written so that a symlink slips past it', () => {
  const raw = fs.readFileSync(path.join(__dirname, '..', '.gitignore'), 'utf8');
  const dirOnly = raw.split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#') && line.endsWith('/'));
  assert.deepEqual(dirOnly, [], 'these match directories only, so a symlink of the same name is committed: '
    + `${dirOnly.join(', ')}. Drop the trailing slash.`);
});
