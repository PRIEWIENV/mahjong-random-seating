import { useLang, useText, WINDS, roundName, tableName } from '../i18n';

/**
 * The round lens (UI-SPEC.md §7).
 *
 * "The three tables for that round render as actual tables — four seats in E/S/W/N
 * positions with names in place, drawn the way the players will find them in the room."
 *
 * So the seats are laid out geometrically, and the geometry has to be the real one:
 * play moves **counter-clockwise**, East to South to West to North. The first version
 * put East on the right and South below it, which draws the winds going clockwise —
 * a table nobody will ever sit at. East is at the bottom now, with each next player to
 * the right of the last, which is where they will be in the room.
 */

const TEXT = {
  zh: { close: '关闭', order: '出牌顺序逆时针：东 → 南 → 西 → 北。对家是（东,西）和（南,北）。' },
  en: { close: 'Close', order: 'Play moves counter-clockwise: East → South → West → North. Facing pairs are (E, W) and (S, N).' },
};

export default function RoundTables({ round, me, onClose, onPickPlayer }) {
  const lang = useLang();
  const t = useText(TEXT);
  if (!round) return null;
  const winds = WINDS[lang];
  return (
    <aside className="panel round-panel" aria-label={roundName(lang, round.round)}>
      <div className="panel-head">
        <h3>{roundName(lang, round.round)}</h3>
        <button className="close" onClick={onClose} aria-label={t.close}>×</button>
      </div>
      <div className="tables">
        {round.tables.map((tbl) => (
          <div key={tbl.table} className={`table-fig t${tbl.table}`}>
            <div className="table-label">{tableName(lang, tbl.table)}</div>
            <div className="seats">
              {/* Logical order in the DOM; the grid places them where people sit. */}
              {['E', 'S', 'W', 'N'].map((w) => {
                const s = tbl.seats[w];
                const isMe = me && me.local_id === s.local_id;
                return (
                  <button
                    key={w}
                    className={`seat seat-${w} ${isMe ? 'me' : ''}`}
                    onClick={() => onPickPlayer(s.local_id)}
                  >
                    <span className="w">{winds[w]}</span>
                    <span className="n">{s.title}</span>
                  </button>
                );
              })}
              <div className="table-top" aria-hidden="true">
                <span className="turn-arrow" aria-hidden="true" />
              </div>
            </div>
          </div>
        ))}
      </div>
      <p className="hint">{t.order}</p>
    </aside>
  );
}
