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
 */

const SEAT_ORDER = ['E', 'S', 'W', 'N'];

const pairKey = (a, b) => (a < b ? `${a}:${b}` : `${b}:${a}`);

/**
 * @param {object} seating results.seating
 * @param {Array}  players roster.players — for titles and to fix the row order
 * @returns per-player stats plus the grid the explorer renders
 */
function computeStats(seating, players) {
  const ids = players.map((p) => p.local_id).sort((a, b) => a - b);
  const titleOf = new Map(players.map((p) => [p.local_id, p.title]));

  const winds = new Map(ids.map((id) => [id, { E: 0, S: 0, W: 0, N: 0 }]));
  const tables = new Map(ids.map((id) => [id, {}]));
  const cells = new Map(ids.map((id) => [id, {}])); // local_id -> round -> {table, wind}
  const points = new Map();

  // pair -> { same_table, opposite, upstream: Map(id -> count of times id was upstream) }
  const pairs = new Map();
  const pairOf = (a, b) => {
    const k = pairKey(a, b);
    if (!pairs.has(k)) pairs.set(k, { same_table: 0, opposite: 0, upstream: new Map([[a, 0], [b, 0]]) });
    return pairs.get(k);
  };

  for (const rd of seating.rounds) {
    for (const tbl of rd.tables) {
      const seated = SEAT_ORDER.map((w) => ({ wind: w, ...tbl.seats[w] }));

      for (const s of seated) {
        winds.get(s.local_id)[s.wind] += 1;
        const t = tables.get(s.local_id);
        t[tbl.table] = (t[tbl.table] || 0) + 1;
        cells.get(s.local_id)[rd.round] = { table: tbl.table, wind: s.wind, point: s.point };
        points.set(s.local_id, s.point);
      }

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
        pairOf(upper, lower).upstream.set(upper, pairOf(upper, lower).upstream.get(upper) + 1);
      }
    }
  }

  const perPlayer = {};
  for (const id of ids) {
    const tableCounts = {};
    for (const [t, n] of Object.entries(tables.get(id))) tableCounts[t] = n;
    const tableSplit = Object.values(tableCounts).sort((a, b) => b - a);

    const opponents = [];
    let perfect = 0;
    for (const other of ids) {
      if (other === id) continue;
      const p = pairs.get(pairKey(id, other));
      const youUpstream = p.upstream.get(id);
      const theyUpstream = p.upstream.get(other);
      // "Perfect": one opposite, and the two adjacent meetings run opposite ways, so
      // whatever edge sitting upstream confers, each gets it once (seating-design.md).
      const isPerfect = p.opposite === 1 && youUpstream === 1 && theyUpstream === 1;
      if (isPerfect) perfect += 1;
      opponents.push({
        local_id: other,
        title: titleOf.get(other),
        same_table: p.same_table,
        opposite: p.opposite,
        you_upstream: youUpstream,
        they_upstream: theyUpstream,
        perfect: isPerfect,
      });
    }

    perPlayer[id] = {
      local_id: id,
      title: titleOf.get(id),
      point: points.get(id),
      winds: winds.get(id),
      wind_split: Object.values(winds.get(id)).sort((a, b) => b - a),
      tables: tableCounts,
      table_split: tableSplit,
      // The one unavoidable imbalance (seating-design.md): three positions get 5-3-3
      // instead of 4-4-3, and the UI names it rather than hiding it.
      table_imbalanced: tableSplit[0] === 5,
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
    players: perPlayer,
    totals: {
      pairs: pairs.size,
      perfect_pairs: perfectTotal,
      imbalanced_players: ids.filter((id) => perPlayer[id].table_imbalanced),
    },
  };
}

module.exports = { computeStats, SEAT_ORDER };
