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

const fs = require('node:fs');
const path = require('node:path');

const { load } = require('./config');
const { Store } = require('./db');
const { Drand } = require('./drand');
const { decryptPayload } = require('./tlock');
const { Mirror, writeLocal } = require('./mirror');
const { computeStats } = require('./stats');
const { createPantheon, PantheonError } = require('./pantheon');
const { generate, serialise } = require('../generate');

const KEY_SNAPSHOT = 'snapshot';
const KEY_PHASE = 'phase';
const KEY_RESULT = 'result';
const KEY_SYNC = 'pantheon_sync';

/** Phase as §6 defines it, derived from persisted state plus the clock. */
function phaseOf(cfg, store, nowMs = Date.now()) {
  const persisted = store.get(KEY_PHASE);
  if (persisted === 'done' || persisted === 'void' || persisted === 'revealing') return persisted;

  // A published results.json outranks anything the database says. RUNBOOK is explicit
  // that results.json is authoritative, and the SQLite state is expendable — every
  // ciphertext is also mirrored to the repository. Without this, restoring a server
  // onto a fresh database after a completed draw would report the round as void,
  // because an empty submissions table past the cutoff looks exactly like a quorum
  // failure. Telling players a finished, published draw was void is the worst
  // wrong answer available here.
  if (fs.existsSync(path.join(cfg.root, 'results.json'))) return 'done';

  if (nowMs < cfg.protocol.cutoff_ms) return 'open';
  const snap = store.get(KEY_SNAPSHOT);
  const count = snap ? snap.local_ids.length : store.snapshotAt(cfg.protocol.cutoff_ms).length;
  return count >= cfg.protocol.quorum ? 'awaiting_round' : 'void';
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
async function decryptSnapshot(snapshot, protocol, log) {
  const decrypted = [];
  const excluded = [];
  // tlock-js prints the whole beacon on every decrypt; a dozen copies of one line
  // buries the only thing an operator needs to see here, which is whether any failed.
  const realLog = console.log;
  console.log = () => {};
  try {
    for (const s of snapshot.submissions) {
      try {
        const payload = await decryptPayload(s.ciphertext, protocol);
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
  log.error?.(`[finalise] ROUND VOID — ${reason}`);
  return notice;
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
  const drand = opts.drand || new Drand(cfg.protocol.chain_hash, [cfg.protocol.drand_api]);
  const pantheon = opts.pantheon || createPantheon(cfg, process.env);
  const onPhase = opts.onPhase || (() => {});
  const wait = opts.wait !== false;
  const pollMs = opts.pollMs ?? 15_000;
  const maxWaitMs = opts.maxWaitMs ?? 60 * 60 * 1000;
  const now = opts.now ?? Date.now();

  if (store.get(KEY_PHASE) === 'done') {
    log.info?.('[finalise] already done — nothing to do');
    return { phase: 'done', results: store.get(KEY_RESULT) };
  }
  if (store.get(KEY_PHASE) === 'void') {
    log.info?.('[finalise] already void — waiting on a new target_round');
    return { phase: 'void' };
  }
  if (now < cfg.protocol.cutoff_ms) {
    const mins = Math.ceil((cfg.protocol.cutoff_ms - now) / 60000);
    log.info?.(`[finalise] cutoff is ${mins} minute(s) away; nothing to do`);
    return { phase: 'open' };
  }

  const snapshot = takeSnapshot(cfg, store, log);

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

  const { decrypted, excluded } = await decryptSnapshot(snapshot, cfg.protocol, log);
  if (decrypted.length < cfg.protocol.quorum) {
    const notice = publishVoid(cfg, store, mirror, 'quorum not met once undecryptable submissions were excluded',
      { snapshot_size: snapshot.local_ids.length, decrypted: decrypted.length, excluded }, log);
    onPhase('void');
    return { phase: 'void', notice };
  }

  store.set(KEY_PHASE, 'revealing');
  onPhase('revealing');

  const results = generate({
    decrypted,
    roster: cfg.roster,
    protocol: cfg.protocol,
    template: cfg.template,
    signature: beacon.signature,
    round: beacon.round,
  });
  if (excluded.length) results.excluded_local_ids = excluded;

  // Publish the draw BEFORE syncing. The seat plan is authoritative the moment it is
  // computed; Pantheon is a delivery target, and a delivery problem must never make
  // the result look unsettled.
  const body = serialise(results);
  writeLocal(cfg.root, 'results.json', body);
  mirror.enqueue('results.json', body, `results for drand round ${beacon.round}`);
  const snapBody = JSON.stringify(snapshot, null, 2) + '\n';
  writeLocal(cfg.root, 'events/snapshot.json', snapBody);
  mirror.enqueue('events/snapshot.json', snapBody, `snapshot at cutoff (round ${beacon.round})`);

  const stats = computeStats(results.seating, cfg.roster.players);
  store.set(KEY_RESULT, { ...results, stats });
  store.set(KEY_PHASE, 'done');
  onPhase('done');

  const sync = await syncToPantheon(cfg, results, pantheon, log, opts.sync);
  store.set(KEY_SYNC, sync);
  // results.json records the sync outcome (§4), so rewrite it once the answer is known.
  const withSync = serialise({ ...results, pantheon_sync: sync });
  writeLocal(cfg.root, 'results.json', withSync);
  mirror.enqueue('results.json', withSync, `results + pantheon sync (round ${beacon.round})`);
  store.set(KEY_RESULT, { ...results, pantheon_sync: sync, stats });

  await mirror.drain?.();
  log.info?.(`[finalise] DONE — R = ${results.R.slice(0, 16)}…, pi = [${results.permutation.join(', ')}]`);
  return { phase: 'done', results: { ...results, pantheon_sync: sync }, stats, beacon, sync };
}

module.exports = {
  run, phaseOf, takeSnapshot, decryptSnapshot, syncToPantheon,
  KEY_PHASE, KEY_SNAPSHOT, KEY_RESULT, KEY_SYNC,
};

if (require.main === module) {
  run({ wait: !process.argv.includes('--no-wait') })
    .then((out) => process.exit(['done', 'void', 'open', 'awaiting_round'].includes(out.phase) ? 0 : 1))
    .catch((err) => {
      console.error(`[finalise] ERROR ${err.stack || err.message}`);
      process.exit(1);
    });
}
