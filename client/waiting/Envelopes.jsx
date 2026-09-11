import { useState } from 'react';
import { useLang, useText, formatTime } from '../i18n';

/**
 * Twelve envelopes, and what is provably in front of them (UI-SPEC §5, PROTOCOL.md §9).
 *
 * The tally used to be a count and a row of name chips: "9 / 12 sealed". True, and
 * entirely dependent on our word for it. This shows, per player, the SHA-256 of the
 * ciphertext we are holding — a fingerprint of a value that is already public, mirrored
 * to the repository as it arrived, and folded into the published roll. A player can see
 * their own envelope land, keep its fingerprint, and check afterwards that the thing
 * that got opened is the thing they sent.
 *
 * It still shows WHO, never WHAT. A digest of a tlock ciphertext discloses nothing
 * about the number inside it; only the beacon opens that, and the beacon does not exist
 * yet. §9's line is not blurred here, it is simply not the line people assumed: the
 * ciphertexts were always public, and hiding their digests protected nobody while
 * leaving players with nothing to verify.
 *
 * After the cutoff an empty slot stops being "not yet" and becomes "never". The two
 * look identical in a chip list and mean opposite things, so the cards say so.
 */

const SHORT = 10;

const TEXT = {
  zh: {
    title: '十二个信封',
    sealedOf: (n, total) => `${n} / ${total} 已封存`,
    quorumMet: '已达门槛',
    quorumShort: (n) => `还差 ${n} 位`,
    quorumMark: (n) => `门槛 ${n}`,
    you: '你',
    waiting: '等待提交',
    missed: '未提交',
    sealedAt: (time) => `${time} 送达`,
    digestHint: '密文指纹（点一下展开）',
    digestHintOpen: '密文指纹（点一下收起）',
    lede: '每个信封上是我们收到的那份密文的 SHA-256。这是信封外面的编号，不是里面的数字——里面的数字要等信标才能打开，谁也不例外。',
    ledeClosed: '提交已截止。下面是最终封存的十二个位置。',
  },
  en: {
    title: 'Twelve envelopes',
    sealedOf: (n, total) => `${n} / ${total} sealed`,
    quorumMet: 'Quorum met',
    quorumShort: (n) => `${n} more needed`,
    quorumMark: (n) => `quorum ${n}`,
    you: 'you',
    waiting: 'Not yet',
    missed: 'Never sealed',
    sealedAt: (time) => `arrived ${time}`,
    digestHint: 'ciphertext fingerprint (click to expand)',
    digestHintOpen: 'ciphertext fingerprint (click to close)',
    lede: 'Each envelope carries the SHA-256 of the ciphertext we hold. That is the number written on the outside, not the one inside: the one inside waits for the beacon, and so does everybody, us included.',
    ledeClosed: 'Submissions are closed. These are the twelve slots as they were sealed.',
  },
};

/**
 * Click to open the full fingerprint, click again to close, and the pointer does nothing.
 *
 * It used to close on mouseleave, and a stylesheet rule used to widen the box on hover.
 * Between them a player got a box that grew on hover without gaining a single character —
 * the extra characters come from `open`, which only a click sets — and then lost the one
 * they had deliberately opened as soon as the cursor drifted a pixel off the tile, with
 * no chance to select the text. One gesture, one disclosure, and it stays until dismissed.
 */
function Envelope({ player, digest, receivedAt, mine, closed, t, lang }) {
  const [open, setOpen] = useState(false);
  const state = digest ? 'sealed' : closed ? 'missed' : 'waiting';
  const cls = ['env-tile', state, mine ? 'mine' : '', open ? 'open' : ''].filter(Boolean).join(' ');

  const toggle = () => digest && setOpen((v) => !v);
  // Click is now the only way in, so it has to be reachable without a mouse. The digest
  // itself is already on the code element's aria-label, so this is for the sighted
  // keyboard user, who had nothing at all before.
  const onKeyDown = (e) => {
    if (!digest || (e.key !== 'Enter' && e.key !== ' ')) return;
    e.preventDefault();
    setOpen((v) => !v);
  };
  const hint = open ? t.digestHintOpen : t.digestHint;

  return (
    <li
      className={cls}
      onClick={toggle}
      onKeyDown={onKeyDown}
      tabIndex={digest ? 0 : undefined}
      aria-expanded={digest ? open : undefined}
    >
      <div className="env-top">
        <span className="env-seal" aria-hidden="true" />
        <span className="env-who">{player.title}</span>
        {mine && <span className="env-you">{t.you}</span>}
      </div>
      {digest ? (
        <>
          <code
            className="env-digest"
            title={`${hint}: ${digest}`}
            aria-label={`${hint}: ${digest}`}
          >
            {open ? digest : digest.slice(0, SHORT)}
          </code>
          <span className="env-when">{t.sealedAt(formatTime(receivedAt, lang))}</span>
        </>
      ) : (
        <span className="env-empty">{closed ? t.missed : t.waiting}</span>
      )}
    </li>
  );
}

/**
 * @param {object}  o
 * @param {object}  o.status  /api/status
 * @param {object}  o.me      /api/me, or null
 * @param {boolean} o.closed  the cutoff has passed
 */
export default function Envelopes({ status, me, closed }) {
  const lang = useLang();
  const t = useText(TEXT);

  const byId = new Map((status.submissions || []).map((s) => [s.local_id, s]));
  const met = status.submitted_count >= status.quorum;
  const filled = (status.submitted_count / status.total_slots) * 100;
  const quorumPct = (status.quorum / status.total_slots) * 100;

  return (
    <section className={closed ? 'card tally closed' : 'card tally'}>
      <div className="tally-head">
        <h2>{t.sealedOf(status.submitted_count, status.total_slots)}</h2>
        <span className={met ? 'pill ok' : 'pill warn'}>
          {met ? t.quorumMet : t.quorumShort(status.quorum - status.submitted_count)}
        </span>
      </div>

      {/* Below quorum the bar is amber, not green: the draw would be void if the cutoff
          arrived now, and a green bar saying so is a bar that reads as fine. */}
      <div className="track" role="img" aria-label={t.sealedOf(status.submitted_count, status.total_slots)}>
        <div className={met ? 'track-fill' : 'track-fill short'} style={{ width: `${filled}%` }} />
        <div className="track-quorum" style={{ left: `${quorumPct}%` }} title={t.quorumMark(status.quorum)} />
      </div>

      <p className="hint">{closed ? t.ledeClosed : t.lede}</p>

      <ul className="env-grid">
        {(status.players || []).map((p) => {
          const s = byId.get(p.local_id);
          return (
            <Envelope
              key={p.local_id}
              player={p}
              digest={s?.digest || null}
              receivedAt={s?.received_at}
              mine={me?.local_id === p.local_id}
              closed={closed}
              t={t}
              lang={lang}
            />
          );
        })}
      </ul>
    </section>
  );
}
