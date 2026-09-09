import { useEffect, useState } from 'react';

/**
 * The waiting stage (UI-SPEC.md §5).
 *
 * The stage most players will actually sit on, possibly for days, so everything here
 * is real observed state: the actual drand round, the real count, a countdown driven
 * by server time. §1's "honest waiting" — no invented progress, and if the beacon goes
 * stale we say so rather than hiding it.
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

export default function Waiting({ status, me, serverNow, connection }) {
  useTick(1000);
  if (!status) return null;

  const left = Date.parse(status.cutoff_utc) - serverNow();
  const { d, h, m, s } = split(left);
  const elapsed = left <= 0;
  const met = status.submitted_count >= status.quorum;
  const pct = (status.submitted_count / status.total_slots) * 100;
  const quorumPct = (status.quorum / status.total_slots) * 100;
  const submitted = new Set(status.submitted_local_ids || []);

  return (
    <div className="stage waiting">
      <section className="countdown-block">
        <p className="eyebrow">距离开奖</p>
        {elapsed ? (
          <div className="countdown done"><span className="cd-unit"><b>开奖中</b></span></div>
        ) : (
          <div className="countdown" aria-label="倒计时">
            {d > 0 && <span className="cd-unit"><b>{d}</b><i>天</i></span>}
            <span className="cd-unit"><b>{String(h).padStart(2, '0')}</b><i>时</i></span>
            <span className="cd-unit"><b>{String(m).padStart(2, '0')}</b><i>分</i></span>
            <span className="cd-unit"><b>{String(s).padStart(2, '0')}</b><i>秒</i></span>
          </div>
        )}
        <p className="hint">
          {new Date(status.cutoff_utc).toLocaleString()} · drand 第 {status.target_round} 轮
        </p>
        {me?.submitted && <p className="note ok">你的数字已封存，不需要再做什么。</p>}
      </section>

      <section className="card tally">
        <div className="tally-head">
          <h2>{status.submitted_count} / {status.total_slots} 已封存</h2>
          <span className={met ? 'pill ok' : 'pill warn'}>
            {met ? '已达门槛' : `还差 ${status.quorum - status.submitted_count} 位`}
          </span>
        </div>

        <div className="track" role="img" aria-label={`${status.submitted_count} of ${status.total_slots} sealed, quorum ${status.quorum}`}>
          <div className="track-fill" style={{ width: `${pct}%` }} />
          <div className="track-quorum" style={{ left: `${quorumPct}%` }} title={`门槛 ${status.quorum}`} />
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
          这里只显示<strong>谁</strong>已经封存，不显示<strong>封存了什么</strong>——那些内容在开奖前谁也读不到。
        </p>
      </section>

      <section className="card beacon">
        <div className="beacon-head">
          <h2>drand 信标</h2>
          <span className={status.drand?.healthy ? 'pill ok live' : 'pill bad'}>
            {status.drand?.healthy ? '运行中' : '暂时联系不上'}
          </span>
        </div>
        <dl className="facts">
          <dt>当前轮次</dt><dd>{status.drand?.latest_round ?? '—'}</dd>
          <dt>等待轮次</dt><dd>{status.target_round}</dd>
          <dt>最近确认</dt><dd>{status.drand?.last_seen_utc ? new Date(status.drand.last_seen_utc).toLocaleTimeString() : '—'}</dd>
        </dl>
        {!status.drand?.healthy && (
          <p className="note warn">
            信标暂时联系不上。这只是延迟，不是安全问题——密文和轮次都已固定，结果早已确定，
            信标恢复后会自动继续。
          </p>
        )}
      </section>

      {connection === 'polling' && (
        <p className="reconnecting">实时连接中断，正在每 15 秒刷新一次…</p>
      )}
    </div>
  );
}
