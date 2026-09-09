import Explorer from '../explorer/Explorer';

/**
 * The result stage (UI-SPEC.md §7).
 *
 * Opens with what the player needs NEXT — their own first-round table and seat, in one
 * sentence — before the data they will browse. The explorer sits below.
 */

const WIND_CN = { E: '东', S: '南', W: '西', N: '北' };

function firstRoundFor(result, localId) {
  const r1 = result?.seating?.rounds?.[0];
  if (!r1) return null;
  for (const t of r1.tables) {
    for (const w of ['E', 'S', 'W', 'N']) {
      if (t.seats[w].local_id === localId) return { table: t.table, wind: w };
    }
  }
  return null;
}

export default function Result({ status, me, result }) {
  if (!result) {
    return <div className="stage centre"><div className="spinner" aria-label="Loading" /></div>;
  }

  const mine = me ? firstRoundFor(result, me.local_id) : null;
  const sync = result.pantheon_sync;

  return (
    <div className="stage result">
      <section className="card next-up">
        <p className="eyebrow">抽签完成</p>
        {mine ? (
          <h1>第 1 轮，你在<strong>第 {mine.table} 桌</strong>坐<strong>{WIND_CN[mine.wind]}</strong>家。</h1>
        ) : (
          <h1>座位表已生成。</h1>
        )}

        {sync?.status === 'ok' ? (
          <p className="note ok">座位表已同步到 Pantheon，手机端看到的会和这里一致。</p>
        ) : sync?.status === 'failed' ? (
          <p className="note warn">
            座位表尚未同步到 Pantheon（组织者会手动处理）。这不影响抽签结果——
            这一页和 results.json 才是权威，且可以被任何人独立复算。
          </p>
        ) : null}

        <details className="verify">
          <summary>这个结果可以自己验一遍</summary>
          <ol>
            <li>
              冻结的四个文件（roster.json、protocol.json、schedule_template.json、generate.js）
              在提交开放前就已打上 git tag <code>{(result.generate_script_ref || '').split('@')[1] || 'frozen-v1'}</code>。
            </li>
            <li>
              每个人的密文在收到时就已公开（<code>events/submissions/</code>），
              drand 第 <code>{result.round_used}</code> 轮的签名任何人都能取到：
              <code className="block">{`curl ${status?.drand?.api || 'https://api.drand.sh'}/${status?.drand?.chain_hash || '<chain>'}/public/${result.round_used}`}</code>
            </li>
            <li>
              每份贡献是 <code>SHA256(域 ‖ "contrib" ‖ local_id ‖ 数字 ‖ nonce ‖ 时间)</code>，
              全部异或得到 R = <code className="block">{result.R}</code>
            </li>
            <li>
              种子 = <code>SHA256(域 ‖ "seed" ‖ R ‖ drand签名 ‖ 参与者编号)</code> =
              <code className="block">{result.seed}</code>
            </li>
            <li>
              重跑一遍，必须逐字节一致：
              <code className="block">node generate.js --verify results.json</code>
              或者不用我们的代码，用另一种语言独立验算：
              <code className="block">python3 tools/verify_contribution.py results.json</code>
            </li>
          </ol>
        </details>
      </section>

      <Explorer result={result} me={me} />
    </div>
  );
}
