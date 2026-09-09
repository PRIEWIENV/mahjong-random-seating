import { useEffect, useRef, useState } from 'react';

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

const STEPS = [
  { key: 'beacon', at: 0, label: '信标已落地' },
  { key: 'open', at: 1200, label: '信封开启' },
  { key: 'fold', at: 3400, label: '数字合成种子' },
  { key: 'shuffle', at: 5000, label: '种子决定座位' },
  { key: 'settle', at: 6600, label: '完成' },
];

export default function Revealing({ status, result, onDone }) {
  const reduced = typeof window !== 'undefined'
    && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const [step, setStep] = useState(reduced ? 'settle' : 'beacon');
  const timers = useRef([]);

  useEffect(() => {
    if (reduced) {
      const t = setTimeout(onDone, 1200);
      return () => clearTimeout(t);
    }
    timers.current = STEPS.map((s) => setTimeout(() => setStep(s.key), s.at));
    const end = setTimeout(onDone, STEPS[STEPS.length - 1].at + 600);
    timers.current.push(end);
    return () => timers.current.forEach(clearTimeout);
  }, [reduced, onDone]);

  const skip = () => {
    timers.current.forEach(clearTimeout);
    onDone();
  };

  const idx = STEPS.findIndex((s) => s.key === step);
  const revealed = result?.revealed || {};
  const players = status?.players || [];
  const order = Object.keys(revealed).map(Number).sort((a, b) => a - b);
  const titleOf = new Map(players.map((p) => [p.local_id, p.title]));

  if (reduced) {
    return (
      <div className="stage centre">
        <div className="card reveal-reduced">
          <h1>开奖完成</h1>
          <p>drand 第 {result?.round_used ?? status?.target_round} 轮的签名已公布，所有信封同时开启。</p>
          <p>{order.length} 份贡献合成了种子 <code>{(result?.seed || '').slice(0, 16)}…</code>，种子决定了座位。</p>
          <button className="primary" onClick={skip}>查看座位表</button>
        </div>
      </div>
    );
  }

  return (
    <div className="stage centre reveal" onClick={skip} role="presentation">
      <div className="reveal-inner">
        <p className="eyebrow">{STEPS[Math.max(0, idx)]?.label}</p>

        <div className={`beacon-drop ${idx >= 0 ? 'in' : ''}`}>
          <span className="beacon-label">drand 第</span>
          <span className="beacon-round">{result?.round_used ?? status?.target_round}</span>
          <span className="beacon-label">轮</span>
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

        <button className="skip" onClick={skip}>跳过 →</button>
      </div>
    </div>
  );
}
