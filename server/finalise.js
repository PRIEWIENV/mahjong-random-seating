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

const { load, loadEnvFile } = require('./config');
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
// Whether the repository has everything this job has written. Cleared by each local
// write and set again once the queue has been worked through, so its absence means a run
// was cut short between the two and the repository a player is pointed at may be missing
// a file they were told to check. It covers what this job publishes; the ciphertexts are
// queued by the server, which settles its own queue when it stops.
const KEY_PUBLISHED = 'results_mirrored';
// Proof that the scheduled job exists and is firing. Nothing else in the system can
// tell the difference between "drand is late" and "nobody ever installed the timer",
// and those have opposite remedies: wait, or go and start something.
const KEY_TICK = 'finalise_tick';

/**
 * Write a durable artefact locally and queue it for the repository, and record that the
 * repository is now behind until something says it has caught up.
 *
 * The two halves have to happen together. The queue lives in memory and the push happens
 * later in the run, so every local write opens a window in which the file exists here and
 * not there — and the file that matters most, `events/snapshot.json`, is written once and
 * guarded against ever being written again, so a push lost in that window was lost for
 * good. That one is the whole of PROTOCOL.md §9: the roll is public before the beacon, or
 * it proves nothing.
 */
function publish(cfg, store, mirror, repoPath, body, message) {
  writeLocal(cfg.root, repoPath, body);
  store.set(KEY_PUBLISHED, false);
  mirror?.enqueue?.(repoPath, body, message);
  return body;
}

/**
 * Work the queue, and record whether it emptied.
 *
 * "Emptied" is not "every push succeeded" — the mirror gives up on a path after five
 * attempts, loudly, with a manual remedy (server/mirror.js). What this distinguishes is
 * the case that had no remedy because nobody knew it had happened: a process that exited
 * with files still sitting in the queue.
 */
async function settle(store, mirror, log) {
  const drained = await mirror?.drain?.();
  if (drained === false) {
    log?.warn?.('[finalise] the mirror queue did not empty; the next run will offer it again');
    return false;
  }
  store.set(KEY_PUBLISHED, true);
  return true;
}

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

/**
 * Does the state in `var/` describe the round that is frozen right now?
 *
 * It usually does, and the two ways it legitimately might not are already handled: a
 * §8 retry clears the round before the new freeze is in place, and a `var/` restored
 * from backup belongs to the same round it always did. What is left is the case that
 * has no honest reading — a new freeze laid over the previous event's database, which
 * happens the moment somebody runs a second event in a checkout that ran a first.
 *
 * It has to be refused rather than warned about. `phaseOf` answers from the persisted
 * phase when no results.json is on disk, so the symptom is the previous event's seat
 * plan served to this event's players as their result, with nothing anywhere saying
 * otherwise. A backend that refuses to start is the better failure: it is visible before
 * anybody is told a URL, which is the whole argument config.js already makes about a
 * malformed roster.
 *
 * @returns {string|null} what disagrees, phrased for somebody who has to fix it
 */
function stateIsFromAnotherRound(cfg, store) {
  const snap = store.get(KEY_SNAPSHOT);
  if (snap?.cutoff_utc && snap.cutoff_utc !== cfg.protocol.submission_cutoff_utc) {
    return `var/ holds a roll taken at the cutoff ${snap.cutoff_utc}, but data/protocol.json ` +
      `now freezes ${cfg.protocol.submission_cutoff_utc}`;
  }
  const result = store.get(KEY_RESULT);
  if (Number.isInteger(result?.round_used) && result.round_used !== cfg.protocol.target_round) {
    return `var/ holds a draw made at round ${result.round_used}, but data/protocol.json ` +
      `now freezes target_round ${cfg.protocol.target_round}`;
  }
  return null;
}

/**
 * The refusal both entry points give, in the same words.
 *
 * Marked `operator` so the command-line entry points print the message and nothing else.
 * A stack trace here would bury four lines that say exactly what to run under twenty that
 * say where in this file the check happens, which is of interest to nobody holding a
 * terminal at the start of an event.
 */
function refuseStaleState(disagreement) {
  return Object.assign(new Error(
    `${disagreement}.\n` +
    'That database belongs to a different round, and serving it under this freeze would ' +
    'show one event\'s players another event\'s result. Close the previous event first:\n' +
    '  node tools/end-event.js --dry-run     # what it would archive and clear\n' +
    '  node tools/end-event.js               # archive it, then clear var/ and events/\n' +
    'A round that was voided under §8 is reopened with tools/new-round.js instead.'),
  { operator: true });
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
  publish(cfg, store, mirror, 'events/snapshot.json', body, `roll taken at the cutoff (${snap.local_ids.length} submissions)`);
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
    publish(cfg, store, mirror, 'events/snapshot.json.ots', out.ots, 'opentimestamps proof for the roll');
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
/**
 * The beacon exists, but this machine's clock has not reached the round's time.
 *
 * tlock-js decides this locally — `genesis_time + (round - 1) * period > Date.now()` —
 * so it can refuse a ciphertext whose beacon it has just been handed, if the host runs
 * behind drand. Distinct from every other decryption failure because it is about the
 * clock rather than about the ciphertext, and because it clears on its own.
 *
 * The wait above this normally makes it unreachable. It stays as the net, because the
 * thing it guards against — excluding a player who did nothing wrong, permanently and
 * in public — is not something to leave to one calculation being right.
 */
class BeaconNotReadyError extends Error {}
const BEACON_NOT_READY = /too early to decrypt/i;
// A moment past the round's time rather than exactly on it: the comparison is strict
// and both sides are computed to the millisecond.
const CLOCK_SLACK_MS = 250;
// Past this, a slow clock is a fault to report rather than a delay to absorb, and the
// retry loop can have it.
const MAX_CLOCK_WAIT_MS = 10_000;

async function decryptSnapshot(snapshot, cfg, log, { decryptFn = decryptPayload } = {}) {
  const decrypted = [];
  const excluded = [];
  // tlock-js prints the whole beacon on every decrypt; a dozen copies of one line
  // buries the only thing an operator needs to see here, which is whether any failed.
  const realLog = console.log;
  console.log = () => {};
  try {
    for (const s of snapshot.submissions) {
      try {
        const payload = await decryptFn(s.ciphertext, cfg);
        decrypted.push({ local_id: s.local_id, ...payload });
        log.info?.(`[finalise] local_id ${s.local_id}: decrypted`);
      } catch (err) {
        // "Too early" is not a property of the ciphertext. It is tlock reading this
        // machine's clock and finding it short of the round's time, on a beacon the
        // caller is already holding. Excluding on it would throw a player out of the
        // draw for being decrypted too promptly, which is both unfair and irreversible:
        // exclusions are published. So the whole pass is abandoned and the caller tries
        // again — nobody is at fault, so nobody is singled out.
        if (BEACON_NOT_READY.test(err.message)) {
          throw new BeaconNotReadyError(
            `round ${cfg.protocol.target_round} is not yet servable for decryption: ${err.message}`);
        }
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
  publish(cfg, store, mirror, 'events/void.json', body, `void: ${reason} (round ${cfg.protocol.target_round})`);
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
function publishSync(cfg, store, mirror, sync, roundUsed) {
  const body = JSON.stringify({ round_used: roundUsed, ...sync }, null, 2) + '\n';
  publish(cfg, store, mirror, 'events/sync.json', body, `pantheon sync ${sync.status} (round ${roundUsed})`);
  return body;
}

// A draw that has been running for longer than this is not running. The slowest honest
// path is a decrypt, three Pantheon attempts with backoff and a two-minute mirror drain,
// so fifteen minutes is far past anything real and still short enough that an operator
// who kills the job does not find the next event refusing to draw.
const LOCK_STALE_MS = 15 * 60_000;
const lockPath = (cfg) => path.join(cfg.root, 'var', 'finalise.lock');

/** Whether the process named in a lock file is still there. */
function lockHeld(file, now = Date.now()) {
  let held;
  try {
    held = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return false; // unreadable or half-written: not a claim anyone is making
  }
  if (!Number.isInteger(held.pid)) return false;
  const at = Date.parse(held.at);
  if (Number.isFinite(at) && now - at > LOCK_STALE_MS) return false;
  try {
    // Signal 0 delivers nothing and only asks whether the process exists.
    process.kill(held.pid, 0);
    return true;
  } catch (err) {
    // EPERM is somebody else's process, which is still a process.
    return err.code === 'EPERM';
  }
}

/**
 * Claim the right to be the only draw job running, or return null.
 *
 * The server's scheduler already refuses to start a second job, but it does that with a
 * variable in its own memory, which decides nothing once two servers exist. That is not
 * hypothetical any more: the draw job now survives the signal that stops the unit, so a
 * `systemctl restart` mid-draw routinely leaves the old job running while a new server
 * starts and schedules another. Both would compute the same seat plan, from the same
 * fixed beacon and the same fixed snapshot, and then race each other over the Pantheon
 * prescript and the mirror queue.
 *
 * A lock nobody holds must never be able to stop the draw permanently, which would trade
 * a race nobody has hit for an event that never draws at all. So a lock is taken over
 * when its process is gone or when it is older than any real run could be.
 */
function takeLock(cfg, now = Date.now()) {
  const file = lockPath(cfg);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      // 'wx' fails rather than truncates when the file is already there, which is what
      // makes this a claim rather than a request.
      const fd = fs.openSync(file, 'wx');
      try {
        fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: new Date(now).toISOString() }));
      } finally {
        fs.closeSync(fd);
      }
      return file;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      if (lockHeld(file, now)) return null;
      try { fs.unlinkSync(file); } catch { /* another job got there first */ }
    }
  }
  return null;
}

function releaseLock(file) {
  if (!file) return;
  try { fs.unlinkSync(file); } catch { /* already gone */ }
}

/**
 * Put back on the mirror queue anything the public repository ought to hold and might
 * not, when the last run did not get as far as saying it had pushed.
 *
 * Each file is written to disk and queued in the same breath, but the queue lives in
 * memory (`server/mirror.js`) and the push happens later in the run. A process that dies
 * in that gap leaves the file on the organiser's disk and absent from the repository, and
 * nothing notices: the next tick sees the file and reports the round already settled.
 *
 * `events/snapshot.json` is the one that would hurt most. It is written once and guarded
 * against ever being written again, so a push lost there is lost permanently — and a roll
 * that was not public before the beacon is §9's entire claim, which is to say it proves
 * nothing. `results.json` is what a player is told to verify against. The void notice is
 * how a round that did not happen is visible at all.
 *
 * The bytes come from disk rather than from the store, deliberately. What is in the
 * store has the derived statistics merged in; what has to be mirrored is the artefact
 * that reproduces byte for byte (§4.3).
 */
async function republishIfUnmirrored(cfg, store, mirror, log) {
  if (store.get(KEY_PUBLISHED)) return false;
  if (!mirror?.enabled) {
    // Nothing to push to, so nothing can be outstanding. Recording it keeps a later run
    // — after a PAT is finally configured — from re-pushing a draw that is long over.
    store.set(KEY_PUBLISHED, true);
    return false;
  }

  const ev = (name) => path.join(cfg.root, 'events', name);
  // Only what belongs to the round frozen right now. A checkout that has run a previous
  // event still has that event's files sitting under events/, and offering them here
  // would publish one event's roll and result under another event's name. The startup
  // guard refuses that combination while var/ still describes the old round, but var/
  // can be cleared on its own and these files left behind, so each one says which round
  // it is about and is checked against the freeze.
  const about = (file, test) => {
    try { return test(JSON.parse(fs.readFileSync(file, 'utf8'))); } catch { return false; }
  };
  const rollIsCurrent = fs.existsSync(ev('snapshot.json')) &&
    about(ev('snapshot.json'), (o) => o.cutoff_utc === cfg.protocol.submission_cutoff_utc);
  const round = cfg.protocol.target_round;

  const wanted = [
    // The roll first, and not only for tidiness: a reader must never find a result
    // published without the file needed to audit its roll-call.
    ['events/snapshot.json', ev('snapshot.json'), 'utf8', () => rollIsCurrent],
    // Binary, so it cannot say which round it is about. It is a proof OF the roll, and
    // it travels with it or not at all.
    ['events/snapshot.json.ots', ev('snapshot.json.ots'), null, () => rollIsCurrent],
    ['results.json', resultsPath(cfg), 'utf8', (f) => about(f, (o) => o.round_used === round)],
    ['events/void.json', ev('void.json'), 'utf8', (f) => about(f, (o) => o.target_round === round)],
    ['events/sync.json', ev('sync.json'), 'utf8', (f) => about(f, (o) => o.round_used === round)],
  ];
  const sent = [];
  const skipped = [];
  for (const [repoPath, file, encoding, belongsHere] of wanted) {
    if (!fs.existsSync(file)) continue;
    if (!belongsHere(file)) { skipped.push(repoPath); continue; }
    mirror.enqueue(repoPath, fs.readFileSync(file, encoding), `re-publishing ${repoPath} after an interrupted run`);
    sent.push(repoPath);
  }
  if (skipped.length) {
    log.warn?.(`[finalise] left alone, they are from another round: ${skipped.join(', ')} ` +
      '— close the previous event with tools/end-event.js');
  }
  if (!sent.length) {
    // Nothing published yet, so the repository is not behind anything.
    store.set(KEY_PUBLISHED, true);
    return false;
  }

  log.warn?.(`[finalise] the last run never confirmed a push; re-mirroring ${sent.join(', ')}`);
  return settle(store, mirror, log);
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

/**
 * How long to wait before asking drand again.
 *
 * The round's time is not a guess: protocol.json fixes it, config.js derives
 * target_round_ms from it, and drand emits on a fixed period. So until that moment
 * there is nothing to poll for, and the honest wait is a single sleep to the second it
 * is due. After it, the beacon is merely propagating and a short poll picks it up.
 *
 * Falls back to the poll interval if the caller handed over a protocol without the
 * derived field, which is the only way targetRoundMs is not a number.
 */
function retryNapMs(targetRoundMs, now, pollMs) {
  if (!Number.isFinite(targetRoundMs)) return pollMs;
  const untilRound = targetRoundMs - now;
  return untilRound > 0 ? untilRound : pollMs;
}

// One line at the first attempt past the round's time, then one every half minute. At a
// one-second poll, logging every miss would bury the run that matters in its own noise.
const LATE_LOG_MS = 30_000;

async function run(opts = {}) {
  const log = opts.log || console;
  const cfg = opts.cfg || load(opts);
  const store = opts.store || new Store(opts.dbFile || path.join(cfg.root, 'var', 'state.sqlite'));
  const mirror = opts.mirror || new Mirror(process.env, log);
  const drand = opts.drand || new Drand(cfg.protocol.chain_hash, cfg.runtime.drand.mirrors);
  const pantheon = opts.pantheon || createPantheon(cfg, process.env);
  const onPhase = opts.onPhase || (() => {});
  const wait = opts.wait !== false;
  // Only ever used once the round is already due, so it is about propagation delay, not
  // about the wait itself. maxWaitMs bounds it: an hour of a genuinely stalled drand is
  // at worst 3600 attempts, and each mirror that is timing out rather than answering
  // throttles that by its own ten-second timeout.
  const pollMs = opts.pollMs ?? 1_000;
  const maxWaitMs = opts.maxWaitMs ?? 60 * 60 * 1000;
  const now = opts.now ?? Date.now();

  // Written before anything is decided, so it records that the job ran and not that it
  // succeeded. The web server never draws — it only serves what this job publishes —
  // and until this key exists, "the beacon is out and the phase has not moved" has two
  // completely different explanations. The dashboard reads it to tell them apart.
  store.set(KEY_TICK, { at: new Date(now).toISOString(), waited: wait });

  // Before any of it. A draw job that ran here would snapshot this round's submissions
  // into the previous round's phase, and the first thing it would find is a result it
  // must not touch.
  const elsewhere = stateIsFromAnotherRound(cfg, store);
  if (elsewhere) throw refuseStaleState(elsewhere);

  // Before any branch. Something written locally by a previous run and never confirmed
  // pushed is offered again here, whatever state this round is in — the snapshot lost at
  // the cutoff matters more than the result lost after the draw, and only this placement
  // catches it, because every later path returns before reaching the other one.
  const republished = await republishIfUnmirrored(cfg, store, mirror, log);

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

    // A results.json that exists and cannot be read used to end here in silence: phase
    // done, no result, /api/result answering 500 to every player, and no run that would
    // ever try again. It should not be reachable now that the file is written through a
    // rename, so if it happens it is somebody's editor or a failing disk, and the one
    // useful thing to do is say which file and what to do about it.
    if (!results && fs.existsSync(resultsPath(cfg))) {
      log.error?.(
        `[finalise] ${resultsPath(cfg)} exists but could not be parsed. The draw is being reported ` +
        'as finished on the strength of that file alone, and players are getting an error instead of ' +
        'a result. Restore it from the mirror, or move it aside and let this job draw again — the ' +
        'beacon and the snapshot are both fixed, so it recomputes the same seat plan.');
    }

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
      publishSync(cfg, store, mirror, sync, results.round_used);
      await settle(store, mirror, log);
      return { phase: 'done', results, sync, resumed: true, republished };
    }
    if (republished) return { phase: 'done', results, republished };
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
    await settle(store, mirror, log);
    return { phase: 'void', notice };
  }

  store.set(KEY_PHASE, 'awaiting_round');
  onPhase('awaiting_round');
  log.info?.(`[finalise] quorum met (${snapshot.local_ids.length}/${cfg.protocol.quorum}); waiting for round ${cfg.protocol.target_round}`);

  const deadline = Date.now() + maxWaitMs;
  let beacon = null;
  let lastLateLog = 0;
  for (;;) {
    try {
      beacon = await drand.round(cfg.protocol.target_round);
      break;
    } catch (err) {
      if (String(err.message).includes('disagree')) throw err; // mirrors disagreeing is fatal
      if (!wait) {
        log.info?.(`[finalise] round ${cfg.protocol.target_round} not published yet; re-run later`);
        // The roll was published a few lines above and its push is still in the queue.
        // This return is the common one — the beacon is not out yet and the job is
        // called again in a minute — so exiting here with the snapshot unsent is the
        // likeliest way for §9's public roll to quietly not be public.
        await settle(store, mirror, log);
        return { phase: 'awaiting_round' };
      }
      if (Date.now() > deadline) {
        // §8: a delay, not a failure. Leave the phase alone and let the next run pick
        // it up; the outcome is already determined by the frozen snapshot.
        log.error?.(`[finalise] gave up waiting for round ${cfg.protocol.target_round}: ${err.message}`);
        await settle(store, mirror, log);
        return { phase: 'awaiting_round', error: err.message };
      }
      const nap = retryNapMs(cfg.protocol.target_round_ms, Date.now(), pollMs);
      if (nap > pollMs) {
        log.info?.(
          `[finalise] round ${cfg.protocol.target_round} is due at ${cfg.protocol.target_round_utc}, ` +
          `${Math.round(nap / 1000)}s away; sleeping until then`);
      } else if (Date.now() - lastLateLog >= LATE_LOG_MS) {
        lastLateLog = Date.now();
        const behind = Math.round((Date.now() - cfg.protocol.target_round_ms) / 1000);
        log.info?.(
          `[finalise] round ${cfg.protocol.target_round} not out yet, ${behind}s past its time; ` +
          `polling every ${pollMs / 1000}s`);
      }
      // Never sleep past the moment we would give up anyway: the sleep to the round is
      // long, and a caller whose maxWaitMs is shorter than its own interval deserves to
      // be told so on time rather than after it.
      await new Promise((r) => setTimeout(r, Math.min(nap, Math.max(deadline - Date.now(), 0))));
    }
  }
  log.info?.(`[finalise] round ${cfg.protocol.target_round} landed; confirmed by ${beacon.mirrors.length} mirror(s)`);

  // tlock does not ask the beacon it was handed whether it is time yet. It recomputes
  // genesis_time + (round - 1) * period and compares that with THIS machine's clock
  // (tlock-js/drand/timelock-decrypter.js). So a host running a second or two behind
  // drand refuses to open a ciphertext it is already holding the key for — and refuses
  // it one submission at a time, which is how this showed up: the first few players
  // excluded and the rest fine, because each decryption took long enough for the clock
  // to catch up. Wait out our own clock before asking.
  const dueMs = cfg.protocol.target_round_ms;
  const shortBy = Number.isFinite(dueMs) ? dueMs + CLOCK_SLACK_MS - Date.now() : 0;
  if (shortBy > 0) {
    log.info?.(
      `[finalise] the beacon is out, but this clock is ${(shortBy / 1000).toFixed(1)}s short of ` +
      `round ${cfg.protocol.target_round}; waiting for it rather than excluding anyone`);
    if (shortBy > MAX_CLOCK_WAIT_MS) {
      // Further behind than propagation explains. Worth saying: every timestamp this
      // deployment writes is off by the same amount.
      log.warn?.(`[finalise] this machine's clock looks ${(shortBy / 1000).toFixed(0)}s slow — check NTP`);
    }
    await new Promise((r) => setTimeout(r, Math.min(shortBy, MAX_CLOCK_WAIT_MS)));
  }

  let decrypted;
  let excluded;
  for (;;) {
    try {
      ({ decrypted, excluded } = await decryptSnapshot(snapshot, cfg, log, { decryptFn: opts.decryptFn }));
      break;
    } catch (err) {
      if (!(err instanceof BeaconNotReadyError)) throw err;
      if (!wait) {
        // The scheduled job: do nothing and let the next run have it. §8 again — a few
        // seconds of delay cannot change an outcome fixed at the cutoff.
        log.info?.(`[finalise] ${err.message}; the next run will draw`);
        return { phase: 'awaiting_round' };
      }
      if (Date.now() > deadline) {
        log.error?.(`[finalise] gave up waiting for the beacon to propagate: ${err.message}`);
        return { phase: 'awaiting_round', error: err.message };
      }
      log.info?.(`[finalise] ${err.message}; retrying in ${pollMs / 1000}s`);
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }
  if (decrypted.length < cfg.protocol.quorum) {
    const notice = publishVoid(cfg, store, mirror, 'quorum not met once undecryptable submissions were excluded',
      { snapshot_size: snapshot.local_ids.length, decrypted: decrypted.length, excluded }, log);
    onPhase('void');
    await settle(store, mirror, log);
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
    publish(cfg, store, mirror, 'events/snapshot.json', rollBody(snapshot), `snapshot at cutoff (round ${beacon.round})`);
  }
  const body = publish(cfg, store, mirror, 'results.json', serialise(results), `results for drand round ${beacon.round}`);

  const stats = computeStats(results.seating, cfg.roster.players);
  store.set(KEY_RESULT, { ...results, stats });
  store.set(KEY_PHASE, 'done');
  onPhase('done');

  const sync = await syncToPantheon(cfg, results, pantheon, log, opts.sync);
  store.set(KEY_SYNC, sync);
  publishSync(cfg, store, mirror, sync, beacon.round);
  store.set(KEY_RESULT, { ...results, stats });

  await settle(store, mirror, log);
  log.info?.(`[finalise] DONE — R = ${results.R.slice(0, 16)}…, pi = [${results.permutation.join(', ')}]`);
  return { phase: 'done', results, stats, beacon, sync };
}

module.exports = {
  run, phaseOf, takeSnapshot, publishRoll, rollBody, rollDigest, decryptSnapshot, syncToPantheon, publishSync,
  retryNapMs, BeaconNotReadyError,
  readPublishedResults, republishIfUnmirrored, takeLock, releaseLock, lockPath,
  stateIsFromAnotherRound, refuseStaleState,
  KEY_PHASE, KEY_SNAPSHOT, KEY_ROLL, KEY_RESULT, KEY_SYNC, KEY_TICK, KEY_PUBLISHED,
};

if (require.main === module) {
  loadEnvFile();
  const cfg = load();

  // One draw at a time. The server's scheduler guards this with a variable in its own
  // memory, which stops nothing once there are two servers — and after the signal
  // handling below there routinely are, for a minute: `systemctl restart` starts a new
  // one while the old one's draw is deliberately still finishing. Two runs would agree
  // about the seat plan, since both recompute it from the same fixed beacon and the same
  // fixed snapshot, but they would race over the Pantheon prescript and the mirror.
  const lock = takeLock(cfg);
  if (!lock) {
    console.info('[finalise] another draw job holds the lock; leaving it to finish');
    process.exit(0);
  }

  // Signals do not interrupt a draw.
  //
  // Under systemd's default KillMode the stop signal goes to every process in the unit,
  // this one included, and Node's default action is to die on the spot. Measured on
  // systemd 255: the unit counts as stopped the moment the main process exits, and a
  // child that survives SIGTERM is left alone to finish rather than being killed later.
  // So surviving it is both possible and sufficient. (KillMode=mixed is the trap here —
  // it sends SIGKILL to whatever is left the instant the main process goes, which cannot
  // be handled at all.)
  //
  // Being killed is no longer corrupting — writeLocal renames into place — so this is
  // about not throwing away work that is nearly done: the beacon has landed, twelve
  // ciphertexts are open, and the Pantheon sync is mid-flight. A second signal exits
  // anyway, because an operator who asks twice means it.
  let signalled = false;
  for (const sig of ['SIGTERM', 'SIGINT']) {
    process.on(sig, () => {
      if (signalled) {
        console.warn(`[finalise] ${sig} again — leaving the draw unfinished, as asked`);
        releaseLock(lock);
        process.exit(130);
      }
      signalled = true;
      console.warn(`[finalise] ${sig} received; the draw is mid-flight and will finish first`);
    });
  }

  const leave = (code) => { releaseLock(lock); process.exit(code); };

  // The real stamper, here and nowhere else: PROTOCOL.md §9's anchor belongs to a
  // deployment, not to every caller of run().
  run({ cfg, wait: !process.argv.includes('--no-wait'), stamp })
    .then((out) => leave(['done', 'void', 'open', 'awaiting_round'].includes(out.phase) ? 0 : 1))
    .catch((err) => {
      console.error(err.operator ? `[finalise] ${err.message}` : `[finalise] ERROR ${err.stack || err.message}`);
      leave(1);
    });
}
