import { useLang, useText } from './i18n';
import { formatExact, split, useTick } from './clock';

/**
 * Where the final round's draw is, while it is happening (UI-SPEC.md §7).
 *
 * The twelfth round has the same shape as the first one — a commitment, then a wait for
 * a public beacon, then a result nobody chose — but for weeks it had none of the first
 * draw's instrumentation. A player who had watched a three-day countdown, a live drand
 * round and a moving marker was then handed a card that said "the winds are drawn once
 * that beacon lands" and nothing else. The gap here is five minutes rather than three
 * days, which makes the absence worse, not better: five minutes is exactly the span over
 * which a page that does not visibly move reads as a page that has stopped working.
 *
 * So this is Timeline's sibling, on the same track and the same classes, with the one
 * structural difference the round actually has: there is no cutoff in the middle, because
 * nobody submits anything. Two ends and one segment — locked, then the beacon.
 *
 *   locked ──────────●────────── the beacon lands ──▶ the server draws
 *
 * Three states, and they are not cosmetic:
 *
 *   tl-locked   the beacon is in the future. Everything on screen is already decided
 *               except the winds, and the countdown is to the moment that changes.
 *   tl-drawing  the beacon has landed and the draw has not appeared. This is NORMAL for
 *               up to one scheduler interval (deploy/README.md §3) — nothing is wrong and
 *               nothing is in doubt, so it says that rather than animating a fake result.
 *   tl-late     past that grace, which is a job that is not running. Same words the
 *               waiting stage uses for the same condition, because it is the same fault.
 *
 * Nothing here is a trigger. The draw runs on server/schedule.js's timer and this page
 * only watches; §9 keeps every draw off HTTP, and a progress bar that could start one
 * would be the hole that rule exists to close.
 */

const TEXT = {
  zh: {
    locked: '决赛轮已锁定，等待信标',
    drawing: '信标已产生，正在抽风位',
    late: '决赛轮的抽签任务没有运行',
    start: '名次与轮次封存',
    end: '信标产生，抽出风位',
    left: (d, h, m, s) => (d > 0 ? `还剩 ${d} 天 ${h} 小时` : h > 0 ? `还剩 ${h} 小时 ${m} 分` : `还剩 ${m} 分 ${s} 秒`),
    roundNow: '当前轮次',
    roundTarget: '决赛信标轮次',
    roundsToGo: (n) => `还差 ${n.toLocaleString()} 轮`,
    roundsHere: '已经到达',
    whatLocked: '桌次已经由前十一轮的名次定下并公开，现在等的只是这一轮 drand 信标。它一产生，服务器会自己算出风位——没有人需要按任何按钮。',
    whatDrawing: '信标已经产生，抽签任务会在几分钟内跑完。结果此刻其实已经确定了，只是还没有算出来。',
    whatLate: (mins) => `信标已经在 ${mins} 分钟前产生，风位却还没出来。这不会改变结果——名次和轮次早已封存，风位已经定了，只是还没有算。请联系组织者。`,
    beaconDown: '信标暂时读不到，上面的当前轮次可能不是最新的。',
  },
  en: {
    locked: 'Final round locked, waiting for the beacon',
    drawing: 'The beacon is out; drawing the winds',
    late: 'The final round’s draw job is not running',
    start: 'Standings and round sealed',
    end: 'The beacon lands, the winds are drawn',
    left: (d, h, m, s) => (d > 0 ? `${d}d ${h}h left` : h > 0 ? `${h}h ${m}m left` : `${m}m ${s}s left`),
    roundNow: 'Current round',
    roundTarget: 'Final beacon',
    roundsToGo: (n) => `${n.toLocaleString()} rounds to go`,
    roundsHere: 'Reached',
    whatLocked: 'The tables were set by the eleven-round standings and published. All that is left is this drand round: the moment it exists, the server works out the winds on its own — nobody presses anything.',
    whatDrawing: 'The beacon exists and the draw job runs within a few minutes. The outcome is already determined; it just has not been computed yet.',
    whatLate: (mins) => `The beacon arrived ${mins} minutes ago and the winds still have not appeared. It cannot change the outcome — the standings and the round were sealed long before, so the winds are already decided and merely uncomputed. Please contact the organiser.`,
    beaconDown: 'The beacon is not readable right now, so the current round above may be stale.',
  },
};

const clamp01 = (n) => Math.max(0, Math.min(1, n));
const pct = (n) => `${(clamp01(n) * 100).toFixed(2)}%`;

/**
 * How long after the beacon a missing draw stops being normal.
 *
 * Deliberately generous and deliberately fixed: the scheduler's interval is a runtime
 * setting this page is not told, and guessing it low would call a healthy server late.
 */
const GRACE_MS = 6 * 60_000;

/**
 * @param {object}   o
 * @param {object}   o.final      status.final, in state 'locked'
 * @param {object}   o.drand      status.drand — latest_round, healthy
 * @param {Function} o.serverNow  server-corrected clock, so this never drifts
 */
export default function FinalTimeline({ final, drand, serverNow }) {
  const lang = useLang();
  const t = useText(TEXT);
  useTick(1000);

  const beaconMs = Date.parse(final?.target_round_utc || '');
  const lockedMs = Date.parse(final?.locked_at || '');
  if (!Number.isFinite(beaconMs)) return null;

  const now = serverNow ? serverNow() : Date.now();
  // Without a lock time there is still a track to draw; it is given a nominal span so the
  // marker moves at a believable rate rather than sitting at one end. An invented origin
  // is never labelled as one — the start label simply carries no date (see Timeline).
  const haveOrigin = Number.isFinite(lockedMs) && lockedMs < beaconMs;
  const spanMs = haveOrigin ? beaconMs - lockedMs : 5 * 60_000;
  const startMs = haveOrigin ? lockedMs : beaconMs - spanMs;

  const landed = now >= beaconMs;
  const late = landed && now - beaconMs > GRACE_MS;
  const position = landed ? 1 : clamp01((now - startMs) / spanMs);
  const { d, h, m, s } = split(Math.max(0, beaconMs - now));

  const stateLabel = late ? t.late : landed ? t.drawing : t.locked;
  const phaseClass = late ? 'tl-late' : landed ? 'tl-drawing' : 'tl-locked';

  const startExact = haveOrigin ? formatExact(final.locked_at, lang) : null;
  const endExact = formatExact(final.target_round_utc, lang);

  const latest = drand?.latest_round;
  const toGo = Number.isFinite(latest) ? final.target_round - latest : null;

  return (
    <section className={`card timeline-card final-timeline ${phaseClass}`}>
      <div className="tl-head">
        <h2>{stateLabel}</h2>
        {!landed && <span className="tl-left">{t.left(d, h, m, s)}</span>}
      </div>

      <div className="tl-track" role="img" aria-label={stateLabel}>
        <div className="tl-fill" style={{ width: pct(position) }} />
        <span className="tl-stop draw" />
        <span className="tl-dot" style={{ left: pct(position) }} />
      </div>

      <div className="tl-labels">
        <div className="tl-label start">
          <span className="tl-name">{t.start}</span>
          {startExact && (
            <span className="tl-when">{startExact.local}<em>{startExact.offset}</em></span>
          )}
        </div>
        <div className="tl-label draw">
          <span className="tl-name">{t.end}</span>
          {endExact && (
            <span className="tl-when">{endExact.local}<em>{endExact.offset}</em></span>
          )}
        </div>
      </div>

      {/* The same pair as the first draw's timeline, and the same reason for it: this is
          the part of the page that is tied to something nobody here operates. */}
      <div className="tl-rounds">
        <div className="tl-round">
          <span className="tl-round-label">{t.roundNow}</span>
          <b className={drand?.healthy ? 'live' : 'stale'}>
            {Number.isFinite(latest) ? latest.toLocaleString() : '—'}
          </b>
        </div>
        <div className="tl-round-gap">
          <span className="tl-arrow" aria-hidden="true" />
          <span>{toGo == null ? '' : toGo > 0 ? t.roundsToGo(toGo) : t.roundsHere}</span>
        </div>
        <div className="tl-round target">
          <span className="tl-round-label">{t.roundTarget}</span>
          <b>{Number(final.target_round).toLocaleString()}</b>
        </div>
      </div>

      <p className={late ? 'note warn' : 'hint'}>
        {late
          ? t.whatLate(Math.floor((now - beaconMs) / 60_000))
          : landed ? t.whatDrawing : t.whatLocked}
      </p>
      {!drand?.healthy && <p className="fineprint">{t.beaconDown}</p>}
    </section>
  );
}
