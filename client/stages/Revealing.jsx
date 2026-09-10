import { useEffect, useRef, useState } from 'react';
import { useText } from '../i18n';

/**
 * The reveal (UI-SPEC.md §6).
 *
 * One continuous idea — sealed things opening, combining, and settling into an order:
 *   1. the beacon lands
 *   2. envelopes open in a stagger, each showing its player's number
 *   3. the numbers fold together into the seed
 *   4. the seed shuffles the names onto the template
 *   5. the seat plan resolves underneath
 *
 * Budgeted at ~7 s, skippable with a click, and short-circuited entirely for anyone
 * arriving after it already happened — they get the finished result, not a replay
 * (App.jsx decides that; this component is only mounted for a live reveal).
 *
 * Under prefers-reduced-motion, steps 2-4 collapse into one cross-fade carrying the
 * same information in text, per §1: nothing important is conveyed by motion alone.
 */

const STEP_KEYS = ['beacon', 'open', 'fold', 'shuffle', 'settle'];
const STEP_AT = [0, 1200, 3400, 5000, 6600];

const TEXT = {
  zh: {
    steps: { beacon: '信标已落地', open: '信封开启', fold: '数字合成种子', shuffle: '种子决定座位', settle: '完成' },
    roundBefore: 'drand 第',
    roundAfter: '轮',
    skip: '跳过 →',
    reducedTitle: '开奖完成',
    reducedBeacon: (n) => `drand 第 ${n} 轮的签名已公布，所有信封同时开启。`,
    reducedSeed: (n, seed) => `${n} 份贡献合成了种子 ${seed}…，种子决定了座位。`,
    reducedGo: '查看座位表',
  },
  en: {
    steps: { beacon: 'The beacon lands', open: 'Envelopes open', fold: 'Numbers fold into the seed', shuffle: 'The seed sets the seats', settle: 'Done' },
    roundBefore: 'drand round',
    roundAfter: '',
    skip: 'Skip →',
    reducedTitle: 'The draw is complete',
    reducedBeacon: (n) => `The signature for drand round ${n} is public, and every envelope opened at once.`,
    reducedSeed: (n, seed) => `${n} contributions folded into the seed ${seed}…, and the seed set the seats.`,
    reducedGo: 'See the seat plan',
  },
};

export default function Revealing({ status, result, onDone }) {
  const t = useText(TEXT);
  const reduced = typeof window !== 'undefined'
    && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const [step, setStep] = useState(reduced ? 'settle' : 'beacon');
  const timers = useRef([]);

  useEffect(() => {
    if (reduced) {
      const t2 = setTimeout(onDone, 1200);
      return () => clearTimeout(t2);
    }
    timers.current = STEP_KEYS.map((k, i) => setTimeout(() => setStep(k), STEP_AT[i]));
    const end = setTimeout(onDone, STEP_AT[STEP_AT.length - 1] + 600);
    timers.current.push(end);
    return () => timers.current.forEach(clearTimeout);
  }, [reduced, onDone]);

  const skip = () => {
    timers.current.forEach(clearTimeout);
    onDone();
  };

  const idx = STEP_KEYS.indexOf(step);
  const revealed = result?.revealed || {};
  const players = status?.players || [];
  const order = Object.keys(revealed).map(Number).sort((a, b) => a - b);
  const titleOf = new Map(players.map((p) => [p.local_id, p.title]));

  if (reduced) {
    return (
      <div className="stage centre">
        <div className="card reveal-reduced">
          <h1>{t.reducedTitle}</h1>
          <p>{t.reducedBeacon(result?.round_used ?? status?.target_round)}</p>
          <p>{t.reducedSeed(order.length, (result?.seed || '').slice(0, 16))}</p>
          <button className="primary" onClick={skip}>{t.reducedGo}</button>
        </div>
      </div>
    );
  }

  return (
    <div className="stage centre reveal" onClick={skip} role="presentation">
      <div className="reveal-inner">
        <p className="eyebrow">{t.steps[STEP_KEYS[Math.max(0, idx)]]}</p>

        <div className={`beacon-drop ${idx >= 0 ? 'in' : ''}`}>
          <span className="beacon-label">{t.roundBefore}</span>
          <span className="beacon-round">{result?.round_used ?? status?.target_round}</span>
          {t.roundAfter && <span className="beacon-label">{t.roundAfter}</span>}
        </div>

        <div className={`envelopes ${idx >= 1 ? 'open' : ''}`}>
          {order.map((id, i) => (
            <div key={id} className="env" style={{ '--i': i }}>
              <span className="env-name">{titleOf.get(id) || id}</span>
              <span className="env-num">{revealed[id]?.user_input}</span>
            </div>
          ))}
        </div>

        <div className={`fold ${idx >= 2 ? 'in' : ''}`}>
          <span className="fold-label">R</span>
          <code className="fold-value">{(result?.R || '').slice(0, 32)}…</code>
        </div>

        <div className={`shuffle ${idx >= 3 ? 'in' : ''}`}>
          {(result?.permutation || []).map((id, point) => (
            <span key={point} className="name-chip" style={{ '--i': point }}>{titleOf.get(id) || id}</span>
          ))}
        </div>

        <button className="skip" onClick={skip}>{t.skip}</button>
      </div>
    </div>
  );
}
