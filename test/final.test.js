'use strict';

/**
 * The final round's draw (generate-final.js, PROTOCOL.md §11).
 *
 * Three things here are worth more than the rest:
 *
 *   1. the deficient wind of every seat is DERIVED from the template, never written down
 *   2. the draw completes as many players as the standings allow, and is uniform among
 *      the ways of doing it
 *   3. the enumeration order of the 24 assignments is pinned, because two implementations
 *      that enumerate differently agree on the seed and disagree on the seats — which is
 *      a wrong answer with no error attached to it
 *
 * The statistical claims in seating-design.md are asserted here as exact integers over an
 * exhaustive enumeration, not as decimals with a tolerance. They are claims about a
 * uniform standings model, and the test names say so.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { generate, serialise, Sha256CounterStream } = require('../generate');
const gf = require('../generate-final');
const { makeRoster, makeProtocol, makeDecrypted, template, SAMPLE_SIG, ROOT } = require('./helpers');

const VECTORS = JSON.parse(fs.readFileSync(path.join(ROOT, 'test', 'final-vectors.json'), 'utf8'));
const SEATS = ['E', 'S', 'W', 'N'];
const FINAL_SIG = 'ab'.repeat(48);
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');

/** A finished eleven-round draw, plus a lock, ready for the final round. */
function fixture(over = {}) {
  const tpl = template();
  const roster = makeRoster(12, 42);
  const protocol = { ...makeProtocol(), generate_final_script_ref: 'generate-final.js@test' };
  const results = generate({
    decrypted: makeDecrypted(12, protocol), excluded: [], roster, protocol,
    template: tpl, signature: SAMPLE_SIG, round: protocol.target_round,
  });
  const lock = {
    results_sha256: sha256(Buffer.from(serialise(results), 'utf8')),
    target_round: protocol.target_round + 5000,
    standings: [7, 2, 11, 4, 9, 1, 12, 5, 3, 10, 8, 6],
    ...over,
  };
  return { tpl, roster, protocol, results, lock };
}

const run = (f, sig = FINAL_SIG) => gf.generateFinal({
  results: f.results, lock: f.lock, signature: sig,
  roster: f.roster, protocol: f.protocol, template: f.tpl,
});

/** Every way twelve labels fall into three labelled tables of four. */
function partitions(items) {
  const out = [];
  const combos = (arr, k) => {
    const acc = [];
    const res = [];
    const go = (start) => {
      if (acc.length === k) { res.push([...acc]); return; }
      for (let i = start; i < arr.length; i++) { acc.push(arr[i]); go(i + 1); acc.pop(); }
    };
    go(0);
    return res;
  };
  for (const a of combos(items, 4)) {
    const rest = items.filter((i) => !a.includes(i));
    for (const b of combos(rest, 4)) out.push([a, b, rest.filter((i) => !b.includes(i))]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// who is short of what
// ---------------------------------------------------------------------------

test('the deficient wind of every seat is derived from the template, not written down', () => {
  const d = gf.deficiencyByPoint(template());
  assert.deepEqual(d, VECTORS.deficiency_by_point);
  assert.equal(d.length, 12);

  // And it is genuinely derived: the vector must not appear as a literal in the source.
  // A copy would be a second source of truth that a future template could contradict
  // without anything throwing — it would just draw the wrong seats.
  const src = fs.readFileSync(path.join(ROOT, 'generate-final.js'), 'utf8');
  for (const quote of ['"', "'"]) {
    const literal = d.map((w) => quote + w + quote).join(', ');
    assert.ok(!src.includes(literal), 'the deficiency vector is hardcoded as ' + literal);
  }
});

test('exactly three seats are short of each wind, and every seat is short of exactly one', () => {
  const d = gf.deficiencyByPoint(template());
  for (const w of SEATS) assert.equal(d.filter((x) => x === w).length, 3, 'short of ' + w);
});

test('a template whose seats are not 3-3-3-2 is refused rather than guessed at', () => {
  const tpl = template();
  // Seat one point twice in a round. Note that swapping the SAME wind between two rounds
  // would not do — every point's counts come out unchanged, which is the trap.
  const seats = tpl.rounds[0].tables[0].seats;
  seats.E = seats.S;
  assert.throws(() => gf.deficiencyByPoint(tpl), /this design requires|are short of/);
});

test('an 11-round shape is required, because 4k-1 is what gives one deficient wind', () => {
  const tpl = template();
  tpl.rounds = tpl.rounds.slice(0, 10);
  assert.throws(() => gf.deficiencyByPoint(tpl), /no single deficient wind|4k-1/);
});

test('counting per player and counting per template point give the same answer', () => {
  // The cross-assertion generateFinal relies on: one route through results.seating, the
  // other through the template and the permutation. Disagreement means the two files
  // have drifted apart and neither can say who is short of what.
  const f = fixture();
  const byPoint = gf.deficiencyByPoint(f.tpl);
  const byPlayer = gf.deficiencyByPlayer(f.results.seating, 3);
  for (let point = 0; point < 12; point++) {
    assert.equal(byPlayer.get(f.results.permutation[point]), byPoint[point], 'point ' + point);
  }
});

test('a seat plan that disagrees with the template is refused', () => {
  const f = fixture();
  // Swap two players in the published seating without touching the permutation.
  const t = f.results.seating.rounds[0].tables[0];
  [t.seats.E, t.seats.S] = [t.seats.S, t.seats.E];
  assert.throws(() => run(f), /disagree|this design requires|the template promises/);
});

// ---------------------------------------------------------------------------
// the enumeration
// ---------------------------------------------------------------------------

test('the 24 assignments are enumerated in the one pinned order', () => {
  assert.equal(gf.ASSIGNMENTS.length, 24);
  assert.deepEqual(gf.ASSIGNMENTS.map((a) => a.join('')), VECTORS.assignments);
  assert.deepEqual([...gf.ASSIGNMENTS[0]], [0, 1, 2, 3]);
  assert.deepEqual([...gf.ASSIGNMENTS[7]], [1, 0, 3, 2]);
  assert.deepEqual([...gf.ASSIGNMENTS[23]], [3, 2, 1, 0]);
  assert.equal(new Set(gf.ASSIGNMENTS.map((a) => a.join(''))).size, 24, 'not all distinct');
  for (const a of gf.ASSIGNMENTS) assert.deepEqual([...a].sort(), [0, 1, 2, 3]);
});

test('the maximum completable at a table is the number of distinct deficient winds', () => {
  // Exhaustive over all 256 four-tuples, impossible ones included: the property is about
  // the enumeration, not about which tuples the template can produce.
  const fact = [1, 1, 2, 6, 24];
  let checked = 0;
  for (const a of SEATS) for (const b of SEATS) for (const c of SEATS) for (const d of SEATS) {
    const deficiencies = [a, b, c, d];
    const { best, optima } = gf.optimaFor(deficiencies);
    assert.equal(best, new Set(deficiencies).size, deficiencies.join(''));

    // and the number of optima is (product of multiplicities) x (4 - distinct)!
    const mult = {};
    for (const w of deficiencies) mult[w] = (mult[w] || 0) + 1;
    const expected = Object.values(mult).reduce((p, v) => p * v, 1) * fact[4 - new Set(deficiencies).size];
    assert.equal(optima.length, expected, 'optima for ' + deficiencies.join(''));
    checked += 1;
  }
  assert.equal(checked, 256);
});

test('optima keep the enumeration order, and contain every maximiser and nothing else', () => {
  for (const deficiencies of [['E', 'E', 'S', 'W'], ['E', 'S', 'W', 'N'], ['N', 'N', 'N', 'E']]) {
    const { best, optima } = gf.optimaFor(deficiencies);
    const positions = optima.map((a) => gf.ASSIGNMENTS.indexOf(a));
    assert.deepEqual(positions, [...positions].sort((x, y) => x - y), 'out of enumeration order');
    for (const a of gf.ASSIGNMENTS) {
      let fixed = 0;
      for (let i = 0; i < 4; i++) if (SEATS[a[i]] === deficiencies[i]) fixed += 1;
      assert.equal(optima.includes(a), fixed === best, a.join('') + ' for ' + deficiencies.join(''));
    }
  }
});

// ---------------------------------------------------------------------------
// the draw
// ---------------------------------------------------------------------------

test('the draw reads the stream exactly once per table and never again', () => {
  // The whole specification of "which numbers come out" is "one below() call per table".
  // An extra read anywhere shifts every table after it.
  const f = fixture();
  const calls = [];
  const real = Sha256CounterStream.prototype.below;
  Sha256CounterStream.prototype.below = function spy(bound) {
    calls.push(bound);
    return real.call(this, bound);
  };
  try { run(f); } finally { Sha256CounterStream.prototype.below = real; }
  assert.equal(calls.length, 3, 'read the stream ' + calls.length + ' times, not 3');
});

test('the draw is uniform among the optimal arrangements', () => {
  // Statistical, on synthetic seeds: a table with two players short of the same wind has
  // several optima and each must come up equally often. 20 000 draws, 4 sigma.
  const { optima } = gf.optimaFor(['E', 'E', 'S', 'W']);
  const n = 20_000;
  const hits = new Array(optima.length).fill(0);
  for (let i = 0; i < n; i++) {
    const rng = new Sha256CounterStream(crypto.createHash('sha256').update('u' + i).digest());
    hits[rng.below(optima.length)] += 1;
  }
  const p = 1 / optima.length;
  const sigma = Math.sqrt(n * p * (1 - p));
  for (const hit of hits) {
    assert.ok(Math.abs(hit - n * p) < 4 * sigma, hit + ' of ' + n + ' for 1/' + optima.length);
  }
});

test('a player is completed with probability 1/m, m being those short of the same wind', () => {
  // The fairness claim the result page states out loud. Verified structurally rather than
  // statistically: among the optima, each of the m players short of wind w gets w in the
  // same share of them.
  for (const deficiencies of [['E', 'E', 'S', 'W'], ['N', 'N', 'N', 'E'], ['E', 'E', 'S', 'S']]) {
    const { optima } = gf.optimaFor(deficiencies);
    deficiencies.forEach((d, i) => {
      const m = deficiencies.filter((x) => x === d).length;
      const got = optima.filter((a) => SEATS[a[i]] === d).length / optima.length;
      assert.ok(Math.abs(got - 1 / m) < 1e-12,
        'player ' + i + ' of ' + deficiencies.join('') + ': ' + got + ' vs 1/' + m);
    });
  }
});

test('the whole draw matches the pinned vector', () => {
  const out = run(fixture());
  const v = VECTORS.draw;
  assert.equal(out.R, v.R);
  assert.equal(out.seed, v.seed_final);
  assert.deepEqual(out.completed_local_ids, v.completed_local_ids);
  assert.equal(out.pantheon_prescript_final, v.final_block);
  assert.deepEqual(
    out.tables.map((t) => ({ ...t, assignment: t.assignment.join('') })),
    v.tables,
  );
});

test('the counter-mode stream matches the pinned rejection-sampling vector', () => {
  // tools/verify_final.py reimplements below() from the spec. This is the vector both
  // implementations are held to, because a divergence here is a different seat plan with
  // no error message.
  const seed = Buffer.from(VECTORS.rng.seed, 'hex');
  for (const [bound, expected] of Object.entries(VECTORS.rng.below)) {
    const rng = new Sha256CounterStream(seed);
    const got = Array.from({ length: expected.length }, () => rng.below(Number(bound)));
    assert.deepEqual(got, expected, 'below(' + bound + ')');
  }
});

test('the same inputs reproduce byte for byte, and one bit changes everything', () => {
  const f = fixture();
  assert.equal(serialise(run(f)), serialise(run(f)));
  const flipped = FINAL_SIG.slice(0, -1) + (FINAL_SIG.endsWith('b') ? 'c' : 'b');
  assert.notEqual(run(f, flipped).seed, run(f).seed);
});

test('the standings are honoured byte for byte, inside a block as well as across one', () => {
  const base = run(fixture());

  // Swapping two players INSIDE a rank block leaves the three tables identical, but the
  // standings bytes feed the seed, so the winds are drawn afresh.
  const inside = fixture();
  const s = [...inside.lock.standings];
  [s[0], s[1]] = [s[1], s[0]];
  inside.lock.standings = s;
  const a = run(inside);
  assert.notEqual(a.seed, base.seed, 'a within-block swap did not reach the seed');
  assert.deepEqual(
    a.tables.map((t) => [...t.players].sort((x, y) => x - y)),
    base.tables.map((t) => [...t.players].sort((x, y) => x - y)),
  );

  // Swapping across the 4|5 boundary moves a player to another table.
  const across = fixture();
  const t = [...across.lock.standings];
  [t[3], t[4]] = [t[4], t[3]];
  across.lock.standings = t;
  assert.notDeepEqual(run(across).tables[0].players, base.tables[0].players);
});

test('every player finishes on 3-3-3-3 or 4-3-3-2, and on nothing else', () => {
  const f = fixture();
  const out = run(f);
  const winds = new Map(f.roster.players.map((p) => [p.local_id, { E: 0, S: 0, W: 0, N: 0 }]));
  for (const rd of [...f.results.seating.rounds, ...out.seating.rounds]) {
    for (const tbl of rd.tables) for (const w of SEATS) winds.get(tbl.seats[w].local_id)[w] += 1;
  }
  const complete = [];
  for (const [id, c] of winds) {
    const split = SEATS.map((w) => c[w]).sort((x, y) => y - x).join('-');
    assert.ok(split === '3-3-3-3' || split === '4-3-3-2', 'local_id ' + id + ' finished ' + split);
    if (split === '3-3-3-3') complete.push(id);
  }
  assert.equal(complete.length, out.completed_count);
  assert.deepEqual(complete.sort((a, b) => a - b), out.completed_local_ids);
});

// ---------------------------------------------------------------------------
// what it refuses
// ---------------------------------------------------------------------------

test('it refuses standings that are not a permutation of the roster', () => {
  for (const standings of [
    [7, 2, 11, 4, 9, 1, 12, 5, 3, 10, 8],          // eleven
    [7, 2, 11, 4, 9, 1, 12, 5, 3, 10, 8, 8],       // a duplicate
    [7, 2, 11, 4, 9, 1, 13, 5, 3, 10, 8, 6],       // not in the roster
  ]) {
    assert.throws(() => run(fixture({ standings })), /standings/, JSON.stringify(standings));
  }
});

test('it refuses a signature from another chain, by its decoded length', () => {
  // The fixed-width argument for the byte encoding depends on this check.
  const f = fixture();
  assert.throws(() => run(f, 'ab'.repeat(32)), /not the same chain/);
  assert.throws(() => run(f, 'nothex'), /hex string/);
});

test('it refuses a final round that does not come after the first draw', () => {
  const f = fixture();
  f.lock.target_round = f.results.round_used;
  assert.throws(() => run(f), /must come after/);
  f.lock.target_round = f.results.round_used - 1;
  assert.throws(() => run(f), /must come after/);
});

test('it refuses a template it cannot split into equal tables', () => {
  const f = fixture();
  f.tpl = { ...f.tpl, n_tables: 5 };
  assert.throws(() => run(f), /equal tables/);
});

// ---------------------------------------------------------------------------
// the statistical claims seating-design.md makes
// ---------------------------------------------------------------------------

test('under a uniform standings model the exact counts are as documented', () => {
  // Exhaustive over all 12!/(4!^3) = 34 650 ways the twelve deficiency labels fall into
  // three labelled tables of four. Exact integers, no RNG, no tolerance.
  const def = gf.deficiencyByPoint(template());
  const all = partitions([...Array(12).keys()]);
  let total = 0;
  const hist = new Map();
  for (const tables of all) {
    const completed = tables.reduce((s, g) => s + new Set(g.map((i) => def[i])).size, 0);
    total += completed;
    hist.set(completed, (hist.get(completed) || 0) + 1);
  }

  assert.equal(all.length, 34650);
  assert.equal(total, 309960, 'E[completed] = 309960/34650 = 4428/495 = 8.9454...');
  assert.equal(hist.get(12), 1296, 'P(all twelve) = 1296/34650 = 3.7403%');
  assert.equal(hist.get(11) ?? 0, 0, 'exactly eleven is impossible');
  assert.equal(Math.min(...hist.keys()), 6);
  assert.equal(hist.get(6), 792);
});

test('under a uniform standings model the residual seat bias is (4/3)(1-P) = 0.3394', () => {
  // The zero-sum argument in seating-design.md: v(E)+v(S)+v(W)+v(N) = 0, so a 3-3-3-3
  // player carries exactly zero seat handicap into the final standings. The residual for
  // everyone else is E[H12]/H11 = (4/3)(1 - P(own deficit)) — which needs P to be the
  // same for every non-deficient wind, so that is asserted rather than assumed.
  const def = gf.deficiencyByPoint(template());
  const acc = new Map(SEATS.map((w) => [w, { n: 0, p: { E: 0, S: 0, W: 0, N: 0 } }]));
  for (const tables of partitions([...Array(12).keys()])) {
    for (const g of tables) {
      const deficiencies = g.map((i) => def[i]);
      const { optima } = gf.optimaFor(deficiencies);
      g.forEach((point, i) => {
        const e = acc.get(def[point]);
        e.n += 1;
        for (const w of SEATS) e.p[w] += optima.filter((x) => SEATS[x[i]] === w).length / optima.length;
      });
    }
  }
  let ownDeficit = null;
  for (const w of SEATS) {
    const e = acc.get(w);
    const others = SEATS.filter((x) => x !== w).map((x) => e.p[x] / e.n);
    assert.ok(Math.max(...others) - Math.min(...others) < 1e-9,
      'the three non-deficient winds are not equally likely for someone short of ' + w);
    const own = e.p[w] / e.n;
    if (ownDeficit === null) ownDeficit = own;
    assert.ok(Math.abs(own - ownDeficit) < 1e-9, 'P(own deficit) differs between winds');
  }
  // E[completed]/12 is the same quantity seen from the other side.
  assert.ok(Math.abs(ownDeficit - 309960 / 34650 / 12) < 1e-12);
  assert.ok(Math.abs((4 / 3) * (1 - ownDeficit) - 0.33939393939) < 1e-9);
  // Pure uniform would leave the eleven-round bias fully intact.
  assert.ok(Math.abs((4 / 3) * (1 - 0.25) - 1) < 1e-12);
});

// ---------------------------------------------------------------------------
// the prescript and the seat plan's shape
// ---------------------------------------------------------------------------

test('the prescript is twelve blocks, with the first eleven byte-identical', () => {
  const f = fixture();
  const out = run(f);
  const blocks = out.pantheon_prescript.split('\n\n');
  assert.equal(blocks.length, 12);
  assert.equal(blocks.slice(0, 11).join('\n\n'), f.results.pantheon_prescript);
  assert.equal(blocks[11], out.pantheon_prescript_final);
  assert.equal(out.pantheon_next_session_index, 12);

  const lines = blocks[11].split('\n');
  assert.equal(lines.length, 3, 'three tables');
  const seated = lines.flatMap((l) => l.split('-').map(Number));
  assert.deepEqual(
    [...seated].sort((a, b) => a - b),
    f.roster.players.map((p) => p.local_id).sort((a, b) => a - b),
  );
});

test('the twelfth round carries a rank, not a template point', () => {
  // Round 12 has no abstract point. A null one here would invite code to treat it as one
  // — which is exactly how stats.js came to overwrite everybody's point with undefined.
  const out = run(fixture());
  for (const tbl of out.seating.rounds[0].tables) {
    for (const w of SEATS) {
      assert.equal(tbl.seats[w].point, undefined);
      const rank = tbl.seats[w].rank;
      assert.ok(Number.isInteger(rank) && rank >= 1 && rank <= 12, 'rank ' + rank);
    }
    assert.deepEqual(Object.keys(tbl.seats), SEATS, 'seat keys must come out E, S, W, N');
  }
  assert.equal(out.seating.rounds[0].round, 12);
});

test('the tables are the rank blocks, in order', () => {
  const f = fixture();
  const out = run(f);
  assert.deepEqual(out.tables[0].players, f.lock.standings.slice(0, 4));
  assert.deepEqual(out.tables[1].players, f.lock.standings.slice(4, 8));
  assert.deepEqual(out.tables[2].players, f.lock.standings.slice(8, 12));
});
