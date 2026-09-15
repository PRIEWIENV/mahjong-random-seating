#!/usr/bin/env node
'use strict';

/**
 * T2 of the final round: wait for the locked beacon, then draw the winds (PROTOCOL.md §11).
 *
 * Everything this does was decided before it ran. The tables come from the standings in
 * events/final/lock.json, which was published and timestamped before the beacon existed;
 * the winds come from generate-final.js, which was frozen and tagged before the
 * tournament started; and the randomness comes from the drand round the lock names. This
 * tool contributes nothing of its own — which is the point, and is why it is safe to run
 * it on an organiser's laptop in front of everybody.
 *
 * IDEMPOTENT, and that is a safety property rather than a convenience. Running it twice
 * must never produce two draws. If final.json already exists it is re-verified, re-offered
 * to the mirror and re-synced, and never recomputed from scratch — because "recompute"
 * and "redraw" look identical from the outside, and the second is the thing nobody should
 * ever be able to do.
 *
 * NO TIMESTAMP HERE. The lock was anchored before its beacon, which is the claim that
 * needed proving. Anchoring this file would prove only that a draw which anyone can
 * reproduce from public inputs existed at some later time, which is nothing.
 *
 *   node tools/draw-final.js --dry-run     say what will happen, touch nothing
 *   node tools/draw-final.js               wait for the round, draw, publish, sync
 *   node tools/draw-final.js --no-wait     refuse rather than wait, for a cron
 *   node tools/draw-final.js --no-sync     draw and publish, leave Pantheon alone
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { load } = require('../server/config');
const { Drand } = require('../server/drand');
const { Mirror, writeLocal } = require('../server/mirror');
const { createPantheon } = require('../server/pantheon');
const { generateFinal, serialise } = require('../generate-final');

const LOCK_REL = 'events/final/lock.json';
const FINAL_REL = 'final.json';
const SYNC_REL = 'events/final/sync.json';

/**
 * Where this tool talks.
 *
 * Injectable because these are operator-facing tools whose output IS part of what they do:
 * the refusals explain what to do instead, and a test that cannot read them cannot check
 * that they do. Passing a sink beats swapping process.stdout out from under the process,
 * which silences everything else running in it — the test runner included.
 */
function writers(deps = {}) {
  const out = deps.stdout || ((s) => process.stdout.write(s));
  const err = deps.stderr || ((s) => process.stderr.write(s));
  return {
    raw: out,
    ok: (s) => out(`  \x1b[32mOK\x1b[0m    ${s}\n`),
    bad: (s) => err(`  \x1b[31mERROR\x1b[0m ${s}\n`),
    warn: (s) => out(`  \x1b[33mWARN\x1b[0m  ${s}\n`),
    note: (s) => out(`        ${s}\n`),
  };
}
/** For the crash handler at the bottom of the file, which has no deps to read. */
const { bad } = writers();

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const k = argv[i].slice(2);
    const v = argv[i + 1];
    out[k] = v === undefined || v.startsWith('--') ? true : (i++, v);
  }
  return out;
}

const blocksOf = (prescript) => String(prescript).split('\n\n').filter((b) => b.trim() !== '');

/**
 * Write the twelve-block prescript, and prove it landed.
 *
 * All twelve blocks, not just the new one. Writing the new block alone with
 * next_session_index = 1 would tell Pantheon to re-seat session ONE from the final
 * round's tables — eleven played sessions rearranged by a round that has not happened.
 * Writing all twelve and reading them back also proves the eleven that have been played
 * were handed back unchanged, which is the part nobody would otherwise check.
 *
 * The read BEFORE the write is three refusals in one. The existing prescript must be
 * byte-for-byte what results.json published (so this is the same plan the players were
 * shown), it must be exactly eleven blocks (so nothing has already been added), and
 * next_session_index must already be at the final round's number — which is Mimir's own
 * statement that all eleven sessions have been played, and therefore the one check here
 * that does not depend on anybody's word for it.
 */
async function syncFinalToPantheon(cfg, final, results, pantheon, log, opts = {}) {
  const attempts = opts.attempts ?? 3;
  const baseDelay = opts.baseDelayMs ?? 1000;
  const eventId = cfg.roster.pantheon_event_id;
  const wanted = final.pantheon_prescript;
  const index = final.pantheon_next_session_index;

  for (let i = 1; i <= attempts; i++) {
    try {
      const before = await pantheon.getPrescript(eventId);

      // Already carrying the final block. Return without writing — not merely to be
      // idempotent, but because by the time this is re-run the final session may have
      // been PLAYED, and Mimir will have moved next_session_index past it. Writing our
      // index back then would point Pantheon at a session that is already in the books.
      if (before.prescript === wanted) {
        log.info?.(`[draw-final] Pantheon already has all ${blocksOf(wanted).length} sessions`);
        return {
          status: 'ok', at: new Date().toISOString(), event_id: eventId, attempts: i,
          sessions: blocksOf(wanted).length, next_session_index: before.next_session_index,
          already: true,
        };
      }
      if (before.prescript !== results.pantheon_prescript) {
        throw new Error(
          'the prescript in Pantheon is not the one results.json published, and not the one this ' +
          'draw would write either. Something else has written to this event, and overwriting it ' +
          'now would hide whatever that was.');
      }
      const n = blocksOf(before.prescript).length;
      if (n !== index - 1) {
        throw new Error(`Pantheon holds ${n} prescript blocks, expected ${index - 1} before the final round`);
      }
      if (before.next_session_index !== index) {
        throw new Error(
          `Pantheon's next_session_index is ${before.next_session_index}, not ${index}. That is ` +
          `Mimir saying the ${index - 1} round-robin sessions have not all been played, and the ` +
          'final round must not be scheduled until they have.');
      }

      await pantheon.setPrescript(eventId, wanted, index);

      const back = await pantheon.getPrescript(eventId);
      if (back.prescript !== wanted) {
        throw new Error('prescript read back different from what was written');
      }
      if (back.next_session_index !== index) {
        throw new Error(`next_session_index read back as ${back.next_session_index}, not ${index}`);
      }
      log.info?.(`[draw-final] Pantheon sync ok (event ${eventId}, ${blocksOf(wanted).length} sessions)`);
      return {
        status: 'ok', at: new Date().toISOString(), event_id: eventId, attempts: i,
        sessions: blocksOf(wanted).length, next_session_index: index,
      };
    } catch (err) {
      log.error?.(`[draw-final] Pantheon sync attempt ${i}/${attempts} failed: ${err.message}`);
      if (i === attempts) {
        return {
          status: 'failed', at: new Date().toISOString(), event_id: eventId, attempts: i,
          error: err.message,
          remedy:
            'The draw is final and final.json is authoritative. Paste pantheon_prescript — ALL ' +
            `${blocksOf(wanted).length} blocks, not just the last — into Pantheon's admin UI, set ` +
            `next_session_index to ${index}, and apply it with MakePrescriptedSeating and ` +
            'wind_shuffle_mode = WIND_SHUFFLE_MODE_PRESCRIPTED. Do NOT re-run the draw.',
        };
      }
      await new Promise((r) => setTimeout(r, baseDelay * 2 ** (i - 1)));
    }
  }
}

/** Sleep until the round is due, then poll for it to propagate. */
async function awaitRound(drand, round, { now, pollMs = 1000, maxWaitMs = 3_600_000, log, sleep }) {
  const nap = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const dueMs = await drand.roundTimeMs(round);
  const deadline = Date.now() + maxWaitMs;
  if (dueMs > now) {
    const mins = Math.round((dueMs - now) / 60_000);
    log.info?.(`[draw-final] round ${round} is due in ${mins} min; waiting`);
    await nap(dueMs - now);
  }
  for (;;) {
    try {
      return await drand.round(round);
    } catch (err) {
      // A disagreement between mirrors is never something to wait out: it is the one
      // condition under which this must not draw at all.
      if (err.disagreement) throw err;
      if (Date.now() >= deadline) throw err;
      await nap(pollMs);
    }
  }
}

async function main(argv, deps = {}) {
  const args = parseArgs(argv);
  const cfg = deps.cfg || load({});
  const env = deps.env || process.env;
  const log = deps.log || console;
  const now = deps.now ?? Date.now();
  const dryRun = args['dry-run'] === true;
  const { raw, ok, bad, warn, note } = writers(deps);

  const lockPath = path.join(cfg.root, LOCK_REL);
  const finalPath = path.join(cfg.root, FINAL_REL);
  const resultsPath = path.join(cfg.root, 'results.json');

  if (!fs.existsSync(lockPath)) {
    bad(`there is no ${LOCK_REL}. The standings and the beacon have to be locked and published ` +
      'first, or the draw would be seated from numbers chosen after the randomness existed.');
    note('  node tools/lock-final.js --in 45m --confirm');
    return 1;
  }
  const lockBytes = fs.readFileSync(lockPath);
  const lock = { ...JSON.parse(lockBytes.toString('utf8')), lock_sha256: sha256(lockBytes) };

  if (!fs.existsSync(resultsPath)) {
    bad('results.json is gone. The final round is built on it — same R, same participants.');
    return 1;
  }
  const resultsBytes = fs.readFileSync(resultsPath);
  const results = JSON.parse(resultsBytes.toString('utf8'));
  if (lock.results_sha256 && lock.results_sha256 !== sha256(resultsBytes)) {
    bad(`results.json has changed since the lock was made.\n` +
      `        lock names  ${lock.results_sha256}\n` +
      `        file hashes ${sha256(resultsBytes)}\n` +
      '        One of the two is not the published file. Stop and find out which.');
    return 1;
  }

  const mirror = deps.mirror || new Mirror(env, log);
  const drand = deps.drand || new Drand(cfg.protocol.chain_hash, cfg.runtime.drand.mirrors);
  const pantheon = deps.pantheon || createPantheon(cfg, env);

  raw(`\n  lock            ${lock.lock_sha256}\n`);
  raw(`  final beacon    drand round ${lock.target_round}, due ${lock.target_round_utc}\n`);
  raw(`  standings       ${lock.standings.join(', ')}\n\n`);

  // ---- already drawn: re-verify and re-publish, never redraw -------------------
  const already = fs.existsSync(finalPath);
  if (already) {
    const onDisk = fs.readFileSync(finalPath, 'utf8');
    const claimed = JSON.parse(onDisk);
    const rebuilt = serialise(generateFinal({
      results, lock, signature: claimed.drand_signature,
      roster: cfg.roster, protocol: cfg.protocol, template: cfg.template,
    }));
    if (rebuilt !== onDisk) {
      bad('final.json is on disk but does not reproduce from the lock and results.json. It was ' +
        'not produced by this code from these inputs. Do NOT overwrite it — keep it, and find ' +
        'out where it came from.');
      note('  node generate-final.js --verify final.json     # says which line differs');
      return 1;
    }
    ok('final.json is already drawn and reproduces byte for byte — nothing is redrawn');
    note(`seed ${claimed.seed}`);
    if (dryRun) {
      note('A dry run stops here. Without --dry-run this would re-offer it to the mirror and');
      note('re-run the Pantheon sync, both of which are safe to repeat.');
      return 0;
    }
  }

  let final;
  let body;
  if (already) {
    body = fs.readFileSync(finalPath, 'utf8');
    final = JSON.parse(body);
  } else {
    // ---- the beacon -----------------------------------------------------------
    if (dryRun) {
      const dueMs = await drand.roundTimeMs(lock.target_round).catch(() => null);
      const landed = dueMs !== null && dueMs <= now;
      ok(`everything is in place; the draw is waiting on drand round ${lock.target_round}`);
      note(landed ? 'That round has landed — run without --dry-run to draw.'
        : `It is due in ${Math.round(((dueMs ?? now) - now) / 60_000)} min. Running without --dry-run waits for it.`);
      note('Nothing was written.');
      return 0;
    }
    let beacon;
    try {
      if (args['no-wait']) {
        beacon = await drand.round(lock.target_round);
      } else {
        beacon = await awaitRound(drand, lock.target_round, {
          now, log, sleep: deps.sleep,
          pollMs: deps.pollMs ?? 1000,
          maxWaitMs: deps.maxWaitMs ?? 3_600_000,
        });
      }
    } catch (err) {
      bad(`could not get drand round ${lock.target_round}: ${err.message}`);
      if (err.disagreement) {
        note('Mirrors disagreeing about a signature is the one case where waiting does not help.');
        note('DO NOT DRAW until they agree.');
      }
      return 1;
    }
    ok(`drand round ${beacon.round} from ${beacon.mirrors.length} mirror(s), all agreeing`);
    note(`signature ${beacon.signature}`);

    final = generateFinal({
      results, lock, signature: beacon.signature,
      roster: cfg.roster, protocol: cfg.protocol, template: cfg.template,
    });
    body = serialise(final);
    writeLocal(cfg.root, FINAL_REL, body);
    ok(`wrote ${FINAL_REL}  sha256 ${sha256(Buffer.from(body, 'utf8'))}`);
  }

  mirror.enqueue?.(FINAL_REL, body, `final round drawn (drand ${lock.target_round})`);

  // ---- what it came to --------------------------------------------------------
  raw('\n');
  for (const t of final.seating.rounds[0].tables) {
    const seats = cfg.template.seat_order.map((w) => `${w} ${t.seats[w].local_id}`).join('   ');
    raw(`        table ${t.table}   ${seats}\n`);
  }
  raw('\n');
  note(`${final.completed_count} of ${final.standings.length} players finish on three of every wind`);
  const short = final.standings.filter((id) => !final.completed_local_ids.includes(id));
  if (short.length) {
    note(`still 4-3-3-2 after twelve rounds: ${short.join(', ')} — they were at a table where two or`);
    note('more people were short of the same wind, and only one of them could have it (§11).');
  }

  // ---- Pantheon ---------------------------------------------------------------
  let sync = null;
  if (args['no-sync']) {
    warn('--no-sync: Pantheon was not touched. The seat plan is published but not scheduled.');
  } else {
    sync = await syncFinalToPantheon(cfg, final, results, pantheon, log, deps.sync);
    const syncBody = JSON.stringify({ final_round: final.final_round, round_used: lock.target_round, ...sync }, null, 2) + '\n';
    writeLocal(cfg.root, SYNC_REL, syncBody);
    mirror.enqueue?.(SYNC_REL, syncBody, `pantheon sync ${sync.status} (final round)`);
    if (sync.status === 'ok') {
      ok(`Pantheon has all ${sync.sessions} sessions, next_session_index ${sync.next_session_index}`);
    } else {
      warn(`Pantheon sync failed: ${sync.error}`);
      for (const line of sync.remedy.split('\n')) note(line);
    }
  }

  const drained = await mirror.drain?.(120_000);
  if (mirror.enabled === false) {
    warn(`MIRROR_REPO and MIRROR_TOKEN are unset, so ${FINAL_REL} is only on this machine. ` +
      'Publish it where the players can fetch it.');
  } else if (!drained) {
    warn('the mirror did not finish pushing. Push the remaining files by hand.');
  } else {
    ok('mirrored');
  }

  raw('\n');
  note('Anyone can check this without trusting anybody:');
  note('  node generate-final.js --verify final.json');
  note('  py tools/verify_final.py');
  note(`  drand round ${lock.target_round} is public, and the lock that named it was timestamped`);
  note('  before it existed.');
  return sync && sync.status !== 'ok' ? 1 : 0;
}

if (require.main === module) {
  main(process.argv.slice(2))
    .then((code) => { process.exitCode = code || 0; })
    .catch((err) => { bad(err.message); process.exitCode = 2; });
}

module.exports = { main, syncFinalToPantheon, awaitRound, blocksOf };
