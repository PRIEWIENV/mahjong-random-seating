/**
 * The per-player detail panel (UI-SPEC.md §7).
 *
 * Carries "the numbers that make the fairness visible": winds, tables, the opponent
 * breakdown, and the perfect-pair count. Each figure is stated as a construction
 * rather than as luck, because that is what it is — and the one unavoidable imbalance
 * (5-3-3 instead of 4-4-3, for exactly three players) is named rather than hidden.
 */

const WIND_CN = { E: '东', S: '南', W: '西', N: '北' };

export default function PlayerDetail({ stats, localId, rounds, onPickPlayer, onClose }) {
  const p = stats.players[localId];
  if (!p) return null;
  const imperfect = p.opponents.filter((o) => !o.perfect);

  return (
    <aside className="panel detail" aria-label={`${p.title} 的赛程`}>
      <div className="panel-head">
        <h3>{p.title}</h3>
        <button className="close" onClick={onClose} aria-label="关闭">×</button>
      </div>

      <div className="stat-row">
        <div className="stat">
          <span className="stat-label">风位</span>
          <span className="stat-value">
            {['E','S','W','N'].map((w) => `${WIND_CN[w]}${p.winds[w]}`).join(' ')}
          </span>
          <span className="stat-note">{p.wind_split.join('-')}，所有人都是如此——这是模板保证的，不是运气。</span>
        </div>
        <div className="stat">
          <span className="stat-label">桌次</span>
          <span className="stat-value">
            {Object.entries(p.tables).map(([t, n]) => `${t}桌${n}`).join(' ')}
          </span>
          <span className="stat-note">
            {p.table_imbalanced
              ? `${p.table_split.join('-')}。十二人里有三人无法拿到 4-4-3，你是其中之一——这是已被证明无法避免的唯一缺口。`
              : `${p.table_split.join('-')}，即最理想的分配。`}
          </span>
        </div>
        <div className="stat">
          <span className="stat-label">完美搭档</span>
          <span className="stat-value">{p.perfect_pairs} / {p.opponents.length}</span>
          <span className="stat-note">
            {imperfect.length === 0
              ? '你的每一对关系都是平衡的。'
              : `与 ${imperfect.map((o) => o.title).join('、')} 的上下家关系不平衡——全局只剩 11 对这样的关系。`}
          </span>
        </div>
      </div>

      <h4>逐轮</h4>
      <ol className="round-list">
        {rounds.map((r) => {
          const c = p.rounds[r.round];
          const table = r.tables.find((t) => t.table === c.table);
          const others = ['E','S','W','N']
            .map((w) => ({ w, ...table.seats[w] }))
            .filter((s) => s.local_id !== localId);
          const idxOf = (w) => ['E','S','W','N'].indexOf(w);
          const rel = (w) => {
            const d = (idxOf(w) - idxOf(c.wind) + 4) % 4;
            return d === 2 ? '对家' : d === 1 ? '你的下家' : '你的上家';
          };
          return (
            <li key={r.round}>
              <span className="r">R{r.round}</span>
              <span className={`tbl t${c.table}`}>{c.table}桌</span>
              <span className="wind">{WIND_CN[c.wind]}</span>
              <span className="others">
                {others.map((o) => (
                  <button key={o.local_id} className="linkish" onClick={() => onPickPlayer(o.local_id)}>
                    {o.title}<i>（{rel(o.w)}）</i>
                  </button>
                ))}
              </span>
            </li>
          );
        })}
      </ol>

      <h4>对手</h4>
      <table className="opponents">
        <thead>
          <tr><th>对手</th><th>同桌</th><th>对家</th><th>他上家</th><th>你上家</th><th /></tr>
        </thead>
        <tbody>
          {p.opponents.map((o) => (
            <tr key={o.local_id} className={o.perfect ? '' : 'imperfect'}>
              <td><button className="linkish" onClick={() => onPickPlayer(o.local_id)}>{o.title}</button></td>
              <td>{o.same_table}</td><td>{o.opposite}</td>
              <td>{o.they_upstream}</td><td>{o.you_upstream}</td>
              <td>{o.perfect ? '✓' : '不平衡'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </aside>
  );
}
