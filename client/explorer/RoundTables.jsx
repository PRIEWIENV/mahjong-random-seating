/**
 * The round lens (UI-SPEC.md §7).
 *
 * "The three tables for that round render as actual tables — four seats in E/S/W/N
 * positions with names in place, drawn the way the players will find them in the
 * room." So the seats are laid out geometrically, not as a list: North at the top,
 * East at the right, matching where people actually sit.
 */

const WIND_CN = { E: '东', S: '南', W: '西', N: '北' };

export default function RoundTables({ round, me, onClose, onPickPlayer }) {
  if (!round) return null;
  return (
    <aside className="panel round-panel" aria-label={`第 ${round.round} 轮`}>
      <div className="panel-head">
        <h3>第 {round.round} 轮</h3>
        <button className="close" onClick={onClose} aria-label="关闭">×</button>
      </div>
      <div className="tables">
        {round.tables.map((t) => (
          <div key={t.table} className={`table-fig t${t.table}`}>
            <div className="table-label">第 {t.table} 桌</div>
            <div className="seats">
              {['N', 'W', 'E', 'S'].map((w) => {
                const s = t.seats[w];
                const isMe = me && me.local_id === s.local_id;
                return (
                  <button
                    key={w}
                    className={`seat seat-${w} ${isMe ? 'me' : ''}`}
                    onClick={() => onPickPlayer(s.local_id)}
                  >
                    <span className="w">{WIND_CN[w]}</span>
                    <span className="n">{s.title}</span>
                  </button>
                );
              })}
              <div className="table-top" aria-hidden="true" />
            </div>
          </div>
        ))}
      </div>
      <p className="hint">出牌顺序逆时针：东 → 南 → 西 → 北。对家是（东,西）和（南,北）。</p>
    </aside>
  );
}
