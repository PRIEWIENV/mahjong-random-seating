import { useCallback, useEffect, useMemo, useState } from 'react';
import PlayerDetail from './PlayerDetail';
import RoundTables from './RoundTables';
import { useLang, useText, WINDS, roundName, tableName } from '../i18n';

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
    legendNote: '格子里的字是那一轮的风位',
    cellTitle: (round, table, wind) => `${round} · ${table} · ${wind}家`,
  },
  en: {
    title: 'Seat plan',
    hint: 'Tap a name for that player’s whole schedule, or a round for its three tables.',
    clear: 'Clear selection (Esc)',
    player: 'Player',
    you: 'you',
    legendNote: 'The letter in each cell is that round’s seat wind',
    cellTitle: (round, table, wind) => `${round} · ${table} · ${wind}`,
  },
};

export default function Explorer({ result, me }) {
  const lang = useLang();
  const t = useText(TEXT);
  const [sel, setSel] = useState(() => readSelectionFromUrl());
  const stats = result.stats;
  const rounds = result.seating.rounds;
  const winds = WINDS[lang];

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
                      {p.title}{isMe && <span className="you">{t.you}</span>}
                    </th>
                    {rounds.map((r) => {
                      const c = cells.get(id)[r.round];
                      const dim = sel.kind === 'round' && sel.id !== r.round;
                      return (
                        <td
                          key={r.round}
                          className={`t${c.table} ${dim ? 'dim' : ''}`}
                          onClick={() => pickRound(r.round)}
                          title={t.cellTitle(roundName(lang, r.round), tableName(lang, c.table), winds[c.wind])}
                        >
                          <span className="wind">{winds[c.wind]}</span>
                        </td>
                      );
                    })}
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
