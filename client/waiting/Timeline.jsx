import { useLang, useText } from '../i18n';
import { formatExact, split } from '../clock';

/**
 * Where the draw is, drawn rather than stated (UI-SPEC §5).
 *
 * This replaces a line of small print that read "sealed at 20:30 · draw at 20:40 ·
 * drand round 8,234,500". Every fact in it was true and none of it was legible: the two
 * instants are a *sequence*, the round is what connects them to something outside this
 * server, and a sentence cannot show that the second instant is minutes after the first
 * while the first is still days away.
 *
 * Two segments, because the draw has two of them and they mean different things:
 *
 *   submissions open ─────●───── cutoff ───── the beacon lands
 *                                 └── reveal_gap_seconds ──┘
 *
 * The right-hand segment has a real duration, `reveal_gap_seconds`, and is drawn to
 * scale. The left-hand one has no honest origin — submissions may have opened a
 * fortnight ago — so it is drawn as one reveal-gap of lead-in, and while now is earlier
 * than that the marker pins to the left edge and says so. A bar that invented a start
 * date would be the same lie as an invented progress bar.
 *
 * The state and the time remaining sit in the card's own header rather than floating
 * over the marker: a label riding a marker that reaches either end has nowhere to go.
 */

const TEXT = {
  zh: {
    open: '提交开放',
    cutoff: '封存截止',
    draw: '开奖',
    nowOpen: '提交进行中',
    nowSealed: '已封存，等待信标',
    nowDrawing: '开奖中',
    left: (d, h, m, s) => (d > 0 ? `还剩 ${d} 天 ${h} 小时` : h > 0 ? `还剩 ${h} 小时 ${m} 分` : `还剩 ${m} 分 ${s} 秒`),
    earlier: '更早开始',
    roundNow: '当前轮次',
    roundTarget: '目标轮次',
    roundsToGo: (n) => `还差 ${n.toLocaleString()} 轮`,
    roundsHere: '已经到达',
    beaconDown: '信标暂时读不到，上面的当前轮次可能不是最新的。',
    what: '开奖等的是 drand 这条公共信标链走到目标轮次。那一轮的值一出现，密文就能打开——包括我们在内，谁也没法让它早一点或晚一点。',
  },
  en: {
    open: 'Submissions open',
    cutoff: 'Sealed',
    draw: 'The draw',
    nowOpen: 'Open for submissions',
    nowSealed: 'Sealed, waiting for the beacon',
    nowDrawing: 'Drawing',
    left: (d, h, m, s) => (d > 0 ? `${d}d ${h}h left` : h > 0 ? `${h}h ${m}m left` : `${m}m ${s}s left`),
    earlier: 'opened earlier',
    roundNow: 'Current round',
    roundTarget: 'Target round',
    roundsToGo: (n) => `${n.toLocaleString()} rounds to go`,
    roundsHere: 'Reached',
    beaconDown: 'The beacon is not readable right now, so the current round above may be stale.',
    what: 'The draw waits for the public drand chain to reach the target round. The moment that round’s value exists the ciphertexts can be opened, and nobody — us included — can make it happen sooner or later.',
  },
};

const pct = (n) => `${Math.max(0, Math.min(100, n * 100)).toFixed(2)}%`;

export default function Timeline({ status, now }) {
  const lang = useLang();
  const t = useText(TEXT);

  const cutoffMs = Date.parse(status.cutoff_utc);
  const drawMs = Date.parse(status.target_round_utc);
  if (!Number.isFinite(cutoffMs) || !Number.isFinite(drawMs)) return null;

  // The gap the protocol actually fixed, not the difference between two parsed strings:
  // they agree, and where they do not it is the protocol that is right.
  const gapMs = Math.max((status.reveal_gap_seconds || 0) * 1000, drawMs - cutoffMs, 60_000);
  const leadMs = gapMs; // the drawn lead-in; see the note above
  const spanMs = leadMs + gapMs;
  const startMs = cutoffMs - leadMs;

  const clipped = now < startMs;
  const position = Math.max(0, Math.min(1, (now - startMs) / spanMs));
  const cutoffAt = leadMs / spanMs;

  const sealed = now >= cutoffMs;
  const drawing = now >= drawMs;
  const stateLabel = drawing ? t.nowDrawing : sealed ? t.nowSealed : t.nowOpen;
  const target = drawing ? null : sealed ? drawMs : cutoffMs;
  const { d, h, m, s } = split(target == null ? 0 : target - now);

  const cutoffExact = formatExact(status.cutoff_utc, lang);
  const drawExact = formatExact(status.target_round_utc, lang);

  const latest = status.drand?.latest_round;
  const toGo = Number.isFinite(latest) ? status.target_round - latest : null;

  const phaseClass = drawing ? 'drawing' : sealed ? 'sealed' : 'open';

  return (
    <section className={`card timeline-card ${phaseClass}`}>
      <div className="tl-head">
        <h2>{stateLabel}</h2>
        {target != null && <span className="tl-left">{t.left(d, h, m, s)}</span>}
      </div>

      <div className="tl-track" role="img" aria-label={stateLabel}>
        <div className="tl-fill" style={{ width: pct(position) }} />
        <span className="tl-stop cutoff" style={{ left: pct(cutoffAt) }} />
        <span className="tl-stop draw" />
        <span className={clipped ? 'tl-dot clipped' : 'tl-dot'} style={{ left: pct(position) }} />
      </div>

      <div className="tl-labels">
        <div className="tl-label start">
          <span className="tl-name">{t.open}</span>
          {clipped && <span className="tl-when">{t.earlier}</span>}
        </div>
        <div className="tl-label cutoff">
          <span className="tl-name">{t.cutoff}</span>
          {cutoffExact && (
            <span className="tl-when">{cutoffExact.local}<em>{cutoffExact.offset}</em></span>
          )}
        </div>
        <div className="tl-label draw">
          <span className="tl-name">{t.draw}</span>
          {drawExact && (
            <span className="tl-when">{drawExact.local}<em>{drawExact.offset}</em></span>
          )}
        </div>
      </div>

      {/* The rounds themselves, which is the part that ties this page to something
          nobody here operates. Large enough to be what you look at. */}
      <div className="tl-rounds">
        <div className="tl-round">
          <span className="tl-round-label">{t.roundNow}</span>
          <b className={status.drand?.healthy ? 'live' : 'stale'}>
            {Number.isFinite(latest) ? latest.toLocaleString() : '—'}
          </b>
        </div>
        <div className="tl-round-gap">
          <span className="tl-arrow" aria-hidden="true" />
          <span>{toGo == null ? '' : toGo > 0 ? t.roundsToGo(toGo) : t.roundsHere}</span>
        </div>
        <div className="tl-round target">
          <span className="tl-round-label">{t.roundTarget}</span>
          <b>{status.target_round.toLocaleString()}</b>
        </div>
      </div>

      <p className="hint">{t.what}</p>
      {!status.drand?.healthy && <p className="fineprint">{t.beaconDown}</p>}
    </section>
  );
}
