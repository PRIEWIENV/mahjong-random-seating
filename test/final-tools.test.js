'use strict';

/**
 * The two commitments the final round is made of (PROTOCOL.md §11).
 *
 * T1 fixes the standings and the beacon, before the beacon exists. T2 opens it. Almost
 * everything that could go wrong with a twelfth round is a way of getting those two out
 * of order — seating from standings fetched after the randomness, choosing the round
 * after seeing the table, re-running the draw until it comes out nicer — so most of what
 * is tested here is a refusal.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { load } = require('../server/config');
const { StubPantheon } = require('../server/pantheon');
const { generate, serialise } = require('../generate');
const { generateFinal, serialise: serialiseFinal } = require('../generate-final');
const lockFinal = require('../tools/lock-final');
const drawFinal = require('../tools/draw-final');
const { makeDataDir, makeDecrypted, cleanup, SAMPLE_SIG } = require('./helpers');

const QUIET = { info() {}, warn() {}, error() {} };
const NOW = Date.parse('2026-09-15T12:00:00Z');
const GENESIS = 1692803367;
const PERIOD = 3;
const roundAt = (ms) => Math.floor((Math.floor(ms / 1000) - GENESIS) / PERIOD) + 1;
// The tools take the round strictly AFTER the requested instant, the way pick-round.js
// does, so a round already in flight is never chosen.
const FINAL_ROUND = roundAt(NOW + 45 * 60_000) + 1;
/** A second signature, distinct from the first draw's and the same length. */
const FINAL_SIG = SAMPLE_SIG.slice(0, -2) + (SAMPLE_SIG.endsWith('00') ? '11' : '00');

/**
 * Collect what a tool said, without taking process.stdout away from anything else.
 *
 * These tools' output is part of what they do — the refusals explain what to do instead —
 * so the tests read it. They read it through the injected sink rather than by swapping
 * process.stdout, which also swallowed the test runner's own reporter and made a file of
 * twenty-odd tests report four.
 */
function collector() {
  const lines = [];
  return { sink: (s) => { lines.push(String(s)); return true; }, text: () => lines.join('') };
}

/** A finished eleven-round event: frozen files, a published results.json, nothing else. */
function played(over = {}) {
  const fx = makeDataDir(over);
  const cfg = load({ dataDir: fx.dataDir });
  cfg.root = fx.dir;
  const results = generate({
    decrypted: makeDecrypted(12),
    roster: cfg.roster,
    protocol: cfg.protocol,
    template: cfg.template,
    signature: SAMPLE_SIG,
    round: cfg.protocol.target_round,
  });
  fs.writeFileSync(path.join(fx.dir, 'results.json'), serialise(results));

  const mirrored = [];
  const mirror = {
    enabled: true,
    enqueue: (p, body) => mirrored.push({ path: p, body }),
    flush: async () => {},
    drain: async () => true,
  };
  const drand = {
    info: async () => ({ genesis_time: GENESIS, period: PERIOD, public_key: cfg.protocol.chain_public_key }),
    roundTimeMs: async (r) => (GENESIS + (r - 1) * PERIOD) * 1000,
    round: async (r) => ({ round: r, signature: FINAL_SIG, randomness: 'x'.repeat(64), mirrors: ['m1', 'm2'] }),
  };
  const pantheon = new StubPantheon({ roster: cfg.roster });
  // Where Mimir would be after eleven played sessions: the plan as published, and its own
  // pointer sitting at the round that has not happened.
  pantheon.prescript = results.pantheon_prescript;
  pantheon.nextSessionIndex = 12;

  const stamped = [];
  const stampFn = async (buf) => {
    stamped.push(buf);
    return { ots: Buffer.from('OTS-PROOF'), digest: 'd', calendars: ['https://a.example'], failed: [] };
  };

  return { fx, cfg, results, mirror, mirrored, drand, pantheon, stampFn, stamped };
}

const lockFile = (c) => path.join(c.fx.dir, 'events', 'final', 'lock.json');
const finalFile = (c) => path.join(c.fx.dir, 'final.json');
const readLock = (c) => JSON.parse(fs.readFileSync(lockFile(c), 'utf8'));

async function runLock(c, argv = [], extra = {}) {
  const t = collector();
  const code = await lockFinal.main(argv, {
    cfg: c.cfg, log: QUIET, now: NOW, mirror: c.mirror, drand: c.drand,
    pantheon: c.pantheon, stampFn: c.stampFn, env: {},
    stdout: t.sink, stderr: t.sink, ...extra,
  });
  return { code, out: t.text() };
}

async function runDraw(c, argv = [], extra = {}) {
  const t = collector();
  const code = await drawFinal.main(argv, {
    cfg: c.cfg, log: QUIET, now: NOW, mirror: c.mirror, drand: c.drand,
    pantheon: c.pantheon, env: {}, sleep: async () => {},
    // Three attempts with real exponential backoff is the right behaviour against a
    // flaky Mimir and six wasted seconds in a test suite.
    sync: { baseDelayMs: 1 },
    stdout: t.sink, stderr: t.sink, ...extra,
  });
  return { code, out: t.text() };
}

/** Standings rows in the shape getRatingTable returns, ranked by the order given. */
function rows(cfg, localIdsInOrder, over = {}) {
  const byLocal = new Map(cfg.roster.players.map((p) => [p.local_id, p]));
  return localIdsInOrder.map((id, i) => ({
    rank: i + 1,
    person_id: byLocal.get(id).person_id,
    title: byLocal.get(id).title,
    rating: 1500 - i * 10,
    chips: 24 - i * 2,
    avg_place: 2 + i * 0.05,
    avg_score: 5000 - i * 400,
    games_played: 11,
    ...(over[i + 1] || {}),
  }));
}

const scripted = (c, localIdsInOrder, over) => c.pantheon.setStandings(rows(c.cfg, localIdsInOrder, over));
const RANKED = [12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1];

// ---------------------------------------------------------------------------
// T1 — locking
// ---------------------------------------------------------------------------

test('a dry run fetches, checks and prints, and writes nothing at all', async () => {
  const c = played();
  scripted(c, RANKED);
  const { code, out } = await runLock(c, ['--in', '45m']);
  assert.equal(code, 0, out);
  assert.match(out, /every check passed/);
  assert.match(out, /dry run/);
  assert.equal(fs.existsSync(lockFile(c)), false, 'a dry run must not write the lock');
  assert.equal(c.mirrored.length, 0, 'nor offer anything to the mirror');
  assert.equal(c.stamped.length, 0, 'nor spend a calendar round trip');
  cleanup(c.fx.dir);
});

test('the lock names the standings, the beacon and the bytes it is a lock on', async () => {
  const c = played();
  scripted(c, RANKED);
  const { code, out } = await runLock(c, ['--in', '45m', '--confirm']);
  assert.equal(code, 0, out);

  const lock = readLock(c);
  assert.deepEqual(lock.standings, RANKED, 'standings are local_ids in finishing order');
  assert.equal(lock.target_round, FINAL_ROUND);
  assert.equal(lock.results_sha256,
    require('node:crypto').createHash('sha256').update(fs.readFileSync(path.join(c.fx.dir, 'results.json'))).digest('hex'));
  assert.equal(lock.R, c.results.R, 'the same R the first draw published');
  assert.equal(lock.generate_final_script_ref, c.cfg.protocol.generate_final_script_ref);
  // Tables are decided here, by the standings, and nothing later can move them.
  assert.deepEqual(lock.standings_detail.slice(0, 4).map((d) => d.table), [1, 1, 1, 1]);
  assert.deepEqual(lock.standings_detail.slice(4, 8).map((d) => d.table), [2, 2, 2, 2]);
  assert.deepEqual(lock.standings_detail.slice(8).map((d) => d.table), [3, 3, 3, 3]);

  // Published, then anchored, in that order, over exactly the bytes on disk.
  assert.ok(c.mirrored.some((m) => m.path === 'events/final/lock.json'));
  assert.ok(c.mirrored.some((m) => m.path === 'events/final/lock.json.ots'));
  assert.equal(c.stamped.length, 1);
  assert.equal(c.stamped[0].toString('utf8'), fs.readFileSync(lockFile(c), 'utf8'),
    'the anchor must be over the file as published, not over a re-serialisation of it');
  cleanup(c.fx.dir);
});

test('the digest the dry run announces is the digest of the file that gets written', async () => {
  // Twelve people are told to compare that string. If the write changed a byte, they
  // would be comparing a number that never existed on disk.
  const c = played();
  scripted(c, RANKED);
  const preview = await runLock(c, ['--in', '45m']);
  const announced = /lock sha256\s+([0-9a-f]{64})/.exec(preview.out)?.[1];
  assert.ok(announced, preview.out);

  await runLock(c, ['--in', '45m', '--confirm']);
  const onDisk = require('node:crypto').createHash('sha256')
    .update(fs.readFileSync(lockFile(c))).digest('hex');
  assert.equal(onDisk, announced);
  cleanup(c.fx.dir);
});

test('an unfinished round-robin is refused, by name and by count', async () => {
  const c = played();
  scripted(c, RANKED, { 3: { games_played: 10 } });
  const { code, out } = await runLock(c, ['--in', '45m', '--confirm']);
  assert.equal(code, 1);
  assert.match(out, /has played 10 of 11 games/);
  assert.equal(fs.existsSync(lockFile(c)), false);
  cleanup(c.fx.dir);
});

test('a standings table that is not about the frozen twelve is refused', async () => {
  const c = played();
  const good = rows(c.cfg, RANKED);
  c.pantheon.setStandings(good.slice(0, 11));
  let r = await runLock(c, ['--in', '45m', '--confirm']);
  assert.equal(r.code, 1);
  assert.match(r.out, /returned 11 players, the frozen roster has 12/);

  c.pantheon.setStandings([...good.slice(0, 11), { ...good[11], person_id: 9999, title: 'stranger' }]);
  r = await runLock(c, ['--in', '45m', '--confirm']);
  assert.equal(r.code, 1);
  assert.match(r.out, /person_id 9999 \(stranger\) is in the standings but not in the frozen roster/);
  assert.match(r.out, /is in the frozen roster but not in the standings/);
  cleanup(c.fx.dir);
});

test('an order Mimir did not actually apply is caught by recomputing it', async () => {
  // This is what makes an order_by nobody has verified safe to depend on: if Mimir ignored
  // it, the ranking is something else, and something else is not what was agreed.
  const c = played();
  const shuffled = rows(c.cfg, RANKED);
  [shuffled[2], shuffled[7]] = [shuffled[7], shuffled[2]]; // ratings now out of order
  c.pantheon.setStandings(shuffled);
  const { code, out } = await runLock(c, ['--in', '45m', '--confirm']);
  assert.equal(code, 1);
  assert.match(out, /Mimir's order does not run desc by "rating"/);
  // It must say WHICH pair is out of order. "the ranking is something else" with no
  // offender named leaves an operator diffing two lists of twelve names by eye.
  assert.match(out, /sits above/);
  assert.equal(fs.existsSync(lockFile(c)), false);
  cleanup(c.fx.dir);
});

test("Mimir's own epsilon decides what counts as a tie, not exact equality", async () => {
  // Measured against a live instance: Mimir compares float keys with abs(a-b) < 0.0001 and
  // orders any pair inside that by a SECOND key. Exact equality got both halves wrong at
  // once -- such a pair was not reported as a tie, AND the order check called Mimir's
  // perfectly good answer a violation. A pair 0.00005 apart straddling the 4|5 boundary is
  // the case that matters: it decides a table.
  const c = played();
  const near = rows(c.cfg, RANKED);
  near[4].rating = near[3].rating - 0.00005;   // ranks 4 and 5: a tie to Mimir
  c.pantheon.setStandings(near);
  const { code, out } = await runLock(c, ['--in', '45m', '--confirm']);
  assert.equal(code, 1, 'a tie across the band boundary must still be refused');
  assert.doesNotMatch(out, /order_by was not applied/,
    'a pair inside the epsilon is not an ordering violation');
  assert.match(out, /decides whether they sit at table 1 or 2/);
  assert.equal(fs.existsSync(lockFile(c)), false);
  cleanup(c.fx.dir);
});

test('a near-tie inside one table is recorded and does not block the lock', async () => {
  const c = played();
  const near = rows(c.cfg, RANKED);
  near[2].rating = near[1].rating - 0.00005;   // ranks 2 and 3: same table either way
  c.pantheon.setStandings(near);
  const { code, out } = await runLock(c, ['--in', '45m', '--confirm']);
  assert.equal(code, 0, out);
  assert.match(out, /inside one table/);
  const lock = JSON.parse(fs.readFileSync(lockFile(c), 'utf8'));
  assert.equal(lock.ties.length, 1, 'the tie belongs in the published lock');
  assert.equal(lock.ties[0].crosses_band, false);
  cleanup(c.fx.dir);
});

test('order_by keys Mimir accepts but this tool will not are refused by name', async () => {
  // Both are real Mimir keys (verified live). Refusing them silently as "unknown" would
  // send an operator to check their spelling against a list they had spelled correctly.
  for (const [key, why] of [['name', /alphabetically/], ['games_and_rating', /games played first/]]) {
    const c = played();
    scripted(c, RANKED);
    const { code, out } = await runLock(c, ['--in', '45m', '--order-by', key, '--confirm']);
    assert.equal(code, 1);
    assert.match(out, /Mimir does accept/);
    assert.match(out, why);
    cleanup(c.fx.dir);
  }
});

test('an order this tool cannot recompute is refused rather than trusted', async () => {
  const c = played();
  scripted(c, RANKED);
  const { code, out } = await runLock(c, ['--in', '45m', '--order-by', 'team_name', '--confirm']);
  assert.equal(code, 1);
  assert.match(out, /cannot confirm an order sorted by "team_name"/);
  cleanup(c.fx.dir);
});

test('a tie across a band boundary decides a table, and is refused until a human owns it', async () => {
  const c = played();
  // Ranks 4 and 5: the 4|5 boundary, so one of them sits at table one and the other at
  // table two purely on the order Mimir happened to return.
  scripted(c, RANKED, { 4: { rating: 1470 }, 5: { rating: 1470 } });
  let r = await runLock(c, ['--in', '45m', '--confirm']);
  assert.equal(r.code, 1);
  assert.match(r.out, /ranks 4 and 5 are tied on rating/);
  assert.match(r.out, /decides whether they sit at table 1 or 2/);
  assert.match(r.out, /never breaks a tie and never breaks one silently/);
  assert.equal(fs.existsSync(lockFile(c)), false);

  // Naming it is not enough; the rule that settled it is published with the lock.
  r = await runLock(c, ['--in', '45m', '--tiebreak', '4', '--confirm']);
  assert.equal(r.code, 1, 'a tiebreak with no reason is still a silent tiebreak');

  r = await runLock(c, ['--in', '45m', '--tiebreak', '4',
    '--tiebreak-reason', 'league rule 6b: more chips', '--confirm']);
  assert.equal(r.code, 0, r.out);
  const lock = readLock(c);
  const crossing = lock.ties.filter((t) => t.crosses_band);
  assert.equal(crossing.length, 1);
  assert.deepEqual(crossing[0].ranks, [4, 5]);
  assert.equal(crossing[0].accepted_reason, 'league rule 6b: more chips');
  assert.equal(lock.tiebreak_reason, 'league rule 6b: more chips');
  // And it did not reorder anybody: the order is still the one Mimir gave.
  assert.deepEqual(lock.standings, RANKED);
  cleanup(c.fx.dir);
});

test('either side of the boundary names the same tie', async () => {
  const c = played();
  scripted(c, RANKED, { 8: { rating: 1430 }, 9: { rating: 1430 } });
  const { code } = await runLock(c, ['--in', '45m', '--tiebreak', '9',
    '--tiebreak-reason', 'rule 6b', '--confirm']);
  assert.equal(code, 0, 'rank 9 names the 8|9 boundary just as rank 8 does');
  cleanup(c.fx.dir);
});

test('a tie inside one table is recorded and not refused', async () => {
  // The same four people are at the same table either way. All it moves is a byte of the
  // seed, and the seed is fixed here, before the beacon, so it cannot be polished.
  const c = played();
  scripted(c, RANKED, { 2: { rating: 1480 }, 3: { rating: 1480 } });
  const { code, out } = await runLock(c, ['--in', '45m', '--confirm']);
  assert.equal(code, 0, out);
  assert.match(out, /tied on rating .*inside one table/);
  const lock = readLock(c);
  assert.equal(lock.ties.length, 1);
  assert.equal(lock.ties[0].crosses_band, false);
  cleanup(c.fx.dir);
});

test('a tiebreak for a tie that is not there means the wrong table is being looked at', async () => {
  const c = played();
  scripted(c, RANKED);
  const { code, out } = await runLock(c, ['--in', '45m', '--tiebreak', '4',
    '--tiebreak-reason', 'rule 6b', '--confirm']);
  assert.equal(code, 1);
  assert.match(out, /names a tie that is not in these standings/);
  cleanup(c.fx.dir);
});

test('the beacon must be far enough ahead to publish a commitment into, and after the first draw', async () => {
  const c = played();
  scripted(c, RANKED);

  let r = await runLock(c, ['--in', '10s', '--confirm']);
  assert.equal(r.code, 1);
  assert.match(r.out, /no room for any of that/);

  r = await runLock(c, ['--round', String(c.cfg.protocol.target_round - 1), '--confirm']);
  assert.equal(r.code, 1);
  assert.match(r.out, /is not after the first draw's round/);
  assert.equal(fs.existsSync(lockFile(c)), false);
  cleanup(c.fx.dir);
});

test('a results.json that does not reproduce is not something to build a final round on', async () => {
  const c = played();
  scripted(c, RANKED);
  const file = path.join(c.fx.dir, 'results.json');
  const tampered = JSON.parse(fs.readFileSync(file, 'utf8'));
  tampered.permutation = [...tampered.permutation].reverse();
  fs.writeFileSync(file, serialise(tampered));

  const { code, out } = await runLock(c, ['--in', '45m', '--confirm']);
  assert.equal(code, 1);
  assert.match(out, /does not reproduce from its own payloads/);
  cleanup(c.fx.dir);
});

test('a second lock is refused, and replacing one is a decision with a reason attached', async () => {
  const c = played();
  scripted(c, RANKED);
  assert.equal((await runLock(c, ['--in', '45m', '--confirm'])).code, 0);
  const first = readLock(c);

  let r = await runLock(c, ['--in', '45m', '--confirm']);
  assert.equal(r.code, 1);
  assert.match(r.out, /already exists/);
  assert.deepEqual(readLock(c), first, 'a refusal changes nothing');

  r = await runLock(c, ['--relock', '--in', '45m', '--confirm']);
  assert.equal(r.code, 1);
  assert.match(r.out, /--relock needs --reason/);

  r = await runLock(c, ['--relock', '--reason', 'the standings were wrong', '--in', '90m', '--confirm']);
  assert.equal(r.code, 0, r.out);
  const second = readLock(c);
  assert.equal(second.relock_reason, 'the standings were wrong');
  assert.equal(second.relock_of.sha256, require('node:crypto').createHash('sha256')
    .update(JSON.stringify(first, null, 2) + '\n').digest('hex'));
  // The superseded lock is kept, not overwritten: it was published too.
  assert.equal(second.relock_of.archived_as, 'events/final/lock.2.json');
  assert.ok(fs.existsSync(path.join(c.fx.dir, 'events', 'final', 'lock.2.json')));
  assert.ok(fs.existsSync(path.join(c.fx.dir, 'events', 'final', 'lock.2.json.ots')));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(c.fx.dir, 'events', 'final', 'lock.2.json'), 'utf8')), first);
  cleanup(c.fx.dir);
});

test('a drawn final round is never re-locked', async () => {
  const c = played();
  scripted(c, RANKED);
  await runLock(c, ['--in', '45m', '--confirm']);
  await runDraw(c, []);
  assert.ok(fs.existsSync(finalFile(c)));

  const { code, out } = await runLock(c, ['--relock', '--reason', 'I would like another one', '--in', '45m', '--confirm']);
  assert.equal(code, 1);
  assert.match(out, /already been drawn/);
  cleanup(c.fx.dir);
});

// ---------------------------------------------------------------------------
// T2 — drawing
// ---------------------------------------------------------------------------

test('there is nothing to draw without a lock', async () => {
  const c = played();
  const { code, out } = await runDraw(c, []);
  assert.equal(code, 1);
  assert.match(out, /there is no events\/final\/lock\.json/);
  cleanup(c.fx.dir);
});

test('the draw reproduces from the lock, the beacon and nothing else', async () => {
  const c = played();
  scripted(c, RANKED);
  await runLock(c, ['--in', '45m', '--confirm']);

  const { code, out } = await runDraw(c, []);
  assert.equal(code, 0, out);
  const onDisk = fs.readFileSync(finalFile(c), 'utf8');

  // Independently recomputed here from the published files, which is exactly what a
  // player with a checkout can do.
  const lockBytes = fs.readFileSync(lockFile(c));
  const rebuilt = serialiseFinal(generateFinal({
    results: JSON.parse(fs.readFileSync(path.join(c.fx.dir, 'results.json'), 'utf8')),
    lock: {
      ...JSON.parse(lockBytes.toString('utf8')),
      lock_sha256: require('node:crypto').createHash('sha256').update(lockBytes).digest('hex'),
    },
    signature: FINAL_SIG,
    roster: c.cfg.roster, protocol: c.cfg.protocol, template: c.cfg.template,
  }));
  assert.equal(onDisk, rebuilt, 'the tool contributes nothing of its own');

  const final = JSON.parse(onDisk);
  assert.equal(final.final_round, 12);
  assert.equal(final.round_used, FINAL_ROUND);
  assert.deepEqual(final.standings, RANKED);
  assert.deepEqual(final.seating.rounds[0].tables.map((t) => t.table), [1, 2, 3]);
  // Table one is the top four of the standings, whatever the winds came out as.
  assert.deepEqual(
    new Set(Object.values(final.seating.rounds[0].tables[0].seats).map((s) => s.local_id)),
    new Set(RANKED.slice(0, 4)));
  assert.ok(c.mirrored.some((m) => m.path === 'final.json'));
  cleanup(c.fx.dir);
});

test('running it twice does not draw twice', async () => {
  // "Recompute" and "redraw" look identical from the outside, so the second must be
  // impossible rather than merely discouraged.
  const c = played();
  scripted(c, RANKED);
  await runLock(c, ['--in', '45m', '--confirm']);
  await runDraw(c, []);
  const first = fs.readFileSync(finalFile(c), 'utf8');

  // A different beacon on the second run: if anything redrew, it would show here.
  c.drand.round = async (r) => ({ round: r, signature: SAMPLE_SIG, randomness: 'y'.repeat(64), mirrors: ['m1'] });
  c.mirrored.length = 0;
  const { code, out } = await runDraw(c, []);
  assert.equal(code, 0, out);
  assert.equal(fs.readFileSync(finalFile(c), 'utf8'), first, 'the draw must not move');
  assert.match(out, /already drawn and reproduces byte for byte/);
  assert.ok(c.mirrored.some((m) => m.path === 'final.json'), 'but it is re-offered to the mirror');
  cleanup(c.fx.dir);
});

test('a final.json that does not reproduce is kept, not overwritten', async () => {
  const c = played();
  scripted(c, RANKED);
  await runLock(c, ['--in', '45m', '--confirm']);
  await runDraw(c, []);

  const tampered = JSON.parse(fs.readFileSync(finalFile(c), 'utf8'));
  tampered.seating.rounds[0].tables[0].seats.E.local_id = 99;
  const bytes = serialiseFinal(tampered);
  fs.writeFileSync(finalFile(c), bytes);

  const { code, out } = await runDraw(c, []);
  assert.equal(code, 1);
  assert.match(out, /does not reproduce/);
  assert.match(out, /Do NOT overwrite it/);
  assert.equal(fs.readFileSync(finalFile(c), 'utf8'), bytes, 'the evidence stays put');
  cleanup(c.fx.dir);
});

test('a results.json that changed after the lock stops the draw', async () => {
  const c = played();
  scripted(c, RANKED);
  await runLock(c, ['--in', '45m', '--confirm']);
  const file = path.join(c.fx.dir, 'results.json');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/\n$/, '\n\n'));

  const { code, out } = await runDraw(c, []);
  assert.equal(code, 1);
  assert.match(out, /results\.json has changed since the lock/);
  assert.equal(fs.existsSync(finalFile(c)), false);
  cleanup(c.fx.dir);
});

test('mirrors that disagree about the signature stop the draw rather than being waited out', async () => {
  const c = played();
  scripted(c, RANKED);
  await runLock(c, ['--in', '45m', '--confirm']);
  c.drand.round = async () => {
    const err = new Error('drand mirrors disagree about round 1 — DO NOT DRAW.');
    err.disagreement = true;
    throw err;
  };
  const { code, out } = await runDraw(c, []);
  assert.equal(code, 1);
  assert.match(out, /DO NOT DRAW/);
  assert.equal(fs.existsSync(finalFile(c)), false);
  cleanup(c.fx.dir);
});

test('Pantheon is given all twelve blocks, and the eleven played ones come back unchanged', async () => {
  const c = played();
  scripted(c, RANKED);
  await runLock(c, ['--in', '45m', '--confirm']);
  const before = c.pantheon.prescript;

  const { code, out } = await runDraw(c, []);
  assert.equal(code, 0, out);
  assert.equal(drawFinal.blocksOf(c.pantheon.prescript).length, 12);
  assert.equal(c.pantheon.nextSessionIndex, 12);
  assert.ok(c.pantheon.prescript.startsWith(`${before}\n\n`),
    'the eleven played sessions are written back byte for byte');
  const final = JSON.parse(fs.readFileSync(finalFile(c), 'utf8'));
  assert.equal(drawFinal.blocksOf(c.pantheon.prescript)[11], final.pantheon_prescript_final);

  const sync = JSON.parse(fs.readFileSync(path.join(c.fx.dir, 'events', 'final', 'sync.json'), 'utf8'));
  assert.equal(sync.status, 'ok');
  assert.equal(sync.sessions, 12);
  assert.equal(sync.next_session_index, 12);
  assert.equal(sync.final_round, 12);
  cleanup(c.fx.dir);
});

test("Mimir's own pointer is what says the round-robin was played, and it is believed over anyone", async () => {
  const c = played();
  scripted(c, RANKED);
  await runLock(c, ['--in', '45m', '--confirm']);
  c.pantheon.nextSessionIndex = 11; // one session still outstanding

  const { code, out } = await runDraw(c, []);
  assert.equal(code, 1, 'the draw is published, but the schedule is not written');
  assert.match(out, /next_session_index is 11, not 12/);
  assert.equal(drawFinal.blocksOf(c.pantheon.prescript).length, 11, 'nothing was written to Pantheon');
  // The draw itself still stands: it is final and reproducible, and the remedy is manual.
  assert.ok(fs.existsSync(finalFile(c)));
  const sync = JSON.parse(fs.readFileSync(path.join(c.fx.dir, 'events', 'final', 'sync.json'), 'utf8'));
  assert.equal(sync.status, 'failed');
  assert.match(sync.remedy, /Do NOT re-run the draw/);
  assert.match(sync.remedy, /ALL 12 blocks/);
  cleanup(c.fx.dir);
});

test('a prescript somebody else has edited is not overwritten', async () => {
  const c = played();
  scripted(c, RANKED);
  await runLock(c, ['--in', '45m', '--confirm']);
  c.pantheon.prescript = c.pantheon.prescript.replace('1-2', '2-1');

  const { code, out } = await runDraw(c, []);
  assert.equal(code, 1);
  assert.match(out, /not the one results\.json published/);
  cleanup(c.fx.dir);
});

test('a dry run before the beacon says what it is waiting for and touches nothing', async () => {
  const c = played();
  scripted(c, RANKED);
  await runLock(c, ['--in', '45m', '--confirm']);
  const { code, out } = await runDraw(c, ['--dry-run']);
  assert.equal(code, 0, out);
  assert.match(out, new RegExp(`waiting on drand round ${FINAL_ROUND}`));
  assert.equal(fs.existsSync(finalFile(c)), false);
  cleanup(c.fx.dir);
});

// ---------------------------------------------------------------------------
// the pure part
// ---------------------------------------------------------------------------

test('bandOf puts ranks into tables of four the way §11 says', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((r) => lockFinal.bandOf(r, 4)),
    [1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3]);
});

test('every wind-completion figure in the draw is checked against the seating, not asserted', async () => {
  // generateFinal derives completed_local_ids from the seat plan and cross-checks it
  // against the optima; this is the outside view of the same thing.
  const c = played();
  scripted(c, RANKED);
  await runLock(c, ['--in', '45m', '--confirm']);
  await runDraw(c, []);
  const final = JSON.parse(fs.readFileSync(finalFile(c), 'utf8'));
  const results = JSON.parse(fs.readFileSync(path.join(c.fx.dir, 'results.json'), 'utf8'));

  const counts = new Map(c.cfg.roster.players.map((p) => [p.local_id, { E: 0, S: 0, W: 0, N: 0 }]));
  for (const rd of [...results.seating.rounds, ...final.seating.rounds]) {
    for (const t of rd.tables) for (const w of ['E', 'S', 'W', 'N']) counts.get(t.seats[w].local_id)[w] += 1;
  }
  const complete = [...counts].filter(([, w]) => w.E === 3 && w.S === 3 && w.W === 3 && w.N === 3)
    .map(([id]) => id).sort((a, b) => a - b);
  assert.deepEqual(complete, final.completed_local_ids);
  assert.equal(complete.length, final.completed_count);
  for (const [, w] of counts) {
    const split = [w.E, w.S, w.W, w.N].sort((a, b) => b - a);
    assert.ok(split.join('') === '3333' || split.join('') === '4332',
      `twelve rounds can only leave 3-3-3-3 or 4-3-3-2, got ${split.join('-')}`);
  }
  cleanup(c.fx.dir);
});

test('a re-sync after the final session has been played does not rewind the pointer', async () => {
  // By the time somebody re-runs this, the final round may have been PLAYED, and Mimir
  // will have moved next_session_index past it. Writing our index back then would aim
  // Pantheon at a session that is already in the books.
  const c = played();
  scripted(c, RANKED);
  await runLock(c, ['--in', '45m', '--confirm']);
  await runDraw(c, []);
  c.pantheon.nextSessionIndex = 13; // the twelfth session has now been played
  const calls = c.pantheon.calls.length;

  const { code } = await runDraw(c, []);
  assert.equal(code, 0);
  assert.equal(c.pantheon.nextSessionIndex, 13, 'the pointer must not be rewound to 12');
  assert.ok(!c.pantheon.calls.slice(calls).some(([m]) => m === 'setPrescript'),
    'nothing is written when Pantheon already holds this exact plan');
  const sync = JSON.parse(fs.readFileSync(path.join(c.fx.dir, 'events', 'final', 'sync.json'), 'utf8'));
  assert.equal(sync.status, 'ok');
  assert.equal(sync.already, true);
  cleanup(c.fx.dir);
});

// ---------------------------------------------------------------------------
// the second implementation
// ---------------------------------------------------------------------------

/** Run tools/verify_final.py, or skip where no interpreter exists (CI has one). */
function python(args) {
  const { execFileSync } = require('node:child_process');
  const script = path.join(__dirname, '..', 'tools', 'verify_final.py');
  for (const exe of ['py', 'python3']) {
    try {
      return execFileSync(exe, [script, ...args], { encoding: 'utf8' });
    } catch (err) {
      // A missing interpreter is a skip; a failing script is a failure, and the two look
      // nothing alike: the script prints FAIL lines and exits 1 with output in hand.
      if (err.stdout) throw new Error(`${exe} ${args.join(' ')}\n${err.stdout}${err.stderr || ''}`);
    }
  }
  return null;
}

test('the Python implementation reproduces the pinned vectors on its own', () => {
  const out = python(['--self-test']);
  if (out === null) return; // no interpreter here
  assert.match(out, /OK\s+24 assignments, lexicographic/);
  assert.match(out, /OK\s+below\(\) reproduces/);
  assert.match(out, /OK\s+seed_final reproduces/);
  assert.match(out, /OK\s+the pinned draw reproduces/);
  assert.match(out, /OK\s+all 256 tables/);
});

test('the Python implementation re-derives a real draw from the published files alone', async () => {
  // Two implementations in two languages, written from the specification rather than
  // from each other. Agreement here is what says the encoding and the enumeration order
  // are precise enough to reimplement — the one failure that would otherwise be silent.
  const c = played();
  scripted(c, RANKED);
  await runLock(c, ['--in', '45m', '--confirm']);
  await runDraw(c, []);

  const out = python([
    '--final', finalFile(c),
    '--lock', lockFile(c),
    '--results', path.join(c.fx.dir, 'results.json'),
    '--roster', path.join(c.fx.dataDir, 'roster.json'),
    '--template', path.join(c.fx.dataDir, 'schedule_template.json'),
  ]);
  if (out === null) { cleanup(c.fx.dir); return; }
  const final = JSON.parse(fs.readFileSync(finalFile(c), 'utf8'));
  assert.match(out, /OK\s+the final round re-derives independently/);
  assert.match(out, new RegExp(`seed_final = ${final.seed}`));
  assert.match(out, new RegExp(`${final.completed_count} of 12 players finish on three of every wind`));
  cleanup(c.fx.dir);
});

test('the Python implementation notices a seat that was moved after the draw', async () => {
  const c = played();
  scripted(c, RANKED);
  await runLock(c, ['--in', '45m', '--confirm']);
  await runDraw(c, []);

  // Two players swapped inside one table: the seed still checks out, the standings still
  // check out, and only recomputing the assignment catches it.
  const final = JSON.parse(fs.readFileSync(finalFile(c), 'utf8'));
  const seats = final.seating.rounds[0].tables[0].seats;
  [seats.E, seats.S] = [seats.S, seats.E];
  fs.writeFileSync(finalFile(c), serialiseFinal(final));

  let failed = null;
  try {
    const out = python(['--final', finalFile(c), '--lock', lockFile(c),
      '--results', path.join(c.fx.dir, 'results.json'),
      '--roster', path.join(c.fx.dataDir, 'roster.json'),
      '--template', path.join(c.fx.dataDir, 'schedule_template.json')]);
    if (out === null) { cleanup(c.fx.dir); return; }
    assert.fail(`the verifier accepted a tampered seat plan:\n${out}`);
  } catch (err) {
    failed = err.message;
  }
  assert.match(failed, /FAIL\s+the recomputed seat plan differs from the published one/);
  cleanup(c.fx.dir);
});

// ---------------------------------------------------------------------------
// substitutes (PROTOCOL.md 11.6)
// ---------------------------------------------------------------------------

/** Declare a substitution in the fixture, the way an organiser would write the file. */
function declareSub(c, over = {}) {
  const seat = c.cfg.roster.players.find((p) => p.local_id === (over.local_id ?? 7));
  const body = {
    substitutions: [{
      local_id: seat.local_id,
      from_round: 8,
      outgoing: { person_id: seat.person_id, title: seat.title },
      incoming: { person_id: 90001, title: 'Substitute Song' },
      reason: 'league rule 9c: withdrawal through injury, seat filled from the reserve list',
      declared_at: '2026-09-10T09:00:00Z',
      ...over,
    }],
  };
  fs.writeFileSync(path.join(c.fx.dataDir, 'substitutes.json'), JSON.stringify(body, null, 2));
  // The tool reads config at call time, so reload to pick the file up.
  const fresh = load({ dataDir: c.fx.dataDir });
  fresh.root = c.fx.dir;
  c.cfg = fresh;
  return body.substitutions[0];
}

test('a substitution is published inside the lock, under its digest and its timestamp', async () => {
  const c = played();
  scripted(c, RANKED);
  const sub = declareSub(c);
  const { code, out } = await runLock(c, ['--in', '45m', '--confirm']);
  assert.equal(code, 0, out);

  const lock = JSON.parse(fs.readFileSync(lockFile(c), 'utf8'));
  assert.equal(lock.substitutes.length, 1);
  assert.equal(lock.substitutes[0].local_id, sub.local_id);
  assert.equal(lock.substitutes[0].incoming.title, 'Substitute Song');
  assert.match(lock.substitutes[0].reason, /league rule 9c/);
  // The operator has to SEE it before confirming, or publishing it is a formality.
  assert.match(out, /seats that changed hands/);
  assert.match(out, /Substitute Song/);
  cleanup(c.fx.dir);
});

test('a substitution changes nothing about the draw', async () => {
  // This is the property that lets the record be written late without becoming a lever.
  // The seat keeps its Pantheon registration, so the standings, the bands and every byte
  // of the seed are what they would have been. Compared by drawing both and diffing.
  const plain = played();
  scripted(plain, RANKED);
  assert.equal(await runLock(plain, ['--in', '45m', '--confirm']).then((r) => r.code), 0);
  const plainLock = JSON.parse(fs.readFileSync(lockFile(plain), 'utf8'));

  const withSub = played();
  scripted(withSub, RANKED);
  declareSub(withSub);
  assert.equal(await runLock(withSub, ['--in', '45m', '--confirm']).then((r) => r.code), 0);
  const subLock = JSON.parse(fs.readFileSync(lockFile(withSub), 'utf8'));

  assert.deepEqual(subLock.standings, plainLock.standings, 'the bands must be identical');
  assert.deepEqual(subLock.standings_detail.map((d) => d.table),
    plainLock.standings_detail.map((d) => d.table));
  cleanup(plain.fx.dir);
  cleanup(withSub.fx.dir);
});

test('a substitution that moved the Pantheon registration is refused', async () => {
  // Under "same_registration" the account does not change hands. If it did, the standings
  // would carry two partial rows for one seat and every count would be wrong -- silently,
  // because both rows look like ordinary rows.
  const c = played();
  assert.throws(
    () => declareSub(c, { outgoing: { person_id: 424242, title: 'somebody else' } }),
    /the frozen roster has .* at local_id/);
  cleanup(c.fx.dir);
});

test('a substitution with no league rule behind it is refused', async () => {
  const c = played();
  assert.throws(() => declareSub(c, { reason: '   ' }), /must say why, naming the league rule/);
  cleanup(c.fx.dir);
});

test('substitutes.json is refused outright when the frozen protocol forbids them', async () => {
  const c = played({ protocol: { final_round: { enabled: true,
    table_assignment: 'rank_blocks', wind_draw: 'max_completion_then_uniform',
    substitutes: 'forbidden' } } });
  assert.throws(() => declareSub(c), /frozen one wins/);
  cleanup(c.fx.dir);
});
