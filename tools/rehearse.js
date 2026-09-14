#!/usr/bin/env node
'use strict';

/**
 * RUNBOOK sections B, C and D, performed end to end, in a sandbox.
 *
 * Section A has test/e2e.js: a real drand round, real tlock, the real finalisation job.
 * B, C and D had nothing. They are the half that is performed by a person, once, on the
 * day — snapshot the roster, pick the round, freeze, tag, chase the stragglers, confirm
 * the draw ran and the sync took — and the day is the worst possible time to discover
 * that a step does not work. It did not: the first thing this found was that
 * tools/freeze.js could not perform step 10 at all, because writing data/roster.json is
 * its job and it refused to start without a data/roster.json. See §6e of
 * docs/IMPLEMENTATION_NOTES.md.
 *
 *   node tools/rehearse.js               the whole of B, C and D, about three minutes
 *   node tools/rehearse.js --window 300  a longer submission window
 *   node tools/rehearse.js --gap 120    a longer interval between cutoff and beacon
 *   node tools/rehearse.js --keep        leave the sandbox behind to poke at
 *
 * What is real here: the commands, the HTTP server as its own process, real tlock
 * sealing, a real drand quicknet round, the finalisation job as a separate process the
 * way cron runs it, a real git commit and tag, and the verification a participant does.
 *
 * What is not: Pantheon (the stub, pointed at a registration list this repository has
 * not seen, so the roster snapshot has something to snapshot), the players (no browser
 * drives the frozen bundle — e2e has the same gap and for the same reason), and
 * mirroring to GitHub (that needs a token, and the dashboard is asserted to say so).
 *
 * The sandbox is a fresh git repository built from this working tree, not a clone of
 * HEAD: what you are about to freeze is what you have, and a rehearsal of the last
 * commit would quietly skip anything not yet committed.
 */

const assert = require('node:assert/strict');
const { execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const ok = (s) => console.log(`  \x1b[32mOK\x1b[0m    ${s}`);
const note = (s) => console.log(`        ${s}`);
// Elapsed time on every step. The rehearsal is a stopwatch as much as a check: the
// submission window has to outlast the freeze, and the only way to choose it is to
// know how long each step actually takes on the machine it runs on.
const START = Date.now();
const elapsed = () => `${String(Math.round((Date.now() - START) / 1000)).padStart(3)}s`;
const step = (s) => console.log(`\n${dim(`[${elapsed()}]`)} ${bold(s)}`);

// The "Pantheon side" of the world: thirteen registrations for an event this repository
// has never heard of, one of whom is present but not playing (RUNBOOK step 8).
const EVENT_ID = 4242;
const TITLES = ['阿明', '小美', '老陈', '阿杰', '小婷', '大伟', '阿芳', '志强', '小雨', '建国', '慧敏', '文彬'];
const EVENT = {
  pantheon_event_id: EVENT_ID,
  players: [
    ...TITLES.map((title, i) => ({ local_id: i + 1, person_id: 5001 + i, title })),
    { local_id: 0, person_id: 5099, title: '记录员（不参加座次）', ignore_seating: true },
  ],
};

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i].replace(/^--/, '');
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) out[k] = true;
    else { out[k] = v; i++; }
  }
  return out;
}

// ---------------------------------------------------------------------------
// the sandbox
// ---------------------------------------------------------------------------

/**
 * A throwaway git repository holding exactly this working tree's tracked files.
 *
 * It has to be a real repository, because step 11 commits and tags and that is a step
 * that can fail. It has to be somewhere else, because step 11 commits and tags.
 */
function makeSandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mjs-rehearsal-'));
  // Steps 9 and 10 exist to produce these two, so a rehearsal that starts with the last
  // event's copies is not rehearsing either of them. It is not academic: freeze.js takes
  // the event id from an existing roster.json in preference to --event, on purpose, so
  // step 10's refusals would run against whatever event this tree was last pointed at
  // and report "0 seated players" instead of the refusal being tested.
  //
  // They are gitignored in this repository, so here the filter is belt and braces. It
  // is load-bearing in an operator's tree: once they have frozen an event, freeze.js has
  // force-added both, `git ls-files` lists them, and a rehearsal for the NEXT event
  // would silently inherit the last one's roster.
  const MADE_BY_STEPS_9_AND_10 = new Set(['data/protocol.json', 'data/roster.json']);
  const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' })
    .split('\0').filter(Boolean)
    .filter((rel) => !MADE_BY_STEPS_9_AND_10.has(rel.replace(/\\/g, '/')));
  for (const rel of tracked) {
    const dest = path.join(dir, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(ROOT, rel), dest);   // bytes, not lines: see .gitattributes
  }
  // Linked rather than installed: npm ci against the network would be testing npm.
  fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(dir, 'node_modules'), 'junction');

  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  // A local identity, so the rehearsal neither depends on nor borrows the operator's.
  git('config', 'user.email', 'rehearsal@example.invalid');
  git('config', 'user.name', 'rehearsal');
  git('add', '-A');
  // What the baseline commits has to be exactly what was copied in, and once it was not.
  // The junction above is a symbolic link on Linux, .gitignore said `node_modules/`, and a
  // trailing slash matches only directories — a symlink is a file to git. So the sandbox
  // committed, froze and tagged a link into the operator's home directory, and the failure
  // surfaced three minutes later at step 16 as an EEXIST from a clone that already had a
  // node_modules. Never on Windows, where the same call makes a junction that git does read
  // as a directory: the rehearsal was green here and broken on the machine it is for.
  //
  // So this is checked rather than trusted. Anything the ignore rules let through lands in
  // the tag, which is the artefact twelve people are told to check out.
  const copied = new Set(tracked.map((rel) => rel.replace(/\\/g, '/')));
  const strays = git('ls-files', '-z').split('\0').filter(Boolean).filter((f) => !copied.has(f));
  if (strays.length) {
    throw new Error(
      `the sandbox committed ${strays.length} file(s) that were not copied into it: ` +
      `${strays.join(', ')}.\n  Whatever .gitignore is meant to be keeping out of the freeze is not ` +
      `being kept out. A pattern ending in / matches directories only, and a symbolic link ` +
      `is not one.`);
  }
  git('commit', '-q', '-m', 'rehearsal baseline: the working tree as it stands');
  return { dir, tracked: tracked.length };
}

// ---------------------------------------------------------------------------
// running the real commands
// ---------------------------------------------------------------------------

function makeRunner(dir, env) {
  /** Runs a command in the sandbox and returns its output; throws with the output. */
  return function run(args, opts = {}) {
    try {
      return execFileSync(process.execPath, args, {
        cwd: dir, encoding: 'utf8', stdio: 'pipe',
        env: { ...process.env, ...env, ...(opts.env || {}) },
      });
    } catch (err) {
      const out = String(err.stdout || '') + String(err.stderr || '');
      if (opts.expectFailure) return out;
      throw new Error(`${args.join(' ')} failed:\n${out}`);
    }
  };
}

const strip = (s) => s.replace(/\x1b\[\d+m/g, '');

// ---------------------------------------------------------------------------
// the player side
// ---------------------------------------------------------------------------

async function signIn(base, personId) {
  const res = await fetch(`${base}/api/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ person_id: personId, auth_token: `token-${personId}` }),
  });
  assert.equal(res.status, 200, `sign-in for ${personId} returned ${res.status}`);
  const cookie = res.headers.getSetCookie?.()[0];
  return cookie.split(';')[0];
}

async function submit(base, cookie, payload, cfg) {
  const { encryptPayload } = require('../server/tlock');
  const ciphertext = await encryptPayload(payload, cfg.protocol.target_round, cfg);
  const res = await fetch(`${base}/api/submit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ ciphertext }),
  });
  assert.equal(res.status, 201, `submit returned ${res.status}: ${await res.text()}`);
  return ciphertext;
}

// ---------------------------------------------------------------------------

async function main(argv) {
  const args = parseArgs(argv);
  // The window has to outlast step 11 itself: freeze.js re-derives the template,
  // rebuilds the bundle from source and runs the whole unit suite before it will
  // write anything, which is most of a minute. A window shorter than that expires
  // during the freeze and the rehearsal fails on its own timing rather than on
  // anything it was meant to exercise.
  // Measured, not guessed, and with room: steps 10 and 11 run tools/freeze.js four
  // times between them and two of those run the whole unit suite and rebuild the
  // bundle. On an idle machine that is about 35 seconds; sharing the machine with
  // anything else it has been seen at 65, and the suite grows every time something is
  // pinned. A window that expires before step 12 fails the rehearsal on its own timing
  // rather than on anything it was meant to exercise, and the symptom — a server
  // reporting `void` at boot — points nowhere near the cause.
  const windowSec = Number(args.window || 120);
  // The rehearsal takes the shortest interval the protocol allows. A real freeze uses
  // ten minutes (PROTOCOL.md section 9); waiting that long here would make the one
  // command nobody runs the one that matters most.
  const gapSec = Number(args.gap || 60);
  const tag = `rehearsal-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 13)}`;

  const { dir, tracked } = makeSandbox();
  const eventFile = path.join(dir, 'pantheon-event.json');
  fs.writeFileSync(eventFile, JSON.stringify(EVENT, null, 2));
  const env = { PANTHEON_MODE: 'stub', PANTHEON_STUB_ROSTER: eventFile, NODE_ENV: 'development' };
  const run = makeRunner(dir, env);
  let child = null;
  // Kept out here so the failure path can read it: everything after step 12 talks to
  // a server in another process, and an assertion there reports a status code.
  let serverLog = '';

  console.log(bold('\nRehearsal — RUNBOOK B, C and D, in a sandbox'));
  note(`${dir}`);
  note(`${tracked} tracked files, committed as the baseline; Pantheon is the stub, drand is real`);

  try {
    // ---- B, step 8 --------------------------------------------------------
    step('B8: the event as Pantheon has it');
    note(`event ${EVENT_ID}: ${EVENT.players.length} registered, one of them ignore_seating`);
    note('nothing in the repository knows any of this yet — that is the point of step 10');

    // ---- B, step 9 --------------------------------------------------------
    step('B9: choose the target round and the cutoff together');
    fs.copyFileSync(path.join(dir, 'data', 'protocol.example.json'), path.join(dir, 'data', 'protocol.json'));
    const picked = run([
      'tools/pick-round.js', '--in', `${windowSec + gapSec}s`, '--gap', String(gapSec), '--write',
    ]);
    const protocol = JSON.parse(fs.readFileSync(path.join(dir, 'data', 'protocol.json'), 'utf8'));
    assert.ok(protocol.target_round > 0 && protocol.chain_public_key, 'pick-round must write both');
    ok(`target_round ${protocol.target_round}, cutoff ${protocol.submission_cutoff_utc}`);
    note(`chain pinned by hash and public key from the live chain, not from a constant in the tool`);
    assert.match(picked, /written to data\/protocol\.json/);

    // ---- B, step 10 -------------------------------------------------------
    step('B10: snapshot the roster out of Pantheon');

    // Before the good run: prove the refusals fire. Each of these otherwise lands after
    // the draw, and a rehearsal that only exercises the happy path proves nothing about
    // the day something is wrong.
    const broken = { ...EVENT, players: EVENT.players.map((p) => (p.local_id === 7 ? { ...p, local_id: null } : p)) };
    fs.writeFileSync(path.join(dir, 'broken-event.json'), JSON.stringify(broken));
    const refusal = run(['tools/freeze.js', '--event', String(EVENT_ID), '--write'],
      { env: { PANTHEON_STUB_ROSTER: path.join(dir, 'broken-event.json') }, expectFailure: true });
    assert.match(refusal, /no usable local_id for: 阿芳/);
    assert.match(refusal, /NOT FROZEN/);
    assert.ok(!fs.existsSync(path.join(dir, 'data', 'roster.json')), 'a refused freeze must write nothing');
    ok('a player with no local_id is refused, and nothing is written');
    note('that one blocks the seat-plan sync, which runs after the draw');

    // Exits non-zero, and should: nothing was frozen. The point is what it did not do.
    const dry = run(['tools/freeze.js', '--event', String(EVENT_ID)], { expectFailure: true });
    assert.match(strip(dry), /no usable data\/roster\.json yet/);
    assert.ok(!fs.existsSync(path.join(dir, 'data', 'roster.json')), 'without --write, nothing is written');
    ok('without --write the command says what it would do and writes nothing');

    const snapped = run(['tools/freeze.js', '--event', String(EVENT_ID), '--write']);
    assert.match(strip(snapped), /data\/roster\.json created from Pantheon event 4242 \(12 players\)/);
    const roster = JSON.parse(fs.readFileSync(path.join(dir, 'data', 'roster.json'), 'utf8'));
    assert.equal(roster.players.length, 12);
    assert.ok(!roster.players.some((p) => p.person_id === 5099), 'ignore_seating must not be seated');
    ok(`data/roster.json written: 12 players, the 13th left out because they are not playing`);

    // ---- B, step 11 -------------------------------------------------------
    step('B11: freeze and tag');
    const frozen = run(['tools/freeze.js', '--event', String(EVENT_ID), '--write', '--tag', tag]);
    const clean = strip(frozen);
    for (const line of ['the template re-derives every proved invariant',
                        'the committed bundle rebuilds byte for byte from source',
                        'unit test files pass']) {
      assert.ok(clean.includes(line), `the freeze must run: ${line}`);
    }
    assert.match(clean, new RegExp(`as ${tag}`));
    ok('template invariants, bundle rebuild and unit tests all ran before anything was committed');

    const inTag = execFileSync('git', ['show', '--name-only', '--format=', tag],
      { cwd: dir, encoding: 'utf8' }).trim().split('\n').filter(Boolean).sort();
    assert.deepEqual(inTag, ['data/protocol.json', 'data/roster.json'],
      `the freeze commit should hold only what step 10 and 11 changed, got ${inTag.join(', ')}`);
    ok(`tag ${tag} exists; the freeze commit carries ${inTag.join(' + ')}`);
    note('the other two frozen files and the bundle were already committed, so git had nothing to add');
    assert.match(clean, /Announcement \(RUNBOOK step 12\)/);
    assert.ok(clean.includes(String(protocol.target_round)), 'the announcement must name the round');
    ok('the step 12 announcement printed, with the round, the cutoff and the tag in it');

    // ---- C, step 12 -------------------------------------------------------
    step('C12: open the window — the server, as its own process');
    const port = 18080 + (process.pid % 500);
    const adminToken = require('node:crypto').randomBytes(16).toString('hex');
    child = spawn(process.execPath, ['server/server.js'], {
      cwd: dir,
      env: {
        ...process.env, ...env, PORT: String(port), ADMIN_TOKEN: adminToken,
        // Player 1 administers the event (Frey GetOwnedEventIds, stood in for here), so
        // the dashboard-by-identity path is exercised alongside the token one.
        PANTHEON_STUB_ADMIN_IDS: String(EVENT.players[0].person_id),
        // The deployed default is that the server draws, on its own timer. Five seconds
        // rather than sixty only so the rehearsal is not mostly spent waiting for a
        // tick; everything else about the path is the shipped one.
        FINALISE_INTERVAL_SECONDS: '5',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const base = `http://127.0.0.1:${port}`;
    // Kept for the whole run, not just the boot: step 14 asks this log who drew, and
    // the failure path below prints its tail.
    child.stdout.on('data', (d) => { serverLog += d; });
    child.stderr.on('data', (d) => { serverLog += d; });
    const boot = await new Promise((resolve, reject) => {
      // The last of the lines it logs on boot, not the first: the ones that say which
      // Pantheon, whether the dashboard is on and who runs the draw come after
      // "listening".
      const look = () => { if (serverLog.includes('running server/finalise.js every')) resolve(serverLog); };
      child.stdout.on('data', look);
      child.stderr.on('data', look);
      child.on('exit', (code) => reject(new Error(`server exited ${code}:\n${serverLog}`)));
      setTimeout(() => reject(new Error(`server did not start:\n${serverLog}`)), 20_000);
    });
    assert.match(boot, /StubPantheon/);
    assert.match(boot, /admin dashboard at \/admin/);
    // A log line is not a running server. The entry point does more after that line,
    // and a throw in any of it leaves a process that announced itself and then died —
    // which is exactly what happened once: the boot check passed and step 13 failed
    // with "fetch failed", three steps from the cause. Ask it something instead.
    const alive = await fetch(`${base}/api/status`).then((r) => r.json());
    if (alive.phase !== 'open') {
      const late = Math.round((Date.now() - Date.parse(protocol.submission_cutoff_utc)) / 1000);
      throw new Error(
        `the window closed before step 12 could open it: phase ${alive.phase}, cutoff ` +
        `${protocol.submission_cutoff_utc} passed ${late}s ago. Steps 10 and 11 took longer than ` +
        `the ${windowSec}s window; re-run with --window ${Math.max(windowSec, late + windowSec + 60)}.`);
    }
    assert.equal(child.exitCode, null, 'the server exited after logging that it had started');
    ok(`server up on ${base}, event ${EVENT_ID}, admin dashboard enabled, /api/status answering`);
    note('it also runs the draw itself, every 5s here — that is the deployed default');

    // The dashboard follows Pantheon identity, not only ADMIN_TOKEN: player 1 is an event
    // admin, so their ordinary session opens /admin, and a player's session does not.
    {
      const asAdmin = await fetch(`${base}/api/session`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ person_id: roster.players[0].person_id, auth_token: `token-${roster.players[0].person_id}` }),
      });
      const adminBody = await asAdmin.json();
      assert.equal(adminBody.is_admin, true, 'the event admin must sign in with is_admin set');
      const adminCookie = asAdmin.headers.getSetCookie?.()[0].split(';')[0];
      const openBySession = await fetch(`${base}/admin`, { headers: { cookie: adminCookie } });
      assert.equal(openBySession.status, 200, 'an admin session must open /admin with no token');

      const asPlayer = await fetch(`${base}/api/session`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ person_id: roster.players[1].person_id, auth_token: `token-${roster.players[1].person_id}` }),
      });
      const playerBody = await asPlayer.json();
      assert.equal(playerBody.is_admin, false, 'an ordinary player is not an admin');
      const playerCookie = asPlayer.headers.getSetCookie?.()[0].split(';')[0];
      const denied = await fetch(`${base}/admin`, { headers: { cookie: playerCookie } });
      assert.equal(denied.status, 404, 'a player session must not open /admin');
      ok('the dashboard follows Pantheon identity: admin session opens /admin, a player session gets 404');
    }

    const { load } = require('../server/config');
    const cfg = load({ dataDir: path.join(dir, 'data') });
    const payloadFor = (i) => ({
      user_input: (i * 37 + 11) % 256,
      client_nonce: require('node:crypto').randomBytes(16).toString('hex'),
      client_timestamp: new Date().toISOString(),
    });

    // ---- C, step 13 -------------------------------------------------------
    step('C13: chase the stragglers');
    const ciphertexts = [];
    const t0 = Date.now();
    for (let i = 0; i < 7; i++) {
      const cookie = await signIn(base, roster.players[i].person_id);
      ciphertexts.push(await submit(base, cookie, payloadFor(i), cfg));
    }
    ok(`7 of 12 sealed and submitted in ${((Date.now() - t0) / 1000).toFixed(1)}s, real tlock`);

    const adminHtml = await fetch(`${base}/admin?token=${adminToken}`).then((r) => r.text());
    const adminJson = await fetch(`${base}/admin/data.json?token=${adminToken}`).then((r) => r.json());
    const missing = adminJson.roster.filter((p) => !p.submitted).map((p) => p.title);
    assert.deepEqual(missing, TITLES.slice(7), 'the chase list must be exactly who has not submitted');
    for (const title of missing) assert.ok(adminHtml.includes(title), `${title} must be on the page`);
    ok(`the dashboard names the five to chase: ${missing.join('、')}`);

    // The rule the dashboard is most likely to break, being the one screen whose job is
    // to show the organiser more than a player sees.
    for (const c of ciphertexts) {
      assert.ok(!adminHtml.includes(c), 'a ciphertext reached the admin page');
      assert.ok(!JSON.stringify(adminJson).includes(c), 'a ciphertext reached /admin/data.json');
    }
    assert.ok(adminJson.roster.every((p) => !('user_input' in p)));
    ok('no ciphertext and no number anywhere on the page or in its JSON — only who, and when');

    assert.equal(adminJson.mirror_enabled, false);
    assert.equal(adminJson.pantheon_mode, 'stub');
    const alarms = adminJson.checks.filter((c) => c.level !== 'ok').map((c) => c.label);
    assert.ok(alarms.some((l) => /[Mm]irror/.test(l)), 'mirroring off must show as a check');
    assert.ok(alarms.some((l) => /Pantheon/.test(l)), 'the stub must show as a check');
    ok(`the pre-flight panel refuses to call this deployment ready: ${alarms.join('; ')}`);

    for (let i = 7; i < 12; i++) {
      const cookie = await signIn(base, roster.players[i].person_id);
      ciphertexts.push(await submit(base, cookie, payloadFor(i), cfg));
    }
    const status = await fetch(`${base}/api/status`).then((r) => r.json());
    assert.equal(status.submitted_count, 12);
    assert.equal(status.phase, 'open');
    ok('12 of 12 in, phase still open — nothing draws before the cutoff');

    // ---- D, step 14 -------------------------------------------------------
    const cutoffMs = Date.parse(protocol.submission_cutoff_utc);
    step(`D14: wait for the cutoff, and let the server draw on its own`);
    // Redrawn in place on a terminal; once every half minute when this is piped into a
    // file, where a carriage return only makes one very long line.
    const tty = process.stdout.isTTY;
    let announced = 0;
    while (Date.now() < cutoffMs) {
      const left = Math.ceil((cutoffMs - Date.now()) / 1000);
      if (tty) process.stdout.write(`\r        ${left}s to go   `);
      else if (announced === 0 || announced - left >= 30) { note(`${left}s to go`); announced = left; }
      await new Promise((r) => setTimeout(r, Math.min(2000, cutoffMs - Date.now() + 50)));
    }
    process.stdout.write(tty ? '\r        cutoff reached        \n' : '        cutoff reached\n');

    // Nothing is run by hand here, deliberately. Nobody installs a timer during a
    // rehearsal, and for a while nobody had to be told to: the server served the page,
    // the countdown reached zero and the draw never happened, because the only
    // documented scheduler was a systemd unit. The server owns that schedule now, and
    // this step is the test of it — what it waits for is the server noticing by itself.
    const resultsFile = path.join(dir, 'results.json');
    const drawBy = Date.parse(protocol.target_round_utc) + 90_000;
    while (!fs.existsSync(resultsFile)) {
      if (Date.now() > drawBy) {
        throw new Error(`nothing drew within 90s of round ${protocol.target_round}. Server log:\n${serverLog.slice(-2000)}`);
      }
      const to = Math.ceil((Date.parse(protocol.target_round_utc) - Date.now()) / 1000);
      if (tty) process.stdout.write(`\r        ${to > 0 ? `${to}s to the round` : 'waiting for the draw'}   `);
      await new Promise((r) => setTimeout(r, 1000));
    }
    if (tty) process.stdout.write('\r                                   \r');
    const results = JSON.parse(fs.readFileSync(resultsFile, 'utf8'));
    assert.equal(results.round_used, protocol.target_round);
    // If any were excluded, the reason is the whole story and it is already recorded.
    // Reporting the count alone sends the reader looking for a sandbox that has usually
    // been deleted by then.
    assert.equal(results.participating_local_ids.length, 12,
      `only ${results.participating_local_ids.length} of 12 took part. Excluded: ` +
      `${JSON.stringify(results.excluded_local_ids)}`);
    assert.match(serverLog, /\[schedule\]|\[finalise\]/,
      'the draw happened but the server log says nothing about running it');
    ok(`the server drew it with nobody asking: round ${results.round_used}, 12 contributions, ` +
       `seed ${results.seed.slice(0, 16)}…`);

    // The same job by hand, which is what RUNBOOK's manual remedies run. It has to be
    // safe on an already-finished draw, because that is when someone reaches for it.
    const again = strip(run(['server/finalise.js']));
    assert.match(again, /already done/);
    assert.deepEqual(JSON.parse(fs.readFileSync(resultsFile, 'utf8')), results,
      'running the job by hand after the draw changed results.json');
    ok('running it again by hand is a no-op: "already done", results.json untouched');

    const verify = run(['generate.js', '--verify', 'results.json']);
    assert.match(strip(verify), /reproduces byte for byte/);
    assert.match(strip(verify), /12 submitted at the cutoff/);
    ok('results.json reproduces byte for byte, and the roll-call agrees with the snapshot');

    // ---- D, step 15 -------------------------------------------------------
    step('D15: confirm the sync took');
    const sync = JSON.parse(fs.readFileSync(path.join(dir, 'events', 'sync.json'), 'utf8'));
    assert.equal(sync.status, 'ok', `sync status was ${sync.status}`);
    ok(`events/sync.json says ok — the prescript was written and read back and matched`);

    const afterJson = await fetch(`${base}/admin/data.json?token=${adminToken}`).then((r) => r.json());
    assert.equal(afterJson.phase, 'done');
    assert.equal(afterJson.pantheon_sync.status, 'ok');
    assert.equal(afterJson.result.round_used, protocol.target_round);
    ok('the dashboard shows phase done, the result, and the sync — without a restart');

    // ---- D, step 16 -------------------------------------------------------
    step('D16: what a player can check, from the tag and the published file');
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'mjs-verifier-'));
    execFileSync('git', ['clone', '--quiet', '--no-hardlinks', '--branch', tag, dir, path.join(outside, 'repo')],
      { stdio: 'pipe' });
    const repo = path.join(outside, 'repo');
    fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(repo, 'node_modules'), 'junction');
    // A participant downloads the published result; everything else they take from the tag.
    fs.copyFileSync(path.join(dir, 'results.json'), path.join(repo, 'results.json'));
    fs.mkdirSync(path.join(repo, 'events'), { recursive: true });
    fs.copyFileSync(path.join(dir, 'events', 'snapshot.json'), path.join(repo, 'events', 'snapshot.json'));

    const theirs = execFileSync(process.execPath, ['generate.js', '--verify', 'results.json'],
      { cwd: repo, encoding: 'utf8', stdio: 'pipe' });
    assert.match(strip(theirs), /reproduces byte for byte/);
    ok(`a fresh clone at ${tag} recomputes the same seat plan from results.json alone`);
    const bundle = execFileSync(process.execPath, ['tools/build-client.js', '--verify-hash'],
      { cwd: repo, encoding: 'utf8', stdio: 'pipe' });
    assert.match(strip(bundle), /committed bundle matches its hash/);
    ok('and the bundle in that clone is byte-identical to the one that took their number');
    fs.rmSync(outside, { recursive: true, force: true });

    console.log(`\n${bold('B, C and D done.')} Everything above ran; nothing was simulated except Pantheon.`);
    return 0;
  } catch (err) {
    // Past step 12 the thing being exercised is a server in another process, and what
    // reaches this catch is a status code: "sign-in for 5001 returned 500" names the
    // symptom and nothing else. The stack that explains it was printed by that process
    // into a pipe read by nobody. Attach it.
    if (serverLog.trim()) {
      const tail = serverLog.slice(-3000).replace(/^/gm, '    ');
      err.message += `\n\n  last of the server log:\n${tail}`;
    }
    throw err;
  } finally {
    if (child && child.exitCode === null) {
      child.kill();
      // Windows holds var/state.sqlite until the process is actually gone, and a rmSync
      // that races it fails with EPERM — which then masks whatever went wrong above.
      await new Promise((r) => { child.once('exit', r); setTimeout(r, 3000); });
    }
    if (args.keep) console.log(`\n  sandbox kept at ${dir}`);
    else {
      try {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
      } catch {
        console.log(`  could not remove the sandbox; it is at ${dir}`);
      }
    }
  }
}

if (require.main === module) {
  main(process.argv.slice(2))
    .then((c) => process.exit(c || 0))
    .catch((err) => {
      console.error(`\n  \x1b[31mREHEARSAL FAILED\x1b[0m  ${err.message}`);
      process.exit(1);
    });
}

// tools/demo.js is the same sandbox, the same stub event and the same simulated
// players, with a browser pointed at it instead of assertions.
module.exports = { makeSandbox, makeRunner, signIn, submit, strip, EVENT, EVENT_ID, TITLES };
