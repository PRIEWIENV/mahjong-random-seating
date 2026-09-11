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

const { run, phaseOf } = require('../server/finalise');
const { load } = require('../server/config');
const { Store } = require('../server/db');
const { StubPantheon } = require('../server/pantheon');
const { verifyArchive, resetForNewRound, readIndex } = require('../server/rounds');
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
  return { get, close: () => new Promise((r) => server.close(r)) };
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
