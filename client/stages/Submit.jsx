import { useEffect, useRef, useState } from 'react';
import * as api from '../api';
import { sealSubmission, rollNumber } from '../seal';
import { useLang, useText } from '../i18n';
import { useTick, split, formatExact } from '../clock';

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

const TEXT = {
  zh: {
    greeting: (name) => `你好，${name}`,
    title: '选一个数字',
    deadline: '抽签截止',
    drawAt: '开奖',
    countdownLabel: '距离截止还有',
    closingSoon: '快要截止了',
    // Digits and their units separately, so the digits can be set large and the units
    // small. One string would have to be sized as a whole, and a countdown whose "小时"
    // is as tall as its "12" reads as a sentence rather than as a clock.
    countdown: (d, h, m, s) => (d > 0
      ? [[d, '天'], [h, '小时'], [m, '分']]
      : h > 0 ? [[h, '小时'], [m, '分'], [s, '秒']]
        : [[m, '分'], [s, '秒']]),
    roundIs: (n) => `drand 第 ${n.toLocaleString()} 轮`,
    retry: (n, had, quorum) =>
      `这是第 ${n} 次开奖。上一次截止时只有 ${had} 位提交，未达到 ${quorum} 位的门槛，按事先定好的规则作废了。`,
    retryLink: '上一次的全部密文和参数都在这里',
    retryTail: '，等那一轮的信标公布后任何人都能自己解开核对。',
    range: (max) => `0 到 ${max} 之间的任意整数——幸运数字、生日，都行。`,
    inputLabel: (max) => `0 到 ${max} 之间的整数`,
    roll: '帮我随机选一个',
    why: '你的数字在你的浏览器里封存，在抽签开启之前任何人都读不到。',
    whyStrong: '你的浏览器里',
    finality: '提交后不能修改，也不能撤回。',
    sealing: '正在封存…',
    posting: '提交中…',
    submit: '封存并提交',
    failed: '提交失败，请重试。',
  },
  en: {
    greeting: (name) => `Hello, ${name}`,
    title: 'Pick a number',
    deadline: 'Entries close',
    drawAt: 'Drawn at',
    countdownLabel: 'Time left',
    closingSoon: 'Closing soon',
    countdown: (d, h, m, s) => (d > 0
      ? [[d, 'd'], [h, 'h'], [m, 'm']]
      : h > 0 ? [[h, 'h'], [m, 'm'], [s, 's']]
        : [[m, 'm'], [s, 's']]),
    roundIs: (n) => `drand round ${n.toLocaleString()}`,
    retry: (n, had, quorum) =>
      `This is draw attempt ${n}. Last time only ${had} numbers were sealed by the cutoff, short of the ${quorum} required, so that round was voided under the rule set before it started.`,
    retryLink: 'Every ciphertext and parameter from that attempt is here',
    retryTail: ', and once that round’s beacon is out anyone can open them and check.',
    range: (max) => `Any whole number from 0 to ${max}. A lucky number, a birthday, anything.`,
    inputLabel: (max) => `A whole number between 0 and ${max}`,
    roll: 'Pick one for me',
    why: 'Your number is sealed in your own browser. Nobody can read it before the draw opens.',
    whyStrong: 'in your own browser',
    finality: 'Once submitted it cannot be changed or withdrawn.',
    sealing: 'Sealing…',
    posting: 'Submitting…',
    submit: 'Seal and submit',
    failed: 'Submission failed. Please try again.',
  },
};

export default function Submit({ protocol, status, me, serverNow, onSubmitted }) {
  const t = useText(TEXT);
  const lang = useLang();
  useTick(1000);
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

  // The band sits above the number field, and the time remaining is its largest element:
  // a deadline expressed as a wall-clock instant asks the reader to do the subtraction,
  // and the answer to "how long have I got" is the one thing on this screen a player
  // acts on immediately. The instants stay, both of them, because they are different
  // instants — entries close, and reveal_gap_seconds later the beacon that opens them
  // exists (PROTOCOL.md §9) — but they are reference, not the headline.
  //
  // §4's single focal element is still the input: the countdown is deliberately set a
  // size below it, so the two never read as competing for the same job.
  //
  // The UTC restatement that used to close the band is gone. Every instant here is
  // already stamped with its own offset, so it was a second way of saying the same thing
  // to a reader who had not asked, on the one screen that should hold nothing spare.
  const now = typeof serverNow === 'function' ? serverNow() : Date.now();
  const cutoffMs = Date.parse(status?.cutoff_utc);
  const msLeft = Number.isFinite(cutoffMs) ? cutoffMs - now : null;
  const cd = split(msLeft ?? 0);
  const urgent = msLeft != null && msLeft < 30 * 60_000;
  const cutoffExact = status?.cutoff_utc ? formatExact(status.cutoff_utc, lang) : null;
  const drawExact = status?.target_round_utc ? formatExact(status.target_round_utc, lang) : null;

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
      setError(err.code === 'already_submitted' ? err.message : (err.message || t.failed));
      if (err.code === 'already_submitted') onSubmitted();
    }
  }

  const [whyBefore, whyAfter] = t.why.split(t.whyStrong);

  return (
    <div className="stage centre">
      <form className="card submit" onSubmit={onSubmit}>
        {cutoffExact && (
          <div className={urgent ? 'deadline-band urgent' : 'deadline-band'}>
            {msLeft != null && msLeft > 0 && (
              <div className="dl-countdown">
                <span className="dl-cd-label">{urgent ? t.closingSoon : t.countdownLabel}</span>
                <span className="dl-clock">
                  {t.countdown(cd.d, cd.h, cd.m, cd.s).map(([n, unit]) => (
                    <span className="cd-seg" key={unit}><b>{n}</b><i>{unit}</i></span>
                  ))}
                </span>
              </div>
            )}
            <div className="dl-times">
              <div className="dl-row">
                <span className="dl-name">{t.deadline}</span>
                <span className="dl-when">
                  {cutoffExact.local} <em>{cutoffExact.offset}</em>
                </span>
              </div>
              {drawExact && (
                <div className="dl-row quiet">
                  <span className="dl-name">{t.drawAt}</span>
                  <span className="dl-when">
                    {drawExact.local} <em>{drawExact.offset}</em>
                  </span>
                </div>
              )}
            </div>
            {drawExact && <p className="dl-round">{t.roundIs(status.target_round)}</p>}
          </div>
        )}

        {/*
          §8: a run can take more than one attempt. Someone who was told the last round
          was void and is now being asked for a number again needs to know why, and needs
          somewhere to check that the void was real — otherwise a restart is
          indistinguishable from the rules moving.

          Only ever about a VOID, and only about one this run actually had. The server
          scopes previous_rounds to the open run for that reason; the check here is the
          second lock on the same door, because the sentence accuses the previous round
          of falling short and there is no worse thing to say about a draw that didn't.
        */}
        {status?.attempt > 1 && last?.status === 'void' && (
          <p className="note retry">
            {t.retry(status.attempt, last.submitted_count, last.quorum)}
            {' '}
            <a href={`/${last.archive}/manifest.json`} target="_blank" rel="noreferrer">{t.retryLink}</a>
            {t.retryTail}
          </p>
        )}

        <p className="eyebrow">{t.greeting(me?.title || '')}</p>
        <h1>{t.title}</h1>

        <div className={`bignum ${phase === 'rolling' ? 'rolling' : ''}`}>
          <input
            ref={inputRef}
            className="bignum-input"
            inputMode="numeric"
            autoComplete="off"
            aria-label={t.inputLabel(max)}
            value={value}
            disabled={busy}
            onChange={(e) => setValue(e.target.value.replace(/[^\d]/g, '').slice(0, 3))}
            placeholder="0"
          />
        </div>

        <p className="hint range">{t.range(max)}</p>

        <button type="button" className="secondary" onClick={roll} disabled={busy}>
          {t.roll}
        </button>

        <p className="why">{whyBefore}<strong>{t.whyStrong}</strong>{whyAfter}</p>
        <p className="finality">{t.finality}</p>

        <button type="submit" className="primary" disabled={!valid || busy}>
          {phase === 'sealing' ? t.sealing : phase === 'posting' ? t.posting : t.submit}
        </button>

        {error && <p className="note bad">{error}</p>}
      </form>
    </div>
  );
}
