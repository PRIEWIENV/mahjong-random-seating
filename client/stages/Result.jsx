import Explorer from '../explorer/Explorer';
import RollCard from '../RollCard';
import FinalCard from '../FinalCard';
import FinalTimeline from '../FinalTimeline';
import { useLang, useText, WINDS, tableName } from '../i18n';
import { allRounds, hasFinal } from '../rounds';

/**
 * The result stage (UI-SPEC.md §7).
 *
 * Opens with what the player needs NEXT — their own table and seat for the round they
 * are about to walk to, in one sentence — before the data they will browse. Round 1
 * until the final round is drawn, and the final round after that: by then round 1 was
 * played weeks ago (PROTOCOL.md §11). The explorer sits below.
 */

/**
 * Where this player sits in a given round.
 *
 * Round 1 while that is the next thing to walk to, and the FINAL round once it has been
 * drawn — because by then round 1 was played weeks ago, and a headline that still
 * announced it would be the one sentence on the page that is about the past.
 */
function seatIn(round, localId) {
  if (!round) return null;
  for (const t of round.tables) {
    for (const w of ['E', 'S', 'W', 'N']) {
      if (t.seats[w].local_id === localId) return { round: round.round, table: t.table, wind: w };
    }
  }
  return null;
}

/** The round the headline should be about: the final one if it exists, else the first. */
function headlineRound(result) {
  const rounds = allRounds(result);
  return hasFinal(result) ? rounds[rounds.length - 1] : rounds[0];
}

const TEXT = {
  zh: {
    eyebrow: '抽签完成',
    generic: '座位表已生成。',
    syncOk: '座位表已同步到 Pantheon。',
    syncFailed: '座位表尚未同步到 Pantheon（组织者会手动处理）。这不影响抽签结果。',
    verify: '验证结果',
    v1: (tag) => ['冻结的五个文件（roster.json、protocol.json、schedule_template.json、generate.js、generate-final.js）在提交开放前就已打上 git tag ', tag, '。'],
    v1NoTag: '冻结的五个文件（roster.json、protocol.json、schedule_template.json、generate.js、generate-final.js）在提交开放前就已打上 git tag。',
    v1get: 'results.json 是抽签之后才写的，不在 tag 里，要另外从默认分支取一次：',
    v1NoMirror: '这次抽签没有配置公开镜像仓库，所以 results.json 和 events/ 只在组织者手里，没有可以直接克隆的地址。向组织者要这两份文件，下面每一步照样能对着它们核验。',
    v2: (round) => ['每个人的密文在收到时就已公开（', 'events/submissions/', '），drand 第 ', round, ' 轮的签名任何人都能取到：'],
    v2NoMirror: (round) => ['密文没有被镜像到公开仓库，所以没有办法核对它们在开奖之前就已经存在——这一条只能信组织者。drand 第 ', round, ' 轮的签名则任何人都能取到：'],
    v3: '每份贡献是 SHA256(域 ‖ "contrib" ‖ local_id ‖ 数字 ‖ nonce ‖ 时间)，全部异或之后得到 R =',
    v4: '种子 = SHA256(域 ‖ "seed" ‖ R ‖ drand签名 ‖ 参与者编号) =',
    v5: '重跑一遍，必须逐字节一致：',
    v5b: '或者不用 js，用 python 独立验算：',
    finalVerify: '决赛轮另外核验',
    f1: '决赛轮的桌次来自前十一轮名次，风位来自另一轮 drand 信标。名次和轮次都写在同一份封存记录里，并在那一轮信标产生之前就已公开、盖了时间戳：',
    f1files: (sha) => ['这份文件的 sha256 是 ', sha, '——它和时间戳存证一起，是“桌次不是看到结果之后才排的”这句话的全部依据。'],
    f2: (round) => ['决定风位的是 drand 第 ', round, ' 轮，任何人都能取到它的签名：'],
    f3: '决赛轮的种子 = SHA256(域 ‖ "final" ‖ R ‖ drand签名 ‖ 名次 ‖ 参与者编号) =',
    f4: '重跑决赛轮的抽签，同样必须逐字节一致：',
    f5: '或者用第二份独立实现（python，照规格写，不照 js 写）：',
  },
  en: {
    eyebrow: 'The draw is complete',
    generic: 'The seat plan is ready.',
    syncOk: 'The seat plan is synced to Pantheon.',
    syncFailed: 'The seat plan has not synced to Pantheon yet — the organiser will handle it by hand. It does not affect the outcome.',
    verify: 'Check the result',
    v1: (tag) => ['The five frozen files (roster.json, protocol.json, schedule_template.json, generate.js, generate-final.js) were git-tagged ', tag, ' before submissions opened.'],
    v1NoTag: 'The five frozen files (roster.json, protocol.json, schedule_template.json, generate.js, generate-final.js) were git-tagged before submissions opened.',
    v1get: ' results.json was written after the draw, so it is not inside the tag and has to be taken from the default branch as well:',
    v1NoMirror: ' This draw was not mirrored to a public repository, so results.json and events/ exist only on the organiser’s machine and there is no address to clone. Ask them for both files; every step below still checks out against those.',
    v2: (round) => ['Every ciphertext was published as it arrived (', 'events/submissions/', '), and the signature for drand round ', round, ' is public:'],
    v2NoMirror: (round) => ['The ciphertexts were not mirrored anywhere public, so there is no way to confirm they existed before the draw — that part rests on the organiser. The signature for drand round ', round, ' is public either way:'],
    v3: 'Each contribution is SHA256(domain ‖ "contrib" ‖ local_id ‖ number ‖ nonce ‖ time); XOR them all and you get R =',
    v4: 'seed = SHA256(domain ‖ "seed" ‖ R ‖ drand signature ‖ participant ids) =',
    v5: 'Run it again; it must match byte for byte:',
    v5b: 'Or check it independently in python, without our js:',
    finalVerify: 'Check the final round',
    f1: 'The final round’s tables come from the eleven-round standings and its winds from a second drand beacon. Both the standings and the round are in one sealed record, published and timestamped before that beacon existed:',
    f1files: (sha) => ['That file’s sha256 is ', sha, ' — together with its timestamp proof, it is the whole of the claim that the tables were not arranged after seeing the result.'],
    f2: (round) => ['The winds were drawn by drand round ', round, ', whose signature is public:'],
    f3: 'The final seed = SHA256(domain ‖ "final" ‖ R ‖ drand signature ‖ standings ‖ participant ids) =',
    f4: 'Redraw the final round; it too must match byte for byte:',
    f5: 'Or use the second, independent implementation (python, written from the spec rather than from the js):',
  },
};

export default function Result({ status, me, result, serverNow }) {
  const lang = useLang();
  const t = useText(TEXT);

  if (!result) {
    return <div className="stage centre"><div className="spinner" /></div>;
  }

  const next = headlineRound(result);
  const mine = me ? seatIn(next, me.local_id) : null;
  const isFinalHeadline = hasFinal(result);
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
        // final.json sits beside results.json and is written even later. Without this
        // line a reader following the block ends up with eleven rounds and no twelfth.
        `git checkout origin/HEAD -- results.json final.json events/`,
      ].join('\n')
    : null;

  return (
    <div className="stage result">
      <section className="card next-up">
        <p className="eyebrow">{t.eyebrow}</p>
        {mine ? (
          <h1>
            {lang === 'zh' ? (
              <>{isFinalHeadline ? '决赛轮' : `第 ${mine.round} 轮`}，你在<strong>第 {mine.table} 桌</strong>坐<strong>{WINDS.zh[mine.wind]}</strong>家。</>
            ) : (
              <>{isFinalHeadline ? 'Final round' : `Round ${mine.round}`}: you are at <strong>{tableName('en', mine.table).toLowerCase()}</strong>, seated <strong>{{ E: 'East', S: 'South', W: 'West', N: 'North' }[mine.wind]}</strong>.</>
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

      {result.final && (() => {
        const [fa, fsha, fb] = t.f1files(result.final.lock_sha256 || '');
        const [f2a, f2round, f2b] = t.f2(result.final.round_used);
        return (
          <section className="card next-up final-verify">
            <details className="verify">
              <summary>{t.finalVerify}</summary>
              <ol>
                <li>
                  {t.f1}
                  <code className="block">events/final/lock.json</code>
                  {fa}<code>{fsha}</code>{fb}
                </li>
                <li>
                  {f2a}<code>{f2round}</code>{f2b}
                  <code className="block">{`curl ${status?.drand?.api ?? '<drand api>'}/${status?.drand?.chain_hash ?? '<chain>'}/public/${result.final.round_used}`}</code>
                </li>
                <li>{t.f3}<code className="block">{result.final.seed}</code></li>
                <li>
                  {t.f4}
                  <code className="block">node generate-final.js --verify final.json</code>
                  {t.f5}
                  <code className="block">python3 tools/verify_final.py</code>
                </li>
              </ol>
            </details>
          </section>
        );
      })()}

      <Explorer result={result} me={me} />

      {/* The sealed ciphertexts do not stop being evidence once they are opened — they
          start being checkable. Offering them only during the wait meant the download
          disappeared at the exact moment someone might want to recompute the result
          from it. Same file, same fingerprint, same timestamp proof. */}
      {/* The countdown to the second beacon, for the minutes it is running. It is shown
          only while the round is locked: once the winds are drawn, the round they were
          drawn for is the headline at the top of this page, and a finished progress bar
          under it would be the one element still talking about the wait. */}
      {status?.final?.state === 'locked' && (
        <FinalTimeline final={status.final} drand={status.drand} serverNow={serverNow} />
      )}

      {/* The final round's commitment, shown from the moment it is locked — which is
          weeks before it is opened, and is the only moment at which comparing its
          digest with eleven other people proves anything (PROTOCOL.md §11). */}
      {status?.final && status.final.state !== 'none' && (
        <FinalCard final={status.final} result={result} players={status.players}
          substitutes={result?.substitutes || []} />
      )}

      {status?.roll && <RollCard roll={status.roll} sealed={false} />}
    </div>
  );
}
