/**
 * The void stage (UI-SPEC.md §6).
 *
 * "Calm, non-blaming." No countdown and no retry button, because there is genuinely
 * nothing for the player to do here — and per PROTOCOL.md §8 the remedy was fixed
 * before the round started, so it is stated as a rule rather than a decision anyone is
 * making now.
 */
export default function Void({ status }) {
  return (
    <div className="stage centre">
      <div className="card void">
        <h1>本轮作废</h1>
        <p className="lede">
          截止时只有 {status?.submitted_count ?? 0} 位封存了数字，未达到 {status?.quorum ?? 8} 位的门槛。
        </p>
        <p>
          按照抽签开始<em>之前</em>就定下的规则，本轮作废。这不是任何人的失误，
          门槛也不会因为差几个人而临时调整——事后调整规则本身就会让抽签变得可以被操纵。
        </p>
        <p className="hint">
          组织者会公布新的开奖轮次，届时<strong>全部 {status?.total_slots ?? 12} 位</strong>都需要重新提交
          （旧的密文绑定在已经过去的那一轮上，不能再用）。
        </p>
      </div>
    </div>
  );
}
