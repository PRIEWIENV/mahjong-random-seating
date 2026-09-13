'use strict';

/**
 * The organiser's dashboard (RUNBOOK sections C and D).
 *
 * PANTHEON-INTEGRATION.md §4 says a failed sync should be "surfaced in the admin view".
 * There was no admin view. More to the point, RUNBOOK step 13 says to chase whoever has
 * not sealed a number as the cutoff approaches, and step 14 and 15 say to confirm the
 * job ran and the sync took — three operational duties with nothing to perform them on
 * but `curl` and a SQLite file.
 *
 * Two decisions shape what this is:
 *
 * **Read-only.** §9 has it that nothing an outsider can poke may trigger, retry or
 * re-time the draw, and the finalisation job is deliberately not an HTTP endpoint. A
 * button here that ran the draw would undo that in one line. Every action an organiser
 * genuinely needs is a command with its own refusals (tools/new-round.js), run on the
 * box by someone who is already there.
 *
 * **Server-rendered, and not part of the frozen bundle.** public/app.js is hash-pinned
 * and committed as part of the freeze, because it is the code that handles a player's
 * plaintext number. Nothing here touches a plaintext number, and folding it into that
 * bundle would change the frozen hash for a reason that has nothing to do with the
 * draw. So this is one string of HTML with no build step and no dependency.
 *
 * It shows who has submitted and when. It never shows what — the same rule as
 * everywhere else, and the easiest place to break it by accident.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { readIndex } = require('./rounds');
const { freyPublicUrl, freyPublicUrlIsLocal } = require('./runtime');
const { KEY_TICK } = require('./finalise');

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function digestOf(file) {
  try {
    return sha256(fs.readFileSync(file));
  } catch {
    return null;
  }
}

/** The committed bundle digest covers app.js and app.css together, in that order. */
function bundleDigest(publicDir) {
  const js = path.join(publicDir, 'app.js');
  const css = path.join(publicDir, 'app.css');
  if (!fs.existsSync(js)) return null;
  return sha256(Buffer.concat([
    fs.readFileSync(js),
    fs.existsSync(css) ? fs.readFileSync(css) : Buffer.alloc(0),
  ]));
}

/**
 * Everything the page shows, as plain data.
 *
 * Separated from the rendering so it can be asserted on directly, and so the same
 * model can be served as JSON to anyone who would rather script against it.
 */
function collect(ctx) {
  const { cfg, store, status, syncOutcome, isStub, mirror, publicDir, now } = ctx;
  // Passed in rather than read from the environment here, so the two states that matter
  // most — stub-in-production, mirror-off-in-production — can be asserted on directly
  // instead of only ever being exercised in the one configuration a laptop happens to be in.
  const production = ctx.production ?? process.env.NODE_ENV === 'production';
  // How THIS request arrived, from the proxy's X-Forwarded-Proto (server.js overTls).
  // The row below used to be `!production` dressed up as a TLS check, which meant a
  // production server with no certificate in front reported "session cookies are marked
  // Secure" in green while no browser could keep one and nobody could sign in.
  const overTls = ctx.overTls === true;

  const committedBundle = (() => {
    try {
      return fs.readFileSync(path.join(publicDir, 'app.js.sha256'), 'utf8').trim().split(/\s+/)[0];
    } catch {
      return null;
    }
  })();
  const actualBundle = bundleDigest(publicDir);

  const submittedAt = new Map(store.listSubmissions().map((r) => [r.local_id, r.received_at]));
  const roster = cfg.roster.players.map((p) => ({
    local_id: p.local_id,
    title: p.title,
    submitted: submittedAt.has(p.local_id),
    // WHEN, never what. The plaintext does not exist on this machine before the target
    // round, and must not appear here after it either.
    received_at: submittedAt.get(p.local_id) || null,
  }));

  // Tri-state on purpose. A boolean forces every not-quite-right state into either a
  // green tick or an alarm, and the two that matter most here are neither: running
  // against the stub is correct on a laptop and catastrophic in production. A row whose
  // label says "ok" while its own detail says STUB is worse than no row at all.
  const checks = [];
  const check = (level, label, detail) => checks.push({ ok: level === 'ok', level, label, detail });

  check(
    actualBundle !== null && actualBundle === committedBundle ? 'ok' : 'fail',
    'The served bundle matches its committed hash',
    actualBundle === committedBundle ? actualBundle : `committed ${committedBundle}, serving ${actualBundle}`
  );
  check(
    !isStub ? 'ok' : production ? 'fail' : 'warn',
    isStub ? 'Pantheon adapter is the STUB' : 'Pantheon adapter is the real Twirp client',
    isStub
      ? 'sign-in is a fake and authorises anyone the stub knows — fine locally, never in production'
      : `frey ${cfg.runtime.pantheon.frey_base_url}, mimir ${cfg.runtime.pantheon.mimir_base_url}`
  );
  // The one Pantheon URL the browser uses itself, so the one that can be right here and
  // useless there. It fails as "wrong email or password" on the player's screen, which
  // is why it earns a row of its own rather than living inside the line above.
  if (!isStub) {
    const browserFrey = freyPublicUrl(cfg.runtime);
    const localFrey = freyPublicUrlIsLocal(cfg.runtime);
    check(
      localFrey ? (production ? 'fail' : 'warn') : 'ok',
      'The Frey URL given to browsers',
      localFrey
        ? `${browserFrey} is this machine, not the player's — set pantheon.frey_public_url`
        : `${browserFrey} (also needs to be in the proxy CSP connect-src)`
    );
  }

  const devAuthLive = isStub && !production;
  check(
    devAuthLive ? 'warn' : 'ok',
    devAuthLive ? 'The dev sign-in stand-in is LIVE' : 'The dev sign-in stand-in is unreachable',
    devAuthLive
      ? 'POST /api/dev-authorize hands out tokens; it returns 404 once NODE_ENV=production'
      : 'POST /api/dev-authorize returns 404'
  );
  check(
    mirror?.enabled ? 'ok' : 'fail',
    'Mirroring to the repository',
    mirror?.enabled
      ? `${mirror.repo || process.env.MIRROR_REPO} (${mirror.branch || process.env.MIRROR_BRANCH || 'main'})`
      : 'DISABLED — nobody but this server is timestamping the ciphertexts, and that ' +
        'third party is what the fairness argument leans on',
  );
  check(
    cfg.roster.players.length === cfg.protocol.total_slots ? 'ok' : 'fail',
    'Roster size matches the frozen total_slots',
    `${cfg.roster.players.length} of ${cfg.protocol.total_slots}`
  );
  check(
    // §8 calls a late beacon a delay rather than a failure: the snapshot is frozen at
    // the cutoff, so the outcome is already determined. It only becomes urgent after.
    status.drand?.healthy ? 'ok' : cfg.protocol.cutoff_ms < now ? 'fail' : 'warn',
    'drand is reachable',
    status.drand?.healthy
      ? `latest round ${status.drand.latest_round}, seen ${status.drand.last_seen_utc}`
      : 'no answer from the configured mirrors'
  );
  check(
    cfg.protocol.chain_public_key ? 'ok' : 'fail',
    'The drand chain is pinned by hash AND public key',
    cfg.protocol.chain_hash
  );
  // The failure this page exists to catch. Serving the page and drawing are two
  // programs; if only the first was ever started, everything else here stays green,
  // the players' countdown reaches zero, and nothing happens. Reading the job's own
  // heartbeat is what separates that from a late beacon, which looks identical from
  // here and needs the opposite response — wait, rather than go and start something.
  const tick = store.get(KEY_TICK);
  const interval = cfg.runtime.server.finalise_interval_seconds;
  const sinceTick = tick ? now - Date.parse(tick.at) : null;
  const overdue = Boolean(status.draw?.overdue);
  check(
    tick === undefined || tick === null
      ? (overdue ? 'fail' : 'warn')
      : sinceTick > interval * 2000 ? (overdue ? 'fail' : 'warn') : 'ok',
    'The draw job has run',
    tick
      ? `server/finalise.js last ran ${tick.at} (${duration(sinceTick)} ago), expected every ${interval}s` +
        (cfg.runtime.server.run_finalise ? ', run by this server' : ', run by something outside this server')
      : 'server/finalise.js has NEVER run against this database. ' +
        (cfg.runtime.server.run_finalise
          ? 'This server is supposed to be running it — check the server log for [schedule] lines'
          : 'server.run_finalise is off in data/runtime.json, so something else has to run it, ' +
            'and nothing has. Set it back to true, or run: node server/finalise.js')
  );
  if (!production) {
    check('warn', 'This page is being served without TLS',
      'the roster and the submission timeline are going over the wire in the clear; NODE_ENV is not production');
  } else if (overTls) {
    check('ok', 'Session cookies are marked Secure, and this request came over TLS',
      'NODE_ENV=production; the proxy reports X-Forwarded-Proto: https');
  } else {
    check('fail', 'Session cookies are marked Secure, but this request came over plain http',
      'No browser will keep the cookie, so nobody can sign in — the server refuses sign-in ' +
      'over http rather than issue one. Put TLS in front (deploy/README.md §7); if it is ' +
      'there already, it is not sending X-Forwarded-Proto.');
  }

  const artefacts = {
    'data/protocol.json': digestOf(path.join(cfg.dataDir, 'protocol.json')),
    'data/roster.json': digestOf(path.join(cfg.dataDir, 'roster.json')),
    'data/schedule_template.json': digestOf(path.join(cfg.dataDir, 'schedule_template.json')),
    'generate.js': digestOf(path.join(cfg.root, 'generate.js')),
    'public/app.js + app.css': actualBundle,
  };

  const resultsFile = path.join(cfg.root, 'results.json');
  let result = null;
  if (fs.existsSync(resultsFile)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(resultsFile, 'utf8'));
      result = {
        round_used: parsed.round_used,
        R: parsed.R,
        seed: parsed.seed,
        permutation: parsed.permutation,
        participating: (parsed.participating_local_ids || []).length,
        excluded: parsed.excluded_local_ids || [],
        digest: digestOf(resultsFile),
      };
    } catch (err) {
      result = { error: err.message };
    }
  }

  return {
    generated_at: new Date(now).toISOString(),
    event_id: cfg.roster.pantheon_event_id,
    phase: status.phase,
    attempt: status.attempt,
    quorum: cfg.protocol.quorum,
    total_slots: cfg.protocol.total_slots,
    submitted_count: status.submitted_count,
    target_round: cfg.protocol.target_round,
    cutoff_utc: cfg.protocol.submission_cutoff_utc,
    cutoff_in_ms: cfg.protocol.cutoff_ms - now,
    drand: status.drand,
    tag_refs: {
      schedule_template_ref: cfg.protocol.schedule_template_ref,
      generate_script_ref: cfg.protocol.generate_script_ref,
    },
    roster,
    checks,
    artefacts,
    result,
    pantheon_sync: syncOutcome,
    attempts: readIndex(cfg),
    mirror_enabled: Boolean(mirror?.enabled),
    pantheon_mode: isStub ? 'stub' : 'twirp',
    node_env: production ? 'production' : process.env.NODE_ENV || 'development',
  };
}

// ---------------------------------------------------------------------------
// rendering
// ---------------------------------------------------------------------------

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function duration(ms) {
  if (!Number.isFinite(ms)) return '—';
  const past = ms < 0;
  let s = Math.floor(Math.abs(ms) / 1000);
  const d = Math.floor(s / 86400); s -= d * 86400;
  const h = Math.floor(s / 3600); s -= h * 3600;
  const m = Math.floor(s / 60);
  const parts = [d && `${d}d`, (d || h) && `${h}h`, `${m}m`].filter(Boolean);
  return (past ? '-' : '') + parts.join(' ');
}

const STYLE = `
:root{--bg:#f7f7f5;--card:#fff;--ink:#1a1a18;--dim:#6b6b66;--line:#e3e3de;
      --ok:#2f7d4f;--warn:#9a6b12;--fail:#b3261e;--accent:#2b5c8a}
@media (prefers-color-scheme:dark){:root{--bg:#16161a;--card:#1e1e23;--ink:#ececed;
      --dim:#9a9aa0;--line:#33333a;--ok:#6fcf97;--warn:#e2b04a;--fail:#ff6b5e;--accent:#7fb2e5}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);
     font:14px/1.5 ui-sans-serif,system-ui,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif}
main{max-width:1040px;margin:0 auto;padding:24px 20px 64px}
h1{font-size:20px;margin:0 0 2px}
h2{font-size:13px;text-transform:uppercase;letter-spacing:.07em;color:var(--dim);margin:0 0 10px}
.sub{color:var(--dim);margin:0 0 24px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:16px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px 18px}
.card.wide{grid-column:1/-1}
.big{font-size:26px;font-weight:600;letter-spacing:-.01em}
.kv{display:flex;justify-content:space-between;gap:16px;padding:5px 0;border-top:1px solid var(--line)}
.kv:first-of-type{border-top:0}
.kv dt{color:var(--dim)}
.kv dd{margin:0;text-align:right}
dl{margin:0}
code,.mono{font:12px/1.45 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;word-break:break-all}
.badge{display:inline-block;padding:2px 9px;border-radius:99px;font-size:12px;font-weight:600}
.b-open{background:#2b5c8a22;color:var(--accent)}
.b-awaiting_round{background:#9a6b1222;color:var(--warn)}
.b-revealing{background:#9a6b1222;color:var(--warn)}
.b-done{background:#2f7d4f22;color:var(--ok)}
.b-void{background:#b3261e22;color:var(--fail)}
table{width:100%;border-collapse:collapse}
th{text-align:left;font-size:12px;color:var(--dim);font-weight:600;padding:4px 8px 8px 0}
td{padding:6px 8px 6px 0;border-top:1px solid var(--line)}
tr.missing td{font-weight:600}
.dot{display:inline-block;width:8px;height:8px;border-radius:99px;margin-right:8px;vertical-align:1px}
.d-ok{background:var(--ok)}.d-warn{background:var(--warn)}.d-fail{background:var(--fail)}.d-no{background:var(--line)}
.track{height:8px;border-radius:99px;background:var(--line);position:relative;overflow:hidden;margin:10px 0 6px}
.fill{height:100%;background:var(--accent)}
.mark{position:absolute;top:-3px;width:2px;height:14px;background:var(--ink);opacity:.55}
li{margin:4px 0}
ul{padding-left:18px;margin:6px 0}
.check{display:flex;gap:10px;padding:7px 0;border-top:1px solid var(--line);align-items:baseline}
.check:first-child{border-top:0}
.check .what{flex:1}
.check .detail{color:var(--dim);font-size:12px}
a{color:var(--accent)}
footer{color:var(--dim);font-size:12px;margin-top:28px}
`;

function render(m) {
  const pct = m.total_slots ? (m.submitted_count / m.total_slots) * 100 : 0;
  const quorumPct = m.total_slots ? (m.quorum / m.total_slots) * 100 : 0;
  const missing = m.roster.filter((r) => !r.submitted);

  const checkRow = (c) => `
    <div class="check">
      <span class="dot d-${c.ok ? 'ok' : c.level}"></span>
      <span class="what">${esc(c.label)}<br><span class="detail">${esc(c.detail)}</span></span>
    </div>`;

  const rosterRow = (r) => `
    <tr class="${r.submitted ? '' : 'missing'}">
      <td>${r.local_id}</td>
      <td>${esc(r.title)}</td>
      <td><span class="dot d-${r.submitted ? 'ok' : 'no'}"></span>${r.submitted ? '已封存' : '未提交'}</td>
      <td class="mono">${r.received_at ? esc(r.received_at) : ''}</td>
    </tr>`;

  const kv = (k, v) => `<div class="kv"><dt>${esc(k)}</dt><dd>${v}</dd></div>`;

  return `<!doctype html>
<html lang="zh"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<meta http-equiv="refresh" content="30">
<title>抽签管理台 · 事件 ${esc(m.event_id)}</title>
<style>${STYLE}</style>
</head><body><main>

<h1>抽签管理台</h1>
<p class="sub">Pantheon 事件 ${esc(m.event_id)} · 第 ${m.attempt} 次开奖 ·
  <span class="badge b-${esc(m.phase)}">${esc(m.phase)}</span> ·
  ${esc(m.node_env)} / pantheon:${esc(m.pantheon_mode)}</p>

<div class="grid">

  <div class="card">
    <h2>提交进度（RUNBOOK 13）</h2>
    <div class="big">${m.submitted_count} / ${m.total_slots}</div>
    <div class="track">
      <div class="fill" style="width:${pct.toFixed(1)}%"></div>
      <div class="mark" style="left:${quorumPct.toFixed(1)}%"></div>
    </div>
    <p class="detail" style="color:var(--dim);margin:0">
      门槛 ${m.quorum} 位${m.submitted_count >= m.quorum ? '，已达到' : `，还差 ${m.quorum - m.submitted_count} 位`}
    </p>
    ${missing.length ? `<p style="margin:10px 0 0">待催办：<strong>${missing.map((r) => esc(r.title)).join('、')}</strong></p>` : ''}
  </div>

  <div class="card">
    <h2>开奖</h2>
    <dl>
      ${kv('target_round', `<span class="mono">${m.target_round}</span>`)}
      ${kv('截止', `<span class="mono">${esc(m.cutoff_utc)}</span>`)}
      ${kv(m.cutoff_in_ms >= 0 ? '距截止' : '已过截止', duration(m.cutoff_in_ms))}
      ${kv('drand 最新轮次', `<span class="mono">${m.drand?.latest_round ?? '—'}</span>`)}
      ${kv('drand 状态', m.drand?.healthy ? '可达' : '<span style="color:var(--fail)">无应答</span>')}
    </dl>
  </div>

  <div class="card wide">
    <h2>上线前检查</h2>
    ${m.checks.map(checkRow).join('')}
  </div>

  <div class="card wide">
    <h2>名册（只显示是否提交与时间，绝不显示内容）</h2>
    <table>
      <tr><th>local_id</th><th>玩家</th><th>状态</th><th>收到时间</th></tr>
      ${[...m.roster].sort((a, b) => (a.submitted === b.submitted ? a.local_id - b.local_id : a.submitted ? 1 : -1)).map(rosterRow).join('')}
    </table>
  </div>

  <div class="card wide">
    <h2>冻结物件指纹</h2>
    <dl>
      ${Object.entries(m.artefacts).map(([k, v]) => kv(k, `<span class="mono">${v ? esc(v) : '缺失'}</span>`)).join('')}
      ${kv('schedule_template_ref', `<span class="mono">${esc(m.tag_refs.schedule_template_ref || '—')}</span>`)}
      ${kv('generate_script_ref', `<span class="mono">${esc(m.tag_refs.generate_script_ref || '—')}</span>`)}
    </dl>
  </div>

  ${m.result ? `
  <div class="card wide">
    <h2>结果（RUNBOOK 14）</h2>
    <dl>
      ${kv('round_used', `<span class="mono">${m.result.round_used}</span>`)}
      ${kv('参与 / 排除', `${m.result.participating} / ${m.result.excluded.length}`)}
      ${kv('R', `<span class="mono">${esc(m.result.R || '')}</span>`)}
      ${kv('seed', `<span class="mono">${esc(m.result.seed || '')}</span>`)}
      ${kv('permutation', `<span class="mono">[${(m.result.permutation || []).join(', ')}]</span>`)}
      ${kv('results.json sha256', `<span class="mono">${esc(m.result.digest || '')}</span>`)}
    </dl>
    ${m.result.excluded.length ? `<ul>${m.result.excluded.map((e) => `<li>local_id ${e.local_id}：${esc(e.reason)}</li>`).join('')}</ul>` : ''}
    <p class="detail" style="color:var(--dim)">
      复算：<code>node generate.js --verify results.json</code>，
      点名核对会自动读取 <code>events/snapshot.json</code>。
    </p>
  </div>` : ''}

  ${m.pantheon_sync ? `
  <div class="card wide">
    <h2>Pantheon 同步（RUNBOOK 15）</h2>
    <dl>
      ${kv('状态', m.pantheon_sync.status === 'ok'
        ? '<span style="color:var(--ok)">ok</span>'
        : `<span style="color:var(--fail)">${esc(m.pantheon_sync.status)}</span>`)}
      ${kv('时间', `<span class="mono">${esc(m.pantheon_sync.at || '')}</span>`)}
      ${kv('尝试次数', esc(m.pantheon_sync.attempts ?? ''))}
    </dl>
    ${m.pantheon_sync.remedy ? `<p style="color:var(--fail)">${esc(m.pantheon_sync.remedy)}</p>` : ''}
  </div>` : ''}

  ${m.attempts.length ? `
  <div class="card wide">
    <h2>历次尝试</h2>
    <table>
      <tr><th>#</th><th>target_round</th><th>结果</th><th>提交数</th><th>存证</th></tr>
      ${m.attempts.map((a) => `<tr>
        <td>${a.attempt}</td>
        <td class="mono">${a.target_round}</td>
        <td>${esc(a.status)}</td>
        <td>${a.submitted_count} / ${a.quorum}</td>
        <td><a href="/${esc(a.archive)}/manifest.json">manifest</a></td>
      </tr>`).join('')}
    </table>
    <p class="detail" style="color:var(--dim)">
      作废轮次的密文、名册和当时的参数都已存档，任何人都能自行核对。
    </p>
  </div>` : ''}

</div>

<footer>
  ${esc(m.generated_at)} · 每 30 秒自动刷新 · 只读页面：开奖、重置、同步都只能在机器上用命令执行
</footer>
</main></body></html>`;
}

module.exports = { collect, render, bundleDigest };
