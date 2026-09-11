'use strict';

/**
 * The scheduled finalisation job (PROTOCOL.md §5 steps 4-5, §8).
 *
 * Deliberately not an HTTP endpoint: nothing an outsider can poke should be able to
 * trigger, retry or re-time the draw.
 *
 *   1. at submission_cutoff_utc, snapshot the submissions received
 *   2. >= quorum  -> phase awaiting_round, wait for drand, decrypt, generate, publish
 *      <  quorum  -> phase void, publish the notice, stop
 *   3. sync the seat plan into Pantheon (never allowed to affect the draw)
 *
 * Idempotent. Re-running after a drand outage recomputes the same result from the same
 * snapshot: the snapshot is persisted the first time it is taken and never retaken, so
 * a submission that slipped in late cannot change the outcome by being present on the
 * second run.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { load } = require('./config');
const { Store } = require('./db');
const { Drand } = require('./drand');
const { decryptPayload } = require('./tlock');
const { Mirror, writeLocal } = require('./mirror');
const { stamp } = require('./ots');
const { computeStats } = require('./stats');
const { createPantheon, PantheonError } = require('./pantheon');
const { archiveVoidedAttempt } = require('./rounds');
const { generate, serialise } = require('../generate');

const LF = String.fromCharCode(10);
const KEY_SNAPSHOT = 'snapshot';
// What was published about the roll, and when: its digest, and whether the
// OpenTimestamps anchor succeeded. Read by /api/status so the waiting page can show
// the digest during the interval (PROTOCOL.md section 9).
const KEY_ROLL = 'roll_published';
const KEY_PHASE = 'phase';
const KEY_RESULT = 'result';
const KEY_SYNC = 'pantheon_sync';

const resultsPath = (cfg) => path.join(cfg.root, 'results.json');
const voidPath = (cfg) => path.join(cfg.root, 'events', 'void.json');
const syncPath = (cfg) => path.join(cfg.root, 'events', 'sync.json');

/** The published result, when the database no longer has it. */
function readPublishedResults(cfg) {
  try {
    return JSON.parse(fs.readFileSync(resultsPath(cfg), 'utf8'));
  } catch {
    return null;
  }
}

/** Phase as §6 defines it, derived from persisted state plus the clock. */
function phaseOf(cfg, store, nowMs = Date.now()) {
  // A published results.json outranks anything the database says — INCLUDING a
  // persisted phase, which is why this is tested first and not after. RUNBOOK is
  // explicit that results.json is authoritative and that the SQLite state is
  // expendable; every ciphertext is also mirrored to the repository.
  //
  // Without this, restoring a server onto a fresh database after a completed draw
  // reports the round as void, because an empty submissions table past the cutoff looks
  // exactly like a quorum failure. And once something has written 'void' into the
  // database, checking the persisted value first would keep answering void forever.
  // Telling players a finished, published draw was void is the worst wrong answer
  // available here.
  if (fs.existsSync(resultsPath(cfg))) return 'done';
  // Same rule for the other terminal state. A void notice is published and mirrored, so
  // it too survives a lost database, and it too must not be recomputed from an empty
  // submissions table.
  if (fs.existsSync(voidPath(cfg))) return 'void';

  const persisted = store.get(KEY_PHASE);
  if (persisted === 'done' || persisted === 'void' || persisted === 'revealing') return persisted;

  if (nowMs < cfg.protocol.cutoff_ms) return 'open';
  const snap = store.get(KEY_SNAPSHOT);
  const count = snap ? snap.local_ids.length : store.snapshotAt(cfg.protocol.cutoff_ms).length;
  return count >= cfg.protocol.quorum ? 'awaiting_round' : 'void';
}

/** The bytes of the roll, fixed the moment it is taken. */
const rollBody = (snap) => JSON.stringify(snap, null, 2) + LF;
const rollDigest = (body) => crypto.createHash('sha256').update(body, 'utf8').digest('hex');

/**
 * Publish the roll, and get it timestamped by somebody who is not us.
 *
 * This runs at the cutoff, inside reveal_gap_seconds, while the beacon that opens the
 * ciphertexts does not yet exist. That is the whole point (PROTOCOL.md section 9): a
 * roll fixed only after the key is out cannot show it was fixed before, and a twelfth
 * submission forged from the decrypted eleven is indistinguishable from a real one that
 * arrived late. Published here, it is neither.
 *
 * Two things happen and they are not equally important. The digest goes into the status
 * the waiting page is already showing, so twelve people see one short string while the
 * outcome is still unknowable; that needs nobody else to be up. The OpenTimestamps
 * anchor is the durable half and depends on calendars being reachable, so it is
 * best-effort and its failure is recorded rather than thrown.
 */
async function publishRoll(cfg, store, snap, { mirror, log, stampFn } = {}) {
  const body = rollBody(snap);
  const digest = rollDigest(body);
  writeLocal(cfg.root, 'events/snapshot.json', body);
  mirror?.enqueue?.('events/snapshot.json', body, `roll taken at the cutoff (${snap.local_ids.length} submissions)`);
  const record = {
    digest,
    published_at: new Date().toISOString(),
    local_ids: snap.local_ids,
    ots: null,
  };
  store.set(KEY_ROLL, record);
  log.info?.(`[finalise] roll published, sha256 ${digest}`);

  if (!stampFn) {
    // No stamper, no anchor. The real one is wired in by the command-line entry
    // point below; a library caller that has not asked for it — every unit test —
    // gets the roll published and nothing dialled. A default that reached four
    // calendars made the offline suite depend on the network and cost a second per
    // test, which is how this was noticed.
    record.ots = { skipped: true, at: new Date().toISOString() };
    store.set(KEY_ROLL, record);
    return record;
  }

  try {
    const out = await stampFn(Buffer.from(body, 'utf8'));
    writeLocal(cfg.root, 'events/snapshot.json.ots', out.ots);
    mirror?.enqueue?.('events/snapshot.json.ots', out.ots, 'opentimestamps proof for the roll');
    record.ots = { calendars: out.calendars, at: new Date().toISOString(), bytes: out.ots.length };
    store.set(KEY_ROLL, record);
    log.info?.(`[finalise] roll anchored with ${out.calendars.length} calendar(s)`);
  } catch (err) {
    // Not fatal. The digest is out and the players can compare it; what is lost is the
    // proof that survives everyone forgetting. Loud, because it is not recoverable
    // later: a stamp made after the beacon proves nothing about before it.
    record.ots = { failed: err.message, at: new Date().toISOString() };
    store.set(KEY_ROLL, record);
    log.error?.(`[finalise] roll NOT anchored: ${err.message}`);
  }
  return record;
}

/** §8: take the snapshot once, at the cutoff, then never again. */
function takeSnapshot(cfg, store, log) {
  const existing = store.get(KEY_SNAPSHOT);
  if (existing) return existing;
  const rows = store.snapshotAt(cfg.protocol.cutoff_ms);
  const snap = {
    cutoff_utc: cfg.protocol.submission_cutoff_utc,
    taken_at: new Date().toISOString(),
    local_ids: rows.map((r) => r.local_id),
    submissions: rows.map((r) => ({ local_id: r.local_id, ciphertext: r.ciphertext, received_at: r.received_at })),
  };
  store.set(KEY_SNAPSHOT, snap);
  log.info?.(`[finalise] snapshot: ${snap.local_ids.length} submissions (${snap.local_ids.join(',') || 'none'})`);
  return snap;
}

/**
 * Decrypt the snapshot.
 *
 * A ciphertext that will not decrypt, or whose payload is malformed, is not a
 * contribution. server.js refuses anything not addressed to this chain and round, so
 * reaching this branch means a submission that bypassed the API or a genuine tlock
 * failure. Either way it cannot be folded into R, and it must not keep counting
 * towards the quorum it was provisionally counted in — hence the second quorum check
 * in run(). Every exclusion is published.
 */
async function decryptSnapshot(snapshot, cfg, log) {
  const decrypted = [];
  const excluded = [];
  // tlock-js prints the whole beacon on every decrypt; a dozen copies of one line
  // buries the only thing an operator needs to see here, which is whether any failed.
  const realLog = console.log;
  console.log = () => {};
  try {
    for (const s of snapshot.submissions) {
      try {
        const payload = await decryptPayload(s.ciphertext, cfg);
        decrypted.push({ local_id: s.local_id, ...payload });
        log.info?.(`[finalise] local_id ${s.local_id}: decrypted`);
      } catch (err) {
        excluded.push({ local_id: s.local_id, reason: err.message });
        log.error?.(`[finalise] local_id ${s.local_id}: UNDECRYPTABLE — excluded (${err.message})`);
      }
    }
  } finally {
    console.log = realLog;
  }
  return { decrypted, excluded };
}

function publishVoid(cfg, store, mirror, reason, detail, log) {
  const notice = {
    phase: 'void',
    target_round: cfg.protocol.target_round,
    submission_cutoff_utc: cfg.protocol.submission_cutoff_utc,
    quorum: cfg.protocol.quorum,
    total_slots: cfg.protocol.total_slots,
    reason,
    ...detail,
    remedy:
      `PROTOCOL.md §8: this round is void. Announce a new target_round and have ALL ` +
      `${cfg.protocol.total_slots} players submit again — ciphertexts are bound to the lapsed round ` +
      `and cannot be reused. The quorum itself is frozen and is not adjusted in response to this.`,
  };
  const body = JSON.stringify(notice, null, 2) + '\n';
  writeLocal(cfg.root, 'events/void.json', body);
  mirror.enqueue('events/void.json', body, `void: ${reason} (round ${cfg.protocol.target_round})`);
  store.set(KEY_PHASE, 'void');

  // Archive now, while the attempt is still live and consistent (§8, server/rounds.js).
  // "Fewer than eight submitted" is a claim, and the only thing that makes it a fact is
  // the evidence: the ciphertexts as received, the roll at the cutoff, and the frozen
  // parameters they were sealed under. protocol.json in particular is about to be
  // rewritten with a new target_round, so waiting until the reset would be too late.
  try {
    archiveVoidedAttempt(cfg, store, notice, mirror, log);
  } catch (err) {
    // The void itself is published either way; losing the archive must not also lose
    // the notice. But say so loudly, because the reset will refuse to run without it.
    log.error?.(`[finalise] FAILED to archive the voided attempt: ${err.message}`);
    log.error?.('[finalise] fix this before starting a new round — tools/new-round.js will refuse');
  }

  log.error?.(`[finalise] ROUND VOID — ${reason}`);
  return notice;
}

/**
 * Record a sync outcome: its own published file, and the mirror (§4.3).
 *
 * Deliberately not folded into results.json. It carries a wall-clock timestamp and the
 * result of a network call made after that file already existed, so a results.json
 * holding it could never be recomputed.
 */
function publishSync(cfg, mirror, sync, roundUsed) {
  const body = JSON.stringify({ round_used: roundUsed, ...sync }, null, 2) + '\n';
  writeLocal(cfg.root, 'events/sync.json', body);
  mirror.enqueue('events/sync.json', body, `pantheon sync ${sync.status} (round ${roundUsed})`);
  return body;
}

/**
 * PANTHEON-INTEGRATION.md §4 — the sync happens after the draw is already final and
 * published, so a failure is an operational nuisance, not a fairness problem. Retry
 * with backoff, record the outcome, and never re-draw in response.
 */
async function syncToPantheon(cfg, results, pantheon, log, opts = {}) {
  const attempts = opts.attempts ?? 3;
  const baseDelay = opts.baseDelayMs ?? 1000;
  const eventId = cfg.roster.pantheon_event_id;

  for (let i = 1; i <= attempts; i++) {
    try {
      await pantheon.setPrescript(eventId, results.pantheon_prescript, 1);
      // Read it back: a write that reports success but stored something else is the
      // failure mode RUNBOOK step A6 calls the most likely to be silently wrong.
      const back = await pantheon.getPrescript(eventId);
      if (back.prescript !== results.pantheon_prescript) {
        throw new PantheonError('prescript read back different from what was written');
      }
      log.info?.(`[finalise] Pantheon sync ok (event ${eventId}, ${results.seating.rounds.length} sessions)`);
      return { status: 'ok', at: new Date().toISOString(), event_id: eventId, attempts: i };
    } catch (err) {
      log.error?.(`[finalise] Pantheon sync attempt ${i}/${attempts} failed: ${err.message}`);
      if (i === attempts) {
        return {
          status: 'failed',
          at: new Date().toISOString(),
          event_id: eventId,
          attempts: i,
          error: err.message,
          remedy:
            'The draw is final and results.json is authoritative. Paste pantheon_prescript into ' +
            "Pantheon's admin UI by hand, then apply it with MakePrescriptedSeating and " +
            'wind_shuffle_mode = WIND_SHUFFLE_MODE_PRESCRIPTED. Do NOT re-run the draw.',
        };
      }
      await new Promise((r) => setTimeout(r, baseDelay * 2 ** (i - 1)));
    }
  }
}

async function run(opts = {}) {
  const log = opts.log || console;
  const cfg = opts.cfg || load(opts);
  const store = opts.store || new Store(opts.dbFile || path.join(cfg.root, 'var', 'state.sqlite'));
  const mirror = opts.mirror || new Mirror(process.env, log);
  const drand = opts.drand || new Drand(cfg.protocol.chain_hash, cfg.runtime.drand.mirrors);
  const pantheon = opts.pantheon || createPantheon(cfg, process.env);
  const onPhase = opts.onPhase || (() => {});
  const wait = opts.wait !== false;
  const pollMs = opts.pollMs ?? 15_000;
  const maxWaitMs = opts.maxWaitMs ?? 60 * 60 * 1000;
  const now = opts.now ?? Date.now();

  // "Has this round already been settled AND published?" — deliberately not phaseOf,
  // which also *predicts* a state the job has yet to act on. phaseOf answers 'void' for
  // a round that is below quorum but whose notice has not been written yet, so guarding
  // on it would return early and the void would never actually be published.
  //
  // What these guards must catch is a terminal state already on disk. Both files are
  // published and mirrored, so both outrank the database: reading the persisted key
  // alone meant that restoring onto a fresh var/ after a completed draw made this job
  // snapshot an empty submissions table, find it below quorum, and publish
  // events/void.json over a draw that had already happened.
  const persisted = store.get(KEY_PHASE);
  const settledDone = persisted === 'done' || fs.existsSync(resultsPath(cfg));
  const settledVoid = persisted === 'void' || fs.existsSync(voidPath(cfg));

  if (settledDone) {
    const results = store.get(KEY_RESULT) || readPublishedResults(cfg);
    store.set(KEY_PHASE, 'done'); // reconcile the database with the published file

    // The sync is the one step that can still be outstanding once the draw is over: it
    // runs after results.json is published and after the phase is already 'done', so a
    // crash or a restart in between left it undone with nothing to pick it up. Writing
    // the prescript and reading it back is idempotent and cannot touch the draw, so the
    // five-minute timer can simply finish the job.
    //
    // Only when NO outcome was ever recorded. A recorded failure is a completed attempt
    // carrying a documented manual remedy (§8 / RUNBOOK step 15); retrying it every five
    // minutes forever would bury that remedy under mirror noise and fight an operator
    // who has already pasted the prescript in by hand.
    const recorded = store.get(KEY_SYNC);
    if (results && !recorded && !fs.existsSync(syncPath(cfg))) {
      log.warn?.('[finalise] draw is done but no Pantheon sync was ever recorded — running it now');
      const sync = await syncToPantheon(cfg, results, pantheon, log, opts.sync);
      store.set(KEY_SYNC, sync);
      publishSync(cfg, mirror, sync, results.round_used);
      await mirror.drain?.();
      return { phase: 'done', results, sync, resumed: true };
    }
    log.info?.('[finalise] already done — nothing to do');
    return { phase: 'done', results };
  }
  if (settledVoid) {
    // Not re-published. The notice records who had submitted when it was written, and
    // recomputing that from a database that no longer holds them would replace a true
    // record with an emptier, wronger one.
    store.set(KEY_PHASE, 'void');
    log.info?.('[finalise] already void — waiting on a new target_round');
    return { phase: 'void' };
  }
  if (now < cfg.protocol.cutoff_ms) {
    const mins = Math.ceil((cfg.protocol.cutoff_ms - now) / 60000);
    log.info?.(`[finalise] cutoff is ${mins} minute(s) away; nothing to do`);
    return { phase: 'open' };
  }

  const snapshot = takeSnapshot(cfg, store, log);
  // Inside the interval, before the beacon exists. Idempotent: the roll is taken once
  // and this records that it was published, so a later tick does not restamp it.
  if (!store.get(KEY_ROLL)) {
    await publishRoll(cfg, store, snapshot, { mirror, log, stampFn: opts.stamp });
  }

  if (snapshot.local_ids.length < cfg.protocol.quorum) {
    const notice = publishVoid(cfg, store, mirror, 'quorum not met at the cutoff',
      { received: snapshot.local_ids.length, submitted_local_ids: snapshot.local_ids }, log);
    onPhase('void');
    return { phase: 'void', notice };
  }

  store.set(KEY_PHASE, 'awaiting_round');
  onPhase('awaiting_round');
  log.info?.(`[finalise] quorum met (${snapshot.local_ids.length}/${cfg.protocol.quorum}); waiting for round ${cfg.protocol.target_round}`);

  const deadline = Date.now() + maxWaitMs;
  let beacon = null;
  for (;;) {
    try {
      beacon = await drand.round(cfg.protocol.target_round);
      break;
    } catch (err) {
      if (String(err.message).includes('disagree')) throw err; // mirrors disagreeing is fatal
      if (!wait) {
        log.info?.(`[finalise] round ${cfg.protocol.target_round} not published yet; re-run later`);
        return { phase: 'awaiting_round' };
      }
      if (Date.now() > deadline) {
        // §8: a delay, not a failure. Leave the phase alone and let the next run pick
        // it up; the outcome is already determined by the frozen snapshot.
        log.error?.(`[finalise] gave up waiting for round ${cfg.protocol.target_round}: ${err.message}`);
        return { phase: 'awaiting_round', error: err.message };
      }
      log.info?.(`[finalise] round ${cfg.protocol.target_round} not out yet; retrying in ${pollMs / 1000}s`);
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }
  log.info?.(`[finalise] round ${cfg.protocol.target_round} landed; confirmed by ${beacon.mirrors.length} mirror(s)`);

  const { decrypted, excluded } = await decryptSnapshot(snapshot, cfg, log);
  if (decrypted.length < cfg.protocol.quorum) {
    const notice = publishVoid(cfg, store, mirror, 'quorum not met once undecryptable submissions were excluded',
      { snapshot_size: snapshot.local_ids.length, decrypted: decrypted.length, excluded }, log);
    onPhase('void');
    return { phase: 'void', notice };
  }

  store.set(KEY_PHASE, 'revealing');
  onPhase('revealing');

  // The exclusions go THROUGH generate.js rather than being attached to its output.
  // They are part of the answer to "who took part", so they belong inside the file's
  // byte-for-byte claim; anything bolted on afterwards would have to be carved out of
  // that claim, and a verification with a footnote is the kind nobody reads.
  const results = generate({
    decrypted,
    excluded,
    roster: cfg.roster,
    protocol: cfg.protocol,
    template: cfg.template,
    signature: beacon.signature,
    round: beacon.round,
  });

  // Publish the draw BEFORE syncing. The seat plan is authoritative the moment it is
  // computed; Pantheon is a delivery target, and a delivery problem must never make
  // the result look unsettled.
  //
  // The snapshot goes out first. It is what lets a verifier check that results.json
  // accounts for every submission taken at the cutoff, so a reader should never find a
  // result published without the file needed to audit its roll-call.
  // Already written and mirrored at the cutoff by publishRoll, which is the only
  // time it can mean anything. Re-published only if that never happened — a database
  // restored from a backup, say — so a result is still never readable without the
  // file needed to audit its roll-call.
  if (!store.get(KEY_ROLL)) {
    const snapBody = rollBody(snapshot);
    writeLocal(cfg.root, 'events/snapshot.json', snapBody);
    mirror.enqueue('events/snapshot.json', snapBody, `snapshot at cutoff (round ${beacon.round})`);
  }
  const body = serialise(results);
  writeLocal(cfg.root, 'results.json', body);
  mirror.enqueue('results.json', body, `results for drand round ${beacon.round}`);

  const stats = computeStats(results.seating, cfg.roster.players);
  store.set(KEY_RESULT, { ...results, stats });
  store.set(KEY_PHASE, 'done');
  onPhase('done');

  const sync = await syncToPantheon(cfg, results, pantheon, log, opts.sync);
  store.set(KEY_SYNC, sync);
  publishSync(cfg, mirror, sync, beacon.round);
  store.set(KEY_RESULT, { ...results, stats });

  await mirror.drain?.();
  log.info?.(`[finalise] DONE — R = ${results.R.slice(0, 16)}…, pi = [${results.permutation.join(', ')}]`);
  return { phase: 'done', results, stats, beacon, sync };
}

module.exports = {
  run, phaseOf, takeSnapshot, publishRoll, rollBody, rollDigest, decryptSnapshot, syncToPantheon, publishSync,
  readPublishedResults, KEY_PHASE, KEY_SNAPSHOT, KEY_ROLL, KEY_RESULT, KEY_SYNC,
};

if (require.main === module) {
  // The real stamper, here and nowhere else: PROTOCOL.md §9's anchor belongs to a
  // deployment, not to every caller of run().
  run({ wait: !process.argv.includes('--no-wait'), stamp })
    .then((out) => process.exit(['done', 'void', 'open', 'awaiting_round'].includes(out.phase) ? 0 : 1))
    .catch((err) => {
      console.error(`[finalise] ERROR ${err.stack || err.message}`);
      process.exit(1);
    });
}
