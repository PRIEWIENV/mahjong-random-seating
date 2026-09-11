import { useState } from 'react';
import { useText } from './i18n';

/**
 * The sealed ciphertexts, their fingerprint, and the evidence that goes with it.
 *
 * Shown twice, on purpose. Before the draw it is the one thing a player is asked to
 * *do*: compare a short string with eleven other people while nobody — including the
 * organiser — can yet open a single envelope. After the draw the same file is what a
 * verifier recomputes from, so it stays downloadable rather than disappearing at the
 * moment it becomes checkable.
 *
 * An OpenTimestamps anchor proves the file existed before a Bitcoin block, which is
 * what a forged late submission cannot satisfy. It does not prove it was the only file
 * anchored — anchoring is cheap. Twelve people agreeing on one value does.
 *
 * The anchor claim, the files and how to check them are one block and not three. Split
 * up, as they were, the page asserted "timestamped into Bitcoin" in one paragraph and
 * offered a download in another, leaving the reader to work out that the second is how
 * you check the first. And the check itself is a web page you drag two files onto, not
 * a command line: a player who has to install a Python package in order to verify the
 * draw does not verify the draw.
 */

const OTS_SITE = 'https://opentimestamps.org';

const TEXT = {
  zh: {
    titleSealed: '密文提交结果已封存，开奖尚未开始',
    titleDone: '密文提交结果',
    ledeSealed: (n) => `截止时收到 ${n} 份密文。下面是这份提交结果的指纹：`,
    ledeDone: (n) => `本次开奖所依据的 ${n} 份密文，连同它的指纹与存证：`,
    ask: '把它发到群里，和别人核对一遍。',
    why: '现在还没有人能解开任何一份密文——解密要等的那一轮信标尚未产生。所以此刻公布这份结果，等于承诺了参与者就是这些人，而且承诺时谁也不知道换个人会带来什么结果。十二个人看到的指纹必须一样。',
    whyDone: '这就是开奖时被打开的那一批密文。指纹和存证都没有变，任何人现在都可以下载下来自己解开、自己复算。',
    copy: '复制',
    copied: '已复制',
    proofTitle: '存证与验证',
    anchored: (n) => `这份文件已由 ${n} 个独立的日历服务器写进比特币区块链做了时间戳存证，证明它在某个区块之前就已存在。`,
    notAnchored: '外部时间戳存证这次没能完成。指纹本身仍然有效——所以和别人核对这一步这次格外重要。',
    fileRoll: '下载密文提交结果',
    fileProof: '下载时间戳证明',
    howTitle: '自己验一遍（不需要命令行）：',
    how: [
      '把上面两个文件都下载下来，放在一起。',
      '打开 opentimestamps.org，选 Verify。',
      '先拖入密文提交结果文件，再拖入时间戳证明文件。',
    ],
    howTail: '页面会告诉你这份文件最早在哪个比特币区块里被证明存在。那个区块的时间早于开奖，也就早于任何人有可能知道结果的时刻。',
  },
  en: {
    titleSealed: 'The ciphertexts are sealed; the draw has not happened',
    titleDone: 'The sealed ciphertexts',
    ledeSealed: (n) => `${n} ciphertexts were held at the cutoff. This is their fingerprint:`,
    ledeDone: (n) => `The ${n} ciphertexts this draw was computed from, with their fingerprint and proof:`,
    ask: 'Post it to the group chat and check it against everybody else.',
    why: 'Nobody can open any of those ciphertexts yet: the beacon that unlocks them has not been produced. So publishing them now commits to who took part, at a moment when nobody knows what swapping someone would do to the outcome. All twelve of you should see the same fingerprint.',
    whyDone: 'These are the ciphertexts that were opened at the draw. The fingerprint and the proof have not changed, and anyone can now download them, open them, and recompute the result.',
    copy: 'Copy',
    copied: 'Copied',
    proofTitle: 'Proof, and how to check it',
    anchored: (n) => `${n} independent calendar servers timestamped this file into the Bitcoin blockchain, proving it existed before a particular block.`,
    notAnchored: 'The external timestamp did not go through this time. The fingerprint still holds, which makes comparing it with other people matter more than usual.',
    fileRoll: 'Download the ciphertexts',
    fileProof: 'Download the timestamp proof',
    howTitle: 'Check it yourself — no command line needed:',
    how: [
      'Download both files above and keep them together.',
      'Open opentimestamps.org and choose Verify.',
      'Drop the ciphertext file in first, then the proof file.',
    ],
    howTail: 'The page tells you the earliest Bitcoin block this file is proved to predate. That block is older than the draw, and so older than the moment anyone could have known the outcome.',
  },
};

/**
 * @param {object}  o
 * @param {object}  o.roll     status.roll — digest, submitted_count, anchored, calendars
 * @param {boolean} o.sealed   true before the draw (the comparison is live), false after
 */
export default function RollCard({ roll, sealed = true }) {
  const t = useText(TEXT);
  const [copied, setCopied] = useState(false);
  if (!roll?.digest) return null;

  const short = roll.digest.slice(0, 16);
  const copy = () => {
    navigator.clipboard?.writeText(roll.digest).then(
      () => { setCopied(true); setTimeout(() => setCopied(false), 2000); },
      () => {}
    );
  };

  return (
    <section className="card roll-card">
      <h2>{sealed ? t.titleSealed : t.titleDone}</h2>
      <p className="lede">{(sealed ? t.ledeSealed : t.ledeDone)(roll.submitted_count)}</p>

      <p className="roll-digest">
        <code title={roll.digest}>{short}</code>
        <button className="linkish" onClick={copy}>{copied ? t.copied : t.copy}</button>
      </p>

      {sealed && <p className="roll-ask">{t.ask}</p>}
      <p className="hint">{sealed ? t.why : t.whyDone}</p>

      {/* One block: the claim, the files that back it, and the way to check them. */}
      <div className={roll.anchored ? 'proof-block' : 'proof-block unanchored'}>
        <h3>{t.proofTitle}</h3>
        <p className={roll.anchored ? 'proof-claim' : 'proof-claim warn'}>
          {roll.anchored ? t.anchored(roll.calendars?.length ?? 0) : t.notAnchored}
        </p>
        <p className="roll-files">
          <a href="/snapshot.json" download>{t.fileRoll}</a>
          {roll.anchored && <a href="/snapshot.json.ots" download>{t.fileProof}</a>}
        </p>
        {roll.anchored && (
          <>
            <p className="proof-how-title">{t.howTitle}</p>
            <ol className="proof-how">
              {t.how.map((step, i) => (
                <li key={i}>
                  {i === 1 ? (
                    <>
                      {step.split('opentimestamps.org')[0]}
                      <a href={OTS_SITE} target="_blank" rel="noreferrer">opentimestamps.org</a>
                      {step.split('opentimestamps.org')[1]}
                    </>
                  ) : step}
                </li>
              ))}
            </ol>
            <p className="fineprint">{t.howTail}</p>
          </>
        )}
      </div>
    </section>
  );
}
