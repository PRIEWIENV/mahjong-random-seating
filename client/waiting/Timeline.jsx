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
 * `submission_opens_utc` (stamped by tools/pick-round.js) gives the left-hand segment a
 * real origin, so the whole span is real and the marker moves in proportion to time
 * actually elapsed. It used to have none — submissions may have opened a fortnight ago —
 * and was drawn as one reveal-gap of lead-in, which meant the marker sat pinned to the
 * left edge for three days and then crossed the entire bar in the last minute. A bar
 * that appears not to be running is its own kind of lie.
 *
 * The sealed segment keeps a floor on its share of the width. Drawn at its true
 * proportion, a sixty-second gap inside a seventy-two-hour window is 0.02% of the track:
 * the cutoff mark would land on top of the draw mark, and the segment whose whole purpose
 * is to be visible would have no pixels. So the submission window is to scale, the gap is
 * to scale whenever it is at least MIN_GAP_SHARE of the whole, and below that the gap is
 * floored and the window takes the rest. The marker stays continuous either way, because
 * it is interpolated within whichever segment now is in.
 *
 * A protocol.json frozen before the field existed still works: without an origin the old
 * synthetic lead-in is used and the start label says the window opened earlier, rather
 * than inventing a date.
 *
 * The state and the time remaining sit together in the card's header, the countdown
 * beside the state it belongs to. It used to sit at the far right of the card, which put
 * it directly above the "the draw" label and read as a countdown to the draw when it is
 * a countdown to the cutoff.
 */

const TEXT = {
  zh: {
    open: '提交开放',
    cutoff: '提交截止',
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
    what: '等待 drand 公共信标链走到目标轮次就可以开奖。目标轮次的签名一旦生成，所有已提交密文就能打开。',
  },
  en: {
    open: 'Submissions open',
    cutoff: 'Submissions close',
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
    what: 'The draw happens once the public drand chain reaches the target round. As soon as that round’s signature exists, every submitted ciphertext can be opened.',
  },
};

const clamp01 = (n) => Math.max(0, Math.min(1, n));
const pct = (n) => `${(clamp01(n) * 100).toFixed(2)}%`;

/**
 * The least share of the track the sealed segment may have. See the note above: at its
 * true proportion a one-minute gap in a three-day window is invisible, and an invisible
 * segment cannot carry the mark and the label that are the point of drawing it.
 */
const MIN_GAP_SHARE = 0.18;

export default function Timeline({ status, now }) {
  const lang = useLang();
  const t = useText(TEXT);

  const cutoffMs = Date.parse(status.cutoff_utc);
  const drawMs = Date.parse(status.target_round_utc);
  if (!Number.isFinite(cutoffMs) || !Number.isFinite(drawMs)) return null;

  // The real origin, when the freeze recorded one.
  const openMs = Date.parse(status.submission_opens_utc || '');
  const toScale = Number.isFinite(openMs) && openMs < cutoffMs;

  let cutoffAt;
  let position;
  let clipped;
  if (toScale) {
    const spanMs = drawMs - openMs;
    const sealedMs = Math.max(drawMs - cutoffMs, 1);
    const gapShare = Math.min(0.5, Math.max(sealedMs / spanMs, MIN_GAP_SHARE));
    cutoffAt = 1 - gapShare;
    clipped = now < openMs;
    position = now <= cutoffMs
      ? cutoffAt * clamp01((now - openMs) / (cutoffMs - openMs))
      : cutoffAt + gapShare * clamp01((now - cutoffMs) / sealedMs);
  } else {
    // No origin was frozen. The gap the protocol actually fixed, not the difference
    // between two parsed strings: they agree, and where they do not the protocol is right.
    const gapMs = Math.max((status.reveal_gap_seconds || 0) * 1000, drawMs - cutoffMs, 60_000);
    const spanMs = gapMs * 2;
    const startMs = cutoffMs - gapMs;
    cutoffAt = 0.5;
    clipped = now < startMs;
    position = clamp01((now - startMs) / spanMs);
  }
  position = clamp01(position);

  const sealed = now >= cutoffMs;
  const drawing = now >= drawMs;
  const stateLabel = drawing ? t.nowDrawing : sealed ? t.nowSealed : t.nowOpen;
  const target = drawing ? null : sealed ? drawMs : cutoffMs;
  const { d, h, m, s } = split(target == null ? 0 : target - now);

  const cutoffExact = formatExact(status.cutoff_utc, lang);
  const drawExact = formatExact(status.target_round_utc, lang);
  const openExact = toScale ? formatExact(status.submission_opens_utc, lang) : null;

  const latest = status.drand?.latest_round;
  const toGo = Number.isFinite(latest) ? status.target_round - latest : null;

  // Namespaced, and not merely for tidiness. These were `open` / `sealed` / `drawing`,
  // and `sealed` is also the class on the submitted stage's card — so `.card.sealed`,
  // written for a 460px confirmation card, matched this one the moment the cutoff passed
  // and shrank the timeline to under half the width of the cards above and below it,
  // centred its text and gave it the wrong shadow. A state modifier shares a namespace
  // with every other class on the element; a component's states have to say whose.
  const phaseClass = drawing ? 'tl-drawing' : sealed ? 'tl-sealed' : 'tl-open';

  return (
    <section className={`card timeline-card ${phaseClass}`}>
      <div className="tl-head">
        <h2>{stateLabel}</h2>
        {target != null && <span className="tl-left">{t.left(d, h, m, s)}</span>}
      </div>

      {/* The cutoff is an interior mark, so its label rides above the track centred on
          it. In the row below it could only ever be centred between its neighbours,
          which is a different position from the line it names and drifts with their
          widths. Below the wide breakpoint this becomes an ordinary line above the
          track, because three dated labels never fit across a phone. */}
      <div className="tl-caption">
        <span className="tl-label cutoff" style={{ left: pct(cutoffAt) }}>
          <span className="tl-name">{t.cutoff}</span>
          {cutoffExact && (
            <span className="tl-when">{cutoffExact.local}<em>{cutoffExact.offset}</em></span>
          )}
        </span>
      </div>

      <div className="tl-track" role="img" aria-label={stateLabel}>
        <div className="tl-fill" style={{ width: pct(position) }} />
        <span className="tl-stop cutoff" style={{ left: pct(cutoffAt) }} />
        <span className="tl-stop draw" />
        <span className={clipped ? 'tl-dot clipped' : 'tl-dot'} style={{ left: pct(position) }} />
      </div>

      {/* The two ends, each against the edge it names. */}
      <div className="tl-labels">
        <div className="tl-label start">
          <span className="tl-name">{t.open}</span>
          {openExact
            ? <span className="tl-when">{openExact.local}<em>{openExact.offset}</em></span>
            : <span className="tl-when">{t.earlier}</span>}
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
