#!/usr/bin/env node
'use strict';

/**
 * The final round: fixed tables, drawn winds (PROTOCOL.md §11).
 *
 * After the eleven template rounds a twelfth is played. Its TABLES are not drawn — they
 * are the standings (ranks 1-4 at table 1, 5-8 at table 2, 9-12 at table 3). Only the
 * WINDS are drawn, and this file is the whole of that draw.
 *
 * ---------------------------------------------------------------------------
 * WHY THERE IS ANYTHING TO DRAW, AND WHAT IT IS DRAWING FOR
 *
 * Over the eleven template rounds every abstract point gets a 3-3-3-2 wind split, so
 * every player is short of exactly one wind. The template spreads those twelve deficits
 * evenly: exactly three points short of East, three of South, three of West, three of
 * North. (Derived here from the template, never written down — see deficiencyByPoint.)
 *
 * Mahjong at a table is zero-sum and the uma sums to zero, so the four seats' expected
 * contributions sum to zero:
 *
 *     v(E) + v(S) + v(W) + v(N) = 0
 *
 * That identity — not a model of mahjong, just zero-sum — is what makes 3-3-3-3 the
 * target. A player who plays three of each carries a seat handicap of exactly
 * 3·(v(E)+v(S)+v(W)+v(N)) = 0 into the final standings, whatever the values of v are. A
 * player on 4-3-3-2 carries exactly v(a) − v(b): small, but systematic, and it does not
 * wash out with more games.
 *
 * So the objective is to complete as many players to 3-3-3-3 as the standings allow, and
 * then to be uniform among the ways of doing it. The twelfth round is the only remaining
 * chance to cancel a deficit every player is carrying.
 *
 * WHAT THIS COSTS, STATED HERE BECAUSE IT IS NOT VISIBLE FROM THE CODE
 *
 * A player's chance of being completed is 1/m, where m is the number of players at their
 * table short of the SAME wind. That is not equal across players, and the inequality is
 * settled by the standings and by a permutation drawn eleven rounds earlier — both
 * already public. Two consequences, both documented in seating-design.md rather than
 * hidden:
 *
 *   - There is a lever. Someone short of East does better separated from the other two
 *     players short of East; someone short of North does better beside them. Only the
 *     rank BAND matters, not the rank. The entire prize is 0.34 × one seat's edge in one
 *     game, against the cost of moving a band in a zero-sum final — a bad trade, but a
 *     real one.
 *   - Sometimes the beacon decides nothing. When all three tables happen to hold four
 *     distinct deficits there is exactly one optimal assignment per table, and the whole
 *     round is settled before the signature exists. That is 3.74% of standings orders.
 *
 * An alternative that removes the lever — draw all 24 uniformly — leaves every player's
 * eleven-round deficit fully intact, because E[completed] = Σ P(player gets their wind),
 * and if every marginal is 1/4 that sum is exactly 12 × 1/4 = 3. Maximising completion
 * and equalising the marginals are incompatible; this file chooses completion.
 * ---------------------------------------------------------------------------
 * THE BYTE ENCODING
 *
 *   SEP = 0x1f (ASCII unit separator)
 *
 *   seed_final = SHA256(
 *       DOMAIN            utf8, no SEP (validated)
 *     ‖ SEP ‖ "final"     ascii
 *     ‖ SEP ‖ R           32 raw bytes, from results.json
 *     ‖ SEP ‖ signature   raw bytes, hex-decoded, for the final target round
 *     ‖ SEP ‖ standings   1 byte each, local_ids in FINISHING ORDER, rank 1 first
 *     ‖ SEP ‖ local_ids   1 byte each, ascending — who contributed to R
 *   )
 *
 * generate.js argues its encoding is unambiguous because every field is fixed-width or
 * validated SEP-free, with the one variable-count field last. That argument does NOT
 * carry over as written: here there are TWO variable-length fields whose bytes may
 * legitimately contain 0x1f — the signature and the standings. The argument is restored,
 * at no cost, by pinning both lengths instead:
 *
 *   - standings is exactly protocol.total_slots bytes and is a permutation of the
 *     roster's local_ids;
 *   - local_ids equals sort(results.participating_local_ids), whose length results.json
 *     already fixes;
 *   - the signature decodes to exactly as many bytes as results.drand_signature does.
 *
 * With those three checks every field is fixed-width, so no two distinct inputs can
 * produce the same byte string, and the separators are belt-and-braces on top as before.
 * ---------------------------------------------------------------------------
 *
 * CLI:
 *   node generate-final.js --signature <hex>
 *                          [--results results.json] [--lock events/final/lock.json]
 *                          [--roster data/roster.json] [--protocol data/protocol.json]
 *                          [--template data/schedule_template.json] [--out final.json]
 *
 *   node generate-final.js --verify final.json      # recompute from the file's own
 *                                                   # inputs, diff byte for byte
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

// The CSPRNG, the seat order and the prescript format all come from generate.js rather
// than being written again here. Two copies of a counter-mode stream is two places for
// it to differ, and the difference would be a different seat plan with no error.
const { Sha256CounterStream, SEAT_ORDER, buildPrescript } = require('./generate');

const SEP = 0x1f;
const HASH_BYTES = 32;

const sep = () => Buffer.from([SEP]);
const u8 = (n) => Buffer.from([n]);

function assertNoSep(buf, what) {
  if (buf.includes(SEP)) throw new Error(`${what} may not contain byte 0x1f`);
  return buf;
}

function domainBytes(domain) {
  if (typeof domain !== 'string' || domain.length === 0) {
    throw new Error('seed_domain_separation must be a non-empty string');
  }
  return assertNoSep(Buffer.from(domain, 'utf8'), 'seed_domain_separation');
}

function hexBytes(hex, what) {
  if (typeof hex !== 'string' || !/^[0-9a-fA-F]+$/.test(hex) || hex.length % 2 !== 0) {
    throw new Error(`${what} must be a hex string`);
  }
  return Buffer.from(hex, 'hex');
}

// ---------------------------------------------------------------------------
// which wind each player is short of
// ---------------------------------------------------------------------------

/**
 * The deficient wind of every abstract point, derived from the frozen template.
 *
 * Never a literal. The vector is a property of schedule_template.json, and a copy of it
 * in this file would be a second source of truth that a future template could silently
 * contradict — which would not throw, it would just draw the wrong seats. So it is
 * recomputed, and the shape it must have is asserted rather than assumed.
 *
 * The shape: with n_rounds rounds, a perfectly even split would be n_rounds/4 of each
 * wind. 11 is not a multiple of 4, so the best possible is k of three winds and k-1 of
 * the fourth, where 4k − 1 = n_rounds. Every point must be exactly that, and each wind
 * must come up short for exactly k·n_players − n_rounds·n_tables points.
 */
function deficiencyByPoint(template) {
  const n = template.n_players;
  const rounds = template.rounds;
  if (!Array.isArray(rounds) || rounds.length === 0) throw new Error('template has no rounds');
  if ((rounds.length + 1) % 4 !== 0) {
    throw new Error(
      `a ${rounds.length}-round template has no single deficient wind per point ` +
        '(this design needs 4k-1 rounds, e.g. 11)'
    );
  }
  const k = (rounds.length + 1) / 4;

  const counts = Array.from({ length: n }, () => ({ E: 0, S: 0, W: 0, N: 0 }));
  for (const rd of rounds) {
    for (const tbl of rd.tables) {
      for (const w of SEAT_ORDER) {
        const point = tbl.seats[w];
        if (!Number.isInteger(point) || point < 0 || point >= n) {
          throw new Error(`round ${rd.round} table ${tbl.table} seat ${w}: bad point ${point}`);
        }
        counts[point][w] += 1;
      }
    }
  }

  const out = counts.map((c, point) => {
    const short = SEAT_ORDER.filter((w) => c[w] === k - 1);
    const full = SEAT_ORDER.filter((w) => c[w] === k);
    if (short.length !== 1 || full.length !== 3) {
      throw new Error(
        `point ${point} has winds ${SEAT_ORDER.map((w) => `${w}${c[w]}`).join(' ')}, ` +
          `not the ${k},${k},${k},${k - 1} this design requires`
      );
    }
    return short[0];
  });

  // Every wind must be short for the same number of points, or "three short of each"
  // is not true of this template and the whole objective changes shape.
  const perWind = k * n - rounds.length * template.n_tables;
  for (const w of SEAT_ORDER) {
    const got = out.filter((x) => x === w).length;
    if (got !== perWind) {
      throw new Error(`${got} points are short of ${w}, expected ${perWind}`);
    }
  }
  return out;
}

/**
 * The same thing counted the other way: straight off the seat plan, per player.
 *
 * This exists to be compared with deficiencyByPoint composed through `permutation`. They
 * are two independent routes to the same fact — one from the template, one from the
 * published result — and generateFinal refuses if they disagree, because a disagreement
 * means results.json and the template have drifted apart and neither can be trusted to
 * say who is short of what.
 */
function deficiencyByPlayer(seating, k) {
  const winds = new Map();
  for (const rd of seating.rounds) {
    for (const tbl of rd.tables) {
      for (const w of SEAT_ORDER) {
        const id = tbl.seats[w].local_id;
        if (!winds.has(id)) winds.set(id, { E: 0, S: 0, W: 0, N: 0 });
        winds.get(id)[w] += 1;
      }
    }
  }
  const out = new Map();
  for (const [id, c] of winds) {
    const short = SEAT_ORDER.filter((w) => c[w] === k - 1);
    const full = SEAT_ORDER.filter((w) => c[w] === k);
    if (short.length !== 1 || full.length !== 3) {
      throw new Error(
        `local_id ${id} has winds ${SEAT_ORDER.map((w) => `${w}${c[w]}`).join(' ')}, ` +
          `not the ${k},${k},${k},${k - 1} the template promises`
      );
    }
    out.set(id, short[0]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// the 24 assignments, in one fixed order
// ---------------------------------------------------------------------------

/**
 * Every way to seat four players in four winds, enumerated once, in lexicographic order.
 *
 * `ASSIGNMENTS[j][i]` is the SEAT INDEX given to the i-th player of the table, where the
 * players are in rank order (best first) and the seat index is into SEAT_ORDER. The
 * direction matters and is easy to get backwards: this maps player → seat, not seat →
 * player. Reversed, it produces a different draw that looks equally plausible.
 *
 * The order is load-bearing. `optima` is filtered out of this list and keeps its order,
 * and the draw is an index into `optima`. An independent reimplementation that enumerates
 * differently will agree on the seed and disagree on the seats, which is the worst
 * possible failure: silent. Pinned in test/final-vectors.json, and printed in
 * seating-design.md so it can be checked without reading any code.
 */
const ASSIGNMENTS = (() => {
  const out = [];
  const build = (acc) => {
    if (acc.length === SEAT_ORDER.length) { out.push(Object.freeze(acc.slice())); return; }
    for (let s = 0; s < SEAT_ORDER.length; s++) {
      if (!acc.includes(s)) { acc.push(s); build(acc); acc.pop(); }
    }
  };
  build([]);
  return Object.freeze(out);
})();

/**
 * The assignments that complete the most players at one table, in enumeration order.
 *
 * The maximum is always the number of DISTINCT deficient winds at the table: give one
 * representative of each distinct wind the wind they want, and the players left over take
 * the seats nobody was short of. So `best` could be computed directly — but it is found
 * by enumeration anyway, because enumerating is 24 steps and a closed form is a second
 * claim to keep true.
 */
function optimaFor(deficiencies) {
  let best = -1;
  const optima = [];
  for (const a of ASSIGNMENTS) {
    let fixed = 0;
    for (let i = 0; i < a.length; i++) if (SEAT_ORDER[a[i]] === deficiencies[i]) fixed += 1;
    if (fixed > best) { best = fixed; optima.length = 0; }
    if (fixed === best) optima.push(a);
  }
  return { best, optima };
}

// ---------------------------------------------------------------------------
// the seed
// ---------------------------------------------------------------------------

/** The encoding at the top of this file, and nothing else. */
function deriveFinalSeed({ R, signature, standings, localIds, domain }) {
  if (!Buffer.isBuffer(R) || R.length !== HASH_BYTES) throw new Error('R must be 32 bytes');
  const h = crypto
    .createHash('sha256')
    .update(domainBytes(domain))
    .update(sep()).update(Buffer.from('final', 'ascii'))
    .update(sep()).update(R)
    .update(sep()).update(signature)
    .update(sep());
  for (const id of standings) h.update(u8(id));
  h.update(sep());
  for (const id of [...localIds].sort((a, b) => a - b)) h.update(u8(id));
  return h.digest();
}

// ---------------------------------------------------------------------------
// the draw
// ---------------------------------------------------------------------------

/**
 * One `below()` call per table, in table order, off one stream. Nothing else reads it.
 *
 * Per-table optimisation is globally optimal and per-table uniformity is globally
 * uniform, which is why this can be a loop rather than a search:
 *
 *   - the three tables partition the twelve players and no constraint crosses a table,
 *     so the global maximum is the sum of the per-table maxima and any combination of
 *     per-table optima is a global optimum;
 *   - the set of global optima is therefore the Cartesian product of the three per-table
 *     optimum sets, and drawing independently and uniformly from each factor is exactly
 *     the uniform distribution on the product.
 */
function drawTables({ standings, deficiency, rng, blockSize, nTables }) {
  const out = [];
  for (let t = 1; t <= nTables; t++) {
    const players = standings.slice(blockSize * (t - 1), blockSize * t);
    const deficiencies = players.map((id) => {
      const d = deficiency.get(id);
      if (!d) throw new Error(`no deficient wind known for local_id ${id}`);
      return d;
    });
    const { best, optima } = optimaFor(deficiencies);
    const index = rng.below(optima.length);
    out.push({
      table: t,
      players,
      deficiencies,
      completed: best,
      optima_count: optima.length,
      optimum_index: index,
      assignment: [...optima[index]],
    });
  }
  return out;
}

/** The twelfth round in the same shape results.json uses, so one renderer serves both. */
function buildFinalSeating(tables, roster, standings, roundNumber) {
  const byId = new Map(roster.players.map((p) => [p.local_id, p]));
  const rankOf = new Map(standings.map((id, i) => [id, i + 1]));
  return {
    seat_order: SEAT_ORDER,
    rounds: [{
      round: roundNumber,
      tables: tables.map((t) => {
        // Filled by seat index so the keys come out E, S, W, N — the same order
        // results.json uses, which is what makes the two files comparable by eye.
        const bySeat = [];
        t.players.forEach((id, i) => { bySeat[t.assignment[i]] = id; });
        const seats = {};
        SEAT_ORDER.forEach((w, si) => {
          const id = bySeat[si];
          const p = byId.get(id);
          if (!p) throw new Error(`standings name unknown local_id ${id}`);
          // `rank`, not `point`: the twelfth round has no template point, and putting a
          // null one here would invite code to treat it as one.
          seats[w] = { rank: rankOf.get(id), local_id: id, title: p.title };
        });
        return { table: t.table, seats };
      }),
    }],
  };
}

// ---------------------------------------------------------------------------
// the whole of §11, as one pure function
// ---------------------------------------------------------------------------

function generateFinal({ results, lock, signature, roster, protocol, template }) {
  const players = roster.players;
  if (!Array.isArray(players) || players.length !== protocol.total_slots) {
    throw new Error(`roster.json holds ${players?.length} players, protocol says ${protocol.total_slots}`);
  }
  if (template.n_players !== protocol.total_slots) {
    throw new Error(`template is for ${template.n_players} points, protocol says ${protocol.total_slots} slots`);
  }
  const nTables = template.n_tables;
  if (!Number.isInteger(nTables) || nTables < 1 || template.n_players % nTables !== 0) {
    throw new Error(`cannot split ${template.n_players} players into ${nTables} equal tables`);
  }
  const blockSize = template.n_players / nTables;

  // ---- the standings --------------------------------------------------------
  const standings = lock.standings;
  const rosterIds = players.map((p) => p.local_id).sort((a, b) => a - b);
  if (!Array.isArray(standings) || standings.length !== protocol.total_slots) {
    throw new Error(`standings must list all ${protocol.total_slots} players in finishing order`);
  }
  if (!standings.every((id) => Number.isInteger(id))) throw new Error('standings must be integers');
  const sortedStandings = [...standings].sort((a, b) => a - b);
  if (sortedStandings.some((id, i) => id !== rosterIds[i])) {
    throw new Error('standings are not a permutation of the roster local_ids');
  }

  // ---- what the first draw settled -----------------------------------------
  const R = hexBytes(results.R, 'results.R');
  if (R.length !== HASH_BYTES) throw new Error(`results.R must be ${HASH_BYTES} bytes`);
  const participating = [...results.participating_local_ids].sort((a, b) => a - b);
  if (participating.length === 0) throw new Error('results.json names no participants');

  // The signature's decoded length is pinned to the first draw's, which is what lets the
  // encoding note above claim every field is fixed-width. Same chain, same curve, same
  // length; a different length means a different chain and the lock is for another event.
  const sigBytes = hexBytes(signature, 'signature');
  const firstSig = hexBytes(results.drand_signature, 'results.drand_signature');
  if (sigBytes.length !== firstSig.length) {
    throw new Error(
      `the final signature decodes to ${sigBytes.length} bytes, the first draw's to ` +
        `${firstSig.length} — these are not the same chain`
    );
  }
  if (!Number.isInteger(lock.target_round) || lock.target_round <= results.round_used) {
    throw new Error(
      `the final round ${lock.target_round} must come after the first draw's ${results.round_used}`
    );
  }

  // ---- who is short of what, twice, independently ---------------------------
  const k = (template.rounds.length + 1) / 4;
  const byPoint = deficiencyByPoint(template);
  const byPlayer = deficiencyByPlayer(results.seating, k);
  for (let point = 0; point < byPoint.length; point++) {
    const id = results.permutation[point];
    if (byPlayer.get(id) !== byPoint[point]) {
      throw new Error(
        `local_id ${id} is short of ${byPlayer.get(id)} in results.json but of ` +
          `${byPoint[point]} at template point ${point} — the result and the template disagree`
      );
    }
  }

  // ---- the draw -------------------------------------------------------------
  const domain = protocol.seed_domain_separation;
  const seed = deriveFinalSeed({ R, signature: sigBytes, standings, localIds: participating, domain });
  const rng = new Sha256CounterStream(seed);
  const tables = drawTables({ standings, deficiency: byPlayer, rng, blockSize, nTables });

  const roundNumber = template.rounds.length + 1;
  const seating = buildFinalSeating(tables, roster, standings, roundNumber);

  // Who ends the tournament on three of every wind. Derived from the draw rather than
  // from `completed`, so the two have to agree or this is wrong in a visible way.
  const complete = [];
  for (const t of tables) {
    t.players.forEach((id, i) => {
      if (SEAT_ORDER[t.assignment[i]] === t.deficiencies[i]) complete.push(id);
    });
  }
  complete.sort((a, b) => a - b);
  const completedTotal = tables.reduce((s, t) => s + t.completed, 0);
  if (complete.length !== completedTotal) {
    throw new Error(`draw completed ${complete.length} players but the optima say ${completedTotal}`);
  }

  const finalBlock = buildPrescript(seating);

  return {
    final_round: roundNumber,
    round_used: lock.target_round,
    drand_signature: signature,
    // What this draw is bound to. Either byte changing makes a different final round,
    // and both files are published, so a verifier can check the binding rather than
    // take it on trust.
    results_sha256: lock.results_sha256,
    lock_sha256: lock.lock_sha256 ?? null,
    standings,
    participating_local_ids: participating,
    R: results.R,
    seed: seed.toString('hex'),
    deficient_winds: Object.fromEntries([...byPlayer].sort((a, b) => a[0] - b[0])),
    tables: tables.map((t) => ({
      table: t.table,
      players: t.players,
      deficiencies: t.deficiencies,
      completed: t.completed,
      optima_count: t.optima_count,
      optimum_index: t.optimum_index,
      assignment: t.assignment,
    })),
    completed_local_ids: complete,
    completed_count: complete.length,
    assignment_note:
      'assignment[i] is the index into seat_order given to the i-th player of the table, ' +
      'players in rank order; the 24 assignments are enumerated in lexicographic order and ' +
      'the draw is optima[optimum_index] — see generate-final.js',
    encoding_note:
      'seed = SHA256(DOMAIN 1f "final" 1f R 1f hexdecode(signature) 1f u8(standings)... 1f ' +
      'u8(local_id)...) — see generate-final.js',
    seed_domain_separation: domain,
    schedule_template_ref: protocol.schedule_template_ref,
    generate_script_ref: protocol.generate_script_ref,
    generate_final_script_ref: protocol.generate_final_script_ref,
    pantheon_event_id: roster.pantheon_event_id,
    seating,
    // The full twelve blocks. Writing only the new one would tell Pantheon to re-seat
    // session 1 from the final round's tables; writing all twelve means the read-back
    // also proves the eleven played sessions were not disturbed.
    pantheon_prescript: `${results.pantheon_prescript}\n\n${finalBlock}`,
    pantheon_prescript_final: finalBlock,
    pantheon_next_session_index: roundNumber,
  };
}

/** The one canonical serialisation, same as generate.js's. */
function serialise(out) {
  return JSON.stringify(out, null, 2) + '\n';
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const k = argv[i].slice(2);
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) out[k] = true;
    else { out[k] = v; i += 1; }
  }
  return out;
}

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function loadInputs(args, root) {
  const resultsPath = args.results || path.join(root, 'results.json');
  const lockPath = args.lock || path.join(root, 'events', 'final', 'lock.json');
  const rosterPath = args.roster || path.join(root, 'data', 'roster.json');
  const protocolPath = args.protocol || path.join(root, 'data', 'protocol.json');
  const templatePath = args.template || path.join(root, 'data', 'schedule_template.json');

  const resultsBytes = fs.readFileSync(resultsPath);
  const lockBytes = fs.readFileSync(lockPath);
  const lock = JSON.parse(lockBytes.toString('utf8'));

  // The lock names the bytes it was made against. If results.json has changed since,
  // everything downstream is about a different draw.
  if (lock.results_sha256 && lock.results_sha256 !== sha256(resultsBytes)) {
    throw new Error(
      `${resultsPath} does not match the lock: lock says ${lock.results_sha256}, ` +
        `the file hashes to ${sha256(resultsBytes)}`
    );
  }
  return {
    results: JSON.parse(resultsBytes.toString('utf8')),
    lock: { ...lock, lock_sha256: sha256(lockBytes) },
    roster: readJson(rosterPath),
    protocol: readJson(protocolPath),
    template: readJson(templatePath),
    paths: { resultsPath, lockPath },
  };
}

function main(argv) {
  const args = parseArgs(argv);
  const root = __dirname;

  if (args.verify) {
    const file = typeof args.verify === 'string' ? args.verify : path.join(root, 'final.json');
    const onDisk = fs.readFileSync(file, 'utf8');
    const claimed = JSON.parse(onDisk);
    const inputs = loadInputs(args, root);
    const rebuilt = serialise(generateFinal({
      results: inputs.results,
      lock: inputs.lock,
      signature: claimed.drand_signature,
      roster: inputs.roster,
      protocol: inputs.protocol,
      template: inputs.template,
    }));
    if (rebuilt === onDisk) {
      process.stdout.write(`  OK    ${file} reproduces byte for byte\n`);
      process.stdout.write(`        seed ${claimed.seed}\n`);
      process.stdout.write(`        ${claimed.completed_count} of ${claimed.standings.length} finish on 3-3-3-3\n`);
      return 0;
    }
    process.stderr.write(`  FAIL  ${file} does not reproduce\n`);
    const a = onDisk.split('\n');
    const b = rebuilt.split('\n');
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      if (a[i] !== b[i]) {
        process.stderr.write(`        line ${i + 1}\n          file: ${a[i]}\n          ours: ${b[i]}\n`);
        break;
      }
    }
    return 1;
  }

  if (typeof args.signature !== 'string') {
    process.stderr.write('usage: node generate-final.js --signature <hex> [--out final.json]\n');
    process.stderr.write('       node generate-final.js --verify final.json\n');
    return 2;
  }

  const inputs = loadInputs(args, root);
  const out = generateFinal({
    results: inputs.results,
    lock: inputs.lock,
    signature: args.signature,
    roster: inputs.roster,
    protocol: inputs.protocol,
    template: inputs.template,
  });
  const body = serialise(out);
  const target = args.out || path.join(root, 'final.json');
  fs.writeFileSync(target, body);
  process.stdout.write(`  OK    ${target}\n`);
  process.stdout.write(`        seed ${out.seed}\n`);
  process.stdout.write(`        ${out.completed_count} of ${out.standings.length} finish on 3-3-3-3\n`);
  for (const t of out.tables) {
    process.stdout.write(
      `        table ${t.table}: ${t.players.join(',')} — ${t.completed} completed, ` +
      `${t.optima_count} optimal arrangement(s), drew #${t.optimum_index}\n`
    );
  }
  return 0;
}

module.exports = {
  generateFinal, serialise, deriveFinalSeed, deficiencyByPoint, deficiencyByPlayer,
  ASSIGNMENTS, optimaFor, drawTables, buildFinalSeating,
};

if (require.main === module) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`  ERROR ${err.message}\n`);
    process.exitCode = 1;
  }
}
