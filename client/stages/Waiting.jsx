import { useLang, useText, formatTime } from '../i18n';
import { useTick, split } from '../clock';
import RollCard from '../RollCard';
import Timeline from '../waiting/Timeline';
import Envelopes from '../waiting/Envelopes';

/**
 * The waiting stage (UI-SPEC.md §5).
 *
 * The stage most players will actually sit on, possibly for days, so everything here
 * is real observed state: the actual drand round, the real count, a countdown driven
 * by server time. §1's "honest waiting" — no invented progress, and if the beacon goes
 * stale we say so rather than hiding it.
 *
 * "Honest" also has to mean "visibly alive". The beacon round is the one number on this
 * page that moves by itself, and quicknet produces one every three seconds, so the
 * server pushes a fresh status every couple of seconds once the cutoff is close. A
 * figure that sits still for half a minute is indistinguishable from a broken page.
 */

const TEXT = {
  zh: {
    until: '距离开奖',
    drawing: '开奖中',
    drawingHint: '信标已产生，开奖任务将在几分钟内运行。',
    stuckTitle: '开奖任务没有运行',
    stuckLate: (mins) => `目标轮次的信标已经在 ${mins} 分钟前产生，但开奖仍未进行。`,
    stuckSafe: '这不会改变结果。参与名单在截止时就已冻结，信标也已公开，座位安排已经定下，只是还没有算出来。',
    stuckWho: '请联系组织者。',
    countdown: '倒计时',
    d: '天', h: '时', m: '分', s: '秒',
    yours: '你的数字已封存，不需要再做什么。',
    missedTitle: '提交已截止',
    missedBody: '你没有在截止之前提交数字，所以这一轮你不参与抽签。这不影响其他人，抽签会照常进行。',
    missedWhy: '截止时间是抽签开始之前就定好的。无法事后补交。',
    beacon: 'drand 信标',
    live: '运行中',
    down: '暂时联系不上',
    lastSeen: '最近确认',
    stale: '信标暂时联系不上。密文和轮次都已固定，结果早已确定，信标恢复后会自动继续。',
    polling: (s) => `实时连接中断，正在每 ${s} 秒刷新一次…`,
  },
  en: {
    until: 'Until the draw',
    drawing: 'Drawing',
    drawingHint: 'The beacon is out. The draw job runs within a few minutes.',
    stuckTitle: 'The draw job is not running',
    stuckLate: (mins) => `The beacon for the target round arrived ${mins} minutes ago and the draw still has not run.`,
    stuckSafe: 'This cannot change the outcome. The list of participants was frozen at the cutoff and the beacon is public, so the seating is already decided. It just has not been computed yet.',
    stuckWho: 'Please contact the organiser.',
    countdown: 'Countdown',
    d: 'd', h: 'h', m: 'm', s: 's',
    yours: 'Your number is sealed. There is nothing more for you to do.',
    missedTitle: 'Submissions are closed',
    missedBody: 'You did not submit a number before the cutoff, so you are not in this draw. It changes nothing for anyone else; the draw goes ahead.',
    missedWhy: 'The cutoff was fixed before the draw opened. A late number cannot be accepted.',
    beacon: 'drand beacon',
    live: 'Live',
    down: 'Not reachable',
    lastSeen: 'Last seen',
    stale: 'The beacon is not reachable right now. The ciphertexts and the round are already fixed, so the outcome is already determined. It resumes on its own.',
    polling: (s) => `Live connection dropped. Refreshing every ${s} seconds…`,
  },
};

export default function Waiting({ status, me, serverNow, connection }) {
  useTick(1000);
  const lang = useLang();
  const t = useText(TEXT);
  if (!status) return null;

  const now = serverNow();
  // UI-SPEC §5 anchors the countdown on the target round, not on the cutoff. The two
  // are reveal_gap_seconds apart (PROTOCOL.md §9), and the interval between them is not
  // dead time: the roll of who submitted is published in it, while the beacon that
  // would open the ciphertexts does not yet exist. Counting to the cutoff here meant
  // the page announced "Drawing" for the whole of that gap, when nothing was.
  const cutoffAt = Date.parse(status.cutoff_utc);
  const roundAt = Date.parse(status.target_round_utc);
  const drawAt = Number.isFinite(roundAt) ? roundAt : cutoffAt;
  const left = drawAt - now;
  const { d, h, m, s } = split(left);
  const elapsed = left <= 0;
  const sealed = now >= cutoffAt;
  // The server says whether the draw is merely pending or actually late; this page does
  // not guess, because the answer depends on a schedule it cannot see.
  const overdue = Boolean(status.draw?.overdue);
  const lateMinutes = Math.floor((status.draw?.seconds_late || 0) / 60);
  // A player who is on this stage without having submitted, after the cutoff, has
  // missed it. Before the cutoff they would be on `submit` instead, so this is not a
  // state anyone can be shown by mistake.
  const missed = sealed && me && !me.submitted;
  // The real cadence, not a number typed into a sentence: it is served in the status
  // and can be changed without rebuilding this bundle.
  const pollSeconds = Math.round((status.status_poll_interval_ms || 5000) / 1000);
  // Shown only while it means something: after the roll is taken and before the
  // beacon that opens the ciphertexts exists (PROTOCOL.md §9). Once the draw has
  // happened the same card reappears on the result stage, where it is evidence rather
  // than a commitment.
  const roll = sealed && status.phase === 'awaiting_round' ? status.roll : null;

  return (
    <div className={missed ? 'stage waiting missed' : 'stage waiting'}>
      <section className="countdown-block">
        <p className="eyebrow">{t.until}</p>
        {elapsed && overdue ? (
          <div className="countdown stuck"><span className="cd-unit"><b>{t.stuckTitle}</b></span></div>
        ) : elapsed ? (
          <div className="countdown done"><span className="cd-unit"><b>{t.drawing}</b></span></div>
        ) : (
          <div className="countdown" aria-label={t.countdown}>
            {d > 0 && <span className="cd-unit"><b>{d}</b><i>{t.d}</i></span>}
            <span className="cd-unit"><b>{String(h).padStart(2, '0')}</b><i>{t.h}</i></span>
            <span className="cd-unit"><b>{String(m).padStart(2, '0')}</b><i>{t.m}</i></span>
            <span className="cd-unit"><b>{String(s).padStart(2, '0')}</b><i>{t.s}</i></span>
          </div>
        )}
        {elapsed && !overdue && <p className="note">{t.drawingHint}</p>}
        {/* Not an error message so much as a correction: the page has been saying
            "Drawing" and nothing is drawing. Say what is actually missing, and say in
            the same breath that the outcome is not at risk, because a player who reads
            only the first sentence will assume it is. */}
        {elapsed && overdue && (
          <div className="note warn stuck">
            <p>{t.stuckLate(lateMinutes)}</p>
            <p>{t.stuckSafe}</p>
            <p>{t.stuckWho}</p>
          </div>
        )}
        {me?.submitted && <p className="note ok">{t.yours}</p>}
      </section>

      {/* The one thing this player needs to know before anything else on the page. */}
      {missed && (
        <section className="card closed-card" role="status">
          <h2>{t.missedTitle}</h2>
          <p>{t.missedBody}</p>
          <p className="hint">{t.missedWhy}</p>
        </section>
      )}

      <Timeline status={status} now={now} />

      {roll && <RollCard roll={roll} sealed />}

      <Envelopes status={status} me={me} closed={sealed} />

      <section className="card beacon">
        <div className="beacon-head">
          <h2>{t.beacon}</h2>
          <span className={status.drand?.healthy ? 'pill ok live' : 'pill bad'}>
            {status.drand?.healthy ? t.live : t.down}
          </span>
        </div>
        <dl className="facts">
          <dt>{t.lastSeen}</dt>
          <dd>{status.drand?.last_seen_utc ? formatTime(status.drand.last_seen_utc, lang) : '—'}</dd>
        </dl>
        {!status.drand?.healthy && <p className="note warn">{t.stale}</p>}
      </section>

      {connection === 'polling' && <p className="reconnecting">{t.polling(pollSeconds)}</p>}
    </div>
  );
}
