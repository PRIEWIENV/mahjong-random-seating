import { useEffect, useRef, useState } from 'react';
import * as api from '../api';
import { sealSubmission, rollNumber } from '../seal';

/**
 * The submission stage (UI-SPEC.md §4) — the focal element of the whole app.
 *
 * One large numeric field, one primary action. The number is sealed in this browser
 * before anything is sent; the nonce that makes the contribution uniformly random is
 * generated silently and revealed later, so a player who types 7 still contributes as
 * unpredictably as one who rolls dice (PROTOCOL.md §3.1).
 *
 * No edit or withdraw affordance. A submission is final by design, and §4 asks that we
 * say so *before* the button rather than after.
 */
export default function Submit({ protocol, status, me, onSubmitted }) {
  const [value, setValue] = useState('');
  const [phase, setPhase] = useState('idle'); // idle | rolling | sealing | posting
  const [error, setError] = useState(null);
  const inputRef = useRef(null);
  const rollTimer = useRef(null);

  // No fallback. Every frozen number the UI shows comes from /api/status, which is
  // served straight out of the tagged protocol.json; inventing one here would let the
  // page state a bound the draw does not actually use.
  const max = status?.user_input_max;
  const last = status?.previous_rounds?.[status.previous_rounds.length - 1];
  const busy = phase === 'sealing' || phase === 'posting';

  useEffect(() => {
    inputRef.current?.focus();
    return () => clearInterval(rollTimer.current);
  }, []);

  const valid = Number.isInteger(max) && /^\d+$/.test(value) && Number(value) >= 0 && Number(value) <= max;

  /** "Roll for me" — digits settle into place rather than snapping (UI-SPEC §4). */
  function roll() {
    if (busy || !Number.isInteger(max)) return;
    clearInterval(rollTimer.current);
    const target = rollNumber(max);
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      setValue(String(target));
      return;
    }
    setPhase('rolling');
    let ticks = 0;
    rollTimer.current = setInterval(() => {
      ticks += 1;
      if (ticks >= 12) {
        clearInterval(rollTimer.current);
        setValue(String(target));
        setPhase('idle');
      } else {
        setValue(String(rollNumber(max)));
      }
    }, 45);
  }

  async function onSubmit(e) {
    e.preventDefault();
    if (!valid || busy) return;
    setError(null);
    // Sealing is a real computation; §4 asks that it not look instant if it isn't.
    setPhase('sealing');
    try {
      // The chain is pinned by the frozen protocol.json; the endpoint it is reached
      // through comes from /api/status, because that one is not frozen (§4.2).
      const chain = { ...protocol, api: status?.drand?.api };
      const { ciphertext } = await sealSubmission(Number(value), chain, max);
      setPhase('posting');
      await api.postSubmit(ciphertext);
      onSubmitted();
    } catch (err) {
      setPhase('idle');
      setError(err.code === 'already_submitted' ? err.message : (err.message || '提交失败，请重试。'));
      if (err.code === 'already_submitted') onSubmitted();
    }
  }

  return (
    <div className="stage centre">
      <form className="card submit" onSubmit={onSubmit}>
        <p className="eyebrow">你好，{me?.title}</p>
        <h1>选一个数字</h1>

        {/*
          §8: a run can take more than one attempt. Someone who was told the last round
          was void and is now being asked for a number again needs to know why, and needs
          somewhere to check that the void was real — otherwise a restart is
          indistinguishable from the rules moving.
        */}
        {status?.attempt > 1 && (
          <p className="note">
            这是第 {status.attempt} 次开奖。上一次截止时只有 {last?.submitted_count} 位提交，
            未达到 {last?.quorum} 位的门槛，按事先定好的规则作废了。
            {' '}
            <a href={`/${last?.archive}/manifest.json`} target="_blank" rel="noreferrer">
              上一次的全部密文和参数都在这里
            </a>
            ，等那一轮的信标公布后任何人都能自己解开核对。
          </p>
        )}

        <div className={`bignum ${phase === 'rolling' ? 'rolling' : ''}`}>
          <input
            ref={inputRef}
            className="bignum-input"
            inputMode="numeric"
            autoComplete="off"
            aria-label={`0 到 ${max} 之间的整数`}
            value={value}
            disabled={busy}
            onChange={(e) => setValue(e.target.value.replace(/[^\d]/g, '').slice(0, 3))}
            placeholder="0"
          />
        </div>

        <p className="hint range">
          0 到 {max} 之间的任意整数——幸运数字、生日，都行。
        </p>

        <button type="button" className="secondary" onClick={roll} disabled={busy}>
          帮我随机选一个
        </button>

        <p className="why">
          你的数字在<strong>你的浏览器里</strong>封存，在抽签开启之前任何人都读不到——包括我们。
        </p>
        <p className="finality">提交后不能修改，也不能撤回。</p>

        <button type="submit" className="primary" disabled={!valid || busy}>
          {phase === 'sealing' ? '正在封存…' : phase === 'posting' ? '提交中…' : '封存并提交'}
        </button>

        {error && <p className="note bad">{error}</p>}
      </form>
    </div>
  );
}
