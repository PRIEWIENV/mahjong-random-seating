import { useLang, useText, WINDS, listOf, roundName, tableName } from '../i18n';

/**
 * The per-player detail panel (UI-SPEC.md §7).
 *
 * Carries "the numbers that make the fairness visible": winds, tables, the opponent
 * breakdown, and the perfect-pair count. Each figure is stated as a construction
 * rather than as luck, because that is what it is — and the one unavoidable imbalance
 * (5-3-3 instead of 4-4-3, for exactly three players) is named rather than hidden.
 *
 * It renders as TWO panels, not one, and they are siblings in the explorer's own grid.
 * The three summary figures are narrow and belong beside the seat grid, where they can
 * be read against the row that is lifted. The round-by-round list and the opponent table
 * are wide — eleven rounds of three names each, and a six-column table — and in a 380px
 * column beside the grid both wrapped into something closer to a paragraph than a table.
 * So they take a full-width panel underneath, where a row is a row.
 */

const TEXT = {
  zh: {
    schedule: (name) => `${name} 的赛程`,
    close: '关闭',
    winds: '风位',
    windsNote: (split) => `${split}，所有人在不同风位的次数都满足这个分布。`,
    tables: '桌次',
    tablesImbalanced: (split) => `${split}。十二人里有三人无法拿到 4-4-3，你是其中之一——这是无法避免的。`,
    tablesIdeal: (split) => `${split}，即最理想的分配。`,
    perfect: '完美搭档',
    perfectAll: '你的每一对关系都是平衡的。',
    perfectSome: (names) => `与 ${names} 的上下家关系不平衡——全局 66 对只有 11 对这样不平衡的关系。`,
    byRound: '逐轮',
    opponents: '对手',
    facing: '对家',
    downstream: '下家',
    upstream: '上家',
    thOpponent: '对手', thSame: '同桌', thFacing: '对家', thTheyUp: '他上家', thYouUp: '你上家',
    balanced: '✓', unbalanced: '不平衡',
    tableShort: (n) => `${n}桌`,
  },
  en: {
    schedule: (name) => `${name}'s schedule`,
    close: 'Close',
    winds: 'Winds',
    windsNote: (split) => `${split}. Everybody's winds fall in this same split.`,
    tables: 'Tables',
    tablesImbalanced: (split) => `${split}. Three of the twelve cannot get 4-4-3 and you are one of them. It is unavoidable.`,
    tablesIdeal: (split) => `${split}, the best possible split.`,
    perfect: 'Balanced pairings',
    perfectAll: 'Every one of your pairings is balanced.',
    perfectSome: (names) => `Your upstream/downstream balance with ${names} is uneven — 11 of the 66 pairs are uneven like this.`,
    byRound: 'Round by round',
    opponents: 'Opponents',
    facing: 'facing you',
    downstream: 'downstream',
    upstream: 'upstream',
    thOpponent: 'Opponent', thSame: 'Same table', thFacing: 'Facing', thTheyUp: 'They upstream', thYouUp: 'You upstream',
    balanced: '✓', unbalanced: 'uneven',
    tableShort: (n) => `T${n}`,
  },
};

export default function PlayerDetail({ stats, localId, rounds, onPickPlayer, onClose }) {
  const lang = useLang();
  const t = useText(TEXT);
  const p = stats.players[localId];
  if (!p) return null;
  const winds = WINDS[lang];
  const imperfect = p.opponents.filter((o) => !o.perfect);

  return (
    <>
    <aside className="panel detail detail-stats" aria-label={t.schedule(p.title)}>
      <div className="panel-head">
        <h3>{p.title}</h3>
        <button className="close" onClick={onClose} aria-label={t.close}>×</button>
      </div>

      <div className="stat-row">
        <div className="stat">
          <span className="stat-label">{t.winds}</span>
          <span className="stat-value">
            {['E', 'S', 'W', 'N'].map((w) => `${winds[w]}${p.winds[w]}`).join(' ')}
          </span>
          <span className="stat-note">{t.windsNote(p.wind_split.join('-'))}</span>
        </div>
        <div className="stat">
          <span className="stat-label">{t.tables}</span>
          <span className="stat-value">
            {Object.entries(p.tables).map(([tb, n]) => `${t.tableShort(tb)} ${n}`).join('  ')}
          </span>
          <span className="stat-note">
            {p.table_imbalanced
              ? t.tablesImbalanced(p.table_split.join('-'))
              : t.tablesIdeal(p.table_split.join('-'))}
          </span>
        </div>
        <div className="stat">
          <span className="stat-label">{t.perfect}</span>
          <span className="stat-value">{p.perfect_pairs} / {p.opponents.length}</span>
          <span className="stat-note">
            {imperfect.length === 0
              ? t.perfectAll
              : t.perfectSome(listOf(lang, imperfect.map((o) => o.title)))}
          </span>
        </div>
      </div>

    </aside>

    <section className="panel detail detail-rest">
      <h4>{t.byRound}</h4>
      <ol className="round-list">
        {rounds.map((r) => {
          const c = p.rounds[r.round];
          const table = r.tables.find((tb) => tb.table === c.table);
          const others = ['E', 'S', 'W', 'N']
            .map((w) => ({ w, ...table.seats[w] }))
            .filter((s) => s.local_id !== localId);
          const idxOf = (w) => ['E', 'S', 'W', 'N'].indexOf(w);
          const rel = (w) => {
            // Winds run in play order, so a difference of one seat is the next player.
            const d = (idxOf(w) - idxOf(c.wind) + 4) % 4;
            return d === 2 ? t.facing : d === 1 ? t.downstream : t.upstream;
          };
          return (
            <li key={r.round}>
              <span className="r">{lang === 'zh' ? `R${r.round}` : `R${r.round}`}</span>
              <span className={`tbl t${c.table}`}>{t.tableShort(c.table)}</span>
              <span className="wind">{winds[c.wind]}</span>
              <span className="others">
                {others.map((o) => (
                  <button key={o.local_id} className="linkish" onClick={() => onPickPlayer(o.local_id)}>
                    {o.title}<i>{lang === 'zh' ? `（${rel(o.w)}）` : ` (${rel(o.w)})`}</i>
                  </button>
                ))}
              </span>
            </li>
          );
        })}
      </ol>

      <h4>{t.opponents}</h4>
      <div className="table-scroll">
        <table className="opponents">
          <thead>
            <tr>
              <th>{t.thOpponent}</th><th>{t.thSame}</th><th>{t.thFacing}</th>
              <th>{t.thTheyUp}</th><th>{t.thYouUp}</th><th />
            </tr>
          </thead>
          <tbody>
            {p.opponents.map((o) => (
              <tr key={o.local_id} className={o.perfect ? '' : 'imperfect'}>
                <td><button className="linkish" onClick={() => onPickPlayer(o.local_id)}>{o.title}</button></td>
                <td>{o.same_table}</td><td>{o.opposite}</td>
                <td>{o.they_upstream}</td><td>{o.you_upstream}</td>
                <td>{o.perfect ? t.balanced : t.unbalanced}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
    </>
  );
}
