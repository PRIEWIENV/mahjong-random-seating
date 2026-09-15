import { useState } from 'react';
import { useLang, useText, tableName } from './i18n';
import { formatExact } from './clock';

/**
 * The final round's commitment, while it is still a commitment (PROTOCOL.md §11).
 *
 * The twelfth round's tables are earned — ranks 1-4 at table one, 5-8 at table two, 9-12
 * at table three — and only the winds are drawn. So there are two inputs, and both were
 * fixed and published BEFORE the beacon that uses them existed: the standings, and the
 * drand round. This card is where a player is asked to check that, and the moment to do
 * it is now rather than afterwards.
 *
 * Which is why it is a sibling of RollCard rather than part of the result. Both exist for
 * the same reason and both make the same ask: here is a short string, compare it with the
 * other eleven people while nobody can yet know what it will open. A digest agreed on by
 * twelve people before the beacon is evidence; the same digest read out afterwards is
 * just a number the organiser is telling you.
 *
 * The tables are shown before the draw too, and that is the point, not an oversight. They
 * were decided by the round-robin, not by the beacon. What nobody knows yet is who sits
 * East.
 */

const TEXT = {
  zh: {
    titleLocked: '决赛轮：桌次已定，风位未抽',
    titleDrawn: '决赛轮的封存记录',
    ledeLocked: '前十一轮的名次已经封存，决定风位的那一轮 drand 信标也已经指定——都在那一轮信标产生之前。',
    ledeDrawn: '决赛轮的桌次与风位所依据的封存记录：',
    ask: '把这串指纹发到群里，和别人核对一遍。',
    why: '此刻还没有人知道这一轮信标的签名，所以现在公布名次和轮次，等于承诺了桌次就是这样排的，而承诺的时候谁也不知道换个排法会抽出什么风位。',
    whyDrawn: '上面这串指纹对应的文件，记录了抽签所用的名次与信标轮次。它在信标产生之前就已公开并盖了时间戳，任何人都能重新算一遍。',
    lockDigest: 'lock.json 指纹',
    beacon: '决定风位的信标',
    beaconAt: '预计产生于',
    tables: '桌次（由前十一轮名次决定）',
    anchored: '这份文件已写进比特币区块链做了时间戳存证，证明它在那一轮信标产生之前就已存在。',
    notAnchored: '外部时间戳存证这次没能完成。指纹本身仍然有效，所以和别人核对这一步这次格外重要。',
    copy: '复制',
    copied: '已复制',
    lockFile: '封存记录',
    otsFile: '时间戳存证',
    finalFile: '决赛轮结果',
    waiting: '信标产生之后，风位才会抽出。',
  },
  en: {
    titleLocked: 'The final round: tables set, winds not yet drawn',
    titleDrawn: 'The final round’s locked inputs',
    ledeLocked: 'The standings after eleven rounds are sealed, and so is the drand round that will draw the winds — both of them before that beacon exists.',
    ledeDrawn: 'The record the final round’s tables and winds were drawn from:',
    ask: 'Send this fingerprint to the group and compare it with everyone else.',
    why: 'Nobody can know that beacon’s signature yet, so publishing the standings and the round now commits the tables to exactly this — while nobody knows what a different arrangement would have drawn.',
    whyDrawn: 'The file behind this fingerprint holds the standings and the beacon round the draw used. It was published and timestamped before that beacon existed, so anyone can recompute the result from it.',
    lockDigest: 'lock.json fingerprint',
    beacon: 'The beacon that draws the winds',
    beaconAt: 'due',
    tables: 'Tables (set by the eleven-round standings)',
    anchored: 'This file is timestamped into the Bitcoin blockchain, which shows it existed before that beacon did.',
    notAnchored: 'The external timestamp did not complete this time. The fingerprint still stands, which makes comparing it with each other matter more than usual here.',
    copy: 'Copy',
    copied: 'Copied',
    lockFile: 'the locked record',
    otsFile: 'its timestamp proof',
    finalFile: 'the final round',
    waiting: 'The winds are drawn once that beacon lands.',
  },
};

/** The three tables, as rank blocks: 1-4, 5-8, 9-12. */
function tablesOf(standings, size = 4) {
  const out = [];
  for (let i = 0; i < standings.length; i += size) {
    out.push({ table: out.length + 1, ranks: standings.slice(i, i + size) });
  }
  return out;
}

export default function FinalCard({ final, result, players }) {
  const lang = useLang();
  const t = useText(TEXT);
  const [copied, setCopied] = useState(false);
  if (!final || final.state === 'none') return null;

  const drawn = final.state === 'drawn';
  const titleOf = new Map((players || []).map((p) => [p.local_id, p.title]));
  const due = final.target_round_utc ? formatExact(final.target_round_utc, lang) : null;

  const copy = () => {
    navigator.clipboard?.writeText(final.lock_sha256 || '').then(
      () => { setCopied(true); setTimeout(() => setCopied(false), 1500); },
      () => {}
    );
  };

  return (
    <section className={`card roll-card final-card ${drawn ? 'drawn' : 'locked'}`}>
      <h2>{drawn ? t.titleDrawn : t.titleLocked}</h2>
      <p className="lede">{drawn ? t.ledeDrawn : t.ledeLocked}</p>

      <p className="fineprint">{t.lockDigest}</p>
      <div className="roll-digest">
        <code>{final.lock_sha256}</code>
        <button
          className={`copy-btn ${copied ? "done" : ""}`}
          onClick={copy}
          aria-label={copied ? t.copied : t.copy}
          title={copied ? t.copied : t.copy}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            {copied
              ? <path d="M5 12.5l4.5 4.5L19 7.5" />
              : <><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V5a2 2 0 012-2h10" /></>}
          </svg>
        </button>
      </div>
      {!drawn && <p className="roll-ask">{t.ask}</p>}
      <p className="note">{drawn ? t.whyDrawn : t.why}</p>

      <p className="final-beacon">
        <span className="fineprint">{t.beacon}</span>
        <code>drand #{final.target_round}</code>
        {due && <span className="dim">{t.beaconAt} {due.local} ({due.offset})</span>}
      </p>

      {final.standings && (
        <>
          <h3>{t.tables}</h3>
          <ul className="final-tables">
            {tablesOf(final.standings).map((tb) => (
              <li key={tb.table}>
                <span className={`tbl t${tb.table}`}>{tableName(lang, tb.table)}</span>
                <span className="names">
                  {tb.ranks.map((id, i) => (
                    <span key={id} className="ranked">
                      <i>{tb.ranks.length * (tb.table - 1) + i + 1}</i>
                      {titleOf.get(id) || `#${id}`}
                    </span>
                  ))}
                </span>
              </li>
            ))}
          </ul>
          {!drawn && <p className="note dim">{t.waiting}</p>}
        </>
      )}

      <p className={`note ${final.anchored ? 'ok' : 'warn'}`}>
        {final.anchored ? t.anchored : t.notAnchored}
      </p>

      <p className="roll-files">
        <a href="/final-lock.json" download>{t.lockFile}</a>
        {final.anchored && <a href="/final-lock.json.ots" download>{t.otsFile}</a>}
        {drawn && result?.final && <a href="/final.json" download>{t.finalFile}</a>}
      </p>
    </section>
  );
}
