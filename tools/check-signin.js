#!/usr/bin/env node
'use strict';

/**
 * One account's sign-in, walked without the relay, step by step (deploy/README.md §6).
 *
 *   1. the call the BROWSER makes: Frey Authorize with email + password
 *   2. the re-check the RELAY makes: Frey QuickAuthorize with the token from step 1
 *   3. the registration the RELAY checks: Mimir GetAllRegisteredPlayers
 *   4. with --admin: the credentials the seat-plan sync will use, as far as a read-only
 *      call can check them
 *
 *   node tools/check-signin.js --email you@example.com
 *   node tools/check-signin.js --email you@example.com --event 2 \
 *       --frey https://userapi.example --mimir https://gameapi.example
 *   node tools/check-signin.js --admin --event 2
 *
 * The URLs default to what the server itself would use: data/runtime.json, then the
 * environment, then the shipped defaults (server/runtime.js). The event id defaults to
 * data/roster.json's, when there is one.
 *
 * The password is read from a hidden prompt (or the first line of stdin when piped) and
 * never printed. Neither is any token — not the player's, and not the admin's, which
 * comes from PANTHEON_ADMIN_PERSON_ID / PANTHEON_ADMIN_TOKEN in the environment or in
 * .env, the same place the server reads it. Only statuses, Twirp codes and this one
 * person's own registration are shown, so the output can be pasted to whoever is helping.
 *
 * Why it exists: the first production sign-in failed with "Pantheon did not recognise
 * that email and password", and at the time that sentence covered a wrong password, a
 * server that was down, a shared rate limit, a 500 and a cookie the browser would not
 * keep. This walks the Pantheon half in isolation. What it cannot see is the relay, and
 * the page names those failures apart itself now (client/api.js, signInProblem).
 */

const fs = require('node:fs');
const path = require('node:path');

const { TwirpPantheon } = require(path.join(__dirname, '..', 'server', 'pantheon'));
const { loadRuntime, freyPublicUrl } = require(path.join(__dirname, '..', 'server', 'runtime'));
const { loadEnvFile, ROOT } = require(path.join(__dirname, '..', 'server', 'config'));

const LF = String.fromCharCode(10);
const TIMEOUT_MS = 15_000;

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const k = argv[i].slice(2);
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) out[k] = true;
    else { out[k] = v; i++; }
  }
  return out;
}

function askHidden(prompt) {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    if (!stdin.isTTY) {
      let data = '';
      stdin.setEncoding('utf8');
      stdin.on('data', (d) => { data += d; });
      stdin.on('end', () => resolve(data.split(LF)[0].replace(String.fromCharCode(13), '')));
      return;
    }
    process.stdout.write(prompt);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let pw = '';
    const onData = (chunk) => {
      for (const ch of chunk) {
        const c = ch.charCodeAt(0);
        if (c === 13 || c === 10 || c === 4) {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off('data', onData);
          process.stdout.write(LF);
          resolve(pw);
          return;
        }
        if (c === 3) { process.stdout.write(LF); process.exit(130); }
        if (c === 127 || c === 8) pw = pw.slice(0, -1);
        else pw += ch;
      }
    };
    stdin.on('data', onData);
  });
}

// What the page shows for each outcome (client/stages/SignIn.jsx), so a line here can
// be matched to what a player saw.
const PAGE = {
  bad_credentials: 'Pantheon 不认识这个邮箱和密码。',
  unknown_account: 'Pantheon 里没有这个邮箱的账号。',
  pantheon_misconfigured: '这次抽签的 Pantheon 地址配置有误……',
  pantheon_error: 'Pantheon 出错了……',
  pantheon_unreachable: '连不上 Pantheon……',
  pantheon_unavailable: '抽签服务器现在连不上 Pantheon……',
  not_registered: '这个账号没有报名本次活动，无法参加抽签。',
};
const says = (kind) => `   the page would say: ${PAGE[kind]}  [${kind}]`;

const usage = () => {
  console.error('usage: node tools/check-signin.js --email <email> [--event <id>] [--frey <url>] [--mimir <url>]');
  console.error('       node tools/check-signin.js --admin [--event <id>] [--mimir <url>]');
  process.exit(2);
};

/** Steps 1–3: one player. Returns true when all three pass. */
async function checkPlayer({ email, eventId, browserFrey, frey, mimir }) {
  const password = await askHidden(`Pantheon password for ${email} (not shown): `);
  if (email.trim() !== email || password.trim() !== password) {
    console.log('  note: the email or password has leading/trailing spaces; the page sends them exactly as typed');
  }
  if (email !== email.toLowerCase()) {
    console.log('  note: the email has capital letters; a phone keyboard may have added one');
  }

  // ---- 1. the browser's call ------------------------------------------------
  const url = `${browserFrey}/v2/common.Frey/Authorize`;
  console.log(`${LF}1. browser -> Frey Authorize  ${url}`);
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ email, password }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    console.log(`   FAIL  no answer: ${e.cause ? `${e.cause.code} ${e.cause.message}` : e.message}`);
    console.log(says('pantheon_unreachable'));
    console.log('   from a browser the same failure also comes from a CSP connect-src without this origin');
    return false;
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const code = body && body.code;
    // The same classification as authorize() in client/api.js.
    const kind = !body || code === 'bad_route' ? 'pantheon_misconfigured'
      : code === 'not_found' ? 'unknown_account'
        : res.status >= 500 ? 'pantheon_error' : 'bad_credentials';
    console.log(`   FAIL  HTTP ${res.status} ${code || '(not a Twirp answer)'}${body && body.msg ? `: ${body.msg}` : ''}`);
    console.log(says(kind));
    console.log('   stopped here: Frey refused in the browser, so the relay was never asked.');
    return false;
  }
  const personId = Number(body && (body.person_id ?? body.personId));
  const token = body && (body.auth_token ?? body.authToken);
  if (!personId || !token) {
    console.log('   FAIL  HTTP 200 but no personId/authToken in the answer');
    console.log(says('pantheon_misconfigured'));
    return false;
  }
  console.log(`   OK    Frey accepted the password; personId ${personId}`);

  // ---- 2. the relay's re-check ----------------------------------------------
  const pantheon = new TwirpPantheon({ frey_base_url: frey, mimir_base_url: mimir }, {}, { timeoutMs: TIMEOUT_MS });
  console.log(`${LF}2. relay -> Frey QuickAuthorize  ${frey}/v2/common.Frey/QuickAuthorize`);
  try {
    const ok = await pantheon.verifyToken(personId, token);
    if (!ok) {
      console.log('   FAIL  Frey refused the token it had just issued');
      console.log(says('bad_credentials') + '  (the relay answers 401)');
      return false;
    }
    console.log('   OK    the token checks out');
  } catch (e) {
    console.log(`   FAIL  ${e.message}`);
    console.log(says('pantheon_unavailable') + '  (the relay answers 503)');
    return false;
  }

  // ---- 3. the relay's registration check ------------------------------------
  console.log(`${LF}3. relay -> Mimir GetAllRegisteredPlayers  event ${eventId}`);
  let live;
  try {
    live = await pantheon.getEventRoster(eventId);
  } catch (e) {
    console.log(`   FAIL  ${e.message}`);
    console.log(says('pantheon_unavailable') + '  (the relay answers 503)');
    return false;
  }
  console.log(`   ${live.length} registered for event ${eventId}`);
  const me = live.find((p) => Number(p.person_id) === personId);
  if (!me) {
    console.log(`   FAIL  personId ${personId} is not registered for event ${eventId}`);
    console.log(says('not_registered') + '  (the relay answers 403)');
    return false;
  }
  if (me.ignore_seating) {
    console.log('   FAIL  registered, but marked ignore_seating (attending, not playing)');
    console.log('   freeze.js leaves ignore_seating players out of data/roster.json, so the relay will answer 403.');
    return false;
  }
  console.log(`   OK    registered: local_id ${me.local_id ?? '(none)'}`);
  if (me.local_id == null) console.log('   note: no local_id yet, so freeze.js will refuse this roster until one is assigned');

  console.log(`${LF}All three Pantheon steps pass for this account. If the page still refused, it now says which`);
  console.log('of these it was: the draw server unreachable (nginx 502), rate limited (429), a server error');
  console.log('(500), sign-in over plain http, or a session the browser did not keep. And if it said "not');
  console.log('registered", this person is missing from data/roster.json on the server.');
  return true;
}

/** Step 4: the sync's credentials. Returns true when everything a read can show is fine. */
async function checkAdmin({ eventId, frey, mimir, env }) {
  console.log(`${LF}4. the seat-plan sync's credentials  (PANTHEON_ADMIN_PERSON_ID / PANTHEON_ADMIN_TOKEN)`);
  const id = Number(env.PANTHEON_ADMIN_PERSON_ID);
  const token = env.PANTHEON_ADMIN_TOKEN;
  if (!Number.isInteger(id) || !token) {
    console.log('   FAIL  not set. The server reads them from the environment or from .env at the');
    console.log('         repository root; this tool looks in the same two places.');
    return false;
  }
  const pantheon = new TwirpPantheon({ frey_base_url: frey, mimir_base_url: mimir }, env, { timeoutMs: TIMEOUT_MS });

  console.log(`   relay -> Frey QuickAuthorize  person id ${id}`);
  try {
    const ok = await pantheon.verifyToken(id, token);
    if (!ok) {
      console.log(`   FAIL  Frey refused the admin token for person id ${id}. Sign in as that account`);
      console.log('         on Pantheon and take auth_token from the answer; a password change invalidates it.');
      return false;
    }
    console.log('   OK    the admin token is valid');
  } catch (e) {
    console.log(`   FAIL  ${e.message}`);
    return false;
  }

  console.log(`   relay -> Mimir GetPrescriptedEventConfig  event ${eventId}, with the admin headers`);
  let current;
  try {
    current = await pantheon.getPrescript(eventId);
  } catch (e) {
    console.log(`   FAIL  ${e.message}`);
    return false;
  }
  const lines = current.prescript ? current.prescript.split(/\r?\n/).filter((l) => l.trim()).length : 0;
  console.log(`   OK    event ${eventId} answers: next_session_index ${current.next_session_index}, ` +
    (lines ? `a prescript of ${lines} line(s) ALREADY SET` : 'no prescript yet'));
  if (lines) {
    console.log('   note: the sync after the draw REPLACES this prescript and sets next_session_index to 1.');
    console.log('         If somebody entered a seating by hand, it will be gone.');
  }
  console.log('   note: on some Pantheon deployments this read is public, so it proves the route and the');
  console.log('         event, not the rights. The write (UpdatePrescriptedEventConfig) is refused without');
  console.log(`         event-admin scope, and it runs after the draw. Confirm in Pantheon that person id ${id}`);
  console.log(`         is an admin of event ${eventId} before the day.`);
  return true;
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  if (!a.email && !a.admin) usage();

  // The same sources, in the same order, as the server: .env, then the environment,
  // then data/runtime.json, then the defaults.
  const envFile = loadEnvFile(ROOT, { error() {} });
  if (envFile) console.log(`  read ${path.relative(ROOT, envFile)}`);
  const runtime = loadRuntime(path.join(ROOT, 'data'), process.env);

  const strip = (u) => String(u).replace(/\/+$/, '');
  const frey = strip(a.frey || runtime.pantheon.frey_base_url);
  const browserFrey = strip(a.frey || freyPublicUrl(runtime));
  const mimir = strip(a.mimir || runtime.pantheon.mimir_base_url);

  let eventId = Number(a.event);
  if (!Number.isInteger(eventId)) {
    try {
      eventId = Number(JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'roster.json'), 'utf8')).pantheon_event_id);
      console.log(`  event ${eventId}, from data/roster.json`);
    } catch { /* no roster yet */ }
  }
  if (!Number.isInteger(eventId)) {
    console.error('no event id: pass --event <id>, or freeze first so data/roster.json names one');
    process.exit(2);
  }

  let ok = true;
  if (a.email) ok = await checkPlayer({ email: String(a.email), eventId, browserFrey, frey, mimir }) && ok;
  if (a.admin) ok = await checkAdmin({ eventId, frey, mimir, env: process.env }) && ok;
  // Set rather than called: process.exit() with a fetch connection still open makes
  // Node on Windows fail fast (0xC0000409) and the exit code is lost with it. Nothing
  // holds the loop open, so the process ends on its own with this code.
  process.exitCode = ok ? 0 : 1;
}

main().catch((e) => { console.error(e); process.exit(1); });
