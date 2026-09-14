import { useText } from '../i18n';

/**
 * The void stage (UI-SPEC.md §6).
 *
 * "Calm, non-blaming." No countdown and no retry button, because there is genuinely
 * nothing for the player to do here — and per PROTOCOL.md §8 the remedy was fixed
 * before the round started, so it is stated as a rule rather than a decision anyone is
 * making now.
 */

const TEXT = {
  zh: {
    title: '本轮作废',
    lede: (had, quorum) => `截止时只有 ${had} 位封存了数字，未达到 ${quorum} 位的门槛。`,
    body: '按照抽签开始之前就定下的规则，本轮作废。',
    again: (total) => `组织者会公布新的开奖轮次，届时全部 ${total} 位都需要重新提交（旧的密文绑定在已经过去的那一轮上，不能再用）。`,
    kept: '这一轮的记录不会被删掉。全部密文、截止时的名册和当时冻结的参数都已',
    keptLink: '公开存档',
    keptTail: (round, n) => `，等第 ${round} 轮的信标公布之后，任何人都能自己解开，确认当时确实只有 ${n} 位提交。`,
  },
  en: {
    title: 'This round is void',
    lede: (had, quorum) => `Only ${had} numbers were sealed by the cutoff, short of the ${quorum} required.`,
    body: 'Under the rule fixed before the draw opened, the round is void.',
    again: (total) => `The organiser will announce a new target round. All ${total} players will need to submit again: the old ciphertexts are bound to a round that has already passed.`,
    kept: 'Nothing from this round is deleted. Every ciphertext, the roster as it stood at the cutoff, and the frozen parameters are ',
    keptLink: 'published as an archive',
    keptTail: (round, n) => `. Once round ${round}'s beacon is out, anyone can open them and confirm that only ${n} people had submitted.`,
  },
};

export default function Void({ status }) {
  const t = useText(TEXT);
  // The archive of THIS attempt only exists once the job has written it, which is the
  // same moment the phase becomes void — so by the time this screen renders it is there.
  const mine = status?.previous_rounds?.find((r) => r.target_round === status.target_round);
  // The quorum and the field size are frozen parameters (§4.1). They are read from
  // /api/status and never defaulted here: a placeholder 8 on this screen would be the
  // app telling a player a rule that may not be the one the draw was tagged to.
  if (!status) return null;
  return (
    <div className="stage centre">
      <div className="card void">
        <h1>{t.title}</h1>
        <p className="lede">{t.lede(status?.submitted_count ?? 0, status?.quorum)}</p>
        <p>{t.body}</p>
        <p className="hint">{t.again(status?.total_slots)}</p>
        {mine && (
          <p className="hint">
            {t.kept}
            <a href={`/${mine.archive}/manifest.json`} target="_blank" rel="noreferrer">{t.keptLink}</a>
            {t.keptTail(status.target_round, mine.submitted_count)}
          </p>
        )}
      </div>
    </div>
  );
}
