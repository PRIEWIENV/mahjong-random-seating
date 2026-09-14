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
    syncOk: '座位表已同步到 Pantheon。',
    syncFailed: '座位表尚未同步到 Pantheon（组织者会手动处理）。这不影响抽签结果。',
    verify: '验证结果',
    v1: (tag) => ['冻结的四个文件（roster.json、protocol.json、schedule_template.json、generate.js）在提交开放前就已打上 git tag ', tag, '。'],
    v1NoTag: '冻结的四个文件（roster.json、protocol.json、schedule_template.json、generate.js）在提交开放前就已打上 git tag。',
    v1get: 'results.json 是抽签之后才写的，不在 tag 里，要另外从默认分支取一次：',
    v1NoMirror: '这次抽签没有配置公开镜像仓库，所以 results.json 和 events/ 只在组织者手里，没有可以直接克隆的地址。向组织者要这两份文件，下面每一步照样能对着它们核验。',
    v2: (round) => ['每个人的密文在收到时就已公开（', 'events/submissions/', '），drand 第 ', round, ' 轮的签名任何人都能取到：'],
    v2NoMirror: (round) => ['密文没有被镜像到公开仓库，所以没有办法核对它们在开奖之前就已经存在——这一条只能信组织者。drand 第 ', round, ' 轮的签名则任何人都能取到：'],
    v3: '每份贡献是 SHA256(域 ‖ "contrib" ‖ local_id ‖ 数字 ‖ nonce ‖ 时间)，全部异或之后得到 R =',
    v4: '种子 = SHA256(域 ‖ "seed" ‖ R ‖ drand签名 ‖ 参与者编号) =',
    v5: '重跑一遍，必须逐字节一致：',
    v5b: '或者不用 js，用 python 独立验算：',
  },
  en: {
    eyebrow: 'The draw is complete',
    generic: 'The seat plan is ready.',
    syncOk: 'The seat plan is synced to Pantheon.',
    syncFailed: 'The seat plan has not synced to Pantheon yet — the organiser will handle it by hand. It does not affect the outcome.',
    verify: 'Check the result',
    v1: (tag) => ['The four frozen files (roster.json, protocol.json, schedule_template.json, generate.js) were git-tagged ', tag, ' before submissions opened.'],
    v1NoTag: 'The four frozen files (roster.json, protocol.json, schedule_template.json, generate.js) were git-tagged before submissions opened.',
    v1get: ' results.json was written after the draw, so it is not inside the tag and has to be taken from the default branch as well:',
    v1NoMirror: ' This draw was not mirrored to a public repository, so results.json and events/ exist only on the organiser’s machine and there is no address to clone. Ask them for both files; every step below still checks out against those.',
    v2: (round) => ['Every ciphertext was published as it arrived (', 'events/submissions/', '), and the signature for drand round ', round, ' is public:'],
    v2NoMirror: (round) => ['The ciphertexts were not mirrored anywhere public, so there is no way to confirm they existed before the draw — that part rests on the organiser. The signature for drand round ', round, ' is public either way:'],
    v3: 'Each contribution is SHA256(domain ‖ "contrib" ‖ local_id ‖ number ‖ nonce ‖ time); XOR them all and you get R =',
    v4: 'seed = SHA256(domain ‖ "seed" ‖ R ‖ drand signature ‖ participant ids) =',
    v5: 'Run it again; it must match byte for byte:',
    v5b: 'Or check it independently in python, without our js:',
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
  // Read out of the frozen file, never defaulted. It used to fall back to the literal
  // "frozen-v1", which is a tag name that only ever existed in a document: an organiser
  // who tagged anything else had this page telling twelve people to check out something
  // that does not exist. tools/freeze.js --tag now writes the real name into
  // generate_script_ref, and when it somehow is not there this says less rather than
  // something untrue.
  const tag = (result.generate_script_ref || '').split('@')[1] || null;
  const [v1a, v1tag, v1b] = t.v1(tag);
  const [v2a, v2path, v2b, v2round, v2c] = t.v2(result.round_used);
  const [v2na, v2nround, v2nb] = t.v2NoMirror(result.round_used);

  /**
   * How to get the files this panel then tells you to check.
   *
   * The panel listed five confident steps and two commands and never said where any of
   * it came from. Worse than an omission: results.json and events/snapshot.json are
   * written after the freeze, so they are on the default branch and NOT inside the tag,
   * and a reader who checks the tag out is left holding neither. The third line is what
   * closes that, and origin/HEAD avoids having to know the branch's name.
   *
   * The repository is the operator's real one, out of MIRROR_REPO by way of /api/status.
   * It used to be a constant copied out of the deployment guide, complete with that
   * guide's stand-in account name — the worst kind of wrong, because such an address
   * reads as real and it clones, and what a player then checks is somebody else's draw.
   * test/result-verify.test.js keeps those names out of this file and out of the bundle.
   *
   * With mirroring off there is no address at all, so the panel does not print a clone
   * command — a placeholder in a copyable block is still something people paste. It
   * says where the files actually are instead, and drops the claim that the ciphertexts
   * were public as they arrived, because without a mirror they were not. That claim is
   * the one thing on this page a player cannot check for themselves, so it must not be
   * made on their behalf when it is untrue (PROTOCOL.md §5).
   */
  const mirrored = Boolean(status?.mirror_repo);
  const fetchCmd = mirrored
    ? [
        `git clone https://github.com/${status.mirror_repo} draw && cd draw`,
        `git checkout ${tag || '<tag>'}`,
        'git checkout origin/HEAD -- results.json events/',
      ].join('\n')
    : null;

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
            <li>
              {tag ? <>{v1a}<code>{v1tag}</code>{v1b}</> : t.v1NoTag}
              {mirrored ? t.v1get : t.v1NoMirror}
              {fetchCmd && <code className="block">{fetchCmd}</code>}
            </li>
            <li>
              {mirrored
                ? <>{v2a}<code>{v2path}</code>{v2b}<code>{v2round}</code>{v2c}</>
                : <>{v2na}<code>{v2nround}</code>{v2nb}</>}
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
