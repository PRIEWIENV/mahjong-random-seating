'use strict';

/**
 * A voided attempt, its archive, and the road back (PROTOCOL.md §8).
 *
 * §8's remedy assumes a run can have more than one attempt. Two things have to be true
 * for that to be honest rather than merely possible:
 *
 *   1. the next attempt can actually open
 *   2. the previous one is still there, in full, for anyone who wants to check that
 *      "fewer than eight submitted" was a fact and not a convenient claim
 *
 * The second is why nothing is deleted, and why the reset refuses to run until the
 * archive verifies.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { run, phaseOf, publishRoll, KEY_ROLL, KEY_TICK } = require('../server/finalise');
const { load } = require('../server/config');
const { Store } = require('../server/db');
const { StubPantheon } = require('../server/pantheon');
const { verifyArchive, resetForNewRound, endEvent, readIndex, attemptsInThisRun } = require('../server/rounds');
const { makeDataDir, fakeCiphertext, cleanup } = require('./helpers');

const QUIET = { info() {}, warn() {}, error() {} };
const PAST = () => new Date(Date.now() - 3_600_000).toISOString();
const FUTURE = () => new Date(Date.now() + 3_600_000).toISOString();

/** A round past its cutoff with n submissions, nothing published yet. */
function attempt(n) {
  const fx = makeDataDir({ protocol: { submission_cutoff_utc: PAST() } });
  const c = {
    fx,
    cfg: load({ dataDir: fx.dataDir }),
    store: new Store(':memory:'),
    mirrored: [],
  };
  c.cfg.root = fx.dir;
  c.mirror = {
    enabled: false,
    enqueue: (p) => c.mirrored.push(p),
    flush: async () => {},
    drain: async () => true,
  };
  for (let i = 1; i <= n; i++) {
    c.store.insertSubmission(
      i, fakeCiphertext(c.cfg.protocol.target_round, c.cfg.protocol.chain_hash),
      c.cfg.protocol.cutoff_ms - 60_000
    );
  }
  return c;
}

const voidIt = (c) => run({
  cfg: c.cfg, store: c.store, mirror: c.mirror,
  pantheon: new StubPantheon({ roster: c.fx.roster }),
  drand: { round: async () => { throw new Error('the job tried to draw below quorum'); } },
  wait: false, log: QUIET,
});

/** Re-freeze at a later round, as RUNBOOK requires before any reset. */
function refreeze(c, over = {}) {
  const file = path.join(c.fx.dataDir, 'protocol.json');
  const p = JSON.parse(fs.readFileSync(file, 'utf8'));
  p.target_round = p.target_round + 100_000;
  p.submission_cutoff_utc = FUTURE();
  Object.assign(p, over);
  // The cutoff and the round it waits for move together, keeping reveal_gap_seconds
  // between them; the loader refuses a protocol.json where they disagree. Derived
  // after the overrides so a test that moves the cutoff moves both, unless it pinned
  // target_round_utc itself.
  if (!('target_round_utc' in over)) {
    p.target_round_utc = new Date(
      Date.parse(p.submission_cutoff_utc) + p.reveal_gap_seconds * 1000
    ).toISOString();
  }
  fs.writeFileSync(file, JSON.stringify(p, null, 2));
  c.cfg = load({ dataDir: c.fx.dataDir });
  c.cfg.root = c.fx.dir;
  return p;
}

const arch = (c, round) => path.join(c.fx.dir, 'events', 'rounds', String(round));

// ---------------------------------------------------------------------------
// the archive
// ---------------------------------------------------------------------------

test('a voided attempt is archived the moment it is declared void', async () => {
  const c = attempt(7);
  const voided = c.cfg.protocol.target_round;
  await voidIt(c);

  const dir = arch(c, voided);
  assert.ok(fs.existsSync(path.join(dir, 'manifest.json')));
  assert.ok(fs.existsSync(path.join(dir, 'void.json')));
  assert.ok(fs.existsSync(path.join(dir, 'snapshot.json')));
  for (let i = 1; i <= 7; i++) {
    assert.ok(fs.existsSync(path.join(dir, 'submissions', `${i}.json`)), `ciphertext ${i}`);
  }
  cleanup(c.fx.dir);
});

test('the archive keeps protocol.json as that attempt ran it', async () => {
  // The next attempt overwrites protocol.json with a new target_round. Without this
  // copy the archived ciphertexts would name a round nothing in the repository records,
  // and the evidence would be unopenable.
  const c = attempt(7);
  const voided = c.cfg.protocol.target_round;
  await voidIt(c);
  refreeze(c);

  const archived = JSON.parse(fs.readFileSync(path.join(arch(c, voided), 'protocol.json'), 'utf8'));
  assert.equal(archived.target_round, voided);
  assert.notEqual(archived.target_round, c.cfg.protocol.target_round);
  assert.ok(fs.existsSync(path.join(arch(c, voided), 'roster.json')));
  cleanup(c.fx.dir);
});

test('the manifest digests every archived file, and they verify', async () => {
  const c = attempt(7);
  const voided = c.cfg.protocol.target_round;
  await voidIt(c);

  const check = verifyArchive(c.cfg, voided);
  assert.ok(check.ok, check.problems.join('\n'));
  assert.equal(check.manifest.submitted_count, 7);
  assert.deepEqual(check.manifest.submitted_local_ids, [1, 2, 3, 4, 5, 6, 7]);
  assert.match(check.manifest.how_to_verify, /decrypt-submissions/);
  cleanup(c.fx.dir);
});

test('tampering with an archived ciphertext is detected', async () => {
  const c = attempt(7);
  const voided = c.cfg.protocol.target_round;
  await voidIt(c);

  const victim = path.join(arch(c, voided), 'submissions', '3.json');
  const rec = JSON.parse(fs.readFileSync(victim, 'utf8'));
  rec.ciphertext = rec.ciphertext.replace(/.$/, 'X');
  fs.writeFileSync(victim, JSON.stringify(rec, null, 2) + '\n');

  const check = verifyArchive(c.cfg, voided);
  assert.equal(check.ok, false);
  assert.match(check.problems.join('\n'), /digest mismatch: submissions\/3\.json/);
  cleanup(c.fx.dir);
});

test('the whole archive is mirrored, so it is timestamped by someone else', async () => {
  const c = attempt(7);
  const voided = c.cfg.protocol.target_round;
  await voidIt(c);
  const want = [
    `events/rounds/${voided}/protocol.json`,
    `events/rounds/${voided}/void.json`,
    `events/rounds/${voided}/submissions/1.json`,
    `events/rounds/${voided}/manifest.json`,
    'events/rounds/index.json',
  ];
  for (const w of want) assert.ok(c.mirrored.includes(w), `not mirrored: ${w}`);
  cleanup(c.fx.dir);
});

test('the index records each attempt and the digest of its manifest', async () => {
  const c = attempt(7);
  const voided = c.cfg.protocol.target_round;
  await voidIt(c);

  const [entry] = readIndex(c.cfg);
  assert.equal(entry.attempt, 1);
  assert.equal(entry.target_round, voided);
  assert.equal(entry.status, 'void');
  assert.equal(entry.submitted_count, 7);
  assert.match(entry.manifest_sha256, /^[0-9a-f]{64}$/);
  cleanup(c.fx.dir);
});

// ---------------------------------------------------------------------------
// the reset, and everything it refuses to do
// ---------------------------------------------------------------------------

test('a new attempt can actually open — the dead end is gone', async () => {
  const c = attempt(7);
  const voided = c.cfg.protocol.target_round;
  await voidIt(c);
  assert.equal(phaseOf(c.cfg, c.store), 'void');

  refreeze(c);
  const out = resetForNewRound(c.cfg, c.store, { log: QUIET });
  assert.ok(out.ok, out.error);
  assert.equal(out.cleared, 7);

  assert.equal(phaseOf(c.cfg, c.store), 'open');
  assert.deepEqual(c.store.submittedLocalIds(), [], 'lapsed ciphertexts must not count');
  const again = c.store.insertSubmission(1, fakeCiphertext(c.cfg.protocol.target_round, c.cfg.protocol.chain_hash), Date.now());
  assert.equal(again.stored, true, 'every player must be able to submit again');
  cleanup(c.fx.dir);
});

test('the reset leaves the previous attempt entirely intact', async () => {
  const c = attempt(7);
  const voided = c.cfg.protocol.target_round;
  await voidIt(c);
  const before = fs.readdirSync(path.join(arch(c, voided), 'submissions')).sort();

  refreeze(c);
  resetForNewRound(c.cfg, c.store, { log: QUIET });

  assert.deepEqual(fs.readdirSync(path.join(arch(c, voided), 'submissions')).sort(), before);
  assert.ok(verifyArchive(c.cfg, voided).ok, 'the archive must still verify afterwards');
  assert.equal(readIndex(c.cfg).length, 1);
  cleanup(c.fx.dir);
});

test('an open round cannot be reset — that is the step §8 forbids', () => {
  // Restarting because you dislike who has submitted is precisely the manipulable move.
  const c = attempt(7);
  const out = resetForNewRound(c.cfg, c.store, { log: QUIET });
  assert.equal(out.ok, false);
  assert.match(out.error, /only a round that was actually declared void/);
  cleanup(c.fx.dir);
});

test('a completed draw is never restarted', async () => {
  const c = attempt(7);
  await voidIt(c);
  refreeze(c);
  fs.writeFileSync(path.join(c.fx.dir, 'results.json'), '{}');
  const out = resetForNewRound(c.cfg, c.store, { log: QUIET });
  assert.equal(out.ok, false);
  assert.match(out.error, /completed draw is never restarted/);
  cleanup(c.fx.dir);
});

test('the reset refuses while protocol.json still names the voided round', async () => {
  // Re-freeze first, reset second. There is never a moment with an open round and no
  // announced target.
  const c = attempt(7);
  await voidIt(c);
  const out = resetForNewRound(c.cfg, c.store, { log: QUIET });
  assert.equal(out.ok, false);
  assert.match(out.error, /still names the voided round/);
  assert.deepEqual(c.store.submittedLocalIds(), [1, 2, 3, 4, 5, 6, 7], 'nothing may be cleared');
  cleanup(c.fx.dir);
});

test('the reset refuses if the archive does not verify', async () => {
  const c = attempt(7);
  const voided = c.cfg.protocol.target_round;
  await voidIt(c);
  refreeze(c);
  fs.rmSync(path.join(arch(c, voided), 'submissions', '2.json'));

  const out = resetForNewRound(c.cfg, c.store, { log: QUIET });
  assert.equal(out.ok, false);
  assert.match(out.error, /does not verify/);
  assert.match(out.error, /missing: submissions\/2\.json/);
  assert.deepEqual(c.store.submittedLocalIds(), [1, 2, 3, 4, 5, 6, 7], 'nothing may be cleared');
  cleanup(c.fx.dir);
});

test('the new target_round must come after the voided one', async () => {
  const c = attempt(7);
  const voided = c.cfg.protocol.target_round;
  await voidIt(c);
  refreeze(c, { target_round: voided - 1 });
  const out = resetForNewRound(c.cfg, c.store, { log: QUIET });
  assert.equal(out.ok, false);
  assert.match(out.error, /not after the voided round/);
  cleanup(c.fx.dir);
});

test('the new cutoff must be in the future', async () => {
  const c = attempt(7);
  await voidIt(c);
  refreeze(c, { submission_cutoff_utc: PAST() });
  const out = resetForNewRound(c.cfg, c.store, { log: QUIET });
  assert.equal(out.ok, false);
  assert.match(out.error, /already in the past/);
  cleanup(c.fx.dir);
});

test('a dry run changes nothing at all', async () => {
  const c = attempt(7);
  await voidIt(c);
  refreeze(c);
  const out = resetForNewRound(c.cfg, c.store, { dryRun: true, log: QUIET });
  assert.ok(out.ok, out.error);
  assert.deepEqual(c.store.submittedLocalIds(), [1, 2, 3, 4, 5, 6, 7]);
  assert.ok(fs.existsSync(path.join(c.fx.dir, 'events', 'void.json')), 'the notice must survive a dry run');
  cleanup(c.fx.dir);
});

test('two voided attempts stack up rather than overwrite each other', async () => {
  const c = attempt(7);
  const first = c.cfg.protocol.target_round;
  await voidIt(c);
  refreeze(c);
  resetForNewRound(c.cfg, c.store, { log: QUIET });

  // Second attempt: six submit this time, past a cutoff that has now passed.
  const second = c.cfg.protocol.target_round;
  refreeze(c, { target_round: second, submission_cutoff_utc: PAST() });
  for (let i = 1; i <= 6; i++) {
    c.store.insertSubmission(i, fakeCiphertext(second, c.cfg.protocol.chain_hash), c.cfg.protocol.cutoff_ms - 60_000);
  }
  await voidIt(c);

  const attempts = readIndex(c.cfg);
  assert.equal(attempts.length, 2);
  assert.deepEqual(attempts.map((a) => a.attempt), [1, 2]);
  assert.deepEqual(attempts.map((a) => a.target_round), [first, second]);
  assert.deepEqual(attempts.map((a) => a.submitted_count), [7, 6]);
  assert.ok(verifyArchive(c.cfg, first).ok, 'the first archive must survive the second void');
  assert.ok(verifyArchive(c.cfg, second).ok);
  cleanup(c.fx.dir);
});

// ---------------------------------------------------------------------------
// what a player can reach
// ---------------------------------------------------------------------------

const http = require('node:http');
const { createServer } = require('../server/server');

async function boot(c) {
  const { server } = createServer({
    cfg: c.cfg, store: c.store, mirror: c.mirror,
    pantheon: new StubPantheon({ roster: c.fx.roster }),
    publicDir: path.join(__dirname, '..', 'public'),
    drand: { latest: async () => ({ round: 1 }) }, drandPollMs: 0, log: QUIET,
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const get = (p) => new Promise((res) => {
    http.get({ host: '127.0.0.1', port, path: p }, (r) => {
      let b = '';
      r.on('data', (d) => { b += d; });
      r.on('end', () => res({ status: r.statusCode, type: (r.headers['content-type'] || '').split(';')[0], body: b }));
    });
  });
  const close = () => new Promise((r) => server.close(r));
  /**
   * Ask for the status and close, whatever the body of the check does.
   *
   * Without the finally, an assertion that fails leaves the socket listening and
   * `node --test` never exits: the run reports nothing at all rather than reporting the
   * failure. Found the hard way, by breaking one of these on purpose.
   */
  const withStatus = async (fn) => {
    try { return await fn(JSON.parse((await get('/api/status')).body)); }
    finally { await close(); }
  };
  return { get, close, withStatus };
}

test('/api/status says which attempt this is and where the last one is published', async () => {
  const c = attempt(7);
  const voided = c.cfg.protocol.target_round;
  await voidIt(c);
  refreeze(c);
  resetForNewRound(c.cfg, c.store, { log: QUIET });

  const s = await boot(c);
  const status = JSON.parse((await s.get('/api/status')).body);
  assert.equal(status.phase, 'open');
  assert.equal(status.attempt, 2);
  assert.equal(status.previous_rounds.length, 1);
  assert.equal(status.previous_rounds[0].submitted_count, 7);
  assert.equal(status.previous_rounds[0].archive, `events/rounds/${voided}`);
  await s.close();
  cleanup(c.fx.dir);
});

test('the run is the voided attempts since the last one that ended', () => {
  const log = [
    { target_round: 1, status: 'void' },
    { target_round: 2, status: 'done' },
    { target_round: 3, status: 'void' },
    { target_round: 4, status: 'void' },
  ];
  const rounds = (index) => attemptsInThisRun(index).map((a) => a.target_round);
  assert.deepEqual(rounds(log), [3, 4]);
  assert.deepEqual(rounds([]), []);
  assert.deepEqual(rounds(log.slice(0, 2)), [], 'a finished event leaves no attempts behind it');
  // Abandoning ends a run as surely as finishing one does: whatever opens next is a
  // different event, and its players were never asked for a number in this one.
  assert.deepEqual(
    rounds([{ target_round: 1, status: 'abandoned' }, { target_round: 2, status: 'void' }]), [2]);
  // An entry with no status predates the field, and only voided attempts were archived
  // back then.
  assert.deepEqual(rounds([{ target_round: 9 }]), [9]);
});

test('a closed event is not counted as a failed attempt of the next one', async () => {
  // The bug as a player met it. An event that had DRAWN, with nine of twelve submitting
  // against a quorum of eight, was closed out and a new one frozen — and the submission
  // page for the new one opened with "last time only 9 submitted, short of the 8
  // required". Nine is not short of eight, and that round had not fallen short of
  // anything: it had succeeded. §8's notice is about a void in THIS run, and a finished
  // event is neither.
  const c = attempt(9);
  fs.writeFileSync(path.join(c.fx.dir, 'results.json'),
    JSON.stringify({ round_used: c.cfg.protocol.target_round, seating: {} }, null, 2) + '\n');
  c.store.set('phase', 'done');
  assert.equal(endEvent(c.cfg, c.store, { mirror: c.mirror, log: QUIET }).ok, true);
  refreeze(c);

  await (await boot(c)).withStatus((status) => {
    assert.equal(status.attempt, 1, 'a new event starts at attempt 1');
    assert.deepEqual(status.previous_rounds, [], 'the closed event is not this run’s history');
  });
  cleanup(c.fx.dir);
});

test('a void in the second event is its attempt 2, not the log’s attempt 3', async () => {
  const c = attempt(12);
  fs.writeFileSync(path.join(c.fx.dir, 'results.json'),
    JSON.stringify({ round_used: c.cfg.protocol.target_round, seating: {} }, null, 2) + '\n');
  c.store.set('phase', 'done');
  endEvent(c.cfg, c.store, { mirror: c.mirror, log: QUIET });

  // A second event opens, and this one does fall short.
  refreeze(c, { submission_cutoff_utc: PAST() });
  const short = c.cfg.protocol.target_round;
  c.store.insertSubmission(1, fakeCiphertext(short, c.cfg.protocol.chain_hash), c.cfg.protocol.cutoff_ms - 60_000);
  await voidIt(c);
  refreeze(c);
  resetForNewRound(c.cfg, c.store, { log: QUIET });

  await (await boot(c)).withStatus((status) => {
    assert.equal(status.attempt, 2, 'the first event is over; this run has had one void');
    assert.equal(status.previous_rounds.length, 1);
    assert.equal(status.previous_rounds[0].target_round, short);
    assert.equal(status.previous_rounds[0].submitted_count, 1);
  });
  cleanup(c.fx.dir);
});

test('the attempt now open is not counted among the attempts before it', async () => {
  // It is archived the instant it is declared void, so from that instant it is in the
  // index — and the screen that announces attempt 2 failed would have called itself 3.
  const c = attempt(7);
  const voided = c.cfg.protocol.target_round;
  await voidIt(c);

  await (await boot(c)).withStatus((status) => {
    assert.equal(status.phase, 'void');
    assert.equal(status.attempt, 1);
    assert.equal(status.previous_rounds[0].target_round, voided,
      'the void screen finds its own archive here');
  });
  cleanup(c.fx.dir);
});

test('the archive is reachable over HTTP, so players can check it themselves', async () => {
  const c = attempt(7);
  const voided = c.cfg.protocol.target_round;
  await voidIt(c);

  const s = await boot(c);
  const manifest = await s.get(`/events/rounds/${voided}/manifest.json`);
  assert.equal(manifest.status, 200);
  assert.equal(JSON.parse(manifest.body).submitted_count, 7);

  const ct = await s.get(`/events/rounds/${voided}/submissions/3.json`);
  assert.equal(ct.status, 200);
  assert.match(JSON.parse(ct.body).ciphertext, /BEGIN AGE ENCRYPTED FILE/);

  const proto = await s.get(`/events/rounds/${voided}/protocol.json`);
  assert.equal(JSON.parse(proto.body).target_round, voided, 'the parameters that attempt ran under');
  await s.close();
  cleanup(c.fx.dir);
});

test('the archive route serves nothing outside events/rounds/', async () => {
  const c = attempt(7);
  await voidIt(c);
  const s = await boot(c);
  for (const p of [
    '/events/rounds/%2e%2e/%2e%2e/data/protocol.json',
    '/events/rounds/../../../etc/passwd',
    '/events/rounds/nope/manifest.json',
  ]) {
    const r = await s.get(p);
    // Either a plain 404 from the archive route, or the SPA fallback for a path the URL
    // parser folded away before it got here. Never a file from outside the archive.
    assert.ok(r.status === 404 || r.type === 'text/html', `${p} served ${r.type}`);
    assert.doesNotMatch(r.body, /chain_public_key|root:/, `${p} leaked content`);
  }
  await s.close();
  cleanup(c.fx.dir);
});

// ---------------------------------------------------------------------------
// what a reset must actually clear
// ---------------------------------------------------------------------------

/**
 * `clearRound` named four keys and missed `roll_published`, which guards `publishRoll`.
 * So every attempt after the first skipped publishing its own roll, and the waiting page
 * showed the previous attempt's digest right through the interval where the digest is
 * the only thing a player has to compare. That is PROTOCOL §9 silently not happening.
 *
 * The list is now an exclusion, so a key added in one file cannot be forgotten in the
 * other, and this test is the one that says so about any future key rather than about
 * the one that went wrong.
 */
test('a reset clears every key that describes the round, and only those', () => {
  const store = new Store(':memory:');
  // Everything the job writes, plus something nobody has thought of yet.
  for (const k of ['snapshot', 'phase', 'result', 'pantheon_sync', 'roll_published',
    'results_mirrored', 'some_key_added_next_year']) {
    store.set(k, { about: 'this attempt' });
  }
  store.set(KEY_TICK, { at: 'whenever' });
  store.clearRound();

  const left = store.db.prepare('SELECT key FROM state').all().map((r) => r.key).sort();
  assert.deepEqual(left, Store.KEPT_ACROSS_ROUNDS.slice().sort(),
    `these survived a reset and describe the previous round: ${left.join(', ')}`);
  store.close();
});

test('the attempt after a reset publishes its own roll, not the previous one', async () => {
  // The bug end to end: void, archive, re-freeze, reset, and then take a roll.
  const c = attempt(7);
  await voidIt(c);
  const first = c.store.get(KEY_ROLL);
  assert.ok(first?.digest, 'the first attempt must have published a roll');

  refreeze(c);
  const reset = resetForNewRound(c.cfg, c.store, { log: QUIET });
  assert.equal(reset.ok, true, reset.error);
  assert.equal(c.store.get(KEY_ROLL), null, 'the previous attempt\'s roll survived the reset');

  // A second attempt reaches its own cutoff with its own submissions.
  for (let i = 1; i <= 9; i++) {
    c.store.insertSubmission(i, fakeCiphertext(c.cfg.protocol.target_round, c.cfg.protocol.chain_hash),
      c.cfg.protocol.cutoff_ms - 60_000);
  }
  await publishRoll(c.cfg, c.store, {
    cutoff_utc: c.cfg.protocol.submission_cutoff_utc,
    taken_at: new Date().toISOString(),
    local_ids: [1, 2, 3, 4, 5, 6, 7, 8, 9],
  }, { mirror: c.mirror, log: QUIET });

  const second = c.store.get(KEY_ROLL);
  assert.notEqual(second.digest, first.digest, 'the second attempt republished the first one\'s digest');
  assert.equal(second.local_ids.length, 9);
  cleanup(c.fx.dir);
});

// ---------------------------------------------------------------------------
// ending an event, as opposed to retrying a round
// ---------------------------------------------------------------------------

test('a finished event is archived and then cleared', async () => {
  const c = attempt(12);
  // Stand in for a completed draw: the artefacts a finished round leaves live.
  fs.writeFileSync(path.join(c.fx.dir, 'results.json'),
    JSON.stringify({ round_used: c.cfg.protocol.target_round, seating: {} }, null, 2) + '\n');
  fs.mkdirSync(path.join(c.fx.dir, 'events'), { recursive: true });
  fs.writeFileSync(path.join(c.fx.dir, 'events', 'sync.json'), '{"status":"ok"}\n');
  c.store.set('phase', 'done');

  const out = endEvent(c.cfg, c.store, { mirror: c.mirror, log: QUIET });
  assert.equal(out.ok, true, out.error);
  assert.equal(out.status, 'done');

  // The evidence moved rather than vanished.
  const dir = arch(c, c.cfg.protocol.target_round);
  for (const f of ['manifest.json', 'protocol.json', 'roster.json', 'results.json', 'submissions/1.json']) {
    assert.ok(fs.existsSync(path.join(dir, f)), `the archive is missing ${f}`);
  }
  assert.equal(verifyArchive(c.cfg, c.cfg.protocol.target_round).ok, true);

  // And the tree is ready for another event.
  assert.equal(fs.existsSync(path.join(c.fx.dir, 'results.json')), false);
  assert.equal(fs.existsSync(path.join(c.fx.dir, 'events', 'sync.json')), false);
  assert.equal(c.store.listSubmissions().length, 0);
  assert.equal(c.store.get('phase'), null);
  assert.equal(phaseOf(c.cfg, c.store), 'void', 'past the cutoff with nothing submitted is a void round, not a done one');
  cleanup(c.fx.dir);
});

test('a round that never reached an end is not closed by accident', () => {
  // Neither drawn nor voided: ending it is abandoning it, and abandoning a round after
  // seeing who has submitted is the step §8 exists to remove.
  const c = attempt(9);
  const refused = endEvent(c.cfg, c.store, { mirror: c.mirror, log: QUIET });
  assert.equal(refused.ok, false);
  assert.match(refused.error, /abandoning/);
  assert.match(refused.error, /--abandon/);
  assert.equal(c.store.listSubmissions().length, 9, 'nothing may be cleared by a refusal');

  const said = endEvent(c.cfg, c.store, { abandon: true, mirror: c.mirror, log: QUIET });
  assert.equal(said.ok, true, said.error);
  assert.equal(said.status, 'abandoned');
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(arch(c, c.cfg.protocol.target_round), 'manifest.json'), 'utf8')).status,
    'abandoned');
  cleanup(c.fx.dir);
});

test('a dry run says what it would do and changes nothing', () => {
  const c = attempt(12);
  fs.writeFileSync(path.join(c.fx.dir, 'results.json'), '{"round_used":1}\n');
  c.store.set('phase', 'done');

  const out = endEvent(c.cfg, c.store, { dryRun: true, mirror: c.mirror, log: QUIET });
  assert.equal(out.ok, true);
  assert.equal(out.status, 'done');
  assert.ok(out.removed.includes('results.json'));
  assert.equal(fs.existsSync(path.join(c.fx.dir, 'results.json')), true);
  assert.equal(c.store.listSubmissions().length, 12);
  assert.equal(fs.existsSync(arch(c, c.cfg.protocol.target_round)), false, 'a dry run must not write an archive');
  cleanup(c.fx.dir);
});

test('closing an event deletes the captured admin token, and a dry run leaves it alone', () => {
  // Frey's tokens do not expire, so one captured at sign-in would otherwise outlive the
  // event by however long that person keeps their password. The close is where it goes.
  const { saveAdminCredential, adminCredentialFileIn } = require('../server/admin-credential');

  const dry = attempt(12);
  fs.writeFileSync(path.join(dry.fx.dir, 'results.json'), '{"round_used":1}\n');
  dry.store.set('phase', 'done');
  const dryFile = adminCredentialFileIn(dry.cfg.root);
  saveAdminCredential({ person_id: 42, auth_token: 'password-equivalent', title: 'Feiyang' }, dryFile);

  const preview = endEvent(dry.cfg, dry.store, { dryRun: true, mirror: dry.mirror, log: QUIET });
  assert.equal(preview.credentialCleared, true, 'the dry run reports that there is one to delete');
  assert.equal(fs.existsSync(dryFile), true, 'a dry run deletes nothing, least of all a secret');
  cleanup(dry.fx.dir);

  const c = attempt(12);
  fs.writeFileSync(path.join(c.fx.dir, 'results.json'), '{"round_used":1}\n');
  c.store.set('phase', 'done');
  const file = adminCredentialFileIn(c.cfg.root);
  saveAdminCredential({ person_id: 42, auth_token: 'password-equivalent', title: 'Feiyang' }, file);

  const out = endEvent(c.cfg, c.store, { mirror: c.mirror, log: QUIET });
  assert.equal(out.ok, true);
  assert.equal(out.credentialCleared, true);
  assert.equal(fs.existsSync(file), false, 'the captured token must not survive the event');

  // And it must never have been archived or mirrored on the way out: the archive is
  // published, and this is the one file in the tree that can never be.
  const archived = fs.readdirSync(arch(c, out.targetRound));
  assert.ok(!archived.some((f) => f.includes('admin-credential')), 'the token must not be in the archive');
  const manifest = JSON.parse(fs.readFileSync(path.join(arch(c, out.targetRound), 'manifest.json'), 'utf8'));
  assert.ok(!JSON.stringify(manifest).includes('password-equivalent'), 'no token in the manifest');
  assert.ok(!c.mirrored.some((p) => String(p).includes('admin-credential')),
    'the token must never be handed to the mirror');
  cleanup(c.fx.dir);
});

test('closing an event with no captured token says so rather than claiming a deletion', () => {
  const c = attempt(12);
  fs.writeFileSync(path.join(c.fx.dir, 'results.json'), '{"round_used":1}\n');
  c.store.set('phase', 'done');
  const out = endEvent(c.cfg, c.store, { mirror: c.mirror, log: QUIET });
  assert.equal(out.ok, true);
  assert.equal(out.credentialCleared, false);
  cleanup(c.fx.dir);
});

test('with nothing to close it says so instead of pretending', () => {
  const c = attempt(0);
  const out = endEvent(c.cfg, c.store, { mirror: c.mirror, log: QUIET });
  assert.equal(out.ok, false);
  assert.match(out.error, /nothing to close/);
  cleanup(c.fx.dir);
});

// ---------------------------------------------------------------------------
// the final round's lock, which outlives the draw it belongs to (PROTOCOL.md §11)
// ---------------------------------------------------------------------------

/** A finished round-robin with a final round locked, and optionally drawn. */
function withFinal(opts = {}) {
  const c = attempt(12);
  fs.writeFileSync(path.join(c.fx.dir, 'results.json'),
    JSON.stringify({ round_used: c.cfg.protocol.target_round, seating: {} }, null, 2) + '\n');
  c.store.set('phase', 'done');
  const finalDir = path.join(c.fx.dir, 'events', 'final');
  fs.mkdirSync(finalDir, { recursive: true });
  fs.writeFileSync(path.join(finalDir, 'lock.json'), '{"final_round":9999999}\n');
  fs.writeFileSync(path.join(finalDir, 'lock.json.ots'), Buffer.from([0x00, 0x4f, 0x54, 0x53]));
  for (const name of opts.superseded || []) fs.writeFileSync(path.join(finalDir, name), '{"superseded":true}\n');
  if (opts.drawn) {
    fs.writeFileSync(path.join(c.fx.dir, 'final.json'), '{"final_round":9999999,"seating":{}}\n');
    fs.writeFileSync(path.join(finalDir, 'sync.json'), '{"status":"ok"}\n');
  }
  return c;
}

test('a locked but undrawn final round is not closed out by a routine end-event', () => {
  // The defect this exists for: results.json is on disk, so `status` is 'done' and none
  // of the other refusals fire. end-event.js would have deleted a published, timestamped
  // commitment — which from the outside is indistinguishable from withdrawing it.
  const c = withFinal();
  const refused = endEvent(c.cfg, c.store, { mirror: c.mirror, log: QUIET });
  assert.equal(refused.ok, false);
  assert.match(refused.error, /events\/final\/lock\.json/);
  assert.match(refused.error, /--abandon/);
  assert.equal(fs.existsSync(path.join(c.fx.dir, 'events', 'final', 'lock.json')), true,
    'a refusal must not delete the thing it refused over');
  assert.equal(fs.existsSync(path.join(c.fx.dir, 'results.json')), true);
  assert.equal(c.store.listSubmissions().length, 12, 'nothing may be cleared by a refusal');
  assert.equal(fs.existsSync(arch(c, c.cfg.protocol.target_round)), false, 'and nothing archived');

  // The dry run refuses too. A preview that says "ok" and a real run that refuses would
  // teach the operator the opposite of what the refusal is for.
  const preview = endEvent(c.cfg, c.store, { dryRun: true, mirror: c.mirror, log: QUIET });
  assert.equal(preview.ok, false);
  cleanup(c.fx.dir);
});

test('abandoning an undrawn final round is allowed once it is said out loud, and archives the lock', () => {
  const c = withFinal({ superseded: ['lock.2.json', 'lock.2.json.ots'] });
  const out = endEvent(c.cfg, c.store, { abandon: true, mirror: c.mirror, log: QUIET });
  assert.equal(out.ok, true, out.error);
  assert.deepEqual(out.final, { locked: true, drawn: false });

  const dir = arch(c, out.targetRound);
  // Flattened into the archive, which has no subdirectories but submissions/.
  for (const f of ['final-lock.json', 'final-lock.json.ots', 'final-lock.2.json', 'final-lock.2.json.ots']) {
    assert.ok(fs.existsSync(path.join(dir, f)), `the archive is missing ${f}`);
  }
  assert.equal(fs.existsSync(path.join(dir, 'final.json')), false, 'there was no draw to archive');
  assert.equal(verifyArchive(c.cfg, out.targetRound).ok, true, 'every archived digest recomputes');
  assert.ok(c.mirrored.some((p) => String(p).endsWith('/final-lock.json')),
    'the archived lock is offered to the mirror like the rest of the evidence');

  // Cleared afterwards, so the next event does not open on top of a dead commitment.
  assert.equal(fs.existsSync(path.join(c.fx.dir, 'events', 'final', 'lock.json')), false);
  assert.equal(fs.existsSync(path.join(c.fx.dir, 'events', 'final', 'lock.json.ots')), false);
  cleanup(c.fx.dir);
});

test('a drawn final round closes without --abandon, and its result is archived', () => {
  const c = withFinal({ drawn: true });
  const out = endEvent(c.cfg, c.store, { mirror: c.mirror, log: QUIET });
  assert.equal(out.ok, true, out.error);
  assert.equal(out.status, 'done');
  assert.deepEqual(out.final, { locked: true, drawn: true });

  const dir = arch(c, out.targetRound);
  for (const f of ['results.json', 'final.json', 'final-lock.json', 'final-lock.json.ots', 'final-sync.json']) {
    assert.ok(fs.existsSync(path.join(dir, f)), `the archive is missing ${f}`);
  }
  assert.equal(verifyArchive(c.cfg, out.targetRound).ok, true);
  for (const rel of ['final.json', 'events/final/lock.json', 'events/final/sync.json']) {
    assert.equal(fs.existsSync(path.join(c.fx.dir, rel)), false, `${rel} should have been cleared`);
    assert.ok(out.removed.includes(rel), `${rel} should be reported as removed`);
  }
  cleanup(c.fx.dir);
});

test('an event with no final round at all closes exactly as it did before', () => {
  // The whole of §11 is additive: a run that never locks a final round must behave the
  // way it did when final.json did not exist as a concept.
  const c = attempt(12);
  fs.writeFileSync(path.join(c.fx.dir, 'results.json'), '{"round_used":1}\n');
  c.store.set('phase', 'done');
  const out = endEvent(c.cfg, c.store, { mirror: c.mirror, log: QUIET });
  assert.equal(out.ok, true, out.error);
  assert.deepEqual(out.final, { locked: false, drawn: false });
  const archived = fs.readdirSync(arch(c, out.targetRound));
  assert.ok(!archived.some((f) => f.startsWith('final')), 'nothing final to archive');
  cleanup(c.fx.dir);
});
