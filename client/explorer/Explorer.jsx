import { useCallback, useEffect, useMemo, useState } from 'react';
import PlayerDetail from './PlayerDetail';
import RoundTables from './RoundTables';
import { useLang, useText, WINDS, roundName, tableName } from '../i18n';
import { allRounds, isFinal, lockedTables, pendingFinal } from '../rounds';

/**
 * The seat plan explorer (UI-SPEC.md §7).
 *
 * One canvas, three lenses, no tabs — the lens follows the selection:
 *   nothing selected  → the full 12 × 11 grid
 *   a player selected → their row lifts, a detail panel opens beside the grid
 *   a round selected  → the grid dims to that column, three real tables render
 *
 * Selections are exclusive and always escapable (background click, or Escape). The URL
 * carries the selection so a player can send someone a link to their own schedule.
 */

function readSelectionFromUrl() {
  const q = new URLSearchParams(location.search);
  const player = q.get('player');
  const round = q.get('round');
  if (player) return { kind: 'player', id: Number(player) };
  if (round) return { kind: 'round', id: Number(round) };
  return { kind: 'none' };
}

function writeSelectionToUrl(sel) {
  const q = new URLSearchParams(location.search);
  q.delete('player'); q.delete('round');
  if (sel.kind === 'player') q.set('player', String(sel.id));
  if (sel.kind === 'round') q.set('round', String(sel.id));
  const qs = q.toString();
  history.replaceState(null, '', location.pathname + (qs ? `?${qs}` : ''));
}

const TEXT = {
  zh: {
    title: '座位表',
    hint: '点名字看某人的完整赛程，点轮次看那一轮的三张桌子。',
    clear: '清除选择 (Esc)',
    player: '玩家',
    you: '你',
    legendNote: '格子里的字是你在那一轮的起始风位',
    cellTitle: (round, table, wind) => `${round} · ${table} · ${wind}家`,
    finalCol: '决赛轮',
    finalCellTitle: (round, table, wind, rank) => `${round}（决赛）· ${table} · ${wind}家 · 第 ${rank} 名`,
    finalNote: '最后一列是决赛轮：桌次由前面的名次决定，只有风位是抽的。',
    pendingNone: '决赛轮还没有锁定：桌次要等前十一轮的名次出来，风位要等那之后的一次抽签。这一列先留在这里。',
    pendingLocked: '决赛轮的桌次已经锁定并公开（见下方封存记录），风位还没抽。所以这一列现在只填得出桌子，填不出风位。',
    pendingCellNone: (round) => `${round}（决赛）· 桌次与风位都还没定`,
    pendingCellLocked: (round, table, rank) => `${round}（决赛）· ${table} · 第 ${rank} 名 · 风位未抽`,
  },
  en: {
    title: 'Seat plan',
    hint: 'Tap a name for that player’s whole schedule, or a round for its three tables.',
    clear: 'Clear selection (Esc)',
    player: 'Player',
    you: 'you',
    legendNote: 'The letter in each cell is your starting wind in that round',
    cellTitle: (round, table, wind) => `${round} · ${table} · ${wind}`,
    finalCol: 'Final',
    finalCellTitle: (round, table, wind, rank) => `${round} (final) · ${table} · ${wind} · ranked ${rank}`,
    finalNote: 'The last column is the final round: its tables come from the standings, and only the winds are drawn.',
    pendingNone: 'The final round is not locked yet: its tables wait on the eleven-round standings and its winds on a draw after that. The column is held open until then.',
    pendingLocked: 'The final round’s tables are locked and public (see the sealed record below); the winds are not drawn yet. So this column can be filled in as far as the table and no further.',
    pendingCellNone: (round) => `${round} (final) · neither table nor wind decided yet`,
    pendingCellLocked: (round, table, rank) => `${round} (final) · ${table} · ranked ${rank} · wind not drawn`,
  },
};

export default function Explorer({ result, me }) {
  const lang = useLang();
  const t = useText(TEXT);
  const [sel, setSel] = useState(() => readSelectionFromUrl());
  const stats = result.stats;
  // The eleven template rounds AND the final one. A player's evening is twelve rounds
  // long; only the published FILES are split in two (client/rounds.js).
  const rounds = allRounds(result);
  const finalOf = (n) => isFinal(result, n);
  const winds = WINDS[lang];
  // The twelfth column before there is a twelfth round to put in it. Held open rather
  // than appearing later, and filled in only as far as what is actually known: nothing
  // before the standings are locked, the table once they are (client/rounds.js).
  const pending = pendingFinal(result);
  const booked = useMemo(() => lockedTables(result), [result]);

  useEffect(() => { writeSelectionToUrl(sel); }, [sel]);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') setSel({ kind: 'none' }); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const clear = useCallback(() => setSel({ kind: 'none' }), []);
  const pickPlayer = useCallback((id) => setSel((s) => (s.kind === 'player' && s.id === id ? { kind: 'none' } : { kind: 'player', id })), []);
  const pickRound = useCallback((n) => setSel((s) => (s.kind === 'round' && s.id === n ? { kind: 'none' } : { kind: 'round', id: n })), []);

  // player -> round -> {table, wind}; precomputed server-side, so no combinatorics here.
  const order = stats.player_order;
  const cells = useMemo(() => {
    const m = new Map();
    for (const id of order) m.set(id, stats.players[id].rounds);
    return m;
  }, [stats, order]);

  return (
    <section className={`explorer sel-${sel.kind}`}>
      <div className="explorer-head">
        <h2>{t.title}</h2>
        <p className="hint">
          {t.hint}
          {sel.kind !== 'none' && <button className="linkish" onClick={clear}>{t.clear}</button>}
        </p>
      </div>

      <div className="explorer-body">
        <div className="grid-wrap" onClick={(e) => { if (e.target === e.currentTarget) clear(); }}>
          <table className="grid">
            <thead>
              <tr>
                <th className="corner" scope="col">{t.player}</th>
                {rounds.map((r) => (
                  <th
                    key={r.round}
                    scope="col"
                    className={[
                      sel.kind === 'round' && sel.id === r.round ? 'on' : '',
                      finalOf(r.round) ? 'final' : '',
                    ].filter(Boolean).join(' ')}
                    title={finalOf(r.round) ? t.finalCol : undefined}
                    onClick={() => pickRound(r.round)}
                  >
                    R{r.round}
                  </th>
                ))}
                {pending && (
                  <th scope="col" className={`final fin-pending fin-${pending.state}`} title={t.finalCol}>
                    R{pending.round}
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {order.map((id) => {
                const p = stats.players[id];
                const isMe = me && me.local_id === id;
                const on = sel.kind === 'player' && sel.id === id;
                return (
                  <tr key={id} className={`${on ? 'on' : ''} ${isMe ? 'me' : ''}`}>
                    <th scope="row" className="name" onClick={() => pickPlayer(id)} title={`local_id ${id}`}>
                      {p.title}{isMe && <span className="you">{t.you}</span>}
                    </th>
                    {rounds.map((r) => {
                      const c = cells.get(id)[r.round];
                      const dim = sel.kind === 'round' && sel.id !== r.round;
                      const fin = finalOf(r.round);
                      return (
                        <td
                          key={r.round}
                          className={`t${c.table} ${dim ? 'dim' : ''} ${fin ? 'final' : ''}`}
                          onClick={() => pickRound(r.round)}
                          title={fin
                            ? t.finalCellTitle(roundName(lang, r.round), tableName(lang, c.table), winds[c.wind], c.rank)
                            : t.cellTitle(roundName(lang, r.round), tableName(lang, c.table), winds[c.wind])}
                        >
                          <span className="wind">{winds[c.wind]}</span>
                        </td>
                      );
                    })}
                    {pending && (() => {
                      // A locked table is a fact about this player, so it is shown; the
                      // wind is not a fact yet, so the cell says so with a placeholder
                      // instead of guessing or leaving the reader to wonder.
                      const b = booked.get(id);
                      // Selecting a round dims every other column, and this one is not
                      // an exception: left bright it would draw the eye away from the
                      // column the reader actually asked for.
                      const dim = sel.kind === 'round';
                      return (
                        <td
                          className={`final fin-pending fin-${pending.state}${b ? ` t${b.table}` : ''}${dim ? ' dim' : ''}`}
                          title={b
                            ? t.pendingCellLocked(roundName(lang, pending.round), tableName(lang, b.table), b.rank)
                            : t.pendingCellNone(roundName(lang, pending.round))}
                        >
                          <span className="wind">·</span>
                        </td>
                      );
                    })()}
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="legend">
            <span className="sw t1" />{tableName(lang, 1)}
            <span className="sw t2" />{tableName(lang, 2)}
            <span className="sw t3" />{tableName(lang, 3)}
            <span className="legend-note">{t.legendNote}</span>
          </p>
          {rounds.some((r) => finalOf(r.round)) && <p className="legend-note final-note">{t.finalNote}</p>}
          {pending && (
            <p className="legend-note final-note fin-pending">
              {pending.state === 'locked' ? t.pendingLocked : t.pendingNone}
            </p>
          )}
        </div>

        {sel.kind === 'player' && (
          <PlayerDetail stats={stats} localId={sel.id} rounds={rounds} result={result} onPickPlayer={pickPlayer} onClose={clear} />
        )}
        {sel.kind === 'round' && (
          <RoundTables round={rounds.find((r) => r.round === sel.id)} me={me} onClose={clear} onPickPlayer={pickPlayer} />
        )}
      </div>
    </section>
  );
}
