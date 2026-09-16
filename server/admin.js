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
 * **The draw is not here, and never will be.** §9 has it that nothing an outsider can
 * poke may trigger, retry or re-time a draw, and the finalisation job is deliberately not
 * an HTTP endpoint. A button here that ran it would undo that in one line. Both draws run
 * on a timer instead (server/schedule.js), which no request can reach.
 *
 * This page was read-only for a second reason as well -- "every action an organiser needs
 * is a command run on the box by someone who is already there" -- and that half was simply
 * false for the twelfth round. It happens minutes after the eleventh, in a venue, with
 * twelve people sitting down, and nobody is at a terminal. So two things live here now:
 * confirming the standings before they are locked, which genuinely needs a person, and
 * declaring a substitute, which was a hand-edited JSON file and therefore did not happen.
 * Both run the same command line a person would, as a child process, so the page shows
 * what the tool said rather than reimplementing it. Re-locking is deliberately still a
 * command: it rewrites a published commitment, and that should stay something you have to
 * mean.
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
/**
 * How often this page reloads itself, and when it must not.
 *
 * There is no javascript here -- the Content-Security-Policy on /admin is
 * `default-src 'none'` with no script-src at all, deliberately, because a dashboard that
 * can run code is a dashboard that can be made to run somebody else's. So the only
 * refresh available is <meta http-equiv="refresh">, and that is a full navigation: it
 * throws away anything typed into a form on the way past.
 *
 * A single interval therefore cannot be right. It was thirty seconds, which is far too
 * slow for the minutes that matter -- the beacon lands and the twelfth round appears
 * inside one of them -- and, at any value short enough to fix that, fast enough to wipe a
 * half-written substitute declaration out from under the person writing it.
 *
 * So the interval follows what is actually happening:
 *
 *   FAST   something is in flight and nobody is typing: the first draw is past its
 *          cutoff, or the final round is locked and its beacon is due. Both resolve
 *          without anyone acting, and both are exactly what the organiser is standing
 *          there watching.
 *   STEADY the ordinary case -- submissions arriving, an event at rest. Still three
 *          times quicker than before, and no form is live in these states.
 *   NEVER  a form is on screen and can be used. The lock and substitute forms render
 *          only in `done` + `none`, which is precisely the state where nothing changes
 *          on its own: the round-robin is over, the twelfth round has not been asked
 *          for, and the next event is the operator pressing something. Reloading under
 *          their hands would destroy the only thing on this page that is theirs.
 */
const REFRESH_FAST = 5;
const REFRESH_STEADY = 10;

function refreshPolicy({ phase, final, csrf }) {
  const formsLive = Boolean(csrf) && phase === 'done' && final.state === 'none';
  if (formsLive) return { forms_live: true, refresh_seconds: null, refresh_why: 'forms' };
  if (final.state === 'locked') return { forms_live: false, refresh_seconds: REFRESH_FAST, refresh_why: 'final' };
  if (phase === 'awaiting_round' || phase === 'revealing') {
    return { forms_live: false, refresh_seconds: REFRESH_FAST, refresh_why: 'draw' };
  }
  return { forms_live: false, refresh_seconds: REFRESH_STEADY, refresh_why: 'steady' };
}

/**
 * The drawn final round's tables, or null.
 *
 * Read here rather than taken from the status payload: `finalSummary()` is sized for
 * twelve polling browsers and stops at the lock. Never fatal — a half-written final.json
 * must not take the dashboard down with it, since the dashboard is where you would go to
 * find out why.
 */
function readFinalSeating(root) {
  try {
    const f = JSON.parse(fs.readFileSync(path.join(root, 'final.json'), 'utf8'));
    const round = f.seating?.rounds?.[0];
    if (!round) return null;
    return { round: round.round, tables: round.tables };
  } catch {
    return null;
  }
}

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

  // Whether the post-draw seat-plan sync has an admin credential to write with, and
  // where it came from — never the token itself (server/admin-credential.js). Only for
  // a real Pantheon: the stub has no sync to run.
  if (!isStub) {
    const ac = ctx.adminCredential || { source: null };
    const done = status.phase === 'done';
    check(
      ac.source ? 'ok' : (done ? 'fail' : 'warn'),
      ac.source === 'env'
        ? 'Seat-plan sync has admin credentials (from the environment)'
        : ac.source === 'captured'
          ? 'Seat-plan sync has admin credentials (captured when an admin signed in)'
          : 'Seat-plan sync has no admin credentials yet',
      ac.source === 'env'
        ? 'PANTHEON_ADMIN_PERSON_ID / PANTHEON_ADMIN_TOKEN are set in the environment'
        : ac.source === 'captured'
          ? `captured from ${ac.title || 'an event admin'}${ac.at ? ` at ${ac.at}` : ''} — the token is never shown here`
          : 'no event admin has signed in yet and PANTHEON_ADMIN_TOKEN is unset. An event admin ' +
            'signing in through the page captures it automatically; until then the seat plan ' +
            'cannot be written back (you can still paste it in by hand after the draw)'
    );
  }

  const artefacts = {
    'data/protocol.json': digestOf(path.join(cfg.dataDir, 'protocol.json')),
    'data/roster.json': digestOf(path.join(cfg.dataDir, 'roster.json')),
    'data/schedule_template.json': digestOf(path.join(cfg.dataDir, 'schedule_template.json')),
    'generate.js': digestOf(path.join(cfg.root, 'generate.js')),
    // Only when there is a twelfth round to draw. On an eleven-round event the row
    // would be a permanent "missing" for a file nothing is waiting on.
    ...(cfg.protocol.final_round?.enabled
      ? { 'generate-final.js': digestOf(path.join(cfg.root, 'generate-final.js')) }
      : {}),
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
      generate_final_script_ref: cfg.protocol.generate_final_script_ref || null,
    },
    roster,
    checks,
    artefacts,
    result,
    // The twelfth round (PROTOCOL.md §11): whether the rules were frozen for one, and
    // how far along it is. {state: 'none'} until the standings are locked.
    final_round_enabled: Boolean(cfg.protocol.final_round?.enabled),
    final: status.final || { state: 'none' },
    final_digest: digestOf(path.join(cfg.root, 'final.json')),
    // The twelfth round's actual seats. The player-facing summary deliberately carries
    // only the lock, because twelve browsers poll it; the operator is the one person who
    // has to read the round out to a room, so the dashboard reads the file.
    final_seating: readFinalSeating(cfg.root),
    // Seats that changed hands (PROTOCOL.md 11.6). The organiser is the one person who
    // can still correct this before it is locked, so it belongs on their page while it
    // is still correctable rather than only on the player-facing result afterwards.
    substitutes: cfg.substitutes.substitutions,
    // The dashboard can now DO two things (server/server.js adminAction), so it needs a
    // CSRF token to put in the forms, somewhere to keep the token if that is how the
    // operator arrived, and whatever the last action said.
    csrf: ctx.csrf || null,
    token_query: ctx.tokenQuery || null,
    ...refreshPolicy({ phase: status.phase, final: status.final || { state: 'none' }, csrf: ctx.csrf || null }),
    last_action: ctx.lastAction || null,
    // Everyone has played every game, so the standings can be locked. Read here rather
    // than in the template so the button's condition is one expression with a name.
    roster_players: (cfg.roster?.players || []).map((pl) => ({ local_id: pl.local_id, title: pl.title })),
    rounds: cfg.template.rounds.length,
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

/**
 * The dashboard's stylesheet, served at /admin.css rather than inlined in a <style>.
 *
 * Both deployment configurations in deploy/ set a Content-Security-Policy with
 * `style-src 'self'`, and a response that carries two CSP headers — the proxy's and
 * this app's — is held to both at once. So the page's own `'unsafe-inline'` bought
 * nothing in production: the intersection allowed no inline style whatsoever, every
 * rule below was dropped, and the dashboard rendered as unstyled markup while the
 * console filled with style-src violations. `'self'` is a source both halves already
 * permit, which is why this is a file and why nothing on the page carries a `style`
 * attribute any more.
 *
 * The two that genuinely vary — how far the progress bar is filled, and where the
 * quorum mark sits — are integer percentages, so they are classes rather than computed
 * values. A hundred and one of each is a lot of rules for two elements and still the
 * cheapest of the options: CSSOM from a script would need script-src as well, and
 * rounding to whole percent is invisible on an eight-pixel bar.
 */
const PCT_CLASSES = Array.from({ length: 101 }, (_, i) => `.w-${i}{width:${i}%}.l-${i}{left:${i}%}`).join('');

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
.dim{color:var(--dim)}
.ok{color:var(--ok)}
.fail{color:var(--fail)}
.flush{margin:0}
.chase{margin:10px 0 0}
${PCT_CLASSES}
/* The two actions the organiser can take (PROTOCOL.md 11). Deliberately plain: this is
   a form on a dashboard, not a product. */
form{margin:.6rem 0 1rem}
form label{display:block;margin:.35rem 0;font-size:.85rem;color:var(--dim)}
form label.check{color:var(--ink)}
form input[type=text],form input:not([type]),form input[type=number],form select{
  font:inherit;font-size:.9rem;padding:.25rem .4rem;margin-left:.4rem;
  border:1px solid var(--line);border-radius:4px;background:var(--card);color:var(--ink)}
form button{font:inherit;font-size:.9rem;padding:.35rem .9rem;margin-right:.5rem;
  border:1px solid var(--line);border-radius:5px;background:var(--card);color:var(--ink);cursor:pointer}
form button:hover{border-color:var(--accent);color:var(--accent)}
form button.danger{border-color:var(--fail);color:var(--fail)}
form button.danger:hover{background:var(--fail);color:#fff}
.action-result{margin:.8rem 0;padding:.6rem .8rem;border-radius:6px;border:1px solid var(--line)}
.action-result.ok{border-color:var(--ok)}
.action-result.fail{border-color:var(--fail)}
.action-result pre{margin:.3rem 0 0;white-space:pre-wrap;word-break:break-word;
  font-size:.8rem;line-height:1.45;color:var(--ink)}

/* ---- the layout the operator arranges --------------------------------------
   Each card has a head with its own controls, and the head is the drag handle. The
   controls are quiet until the card is hovered or something inside it has focus: this
   page is read far more often than it is rearranged, and four buttons on every card at
   full strength would be four buttons competing with the numbers they sit above. */
.card-head{display:flex;align-items:baseline;justify-content:space-between;gap:10px;cursor:grab}
.card-head h2{margin:0}
.card-tools{display:flex;gap:2px;opacity:0;transition:opacity 120ms}
.card:hover .card-tools,.card:focus-within .card-tools{opacity:1}
@media (hover:none){.card-tools{opacity:.6}}
.card-btn{font:inherit;font-size:12px;line-height:1;padding:3px 7px;cursor:pointer;
  border:1px solid var(--line);border-radius:5px;background:var(--card);color:var(--dim)}
.card-btn:hover{border-color:var(--accent);color:var(--accent)}
.card-body{margin-top:10px}
.card.dragging{opacity:.5;outline:2px dashed var(--accent)}
.bar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:0 0 16px}
/* Removed cards are listed by name, not by an icon: "+ 服务器日志" is the only label
   that tells an operator what pressing it brings back. */
.bar [data-palette]{display:flex;gap:6px;flex-wrap:wrap}

/* ---- the log ---------------------------------------------------------------
   A terminal, on a page that is not one: monospace, fixed height so the card does not
   grow without bound, and its own scroller so following the tail does not drag the whole
   dashboard down with it. */
.log-controls{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin:0 0 8px}
.log-controls label.check{display:flex;align-items:center;gap:5px;margin:0;color:var(--ink)}
.log-controls input[data-log-filter]{font:inherit;font-size:.85rem;padding:.2rem .4rem;
  border:1px solid var(--line);border-radius:4px;background:var(--card);color:var(--ink)}
.logview{margin:0;height:300px;overflow:auto;overscroll-behavior:contain;
  background:var(--bg);border:1px solid var(--line);border-radius:6px;padding:8px 10px;
  font:12px/1.55 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;white-space:pre-wrap;
  word-break:break-word}
.logline{display:block}
.logline.err{color:var(--fail)}
.logtime{color:var(--dim);margin-right:10px}

/* The final round's seats, once they are drawn: the one table on this page that gets
   read out loud to a room, so the table numbers keep the colours the seat plan uses. */
table.seating td .tbl{border-radius:5px;padding:1px 7px;font-size:12px;font-weight:600}
table.seating td .tbl.t1{background:#2f6f8f22;color:#2f6f8f}
table.seating td .tbl.t2{background:#8a5a1222;color:#8a5a12}
table.seating td .tbl.t3{background:#6a4b8a22;color:#6a4b8a}
@media (prefers-color-scheme:dark){
  table.seating td .tbl.t1{background:#7fb6d422;color:#7fb6d4}
  table.seating td .tbl.t2{background:#d8a75a22;color:#d8a75a}
  table.seating td .tbl.t3{background:#b49ad422;color:#b49ad4}
}

`;

/**
 * The dashboard, as a set of cards that refresh independently.
 *
 * It used to be one template and one `<meta http-equiv="refresh">`, and the whole page
 * blinked on a single interval — which is why the interval could never be right. Ten
 * seconds is too slow for the minute the beacon lands in and too fast for a page with a
 * half-typed form on it, and no single number fixes both.
 *
 * So each card declares its own cadence, and the client fetches only the cards that are
 * due. `every: null` means "never on a timer": the final-round card while its forms are
 * usable, and the log, which streams its own way. The rest sit between five seconds and
 * a minute depending on how fast what they show can actually change — the roster moves
 * every time somebody submits, the frozen artefact digests cannot move at all while the
 * process is up.
 *
 * Every card is addressable (`id`), so the same registry serves three things that would
 * otherwise be three implementations: the first full-page render, the partial refresh,
 * and the palette of cards an operator can remove and put back.
 */
/**
 * The dashboard's client, served verbatim at /admin.js.
 *
 * A file rather than a string in this one, so it is real javascript: node --check
 * parses it, an editor highlights it, and a syntax error is caught at require time
 * instead of arriving at a browser as a blank dashboard. Read once at startup, because
 * it cannot change while the process is up.
 */
const SCRIPT = fs.readFileSync(path.join(__dirname, 'admin-client.js'), 'utf8');

function cardRegistry(m) {
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

  return [
    {
      id: 'submissions',
      title: '提交进度（RUNBOOK 13）',
      every: 5,
      body: () => `
    <div class="big">${m.submitted_count} / ${m.total_slots}</div>
    <div class="track">
      <div class="fill w-${Math.round(pct)}"></div>
      <div class="mark l-${Math.round(quorumPct)}"></div>
    </div>
    <p class="detail dim flush">
      门槛 ${m.quorum} 位${m.submitted_count >= m.quorum ? '，已达到' : `，还差 ${m.quorum - m.submitted_count} 位`}
    </p>
    ${missing.length ? `<p class="chase">待催办：<strong>${missing.map((r) => esc(r.title)).join('、')}</strong></p>` : ''}`,
    },

    {
      id: 'draw',
      title: '开奖',
      every: 5,
      body: () => `
    <dl>
      ${kv('target_round', `<span class="mono">${m.target_round}</span>`)}
      ${kv('截止', `<span class="mono">${esc(m.cutoff_utc)}</span>`)}
      ${kv(m.cutoff_in_ms >= 0 ? '距截止' : '已过截止', duration(m.cutoff_in_ms))}
      ${kv('drand 最新轮次', `<span class="mono">${m.drand?.latest_round ?? '—'}</span>`)}
      ${kv('drand 状态', m.drand?.healthy ? '可达' : '<span class="fail">无应答</span>')}
    </dl>`,
    },

    {
      id: 'log',
      title: '服务器日志',
      wide: true,
      // Not on the card timer: it appends new lines from its own endpoint rather than
      // re-rendering, so a screenful of scrollback survives and the view does not jump.
      every: null,
      body: () => `
    <p class="detail dim flush">
      这台服务器自己打印的东西，最近 ${m.log_capacity} 行。开奖任务和决赛抽签任务的输出也在里面——
      它们由 server/schedule.js 转回主进程。日志只在内存里，重启就没了。
    </p>
    <div class="log-controls">
      <label class="check"><input type="checkbox" data-log-follow checked> 跟随最新</label>
      <input data-log-filter placeholder="过滤，如 finalise" size="18">
      <span class="dim" data-log-state>连接中…</span>
    </div>
    <pre class="logview" data-logview aria-live="polite"></pre>`,
    },

    {
      id: 'checks',
      title: '上线前检查',
      wide: true,
      every: 30,
      body: () => m.checks.map(checkRow).join(''),
    },

    {
      id: 'roster',
      title: '名册（只显示是否提交与时间，绝不显示内容）',
      wide: true,
      every: 5,
      body: () => `
    <table>
      <tr><th>local_id</th><th>玩家</th><th>状态</th><th>收到时间</th></tr>
      ${[...m.roster].sort((a, b) => (a.submitted === b.submitted ? a.local_id - b.local_id : a.submitted ? 1 : -1)).map(rosterRow).join('')}
    </table>`,
    },

    {
      id: 'artefacts',
      title: '冻结物件指纹',
      wide: true,
      // Frozen means frozen: these cannot change while the process is up, and a card
      // that re-fetches what cannot change is a card teaching you to ignore the page.
      every: null,
      body: () => `
    <dl>
      ${Object.entries(m.artefacts).map(([k, v]) => kv(k, `<span class="mono">${v ? esc(v) : '缺失'}</span>`)).join('')}
      ${kv('schedule_template_ref', `<span class="mono">${esc(m.tag_refs.schedule_template_ref || '—')}</span>`)}
      ${kv('generate_script_ref', `<span class="mono">${esc(m.tag_refs.generate_script_ref || '—')}</span>`)}
    </dl>`,
    },

    {
      id: 'result',
      title: '结果（RUNBOOK 14）',
      wide: true,
      every: 15,
      when: () => Boolean(m.result),
      body: () => `
    <dl>
      ${kv('round_used', `<span class="mono">${m.result.round_used}</span>`)}
      ${kv('参与 / 排除', `${m.result.participating} / ${m.result.excluded.length}`)}
      ${kv('R', `<span class="mono">${esc(m.result.R || '')}</span>`)}
      ${kv('seed', `<span class="mono">${esc(m.result.seed || '')}</span>`)}
      ${kv('permutation', `<span class="mono">[${(m.result.permutation || []).join(', ')}]</span>`)}
      ${kv('results.json sha256', `<span class="mono">${esc(m.result.digest || '')}</span>`)}
    </dl>
    ${m.result.excluded.length ? `<ul>${m.result.excluded.map((e) => `<li>local_id ${e.local_id}：${esc(e.reason)}</li>`).join('')}</ul>` : ''}
    <p class="detail dim">
      复算：<code>node generate.js --verify results.json</code>，
      点名核对会自动读取 <code>events/snapshot.json</code>。
    </p>`,
    },

    {
      id: 'final',
      title: '决赛轮（PROTOCOL §11）',
      wide: true,
      // The forms are the exception the whole refresh policy is built around: a partial
      // refresh replaces this card's markup, and a form inside it would lose whatever is
      // half-typed. While they are usable the card holds still.
      every: m.forms_live ? null : 5,
      when: () => m.final_round_enabled,
      body: () => `
    <p class="detail dim flush">
      桌次由前 ${m.final.round ? m.final.round - 1 : 11} 轮名次决定，风位由一次新的 drand 抽签决定。
      名次与信标轮次都在信标出块<strong>之前</strong>锁定并公开。
    </p>
    ${m.final.state === 'none' ? (m.forms_live ? `
    <p class="chase">还没有锁定。用下面的表单；也可以在服务器上跑 <code>node tools/lock-final.js --in 5m --confirm</code>。</p>` : `
    <p class="chase">还没有锁定，现在也还不能锁定：循环赛还没打完（当前阶段
      <span class="badge b-${esc(m.phase)}">${esc(m.phase)}</span>）。等结果出来、阶段变成
      <span class="badge b-done">done</span> 之后，这里会出现锁定与替补两个表单。
      在那之前 <code>node tools/lock-final.js</code> 也会因为没有 <code>results.json</code> 而拒绝。</p>`) : `
    <dl>
      ${kv('状态', m.final.state === 'drawn'
        ? '<span class="ok">已抽签</span>'
        : '<span class="badge b-awaiting_round">已锁定，等信标</span>')}
      ${kv('锁定时间', `<span class="mono">${esc(m.final.locked_at || '')}</span>`)}
      ${kv('lock.json sha256', `<span class="mono">${esc(m.final.lock_sha256 || '')}</span>`)}
      ${kv('时间戳存证', m.final.anchored
        ? '<span class="ok">已锚定</span>'
        : '<span class="fail">没有 .ots —— 信标之后再补证明不了任何事</span>')}
      ${kv('决赛信标', `<span class="mono">round ${m.final.target_round ?? '—'} · ${esc(m.final.target_round_utc || '')}</span>`)}
      ${m.final.standings ? kv('名次（一桌 / 二桌 / 三桌）', `<span class="mono">${
        [0, 4, 8].map((i) => m.final.standings.slice(i, i + 4).join('-')).join(' &nbsp; ')
      }</span>`) : ''}
      ${m.final.state === 'drawn' ? kv('十二轮后风位补齐', `${m.final.completed_count} / ${(m.final.standings || []).length}`) : ''}
      ${m.final.state === 'drawn' ? kv('final.json sha256', `<span class="mono">${esc(m.final_digest || '')}</span>`) : ''}
      ${m.substitutes.length ? kv('中途换人', m.substitutes.map((sub) =>
        `<span class="mono">#${sub.local_id}</span> 第 ${sub.from_round} 轮起 ` +
        `${esc(sub.outgoing.title || '')} &rarr; ${esc(sub.incoming.title)}` +
        `<br><span class="dim">${esc(sub.reason)}</span>`).join('<br>')) : ''}
    </dl>
    ${m.substitutes.length ? `
    <p class="detail dim flush">
      这些席位保留了原有的 Pantheon 注册位，所以名次表仍是一人一行，桌次与没有换人时完全一致。
      记录会被抄进 lock.json，与名次同一个指纹、同一个时间戳。
    </p>` : ''}

    ${m.final_seating ? `
    <h3>第 ${m.final_seating.round} 轮座位</h3>
    <p class="detail dim flush">抽签已完成。这就是要念给场地的那张表。</p>
    <table class="seating">
      <tr><th>桌</th><th>东</th><th>南</th><th>西</th><th>北</th></tr>
      ${m.final_seating.tables.map((tb) => `
      <tr>
        <td><span class="tbl t${tb.table}">第 ${tb.table} 桌</span></td>
        ${['E', 'S', 'W', 'N'].map((w) => {
          const st = tb.seats[w];
          return `<td>${esc(st.title || '')}<span class="dim mono"> #${st.local_id}</span></td>`;
        }).join('')}
      </tr>`).join('')}
    </table>` : ''}

    <p class="detail dim">
      ${m.final.state === 'drawn'
        ? '复算：<code>node generate-final.js --verify final.json</code>，第二实现：<code>py tools/verify_final.py</code>'
        : '信标落地时服务器会自己抽签，你什么都不用做。在那之前，让十二个人互相核对上面那串 sha256。'}
    </p>`}

    ${m.last_action ? `
    <div class="action-result ${m.last_action.code === 0 ? 'ok' : 'fail'}">
      <p class="fineprint">上一次操作：${esc(m.last_action.kind)} · ${esc(m.last_action.at)} · 退出码 ${m.last_action.code}</p>
      <pre>${esc(m.last_action.out || '')}</pre>
    </div>` : ''}

    ${m.forms_live ? `
    <h3>锁定决赛轮</h3>
    <p class="detail dim flush">
      先按「预览」：它会拉回名次并把所有检查跑一遍，<strong>什么也不写</strong>。
      确认无误之后再按「锁定并公布」。锁定之后你什么都不用做：信标落地时服务器会自己抽签。
    </p>
    <form method="post" action="/admin/final/lock${m.token_query ? `?token=${encodeURIComponent(m.token_query)}` : ''}">
      <input type="hidden" name="csrf" value="${esc(m.csrf)}">
      <label>信标提前量
        <input name="in" value="5m" size="6" pattern="[0-9]+[smhd]" title="如 5m、2h">
      </label>
      <label class="check">
        <input type="checkbox" name="as_admin"> 赛事隐藏成绩时勾选（会把未结束的对局一并算入，确认没有桌在打）
      </label>
      <label>并列名次（可空）
        <input name="tiebreak" size="4" pattern="[0-9,]*" placeholder="4">
      </label>
      <label>并列裁决依据
        <input name="tiebreak_reason" size="40" placeholder="联赛规则 6b：点棒多者优先">
      </label>
      <p>
        <button name="mode" value="preview" type="submit">预览（不写入）</button>
        <button name="mode" value="confirm" type="submit" class="danger">锁定并公布</button>
      </p>
    </form>

    <h3>声明替补</h3>
    <p class="detail dim flush">
      替补沿用该席位原有的 Pantheon 注册位，所以这不影响抽签，只是一份公开记录。
      必须写明联赛规则，否则不予受理。
    </p>
    <form method="post" action="/admin/final/substitute${m.token_query ? `?token=${encodeURIComponent(m.token_query)}` : ''}">
      <input type="hidden" name="csrf" value="${esc(m.csrf)}">
      <label>座位
        <select name="local_id">
          ${m.roster_players.map((pl) => `<option value="${pl.local_id}">#${pl.local_id} ${esc(pl.title)}</option>`).join('')}
        </select>
      </label>
      <label>从第几轮起
        <input name="from_round" type="number" min="1" max="${m.rounds}" value="1" size="3">
      </label>
      <label>接手者姓名
        <input name="incoming_title" size="16" required>
      </label>
      <label>接手者 person_id（可空，仅存档）
        <input name="incoming_person_id" type="number" size="8">
      </label>
      <label>联赛规则与理由
        <input name="reason" size="48" required placeholder="联赛规则 9c：伤病退赛，由候补名单首位递补">
      </label>
      <p><button type="submit">记录</button></p>
    </form>` : ''}`,
    },

    {
      id: 'sync',
      title: 'Pantheon 同步（RUNBOOK 15）',
      wide: true,
      every: 15,
      when: () => Boolean(m.pantheon_sync),
      body: () => `
    <dl>
      ${kv('状态', m.pantheon_sync.status === 'ok'
        ? '<span class="ok">ok</span>'
        : `<span class="fail">${esc(m.pantheon_sync.status)}</span>`)}
      ${kv('时间', `<span class="mono">${esc(m.pantheon_sync.at || '')}</span>`)}
      ${kv('尝试次数', esc(m.pantheon_sync.attempts ?? ''))}
    </dl>
    ${m.pantheon_sync.remedy ? `<p class="fail">${esc(m.pantheon_sync.remedy)}</p>` : ''}`,
    },

    {
      id: 'attempts',
      title: '历次尝试',
      wide: true,
      every: 60,
      when: () => m.attempts.length > 0,
      body: () => `
    <table>
      <tr><th>#</th><th>target_round</th><th>结果</th><th>提交数</th><th>存证</th></tr>
      ${m.attempts.map((a) => `<tr>
        <td>${a.attempt}</td>
        <td class="mono">${a.target_round}</td>
        <td>${esc(a.outcome)}</td>
        <td>${a.submitted_count} / ${a.quorum}</td>
        <td><a href="/${esc(a.archive)}/manifest.json">manifest</a></td>
      </tr>`).join('')}
    </table>
    <p class="detail dim">
      作废轮次的密文、名册和当时的参数都已存档，任何人都能自行核对。
    </p>`,
    },
  ].filter((c) => (c.when ? c.when() : true));
}

/** One card's shell. The body is separate so a refresh can replace only that. */
function cardHtml(card) {
  return `<section class="card${card.wide ? ' wide' : ''}" data-card="${card.id}"` +
    `${card.every ? ` data-every="${card.every}"` : ''}>` +
    `<div class="card-head">` +
    `<h2>${esc(card.title)}</h2>` +
    `<div class="card-tools">` +
    `<button type="button" class="card-btn" data-move="up" title="上移" aria-label="上移">&uarr;</button>` +
    `<button type="button" class="card-btn" data-move="down" title="下移" aria-label="下移">&darr;</button>` +
    `<button type="button" class="card-btn" data-wide title="宽窄" aria-label="宽窄">&harr;</button>` +
    `<button type="button" class="card-btn" data-hide title="移除" aria-label="移除">&times;</button>` +
    `</div></div>` +
    `<div class="card-body">${card.body()}</div>` +
    `</section>`;
}

/** The bodies alone, for a partial refresh. */
function renderCardBodies(m, only) {
  const wanted = only && only.length ? new Set(only) : null;
  const out = {};
  for (const card of cardRegistry(m)) {
    if (wanted && !wanted.has(card.id)) continue;
    out[card.id] = card.body();
  }
  return out;
}

function render(m) {
  const cards = cardRegistry(m);
  return `<!doctype html>
<html lang="zh"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
${/* The no-javascript fallback, and only that. With the script running, each card
      refreshes on its own cadence and a whole-page reload would throw away the layout
      the operator arranged and the log they had scrolled back through. Without it, this
      is the page exactly as it behaved before. */''}
<noscript>${m.refresh_seconds ? `<meta http-equiv="refresh" content="${m.refresh_seconds}">` : '<!-- no auto-refresh: a form is on screen and a reload would empty it -->'}</noscript>
<title>抽签管理台 · 事件 ${esc(m.event_id)}</title>
<link rel="stylesheet" href="/admin.css">
<script src="/admin.js" defer></script>
</head><body><main>

<h1>抽签管理台</h1>
<p class="sub">Pantheon 事件 ${esc(m.event_id)} · 第 ${m.attempt} 次开奖 ·
  <span class="badge b-${esc(m.phase)}">${esc(m.phase)}</span> ·
  ${esc(m.node_env)} / pantheon:${esc(m.pantheon_mode)}</p>

<div class="bar" data-bar hidden>
  <span class="dim">已移除：</span>
  <span data-palette></span>
  <button type="button" class="card-btn" data-reset>恢复默认布局</button>
</div>

<div class="grid" data-grid>
${cards.map(cardHtml).join('\n')}
</div>

<footer>
  ${esc(m.generated_at)} · <span data-refresh-note>${
    m.refresh_seconds
      ? `每张卡片按自己的节奏刷新${m.refresh_why === 'final' ? '（等信标落地）' : m.refresh_why === 'draw' ? '（开奖进行中）' : ''}`
      : '决赛轮的表单在屏幕上，那张卡片会停住不刷新，以免把填到一半的内容清空'
  }</span> · 开奖与重置仍然只能在机器上用命令执行
</footer>
</main></body></html>`;
}

module.exports = {
  collect, render, renderCardBodies, cardRegistry, bundleDigest,
  ADMIN_STYLE: STYLE, ADMIN_SCRIPT: SCRIPT,
};
