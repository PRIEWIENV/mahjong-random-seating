#!/usr/bin/env node
'use strict';

/**
 * The whole draw, on this machine, in about six minutes — `npm run demo`.
 *
 * A throwaway copy of the working tree gets a twelve-player event, a target round a few
 * minutes out, and the server, run exactly as an organiser runs it, except that Pantheon
 * is the in-process stub. You are player 1; the other eleven are simulated and submit
 * while you watch. Everything else is real: the timelock, the drand beacon, the draw,
 * the seat plan and the check a player can do afterwards. Ctrl+C removes the copy.
 *
 * Then it runs the TWELFTH round (PROTOCOL.md 11), which is the part that is hardest to
 * believe from a description: the tables are earned rather than drawn, only the winds are
 * drawn, and the commitment to both is published and timestamped before the beacon that
 * opens it exists. One thing there is simulated and one only — eleven rounds were not
 * really played, so the standings are invented and handed to the stub. The second drand
 * round is real, the lock and its OpenTimestamps anchor are real, and the draw is run by
 * nobody: the server does it on its own timer when the beacon lands, as it would at a
 * tournament where the organiser is in a venue and not at a terminal.
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

/**
 * The twelfth round, once the first eleven are notionally in the books (PROTOCOL.md 11).
 *
 * This is the part of the protocol a player sees LAST and understands least from reading
 * about it: the tables are earned rather than drawn, only the winds are drawn, and the
 * commitment to both is published before the beacon that opens it exists. Watching it is
 * worth more than reading it, which is why the demo now runs it.
 *
 * Two things are simulated and nothing else is. Eleven rounds were not played, so the
 * standings are invented here and handed to the stub. Everything after that is real: a
 * real second drand round, the real lock with its real OpenTimestamps anchor, and a draw
 * that nobody triggers -- the server does it on its own timer when the beacon lands,
 * exactly as it would at a tournament.
 */
async function runFinalRound({ dir, run, base, cfg, playedFile, leadSec }) {
  const results = JSON.parse(fs.readFileSync(path.join(dir, 'results.json'), 'utf8'));

  // Standings that differ every run, derived from the draw's own R so they are at least
  // reproducible within a run. Ranked 1..12; the top four take table one.
  const crypto = require('node:crypto');
  const scoreOf = (localId) =>
    parseInt(crypto.createHash('sha256').update(`${results.R}:${localId}`).digest('hex').slice(0, 8), 16);
  const ranked = [...cfg.roster.players].sort((a, b) => scoreOf(b.local_id) - scoreOf(a.local_id));
  fs.writeFileSync(playedFile, JSON.stringify({
    standings: ranked.map((pl, i) => ({
      person_id: pl.person_id, title: pl.title,
      rating: 1500 - i * 17, chips: 24 - i * 2,
      avg_place: Number((2.1 + i * 0.06).toFixed(2)),
      avg_score: 32000 - i * 450,
      games_played: cfg.template.rounds.length,
    })),
  }, null, 2) + LF);

  console.log(`${LF}  ${bold('The eleven rounds are in the books.')} Standings for this run:`);
  for (let i = 0; i < ranked.length; i += 4) {
    console.log(`    table ${i / 4 + 1}  ${ranked.slice(i, i + 4).map((pl) => pl.title).join('  ')}`);
  }

  // T1. The tool fetches those standings through the stub, runs every check, writes the
  // lock, mirrors it and anchors it -- then reports how much room it actually had.
  const out = run(['tools/lock-final.js', '--in', `${leadSec}s`, '--confirm']);
  const digest = (out.match(/sha256 ([0-9a-f]{64})/) || [])[1];
  const round = (out.match(/final beacon +round ([0-9]+)/) || [])[1];
  const spare = (out.match(/published with ([^ ]+) to spare/) || [])[1];
  console.log(`  ${green('OK')}    locked: standings + drand round ${round || '?'}`);
  if (digest) console.log(`        lock.json sha256 ${digest}`);
  if (spare) console.log(`        published with ${spare} to spare -- measured, not assumed`);
  console.log(dim('        Nobody runs the draw. The server does it when that round lands.'));
  console.log(`${LF}  Open ${base} again: the page now shows the locked tables and a countdown.`);
  console.log('  The winds are the only thing still unknown, to anyone.');
}

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
    // Once this file exists the stub reports the round-robin as played: Mimir's pointer
    // past every session, and a standings table. Both are consequences of people actually
    // playing eleven rounds, which a four-minute demo does not do -- so the demo writes it
    // at the moment it would have become true. See StubPantheon.playedFile.
    const playedFile = path.join(dir, 'pantheon-played.json');
    const env = {
      PANTHEON_MODE: 'stub', PANTHEON_STUB_ROSTER: eventFile, PANTHEON_STUB_EVENT_TITLE: 'Demo',
      PANTHEON_STUB_PLAYED: playedFile,
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
    // The twelfth round is in protocol.example.json, so the demo gets it too. Its script
    // has to name a tag the same way the first draw's does, or config.js refuses to load.
    protocol.generate_final_script_ref = 'generate-final.js@demo';
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

    // Say when the phase changes, when there is a result to look at, and then follow the
    // twelfth round through its two states. `phase` stays 'done' throughout that -- the
    // final round is a state of a finished event, not a fourth phase (PROTOCOL.md 11.8) --
    // so this watches status.final.state as well and not instead.
    const doFinal = protocol.final_round?.enabled === true;
    let last = status.phase;
    let lastFinal = 'none';
    for (;;) {
      await sleep(5000);
      if (child.exitCode !== null) throw new Error(`the server exited with ${child.exitCode}`);
      const now = await fetch(`${base}/api/status`).then((r) => r.json()).catch(() => null);
      if (!now) continue;

      if (now.phase !== last) {
        last = now.phase;
        if (now.phase === 'awaiting_round') console.log(`${LF}  ${bold('Submissions closed.')} Waiting for round ${protocol.target_round}.`);
        if (now.phase === 'revealing') console.log(`  ${bold('The beacon landed.')} Opening the envelopes.`);
        if (now.phase === 'void') console.log(`${LF}  ${bold('Void:')} fewer than ${protocol.quorum} submissions. That is the protocol working, not a fault.`);
        if (now.phase === 'done') {
          console.log(`${LF}  ${green(bold('The seat plan is up.'))} Open ${base} — the page shows it, and how anyone can`);
          console.log('  recompute it.');
          if (doFinal) {
            // A beat, so the eleven-round result can be looked at before the twelfth
            // round's card appears underneath it.
            await sleep(8000);
            try {
              await runFinalRound({ dir, run, base, cfg, playedFile, leadSec: 90 });
            } catch (err) {
              console.log(`  the final round could not be locked: ${err.message}`);
            }
          } else {
            console.log('  Ctrl+C to finish.');
          }
        }
      }

      const state = now.final?.state || 'none';
      if (doFinal && state !== lastFinal) {
        lastFinal = state;
        if (state === 'drawn') {
          console.log(`${LF}  ${green(bold('The twelfth round is drawn.'))} Nobody ran it: the server saw the beacon`);
          console.log('  land and drew the winds on its own timer. The page has the seats, the lock');
          console.log('  it was drawn from, and the two commands that reproduce it.');
          console.log(`${LF}  Ctrl+C when you are done.`);
        }
      }
    }
  } catch (err) {
    console.error(`${LF}  \x1b[31mDEMO FAILED\x1b[0m  ${err.message}`);
    await cleanup();
    process.exit(1);
  }
}

main(process.argv.slice(2)).catch((err) => { console.error(err); process.exit(1); });
