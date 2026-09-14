#!/usr/bin/env node
'use strict';

/**
 * The whole draw, on this machine, in about four minutes — `npm run demo`.
 *
 * A throwaway copy of the working tree gets a twelve-player event, a target round a few
 * minutes out, and the server, run exactly as an organiser runs it, except that Pantheon
 * is the in-process stub. You are player 1; the other eleven are simulated and submit
 * while you watch. Everything else is real: the timelock, the drand beacon, the draw,
 * the seat plan and the check a player can do afterwards. Ctrl+C removes the copy.
 *
 *   npm run demo                    a three-minute window, port 8080
 *   npm run demo -- --window 600    ten minutes to look around
 *   npm run demo -- --port 9000
 *   npm run demo -- --keep          leave the copy behind
 *
 * It needs the network: tools/pick-round.js pins the drand chain from the live chain
 * info, the browser seals against it, and the draw waits for the beacon.
 *
 * Why this exists: the README used to open with `npm test` and `npm run rehearse`, and
 * a reader who ran both saw 432 green lines and a headless transcript, and no page.
 * The rehearsal is the organiser's sequence with nothing to look at; this is the
 * player's, with everything to look at, and it is built from the same pieces.
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { makeSandbox, makeRunner, signIn, submit, EVENT, EVENT_ID, TITLES } = require('./rehearse');
const { load } = require('../server/config');

const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const LF = '\n';

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clock = (iso) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

async function main(argv) {
  const args = parseArgs(argv);
  const windowSec = Number(args.window || 180);
  const gapSec = Number(args.gap || 60);
  const port = Number(args.port || 8080);
  if (!(windowSec >= 90)) throw new Error('--window is in seconds and needs at least 90: the beacon is real and so is the clock');

  console.log(bold(`${LF}Demo — a complete draw, on this machine`));
  const { dir } = makeSandbox();
  console.log(dim(`  throwaway copy at ${dir}`));

  // Cleanup exists before anything can fail: a copy left behind by a failed setup is the
  // directory somebody finds in their temp folder a week later.
  let child = null;
  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    if (child && child.exitCode === null) {
      child.kill();
      await new Promise((r) => { child.once('exit', r); setTimeout(r, 3000); });
    }
    if (args.keep) console.log(`${LF}  copy kept at ${dir}`);
    else {
      try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }); }
      catch { console.log(`  could not remove the copy; it is at ${dir}`); }
    }
  };
  process.on('SIGINT', async () => { console.log(`${LF}  stopping`); await cleanup(); process.exit(0); });

  const base = `http://127.0.0.1:${port}`;
  let serverLog = '';
  try {
    // The "Pantheon side": thirteen registrations for an event this tree has never seen.
    const eventFile = path.join(dir, 'pantheon-event.json');
    fs.writeFileSync(eventFile, JSON.stringify(EVENT, null, 2));
    const env = {
      PANTHEON_MODE: 'stub', PANTHEON_STUB_ROSTER: eventFile, PANTHEON_STUB_EVENT_TITLE: 'Demo',
      NODE_ENV: 'development',
    };
    const run = makeRunner(dir, env);

    // What the organiser's freeze produces, produced directly: a round a few minutes
    // out, the roster, and a name in the two reference fields the result page reads.
    // The freeze command itself is not run here — its pre-flight rebuilds the bundle
    // and runs the whole suite, which is right for a freeze and forty seconds of
    // nothing to look at for a demo. `npm run rehearse` is where the freeze is exercised.
    fs.copyFileSync(path.join(dir, 'data', 'protocol.example.json'), path.join(dir, 'data', 'protocol.json'));
    run(['tools/pick-round.js', '--in', `${windowSec + gapSec}s`, '--gap', String(gapSec), '--write']);
    const roster = {
      pantheon_event_id: EVENT_ID,
      players: EVENT.players
        .filter((p) => !p.ignore_seating)
        .sort((a, b) => a.local_id - b.local_id)
        .map(({ local_id, person_id, title }) => ({ local_id, person_id, title })),
    };
    fs.writeFileSync(path.join(dir, 'data', 'roster.json'), JSON.stringify(roster, null, 2) + LF);
    const protocolFile = path.join(dir, 'data', 'protocol.json');
    const protocol = JSON.parse(fs.readFileSync(protocolFile, 'utf8'));
    protocol.schedule_template_ref = 'data/schedule_template.json@demo';
    protocol.generate_script_ref = 'generate.js@demo';
    fs.writeFileSync(protocolFile, JSON.stringify(protocol, null, 2) + LF);
    console.log(`  ${green('OK')}    event ${EVENT_ID}, twelve players, round ${protocol.target_round}`);

    // The server, as its own process, the way it is deployed. Five-second draw ticks
    // rather than sixty so the result appears within moments of the beacon.
    const adminToken = require('node:crypto').randomBytes(12).toString('hex');
    child = spawn(process.execPath, ['server/server.js'], {
      cwd: dir,
      env: {
        ...process.env, ...env, PORT: String(port), ADMIN_TOKEN: adminToken, FINALISE_INTERVAL_SECONDS: '5',
        // You (player 1) administer the event, so the header shows the organiser panel
        // once you sign in — the same thing a real event admin sees.
        PANTHEON_STUB_ADMIN_IDS: String(EVENT.players[0].person_id),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let lastShown = '';
    const forward = (d) => {
      serverLog += d;
      for (const line of String(d).split(/\r?\n/)) {
        // The lines worth watching: the phase changing, and the draw itself. The job
        // says "waiting for round N" on every five-second tick until the beacon lands;
        // once is enough.
        if (!/phase ->|\[finalise\] (DONE|round .* landed|local_id|Pantheon sync|quorum)/.test(line)) continue;
        if (line === lastShown) continue;
        lastShown = line;
        console.log(dim(`  ${line}`));
      }
    };
    child.stdout.on('data', forward);
    child.stderr.on('data', forward);

    await new Promise((resolve, reject) => {
      const look = () => { if (serverLog.includes('running server/finalise.js every')) resolve(); };
      child.stdout.on('data', look);
      child.stderr.on('data', look);
      child.on('exit', (code) => reject(new Error(`the server exited with ${code}:${LF}${serverLog}`)));
      setTimeout(() => reject(new Error(`the server did not start:${LF}${serverLog}`)), 20_000);
    });
    const status = await fetch(`${base}/api/status`).then((r) => r.json());
    if (status.phase !== 'open') throw new Error(`the window is not open: phase ${status.phase}`);

    const cutoff = new Date(protocol.submission_cutoff_utc);
    const drawAt = new Date(protocol.target_round_utc || cutoff.getTime() + gapSec * 1000);
    console.log(`
  ${bold('Open')}   ${base}

  You are player 1, ${TITLES[0]}: sign in with person_id ${EVENT.players[0].person_id}. You also administer this
  event, so once you sign in the header shows an "Organiser panel" link — that is the
  dashboard, opened by who you are, no token to copy. The other eleven are simulated and
  will submit over the next minute or so. Submissions close at ${clock(cutoff)}; the beacon
  lands and the draw runs at about ${clock(drawAt)}. Any id from ${EVENT.players[0].person_id} to
  ${EVENT.players[11].person_id} can sign in, so a second tab can be a second player.

  Organiser's dashboard (also reachable by token): ${base}/admin?token=${adminToken}

  Ctrl+C when you are done. The copy this runs in is removed; nothing here is kept.
`);

    // The other eleven, staggered so the waiting page can be watched filling up.
    const cfg = load({ dataDir: path.join(dir, 'data') });
    const payloadFor = (i) => ({
      user_input: (i * 37 + 11) % 256,
      client_nonce: require('node:crypto').randomBytes(16).toString('hex'),
      client_timestamp: new Date().toISOString(),
    });
    (async () => {
      for (let i = 1; i < 12; i++) {
        await sleep(4000);
        if (child.exitCode !== null) return;
        try {
          const cookie = await signIn(base, EVENT.players[i].person_id);
          await submit(base, cookie, payloadFor(i), cfg);
          const now = await fetch(`${base}/api/status`).then((r) => r.json());
          console.log(`  ${TITLES[i]} sealed a number  (${now.submitted_count} of 12)`);
        } catch (err) {
          console.log(`  ${TITLES[i]}: ${err.message}`);
        }
      }
    })();

    // Say when the phase changes, and when there is a result to look at.
    let last = status.phase;
    for (;;) {
      await sleep(5000);
      if (child.exitCode !== null) throw new Error(`the server exited with ${child.exitCode}`);
      const now = await fetch(`${base}/api/status`).then((r) => r.json()).catch(() => null);
      if (!now || now.phase === last) continue;
      last = now.phase;
      if (now.phase === 'awaiting_round') console.log(`${LF}  ${bold('Submissions closed.')} Waiting for round ${protocol.target_round}.`);
      if (now.phase === 'revealing') console.log(`  ${bold('The beacon landed.')} Opening the envelopes.`);
      if (now.phase === 'done') {
        console.log(`${LF}  ${green(bold('The seat plan is up.'))} Open ${base} — the page shows it, and how anyone can`);
        console.log('  recompute it. Ctrl+C to finish.');
      }
      if (now.phase === 'void') console.log(`${LF}  ${bold('Void:')} fewer than ${protocol.quorum} submissions. That is the protocol working, not a fault.`);
    }
  } catch (err) {
    console.error(`${LF}  \x1b[31mDEMO FAILED\x1b[0m  ${err.message}`);
    await cleanup();
    process.exit(1);
  }
}

main(process.argv.slice(2)).catch((err) => { console.error(err); process.exit(1); });
