'use strict';

/**
 * Per-player statistics for GET /api/result (UI-SPEC.md §7).
 *
 * Derived entirely from the seat plan, and computed on the server so the client does
 * no combinatorics. Nothing here is part of the frozen algorithm — it is a reading of
 * the result, not an input to it — which is why it lives outside generate.js.
 *
 * SEAT GEOMETRY. Seats run counter-clockwise E → S → W → N. The upper hand of seat i
 * is seat i-1, so E's upper hand is N and S's is E. Opposite pairs are (E,W) and (S,N).
 * This matches tools/verify_template.py exactly; if the two ever disagree, the figures
 * shown to players would contradict the template verifier they are invited to run.
 *
 * ---------------------------------------------------------------------------
 * TWO SCOPES, AND WHY THEY MUST NOT BE MERGED
 *
 * With a twelfth round (PROTOCOL.md §11) the seat plan stops being one thing. Round 12's
 * table is earned, not drawn, so it breaks the template's pairing invariants — some pairs
 * meet a fourth time, some sit opposite twice. So every figure here belongs to exactly
 * one of two scopes, and the split is the whole design of this file:
 *
 *   winds and tables    counted over ALL rounds — that is the quantity the final round
 *                       exists to correct, and a count that stopped at eleven would be
 *                       answering a question nobody asked
 *
 *   pairs               counted over the TEMPLATE rounds only — same_table 3x, opposite
 *                       1x and 55/66 perfect pairs are properties OF THE TEMPLATE, proved
 *                       by verify_template.py, and players are invited to run it. If
 *                       these figures quietly changed meaning, the page would contradict
 *                       the verifier it points at.
 *
 * The twelfth round's own pair relations are not discarded — they go in a nested `final`
 * on each opponent, where they cannot be mistaken for the template's.
 *
 * With extraRounds = [] every key keeps exactly the value it had before the final round
 * existed, so a pre-final result page is byte-identical to what it always was.
 * ---------------------------------------------------------------------------
 */

const SEAT_ORDER = ['E', 'S', 'W', 'N'];

/** What the template achieves for every seat, and therefore what "imbalanced" is not. */
const IDEAL_TABLE_SPLIT = [4, 4, 3];

const pairKey = (a, b) => (a < b ? `${a}:${b}` : `${b}:${a}`);
const sameArray = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

/**
 * The wind a player is short of over the template rounds, or null.
 *
 * Null rather than a guess: this is only meaningful when the split is k,k,k,k-1, which
 * is what the eleven-round template guarantees and what generate-final.js requires. A
 * seat plan that does not have that shape has no "missing wind" to name.
 */
function deficientWind(counts) {
  const values = SEAT_ORDER.map((w) => counts[w]);
  const high = Math.max(...values);
  const short = SEAT_ORDER.filter((w) => counts[w] === high - 1);
  const full = SEAT_ORDER.filter((w) => counts[w] === high);
  return short.length === 1 && full.length === SEAT_ORDER.length - 1 ? short[0] : null;
}

/** Accumulate the pair relations produced by one list of rounds. */
function pairsOver(rounds) {
  const pairs = new Map();
  const pairOf = (a, b) => {
    const k = pairKey(a, b);
    if (!pairs.has(k)) pairs.set(k, { same_table: 0, opposite: 0, upstream: new Map([[a, 0], [b, 0]]) });
    return pairs.get(k);
  };
  for (const rd of rounds) {
    for (const tbl of rd.tables) {
      const seated = SEAT_ORDER.map((w) => ({ wind: w, ...tbl.seats[w] }));

      // every unordered pair at this table met once
      for (let i = 0; i < seated.length; i++) {
        for (let j = i + 1; j < seated.length; j++) {
          pairOf(seated[i].local_id, seated[j].local_id).same_table += 1;
        }
      }
      // opposite: (E,W) and (S,N) — indices 0/2 and 1/3
      for (const [i, j] of [[0, 2], [1, 3]]) {
        pairOf(seated[i].local_id, seated[j].local_id).opposite += 1;
      }
      // adjacency: seat i-1 is the upper hand of seat i
      for (let i = 0; i < 4; i++) {
        const upper = seated[(i + 3) % 4].local_id;
        const lower = seated[i].local_id;
        const p = pairOf(upper, lower);
        p.upstream.set(upper, p.upstream.get(upper) + 1);
      }
    }
  }
  return pairs;
}

/**
 * @param {object} seating      results.seating — the template rounds, and only those
 * @param {Array}  players      roster.players — for titles and to fix the row order
 * @param {Array}  [extraRounds] rounds played outside the template, in order. Today that
 *                 is final.seating.rounds, i.e. the one final round; [] before it exists.
 * @returns per-player stats plus the grid the explorer renders
 */
function computeStats(seating, players, extraRounds = []) {
  const ids = players.map((p) => p.local_id).sort((a, b) => a - b);
  const titleOf = new Map(players.map((p) => [p.local_id, p.title]));
  const counted = [...seating.rounds, ...extraRounds];

  const winds = new Map(ids.map((id) => [id, { E: 0, S: 0, W: 0, N: 0 }]));
  const windsTemplate = new Map(ids.map((id) => [id, { E: 0, S: 0, W: 0, N: 0 }]));
  const tables = new Map(ids.map((id) => [id, {}]));
  const tablesTemplate = new Map(ids.map((id) => [id, {}]));
  const cells = new Map(ids.map((id) => [id, {}])); // local_id -> round -> {table, wind, ...}
  const points = new Map();

  // ---- winds, tables and the grid: every round that was played ---------------
  const templateRounds = new Set(seating.rounds.map((rd) => rd.round));
  for (const rd of counted) {
    const isTemplate = templateRounds.has(rd.round);
    for (const tbl of rd.tables) {
      for (const w of SEAT_ORDER) {
        const s = tbl.seats[w];
        winds.get(s.local_id)[w] += 1;
        const t = tables.get(s.local_id);
        t[tbl.table] = (t[tbl.table] || 0) + 1;

        if (isTemplate) {
          windsTemplate.get(s.local_id)[w] += 1;
          const tt = tablesTemplate.get(s.local_id);
          tt[tbl.table] = (tt[tbl.table] || 0) + 1;
          // Only a template round has an abstract point. Setting it from every round
          // would overwrite it with undefined the moment a final round is counted —
          // which JSON then drops, so nothing would break loudly.
          points.set(s.local_id, s.point);
        }

        const cell = { table: tbl.table, wind: w };
        if (isTemplate) cell.point = s.point;
        else cell.rank = s.rank;
        cells.get(s.local_id)[rd.round] = cell;
      }
    }
  }

  // ---- pairs: the template rounds, and separately the rest -------------------
  const pairs = pairsOver(seating.rounds);
  const finalPairs = extraRounds.length ? pairsOver(extraRounds) : null;

  const perPlayer = {};
  for (const id of ids) {
    const tableCounts = { ...tables.get(id) };
    const tableSplit = Object.values(tableCounts).sort((a, b) => b - a);
    const tableCountsTemplate = { ...tablesTemplate.get(id) };
    const tableSplitTemplate = Object.values(tableCountsTemplate).sort((a, b) => b - a);

    const opponents = [];
    let perfect = 0;
    for (const other of ids) {
      if (other === id) continue;
      const p = pairs.get(pairKey(id, other));
      const youUpstream = p.upstream.get(id);
      const theyUpstream = p.upstream.get(other);
      // "Perfect": one opposite, and the two adjacent meetings run opposite ways, so
      // whatever edge sitting upstream confers, each gets it once (seating-design.md).
      // Unchanged, and it must stay unchanged: `pairs` holds template rounds only.
      const isPerfect = p.opposite === 1 && youUpstream === 1 && theyUpstream === 1;
      if (isPerfect) perfect += 1;

      const f = finalPairs?.get(pairKey(id, other));
      opponents.push({
        local_id: other,
        title: titleOf.get(other),
        same_table: p.same_table,
        opposite: p.opposite,
        you_upstream: youUpstream,
        they_upstream: theyUpstream,
        perfect: isPerfect,
        // The final round's own relation, kept apart so it can never be counted into
        // the template's proved invariants. Null when there is no final round; null
        // also when there is one and these two were not at the same table in it.
        final: f ? {
          same_table: f.same_table,
          opposite: f.opposite,
          you_upstream: f.upstream.get(id),
          they_upstream: f.upstream.get(other),
        } : null,
      });
    }

    const windCounts = winds.get(id);
    const windCountsTemplate = windsTemplate.get(id);
    const windSplit = SEAT_ORDER.map((w) => windCounts[w]).sort((a, b) => b - a);

    perPlayer[id] = {
      local_id: id,
      title: titleOf.get(id),
      point: points.get(id),
      winds: windCounts,
      wind_split: windSplit,
      // The eleven-round figures, always present, because the claims the page makes
      // about balance ("everybody gets 3-3-3-2") are claims about the template.
      winds_template: windCountsTemplate,
      wind_split_template: SEAT_ORDER.map((w) => windCountsTemplate[w]).sort((a, b) => b - a),
      deficient_wind: deficientWind(windCountsTemplate),
      // Three of every wind across everything played: exactly zero seat handicap, by the
      // zero-sum argument in seating-design.md. False until the final round lands.
      wind_complete: counted.length > 0 && SEAT_ORDER.every((w) => windCounts[w] === windCounts.E),
      tables: tableCounts,
      table_split: tableSplit,
      tables_template: tableCountsTemplate,
      table_split_template: tableSplitTemplate,
      // The one unavoidable imbalance (seating-design.md): three positions get 5-3-3
      // instead of 4-4-3, and the UI names it rather than hiding it. Stated as "is not
      // the ideal" rather than "starts with a 5", because over twelve rounds 5-4-3 is
      // normal and the old test would have called two thirds of the field imbalanced.
      table_imbalanced: !sameArray(tableSplitTemplate, IDEAL_TABLE_SPLIT),
      opponents,
      perfect_pairs: perfect,
      rounds: cells.get(id),
    };
  }

  let perfectTotal = 0;
  for (const p of pairs.values()) {
    if (p.opposite === 1 && [...p.upstream.values()].every((v) => v === 1)) perfectTotal += 1;
  }

  return {
    seat_order: SEAT_ORDER,
    player_order: ids,
    // Which scope each figure belongs to, so the client does not have to infer it.
    rounds_counted: counted.length,
    pair_rounds_counted: seating.rounds.length,
    final_rounds: extraRounds.map((rd) => rd.round),
    players: perPlayer,
    totals: {
      pairs: pairs.size,
      perfect_pairs: perfectTotal,
      imbalanced_players: ids.filter((id) => perPlayer[id].table_imbalanced),
      wind_complete_players: ids.filter((id) => perPlayer[id].wind_complete),
    },
  };
}

module.exports = { computeStats, SEAT_ORDER, IDEAL_TABLE_SPLIT };
