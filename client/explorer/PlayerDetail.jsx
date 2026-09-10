import { useLang, useText, WINDS, listOf, roundName, tableName } from '../i18n';

/**
 * The per-player detail panel (UI-SPEC.md §7).
 *
 * Carries "the numbers that make the fairness visible": winds, tables, the opponent
 * breakdown, and the perfect-pair count. Each figure is stated as a construction
 * rather than as luck, because that is what it is — and the one unavoidable imbalance
 * (5-3-3 instead of 4-4-3, for exactly three players) is named rather than hidden.
 */

const TEXT = {
  zh: {
    schedule: (name) => `${name} 的赛程`,
    close: '关闭',
    winds: '风位',
    windsNote: (split) => `${split}，所有人都是如此——这是模板保证的，不是运气。`,
    tables: '桌次',
    tablesImbalanced: (split) => `${split}。十二人里有三人无法拿到 4-4-3，你是其中之一——这是已被证明无法避免的唯一缺口。`,
    tablesIdeal: (split) => `${split}，即最理想的分配。`,
    perfect: '完美搭档',
    perfectAll: '你的每一对关系都是平衡的。',
    perfectSome: (names) => `与 ${names} 的上下家关系不平衡——全局只剩 11 对这样的关系。`,
    byRound: '逐轮',
    opponents: '对手',
    facing: '对家',
    downstream: '你的下家',
    upstream: '你的上家',
    thOpponent: '对手', thSame: '同桌', thFacing: '对家', thTheyUp: '他上家', thYouUp: '你上家',
    balanced: '✓', unbalanced: '不平衡',
    tableShort: (n) => `${n}桌`,
  },
  en: {
    schedule: (name) => `${name}'s schedule`,
    close: 'Close',
    winds: 'Winds',
    windsNote: (split) => `${split} — the same for everybody. The template guarantees it; it is not luck.`,
    tables: 'Tables',
    tablesImbalanced: (split) => `${split}. Three of the twelve cannot get 4-4-3 and you are one of them. It is the one gap proved to be unavoidable.`,
    tablesIdeal: (split) => `${split}, the best possible split.`,
    perfect: 'Balanced pairings',
    perfectAll: 'Every one of your pairings is balanced.',
    perfectSome: (names) => `Your upstream/downstream balance with ${names} is uneven — only 11 such pairs exist in the whole plan.`,
    byRound: 'Round by round',
    opponents: 'Opponents',
    facing: 'facing you',
    downstream: 'downstream of you',
    upstream: 'upstream of you',
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
    <aside className="panel detail" aria-label={t.schedule(p.title)}>
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
    </aside>
  );
}
