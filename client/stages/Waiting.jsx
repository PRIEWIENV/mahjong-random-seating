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
    rollTitle: '名单已封存，开奖尚未开始',
    rollLede: (n) => `截止时收到 ${n} 份密文。下面是这份名单的指纹：`,
    rollAsk: '把它发到群里，和别人核对一遍。' ,
    rollWhy: '现在还没有人能解开任何一份密文——解密要等的那一轮信标尚未产生。所以此刻公布名单，等于承诺了参与者就是这些人，而且承诺时谁也不知道换个人会带来什么结果。十二个人看到的指纹必须一样。',
    rollCopy: '复制',
    rollCopied: '已复制',
    rollFile: '下载名单',
    rollProof: '下载时间戳证明',
    rollAnchored: (n) => `已由 ${n} 个独立日历服务器做了区块链时间戳存证。`,
    rollNotAnchored: '外部时间戳存证这次没能完成，指纹本身仍然有效——但请务必和别人核对。',
    rollHow: '验证方法：ots verify snapshot.json.ots，或用任意工具算 snapshot.json 的 sha256。',
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
    rollTitle: 'The roll is closed; the draw has not happened',
    rollLede: (n) => `${n} ciphertexts were held at the cutoff. This is the fingerprint of that list:`,
    rollAsk: 'Post it to the group chat and check it against everybody else.',
    rollWhy: 'Nobody can open any of those ciphertexts yet: the beacon that unlocks them has not been produced. So publishing the list now commits to who took part, at a moment when nobody knows what swapping someone would do to the outcome. All twelve of you should see the same fingerprint.',
    rollCopy: 'Copy',
    rollCopied: 'Copied',
    rollFile: 'Download the roll',
    rollProof: 'Download the timestamp proof',
    rollAnchored: (n) => `Timestamped into Bitcoin by ${n} independent calendars.`,
    rollNotAnchored: 'The external timestamp did not go through this time. The fingerprint still holds, so comparing it with others matters more than usual.',
    rollHow: 'To check: ots verify snapshot.json.ots, or take the sha256 of snapshot.json with any tool you like.',
  },
};

/**
 * The one thing a player is asked to do that is not submitting: look at a short
 * string and check it against everybody else's.
 *
 * An OpenTimestamps anchor proves the roll existed before a Bitcoin block, which is
 * what a forged late submission cannot satisfy. It does not prove it was the only
 * roll anchored — anchoring is cheap. Twelve people agreeing on one value does.
 */
function RollCard({ roll, t }) {
  const [copied, setCopied] = useState(false);
  const short = (roll.digest || '').slice(0, 16);
  const copy = () => {
    navigator.clipboard?.writeText(roll.digest).then(
      () => { setCopied(true); setTimeout(() => setCopied(false), 2000); },
      () => {}
    );
  };
  return (
    <section className="card roll-card">
      <h2>{t.rollTitle}</h2>
      <p className="lede">{t.rollLede(roll.submitted_count)}</p>
      <p className="roll-digest">
        <code title={roll.digest}>{short}</code>
        <button className="linkish" onClick={copy}>{copied ? t.rollCopied : t.rollCopy}</button>
      </p>
      <p className="roll-ask">{t.rollAsk}</p>
      <p className="hint">{t.rollWhy}</p>
      <p className={roll.anchored ? 'note ok' : 'note warn'}>
        {roll.anchored ? t.rollAnchored(roll.calendars.length) : t.rollNotAnchored}
      </p>
      <p className="roll-files">
        <a href="/snapshot.json" download>{t.rollFile}</a>
        {roll.anchored && <a href="/snapshot.json.ots" download>{t.rollProof}</a>}
      </p>
      <p className="fineprint">{t.rollHow}</p>
    </section>
  );
}

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
  // Shown only while it means something: after the roll is taken and before the
  // beacon that opens the ciphertexts exists (PROTOCOL.md §9). Once the draw has
  // happened the fingerprint is still true but no longer a commitment to anything,
  // and the result page is where people should be looking.
  const roll = elapsed && status.phase === 'awaiting_round' ? status.roll : null;

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

      {roll && <RollCard roll={roll} t={t} />}

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
