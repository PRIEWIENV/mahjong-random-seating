import Explorer from '../explorer/Explorer';
import RollCard from '../RollCard';
import { useLang, useText, WINDS, tableName } from '../i18n';

/**
 * The result stage (UI-SPEC.md §7).
 *
 * Opens with what the player needs NEXT — their own first-round table and seat, in one
 * sentence — before the data they will browse. The explorer sits below.
 */

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

const TEXT = {
  zh: {
    eyebrow: '抽签完成',
    generic: '座位表已生成。',
    syncOk: '座位表已同步到 Pantheon，手机端看到的会和这里一致。',
    syncFailed: '座位表尚未同步到 Pantheon（组织者会手动处理）。这不影响抽签结果——这一页和 results.json 才是权威，且可以被任何人独立复算。',
    verify: '这个结果可以自己验一遍',
    v1: (tag) => ['冻结的四个文件（roster.json、protocol.json、schedule_template.json、generate.js）在提交开放前就已打上 git tag ', tag, '。'],
    v2: (round) => ['每个人的密文在收到时就已公开（', 'events/submissions/', '），drand 第 ', round, ' 轮的签名任何人都能取到：'],
    v3: '每份贡献是 SHA256(域 ‖ "contrib" ‖ local_id ‖ 数字 ‖ nonce ‖ 时间)，全部异或得到 R =',
    v4: '种子 = SHA256(域 ‖ "seed" ‖ R ‖ drand签名 ‖ 参与者编号) =',
    v5: '重跑一遍，必须逐字节一致：',
    v5b: '或者不用我们的代码，用另一种语言独立验算：',
  },
  en: {
    eyebrow: 'The draw is complete',
    generic: 'The seat plan is ready.',
    syncOk: 'The seat plan is synced to Pantheon; what you see on your phone will match this.',
    syncFailed: 'The seat plan has not synced to Pantheon yet — the organiser will handle it by hand. It does not affect the outcome: this page and results.json are authoritative, and anyone can recompute them.',
    verify: 'You can check this result yourself',
    v1: (tag) => ['The four frozen files (roster.json, protocol.json, schedule_template.json, generate.js) were git-tagged ', tag, ' before submissions opened.'],
    v2: (round) => ['Every ciphertext was published as it arrived (', 'events/submissions/', '), and the signature for drand round ', round, ' is public:'],
    v3: 'Each contribution is SHA256(domain ‖ "contrib" ‖ local_id ‖ number ‖ nonce ‖ time); XOR them all for R =',
    v4: 'seed = SHA256(domain ‖ "seed" ‖ R ‖ drand signature ‖ participant ids) =',
    v5: 'Run it again; it must match byte for byte:',
    v5b: 'Or check it without our code at all, in another language:',
  },
};

export default function Result({ status, me, result }) {
  const lang = useLang();
  const t = useText(TEXT);

  if (!result) {
    return <div className="stage centre"><div className="spinner" /></div>;
  }

  const mine = me ? firstRoundFor(result, me.local_id) : null;
  const sync = result.pantheon_sync;
  const tag = (result.generate_script_ref || '').split('@')[1] || 'frozen-v1';
  const [v1a, v1tag, v1b] = t.v1(tag);
  const [v2a, v2path, v2b, v2round, v2c] = t.v2(result.round_used);

  return (
    <div className="stage result">
      <section className="card next-up">
        <p className="eyebrow">{t.eyebrow}</p>
        {mine ? (
          <h1>
            {lang === 'zh' ? (
              <>第 1 轮，你在<strong>第 {mine.table} 桌</strong>坐<strong>{WINDS.zh[mine.wind]}</strong>家。</>
            ) : (
              <>Round 1: you are at <strong>{tableName('en', mine.table).toLowerCase()}</strong>, seated <strong>{{ E: 'East', S: 'South', W: 'West', N: 'North' }[mine.wind]}</strong>.</>
            )}
          </h1>
        ) : (
          <h1>{t.generic}</h1>
        )}

        {sync?.status === 'ok' ? (
          <p className="note ok">{t.syncOk}</p>
        ) : sync?.status === 'failed' ? (
          <p className="note warn">{t.syncFailed}</p>
        ) : null}

        <details className="verify">
          <summary>{t.verify}</summary>
          <ol>
            <li>{v1a}<code>{v1tag}</code>{v1b}</li>
            <li>
              {v2a}<code>{v2path}</code>{v2b}<code>{v2round}</code>{v2c}
              <code className="block">{`curl ${status?.drand?.api ?? '<drand api>'}/${status?.drand?.chain_hash ?? '<chain>'}/public/${result.round_used}`}</code>
            </li>
            <li>{t.v3}<code className="block">{result.R}</code></li>
            <li>{t.v4}<code className="block">{result.seed}</code></li>
            <li>
              {t.v5}
              <code className="block">node generate.js --verify results.json</code>
              {t.v5b}
              <code className="block">python3 tools/verify_contribution.py results.json</code>
            </li>
          </ol>
        </details>
      </section>

      <Explorer result={result} me={me} />

      {/* The sealed ciphertexts do not stop being evidence once they are opened — they
          start being checkable. Offering them only during the wait meant the download
          disappeared at the exact moment someone might want to recompute the result
          from it. Same file, same fingerprint, same timestamp proof. */}
      {status?.roll && <RollCard roll={status.roll} sealed={false} />}
    </div>
  );
}
