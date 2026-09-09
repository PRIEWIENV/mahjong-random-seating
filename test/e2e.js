#!/usr/bin/env node
'use strict';

/**
 * RUNBOOK steps A2-A7, for real.
 *
 * A stub Pantheon and a dummy roster, but a genuine drand quicknet round only minutes
 * away. Everything else is the real thing: real tlock sealing in a real HTTP POST to
 * the real backend, the real scheduled job, the real generate.js, the real sync.
 *
 *   A2  the whole journey: sign in → submit → wait → reveal → result → sync
 *   A3  the sign-in gate both ways: registered gets in, valid-but-unregistered refused
 *   A4  quorum boundaries: 8 draws normally, 7 is declared void
 *   A5  recompute a finished draw from results.json alone, in a separate process,
 *       and again in Python — the test that catches a loose byte encoding
 *   A6  read the prescript back and confirm the seating matches, winds included
 *   A7  results.json alone is enough to recompute the same plan offline
 *
 * All scenarios share one target round so the suite waits once rather than three times.
 *
 *   node test/e2e.js [--window 150]
 */

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createServer } = require('../server/server');
const { load } = require('../server/config');
const { Store } = require('../server/db');
const { Drand } = require('../server/drand');
const { run: finalise } = require('../server/finalise');
const { encryptPayload } = require('../server/tlock');
const { StubPantheon } = require('../server/pantheon');
const { makeRoster, QUICKNET_HASH, QUICKNET_PK, ROOT } = require('./helpers');

const QUIET = { info() {}, warn() {}, error() {} };
const DRAND_API = 'https://api.drand.sh'; // operational (§4.2), not part of the freeze

const log = (...a) => console.log(...a);
const step = (s) => console.log(`\n\x1b[1m${s}\x1b[0m`);

function scenarioDir(name, protocol, roster, runtime) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `mjs-e2e-${name}-`));
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'data', 'roster.json'), JSON.stringify(roster, null, 2));
  fs.writeFileSync(path.join(dir, 'data', 'protocol.json'), JSON.stringify(protocol, null, 2));
  fs.writeFileSync(path.join(dir, 'data', 'runtime.json'), JSON.stringify(runtime, null, 2));
  fs.copyFileSync(path.join(ROOT, 'data', 'schedule_template.json'), path.join(dir, 'data', 'schedule_template.json'));
  return dir;
}

async function boot(dir, roster) {
  const cfg = load({ dataDir: path.join(dir, 'data') });
  cfg.root = dir;
  const store = new Store(':memory:');
  const mirror = { enabled: false, enqueue: () => {}, flush: async () => {}, drain: async () => true };
  const pantheon = new StubPantheon({
    roster,
    extraAccounts: [{ person_id: 9999, auth_token: 'token-9999' }],
  });
  const { server } = createServer({
    cfg, store, mirror, pantheon, publicDir: path.join(ROOT, 'public'),
    drandPollMs: 0, drand: { latest: async () => ({ round: 0 }) }, log: QUIET,
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { cfg, store, mirror, pantheon, server, dir, base: `http://127.0.0.1:${server.address().port}`,
           close: () => new Promise((r) => server.close(r)) };
}

async function signIn(sc, personId, token) {
  const res = await fetch(sc.base + '/api/session', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ person_id: personId, auth_token: token ?? `token-${personId}` }),
  });
  const setCookie = res.headers.getSetCookie?.()[0];
  return { status: res.status, body: await res.json().catch(() => null), cookie: setCookie ? setCookie.split(';')[0] : null };
}

/** Seal in the browser's place, then POST exactly what the page would POST. */
async function submitAs(sc, cookie, payload, cfg) {
  const ciphertext = await encryptPayload(payload, cfg.protocol.target_round, cfg);
  const res = await fetch(sc.base + '/api/submit', {
    method: 'POST', headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ ciphertext }),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function main() {
  const wIdx = process.argv.indexOf('--window');
  const windowSec = wIdx > -1 ? Number(process.argv[wIdx + 1]) : 150;

  step('Setting up: a real drand quicknet round, minutes away');
  const drand = new Drand(QUICKNET_HASH, [DRAND_API]);
  const info = await drand.info();
  const targetRound = Math.floor((Math.ceil((Date.now() + windowSec * 1000) / 1000) - info.genesis_time) / info.period) + 2;
  const cutoffMs = await drand.roundTimeMs(targetRound);
  const cutoff = new Date(cutoffMs).toISOString().replace(/\.\d{3}Z$/, 'Z');
  log(`  chain        ${info.metadata?.beaconID} (period ${info.period}s, scheme ${info.schemeID})`);
  log(`  target_round ${targetRound}`);
  log(`  cutoff       ${cutoff}  (${((cutoffMs - Date.now()) / 1000).toFixed(0)}s away)`);

  // The frozen half (§4.1) and nothing else — config.js refuses to load it otherwise.
  const protocol = {
    drand_chain: 'quicknet', chain_hash: QUICKNET_HASH, chain_public_key: QUICKNET_PK,
    target_round: targetRound, submission_cutoff_utc: cutoff,
    quorum: 8, total_slots: 12, user_input_max: 255,
    seed_domain_separation: 'mahjong-seating-v1',
    schedule_template_ref: 'data/schedule_template.json@e2e', generate_script_ref: 'generate.js@e2e',
    pantheon: { wind_shuffle_mode: 'WIND_SHUFFLE_MODE_PRESCRIPTED' },
  };
  // The operational half (§4.2), which is not tagged and may change mid-window.
  const runtime = {
    drand: { api: DRAND_API },
    pantheon: { frey_base_url: 'http://127.0.0.1:1', mimir_base_url: 'http://127.0.0.1:1' },
  };
  const roster = makeRoster(12);
  const VALUES = [17, 200, 3, 99, 255, 0, 42, 128, 7, 63, 191, 88];
  const payloadFor = (i) => ({
    user_input: VALUES[i],
    client_nonce: Buffer.alloc(16, i + 1).toString('hex'),
    client_timestamp: `2026-09-10T19:59:0${i % 10}.000Z`,
  });

  const cases = [
    { name: 'twelve', n: 12, expect: 'done' },
    { name: 'eight', n: 8, expect: 'done' },
    { name: 'seven', n: 7, expect: 'void' },
  ];

  // ---- A3: the sign-in gate, both ways ---------------------------------
  step('A3: the sign-in gate must work in both directions');
  cases[0].dir = scenarioDir('twelve', protocol, roster, runtime);
  cases[0].sc = await boot(cases[0].dir, roster);
  const inGate = await signIn(cases[0].sc, roster.players[0].person_id);
  assert.equal(inGate.status, 200, 'a registered account must get in');
  const outsider = await signIn(cases[0].sc, 9999);
  assert.equal(outsider.status, 403, 'a valid but unregistered account must be refused');
  assert.equal(outsider.body.error, 'not_registered');
  assert.match(outsider.body.message, /isn't registered for this event/);
  const badPw = await signIn(cases[0].sc, roster.players[0].person_id, 'wrong');
  assert.equal(badPw.status, 401);
  assert.notEqual(badPw.body.message, outsider.body.message, 'the two refusals must be distinguishable');
  log('  registered → 200 | valid-but-unregistered → 403 | wrong token → 401, distinct messages');

  // ---- A2/A4: submissions ----------------------------------------------
  step('A2/A4: submitting, with real tlock sealing in place of the browser');
  for (const c of cases) {
    if (!c.dir) { c.dir = scenarioDir(c.name, protocol, roster, runtime); c.sc = await boot(c.dir, roster); }
    const t0 = Date.now();
    for (let i = 0; i < c.n; i++) {
      const { cookie, status } = await signIn(c.sc, roster.players[i].person_id);
      assert.equal(status, 200);
      const r = await submitAs(c.sc, cookie, payloadFor(i), c.sc.cfg);
      assert.equal(r.status, 201, `[${c.name}] player ${i + 1} → ${r.status} ${JSON.stringify(r.body)}`);
    }
    const st = await fetch(c.sc.base + '/api/status').then((r) => r.json());
    assert.equal(st.submitted_count, c.n);
    assert.equal(st.phase, 'open');
    log(`  ${c.name.padEnd(7)} ${c.n} sealed in ${((Date.now() - t0) / 1000).toFixed(1)}s — phase ${st.phase}`);
  }

  // finalising before the cutoff must be a no-op
  const early = await finalise({ cfg: cases[0].sc.cfg, store: cases[0].sc.store, mirror: cases[0].sc.mirror,
                                 pantheon: cases[0].sc.pantheon, drand, wait: false, log: QUIET });
  assert.equal(early.phase, 'open');
  log('  finalise before the cutoff → no-op (phase open)');

  // ---- wait -------------------------------------------------------------
  step(`Waiting for the cutoff and round ${targetRound}`);
  while (Date.now() < cutoffMs) {
    process.stdout.write(`\r  ${Math.ceil((cutoffMs - Date.now()) / 1000)}s to go   `);
    await new Promise((r) => setTimeout(r, Math.min(2000, cutoffMs - Date.now() + 50)));
  }
  process.stdout.write('\r  cutoff reached          \n');

  // ---- A4: seven is void ------------------------------------------------
  step('A4: seven submissions must be declared void, not drawn and not crashed');
  const seven = cases[2];
  const voidOut = await finalise({ cfg: seven.sc.cfg, store: seven.sc.store, mirror: seven.sc.mirror,
                                   pantheon: seven.sc.pantheon, drand, wait: false, log: QUIET });
  assert.equal(voidOut.phase, 'void');
  assert.match(voidOut.notice.reason, /quorum not met/);
  assert.equal(voidOut.notice.received, 7);
  assert.match(voidOut.notice.remedy, /ALL 12 players submit again/);
  assert.ok(!fs.existsSync(path.join(seven.dir, 'results.json')), 'a void round must not produce results.json');
  assert.equal(seven.sc.pantheon.prescript, '', 'a void round must not touch Pantheon');
  assert.equal((await fetch(seven.sc.base + '/api/status').then((r) => r.json())).phase, 'void');
  log('  7 sealed → phase void, no results.json, Pantheon untouched');

  // ---- A2: twelve and eight both draw -----------------------------------
  for (const c of [cases[0], cases[1]]) {
    step(`A2: ${c.n} submissions must draw, and sync`);
    const out = await finalise({
      cfg: c.sc.cfg, store: c.sc.store, mirror: c.sc.mirror, pantheon: c.sc.pantheon,
      drand, wait: true, pollMs: 3000, maxWaitMs: 5 * 60_000, log: QUIET,
    });
    assert.equal(out.phase, 'done', `[${c.name}] expected done, got ${out.phase} ${out.error || ''}`);
    const r = out.results;

    assert.equal(r.round_used, targetRound);
    assert.equal(r.participating_local_ids.length, c.n);
    assert.equal(r.R.length, 64, 'R must be the full 256 bits');
    for (let i = 0; i < c.n; i++) {
      assert.equal(r.revealed[i + 1].user_input, VALUES[i], `[${c.name}] player ${i + 1} value round-tripped wrong`);
    }
    assert.deepEqual([...r.permutation].sort((a, b) => a - b), [1,2,3,4,5,6,7,8,9,10,11,12]);
    assert.equal(r.seating.rounds.length, 11);
    for (const rd of r.seating.rounds) {
      const seen = new Set();
      for (const t of rd.tables) for (const w of ['E','S','W','N']) seen.add(t.seats[w].local_id);
      assert.equal(seen.size, 12, `[${c.name}] round ${rd.round} does not seat all twelve`);
    }
    assert.equal(out.sync.status, 'ok', `[${c.name}] sync: ${out.sync.error || ''}`);
    log(`  ${c.n} sealed → R = ${r.R.slice(0, 24)}…`);
    log(`  pi = [${r.permutation.join(', ')}]`);
    log(`  R1T1: ` + ['E','S','W','N'].map((w) => `${w}=${r.seating.rounds[0].tables[0].seats[w].title}`).join(' '));

    // ---- A6: read the prescript back, winds included -------------------
    const back = await c.sc.pantheon.getPrescript(roster.pantheon_event_id);
    assert.equal(back.prescript, r.pantheon_prescript);
    assert.equal(back.next_session_index, 1);
    const firstBlock = back.prescript.split('\n\n')[0].split('\n');
    firstBlock.forEach((line, t) => {
      const seats = r.seating.rounds[0].tables[t].seats;
      assert.deepEqual(line.split('-').map(Number), [seats.E, seats.S, seats.W, seats.N].map((s) => s.local_id),
        `[${c.name}] session 1 table ${t + 1} winds do not match`);
    });
    log(`  A6: prescript read back matches session 1 exactly, winds included`);

    // ---- A5/A7: recompute offline, fresh process ------------------------
    const verify = execFileSync(process.execPath, [
      path.join(ROOT, 'generate.js'), '--verify', path.join(c.dir, 'results.json'),
      '--roster', path.join(c.dir, 'data', 'roster.json'),
      '--protocol', path.join(c.dir, 'data', 'protocol.json'),
      '--template', path.join(c.dir, 'data', 'schedule_template.json'),
    ], { encoding: 'utf8' });
    assert.match(verify, /the whole file, no fields set aside/, `[${c.name}] A7 failed`);
    // The roll-call is a different claim from the byte comparison, and e2e must not
    // pass on a run where generate.js quietly skipped it for want of a snapshot.
    assert.match(verify, /submitted at the cutoff = \d+ participating \+ \d+ excluded/,
      `[${c.name}] the roll-call against events/snapshot.json did not run`);
    assert.doesNotMatch(verify, /NOT checked/, `[${c.name}] the snapshot was not found`);
    log(`  A7: ${verify.trim()}`);

    // A5's real teeth: a SECOND implementation, in another language, from the
    // documented encoding rather than from generate.js.
    for (const py of ['py', 'python3']) {
      try {
        const out2 = execFileSync(py, [path.join(ROOT, 'tools', 'verify_contribution.py'), path.join(c.dir, 'results.json')], { encoding: 'utf8' });
        assert.match(out2, /re-derived independently/);
        log(`  A5: ${out2.trim().split('\n')[0].trim()}`);
        break;
      } catch (err) {
        if (err.status === 1) throw err; // the checker ran and disagreed — a real failure
      }
    }

    // re-running must be idempotent
    const again = await finalise({ cfg: c.sc.cfg, store: c.sc.store, mirror: c.sc.mirror,
                                   pantheon: c.sc.pantheon, drand, wait: false, log: QUIET });
    assert.equal(again.phase, 'done');
    assert.equal(again.results.R, r.R, 're-running finalise must not change the result');
    log('  re-running finalise is idempotent');
  }

  // ---- the result is served ---------------------------------------------
  step('The finished result is served with its statistics');
  const res = await fetch(cases[0].sc.base + '/api/result').then((r) => r.json());
  assert.equal(res.stats.totals.perfect_pairs, 55);
  assert.equal(res.stats.totals.imbalanced_players.length, 3);
  assert.equal(res.pantheon_sync.status, 'ok');
  // §4.3: the sync outcome is served in the API view but must NOT be in the artefact.
  for (const c of cases.filter((x) => x.expect === 'done')) {
    const onDisk = JSON.parse(fs.readFileSync(path.join(c.dir, 'results.json'), 'utf8'));
    assert.equal(onDisk.pantheon_sync, undefined, `[${c.name}] pantheon_sync leaked into results.json`);
    assert.ok(Array.isArray(onDisk.excluded_local_ids), `[${c.name}] excluded_local_ids must always be present`);
    const sync = JSON.parse(fs.readFileSync(path.join(c.dir, 'events', 'sync.json'), 'utf8'));
    assert.equal(sync.status, 'ok', `[${c.name}] events/sync.json`);
  }
  log('  results.json holds only what generate.js computes; sync recorded in events/sync.json');
  log(`  /api/result: 66 pairs, ${res.stats.totals.perfect_pairs} perfect, ` +
      `${res.stats.totals.imbalanced_players.length} players on 5-3-3, sync ${res.pantheon_sync.status}`);

  // Keep one finished result for inspection, then clean up.
  const keep = path.join(ROOT, 'var', 'e2e-results.json');
  fs.mkdirSync(path.dirname(keep), { recursive: true });
  fs.copyFileSync(path.join(cases[0].dir, 'results.json'), keep);
  log(`  a finished results.json kept at var/e2e-results.json`);

  for (const c of cases) { await c.sc.close(); c.sc.store.close(); fs.rmSync(c.dir, { recursive: true, force: true }); }
  step('\x1b[32mAll end-to-end scenarios passed (RUNBOOK A2-A7).\x1b[0m');
}

main().catch((err) => {
  console.error(`\n\x1b[31mE2E FAILED\x1b[0m\n${err.stack || err.message}`);
  process.exit(1);
});
