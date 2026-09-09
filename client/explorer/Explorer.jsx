import { useCallback, useEffect, useMemo, useState } from 'react';
import PlayerDetail from './PlayerDetail';
import RoundTables from './RoundTables';

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

const WIND_CN = { E: '东', S: '南', W: '西', N: '北' };

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

export default function Explorer({ result, me }) {
  const [sel, setSel] = useState(() => readSelectionFromUrl());
  const stats = result.stats;
  const rounds = result.seating.rounds;

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
        <h2>座位表</h2>
        <p className="hint">
          点名字看某人的完整赛程，点轮次看那一轮的三张桌子。
          {sel.kind !== 'none' && <button className="linkish" onClick={clear}>清除选择 (Esc)</button>}
        </p>
      </div>

      <div className="explorer-body">
        <div className="grid-wrap" onClick={(e) => { if (e.target === e.currentTarget) clear(); }}>
          <table className="grid">
            <thead>
              <tr>
                <th className="corner" scope="col">玩家</th>
                {rounds.map((r) => (
                  <th
                    key={r.round}
                    scope="col"
                    className={sel.kind === 'round' && sel.id === r.round ? 'on' : ''}
                    onClick={() => pickRound(r.round)}
                  >
                    R{r.round}
                  </th>
                ))}
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
                      {p.title}{isMe && <span className="you">你</span>}
                    </th>
                    {rounds.map((r) => {
                      const c = cells.get(id)[r.round];
                      const dim = sel.kind === 'round' && sel.id !== r.round;
                      return (
                        <td
                          key={r.round}
                          className={`t${c.table} ${dim ? 'dim' : ''}`}
                          onClick={() => pickRound(r.round)}
                          title={`第 ${r.round} 轮 · 第 ${c.table} 桌 · ${WIND_CN[c.wind]}家`}
                        >
                          <span className="wind">{WIND_CN[c.wind]}</span>
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="legend">
            <span className="sw t1" />第 1 桌
            <span className="sw t2" />第 2 桌
            <span className="sw t3" />第 3 桌
            <span className="legend-note">格子里的字是那一轮的风位</span>
          </p>
        </div>

        {sel.kind === 'player' && (
          <PlayerDetail stats={stats} localId={sel.id} rounds={rounds} onPickPlayer={pickPlayer} onClose={clear} />
        )}
        {sel.kind === 'round' && (
          <RoundTables round={rounds.find((r) => r.round === sel.id)} me={me} onClose={clear} onPickPlayer={pickPlayer} />
        )}
      </div>
    </section>
  );
}
