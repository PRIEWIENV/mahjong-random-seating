/**
 * The rounds a player actually sits down for, which is not one list any more.
 *
 * /api/result keeps them apart on purpose. `seating` is results.json's own key and names
 * a published file holding the eleven template rounds; the twelfth arrives beside it in
 * `final`, exactly as it does on disk, because a payload that folded them together would
 * disagree with the file every verifier works on (PROTOCOL.md §11).
 *
 * The page, though, is about a player's evening. So this is the one place the two are
 * joined, and everything that draws a schedule goes through it — a second component
 * appending the final round its own way is a second place for the round to be missing.
 *
 * The two kinds of round are not interchangeable, and `isFinal` is how the difference is
 * asked about rather than inferred from a round number: a template round's seats carry
 * `point` (the abstract position the shuffle assigned) and the final round's carry `rank`
 * (where the player finished the round-robin).
 */

/** Template rounds followed by the final round, or just the template rounds. */
export function allRounds(result) {
  const base = result?.seating?.rounds || [];
  const extra = result?.final?.seating?.rounds || [];
  return extra.length ? [...base, ...extra] : base;
}

/** Whether `round` (a number) is the earned round rather than a drawn one. */
export function isFinal(result, round) {
  return (result?.final?.seating?.rounds || []).some((r) => r.round === round);
}

/** Has the final round been drawn at all? */
export const hasFinal = (result) => Boolean(result?.final);

/**
 * How many people at this player's final table are short of the same wind they are.
 *
 * The number that makes the fairness claim honest instead of comforting. Exactly one
 * player at a table can be given any particular wind, so when m of them need the same
 * one, each has a 1/m chance of finishing on three of every wind and the rest do not.
 * That is not an accident of the draw, it is the cost of maximising completion, and the
 * page says the number rather than leaving the reader to infer that someone lost.
 *
 * Derived here from what the panel already holds — who sat at the table, and what each
 * of them was short of — so it needs nothing added to the payload.
 *
 * @returns {number} 1 when nobody else needed it, 0 when there is no final round
 */
export function sameDeficitCount(stats, rounds, localId) {
  const me = stats.players[localId];
  const finalRound = rounds.find((r) => Object.values(r.tables)
    .some((t) => Object.values(t.seats).some((s) => s.rank !== undefined)));
  if (!me?.deficient_wind || !finalRound) return 0;
  const table = finalRound.tables.find((t) =>
    Object.values(t.seats).some((s) => s.local_id === localId));
  if (!table) return 0;
  return Object.values(table.seats)
    .filter((s) => stats.players[s.local_id]?.deficient_wind === me.deficient_wind).length;
}
