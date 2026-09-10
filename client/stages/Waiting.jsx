import { useEffect, useState } from 'react';
import { useLang, useText, formatDateTime, formatTime } from '../i18n';

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

function useTick(ms = 1000) {
  const [, force] = useState(0);
  useEffect(() => {
    const t = setInterval(() => force((n) => n + 1), ms);
    return () => clearInterval(t);
  }, [ms]);
}

function split(msLeft) {
  const s = Math.max(0, Math.floor(msLeft / 1000));
  return { d: Math.floor(s / 86400), h: Math.floor((s % 86400) / 3600), m: Math.floor((s % 3600) / 60), s: s % 60 };
}

const TEXT = {
  zh: {
    until: '距离开奖',
    drawing: '开奖中',
    countdown: '倒计时',
    d: '天', h: '时', m: '分', s: '秒',
    round: (n) => `drand 第 ${n} 轮`,
    yours: '你的数字已封存，不需要再做什么。',
    sealedOf: (n, total) => `${n} / ${total} 已封存`,
    quorumMet: '已达门槛',
    quorumShort: (n) => `还差 ${n} 位`,
    quorumMark: (n) => `门槛 ${n}`,
    whoNotWhat: ['这里只显示', '谁', '已经封存，不显示', '封存了什么', '——那些内容在开奖前谁也读不到。'],
    beacon: 'drand 信标',
    live: '运行中',
    down: '暂时联系不上',
    current: '当前轮次',
    awaiting: '等待轮次',
    lastSeen: '最近确认',
    stale: '信标暂时联系不上。这只是延迟，不是安全问题——密文和轮次都已固定，结果早已确定，信标恢复后会自动继续。',
    polling: (s) => `实时连接中断，正在每 ${s} 秒刷新一次…`,
  },
  en: {
    until: 'Until the draw',
    drawing: 'Drawing',
    countdown: 'Countdown',
    d: 'd', h: 'h', m: 'm', s: 's',
    round: (n) => `drand round ${n}`,
    yours: 'Your number is sealed. There is nothing more for you to do.',
    sealedOf: (n, total) => `${n} / ${total} sealed`,
    quorumMet: 'Quorum met',
    quorumShort: (n) => `${n} more needed`,
    quorumMark: (n) => `quorum ${n}`,
    whoNotWhat: ['This shows ', 'who', ' has sealed a number, never ', 'what they sealed', '. Nobody can read that before the draw.'],
    beacon: 'drand beacon',
    live: 'Live',
    down: 'Not reachable',
    current: 'Current round',
    awaiting: 'Waiting for round',
    lastSeen: 'Last seen',
    stale: 'The beacon is not reachable right now. That is a delay, not a safety problem: the ciphertexts and the round are already fixed, so the outcome is already determined. It resumes on its own.',
    polling: (s) => `Live connection dropped. Refreshing every ${s} seconds…`,
  },
};

export default function Waiting({ status, me, serverNow, connection }) {
  useTick(1000);
  const lang = useLang();
  const t = useText(TEXT);
  if (!status) return null;

  const left = Date.parse(status.cutoff_utc) - serverNow();
  const { d, h, m, s } = split(left);
  const elapsed = left <= 0;
  const met = status.submitted_count >= status.quorum;
  const pct = (status.submitted_count / status.total_slots) * 100;
  const quorumPct = (status.quorum / status.total_slots) * 100;
  const submitted = new Set(status.submitted_local_ids || []);
  // The real cadence, not a number typed into a sentence: it is served in the status
  // and can be changed without rebuilding this bundle.
  const pollSeconds = Math.round((status.status_poll_interval_ms || 5000) / 1000);

  return (
    <div className="stage waiting">
      <section className="countdown-block">
        <p className="eyebrow">{t.until}</p>
        {elapsed ? (
          <div className="countdown done"><span className="cd-unit"><b>{t.drawing}</b></span></div>
        ) : (
          <div className="countdown" aria-label={t.countdown}>
            {d > 0 && <span className="cd-unit"><b>{d}</b><i>{t.d}</i></span>}
            <span className="cd-unit"><b>{String(h).padStart(2, '0')}</b><i>{t.h}</i></span>
            <span className="cd-unit"><b>{String(m).padStart(2, '0')}</b><i>{t.m}</i></span>
            <span className="cd-unit"><b>{String(s).padStart(2, '0')}</b><i>{t.s}</i></span>
          </div>
        )}
        <p className="hint">
          {formatDateTime(status.cutoff_utc, lang)} · {t.round(status.target_round)}
        </p>
        {me?.submitted && <p className="note ok">{t.yours}</p>}
      </section>

      <section className="card tally">
        <div className="tally-head">
          <h2>{t.sealedOf(status.submitted_count, status.total_slots)}</h2>
          <span className={met ? 'pill ok' : 'pill warn'}>
            {met ? t.quorumMet : t.quorumShort(status.quorum - status.submitted_count)}
          </span>
        </div>

        <div className="track" role="img" aria-label={t.sealedOf(status.submitted_count, status.total_slots)}>
          <div className="track-fill" style={{ width: `${pct}%` }} />
          <div className="track-quorum" style={{ left: `${quorumPct}%` }} title={t.quorumMark(status.quorum)} />
        </div>

        {/* Who has submitted is public; what they submitted is not. §9 asks the UI to
            make that distinction obvious in words, not just by omission. */}
        <ul className="chips">
          {(status.players || []).map((p) => (
            <li key={p.local_id} className={submitted.has(p.local_id) ? 'chip sealed' : 'chip'}>
              <span className="dot" />{p.title}
            </li>
          ))}
        </ul>
        <p className="hint">
          {t.whoNotWhat[0]}<strong>{t.whoNotWhat[1]}</strong>{t.whoNotWhat[2]}
          <strong>{t.whoNotWhat[3]}</strong>{t.whoNotWhat[4]}
        </p>
      </section>

      <section className="card beacon">
        <div className="beacon-head">
          <h2>{t.beacon}</h2>
          <span className={status.drand?.healthy ? 'pill ok live' : 'pill bad'}>
            {status.drand?.healthy ? t.live : t.down}
          </span>
        </div>
        <dl className="facts">
          <dt>{t.current}</dt><dd>{status.drand?.latest_round ?? '—'}</dd>
          <dt>{t.awaiting}</dt><dd>{status.target_round}</dd>
          <dt>{t.lastSeen}</dt>
          <dd>{status.drand?.last_seen_utc ? formatTime(status.drand.last_seen_utc, lang) : '—'}</dd>
        </dl>
        {!status.drand?.healthy && <p className="note warn">{t.stale}</p>}
      </section>

      {connection === 'polling' && <p className="reconnecting">{t.polling(pollSeconds)}</p>}
    </div>
  );
}
