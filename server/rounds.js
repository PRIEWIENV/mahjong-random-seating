'use strict';

/**
 * Attempts, and the evidence a voided one leaves behind (PROTOCOL.md §8).
 *
 * §8's remedy for falling short of quorum is to void the round, announce a new
 * target_round, and have all twelve submit again. That makes a run a sequence of
 * attempts rather than a single event, and it raises a question the protocol does not
 * answer on its own: what happens to the first attempt's evidence?
 *
 * It must not be discarded, and not only for tidiness. "Fewer than eight submitted" is
 * a claim the organiser makes, and it is exactly the claim an organiser would make if
 * they wanted a do-over after seeing who had turned up. The only thing that turns it
 * from a claim into a fact is the evidence: the ciphertexts as received, the roll taken
 * at the cutoff, and the frozen parameters they were sealed under. Once the voided
 * target_round's beacon lands — three seconds later, whatever anyone does — every one of
 * those ciphertexts can be opened by anybody, and the count checked.
 *
 * So an attempt is archived at the moment it is declared void, while all of it is still
 * live and consistent, into events/rounds/<target_round>/. Crucially that includes
 * protocol.json: the next attempt overwrites it with a new target_round, and without the
 * copy the archived ciphertexts would name a chain and round nobody could look up.
 *
 * Nothing here is ever deleted. resetForNewRound() clears the LIVE tables so the next
 * attempt can open, and refuses to run unless the archive is already in place and
 * verifies.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { writeLocal } = require('./mirror');

const ROUNDS_DIR = 'events/rounds';
const INDEX_PATH = `${ROUNDS_DIR}/index.json`;

const j = (o) => JSON.stringify(o, null, 2) + '\n';
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

const archiveRel = (targetRound) => `${ROUNDS_DIR}/${targetRound}`;
const archiveAbs = (cfg, targetRound) => path.join(cfg.root, archiveRel(targetRound));
const indexAbs = (cfg) => path.join(cfg.root, INDEX_PATH);

function readIndex(cfg) {
  try {
    const parsed = JSON.parse(fs.readFileSync(indexAbs(cfg), 'utf8'));
    return Array.isArray(parsed.attempts) ? parsed.attempts : [];
  } catch {
    return [];
  }
}

/**
 * The attempts that belong to the run which is open now (§8).
 *
 * The index is a log of every attempt this checkout has ever archived, and that is more
 * than one event: closing out a finished draw leaves its entry in place, and the next
 * event opens underneath it. §8's "attempt" is a narrower thing — a round that fell
 * short of quorum and was voided, within the run that is still looking for a result. A
 * finished or abandoned attempt ends a run, so it and everything before it belong to a
 * different event and are not this run's history.
 *
 * The distinction is not cosmetic. The submission stage reads the last of these to tell
 * a player why they are being asked for a number a second time, and over the whole index
 * it told them that a draw which had *succeeded* with nine submissions had fallen short
 * of eight — which is precisely the accusation §8's evidence exists to refute.
 *
 * An entry with no status at all predates the generalised archive, which only ever wrote
 * voided attempts, so it counts as one.
 */
function attemptsInThisRun(index) {
  const ended = index.findLastIndex((a) => (a.status ?? 'void') !== 'void');
  return index.slice(ended + 1);
}

/** §8's case: an attempt that fell short of quorum. */
function archiveVoidedAttempt(cfg, store, notice, mirror, log = console) {
  return archiveAttempt(cfg, store, { status: 'void', notice, reason: notice.reason }, mirror, log);
}

/**
 * Copy one attempt's evidence into events/rounds/<target_round>/ and record it.
 *
 * Voided attempts are archived the moment they are declared, because §8 makes them a
 * claim that has to be checkable. A finished one is archived for a different reason and
 * at a different moment: when the event is closed out, so that the checkout can hold a
 * second event without the first one's files sitting in it, still being served and still
 * being offered to the mirror. Same evidence either way, and the manifest says which.
 *
 * @param {object} outcome `{status, notice?, reason?}` — 'void', 'done' or 'abandoned'
 * @returns {object} the index entry that was appended
 */
function archiveAttempt(cfg, store, outcome, mirror, log = console) {
  const { status, notice = null, reason = null } = outcome;
  // The round an attempt is about comes from its own evidence when the caller knows it.
  // Closing an event after somebody has already frozen the next one is exactly when that
  // differs from what protocol.json says, and archiving twelve ciphertexts under a round
  // they were never sealed against would make the archive worse than useless.
  const targetRound = outcome.targetRound ?? cfg.protocol.target_round;
  // Whether data/ still holds the freeze this attempt ran under. It always does in the
  // case the protocol describes, because a voided attempt is archived the moment it is
  // declared.
  const frozenIsThisAttempt = targetRound === cfg.protocol.target_round;
  const dir = archiveAbs(cfg, targetRound);
  if (fs.existsSync(path.join(dir, 'manifest.json'))) {
    log.info?.(`[rounds] attempt ${targetRound} is already archived`);
    return readIndex(cfg).find((a) => a.target_round === targetRound) || null;
  }

  // The submissions come from the database rather than from events/submissions/, so the
  // archive holds what the server actually counted, not what happened to reach the
  // mirror. Anyone can diff the two; they are published side by side.
  const rows = store.listSubmissions();
  const files = {};
  const put = (rel, content) => {
    const body = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    writeLocal(cfg.root, `${archiveRel(targetRound)}/${rel}`, body);
    files[rel] = { sha256: sha256(body), bytes: body.length };
    mirror?.enqueue?.(`${archiveRel(targetRound)}/${rel}`, body.toString('utf8'),
      `archive attempt ${targetRound}: ${rel}`);
  };

  // The frozen artefacts AS THIS ATTEMPT RAN THEM. protocol.json is about to be
  // rewritten with a new target_round; without this copy the ciphertexts below would
  // name a round and a chain that the repository no longer records anywhere.
  if (frozenIsThisAttempt) {
    for (const name of ['protocol.json', 'roster.json']) {
      put(name, fs.readFileSync(path.join(cfg.dataDir, name)));
    }
  } else {
    log.warn?.(
      `[rounds] data/protocol.json already names round ${cfg.protocol.target_round}, so the freeze ` +
      `attempt ${targetRound} actually ran under is gone and cannot be archived beside its ` +
      'ciphertexts. Close an event before freezing the next one.');
  }
  if (notice) put('void.json', j(notice));
  const snapshot = store.get('snapshot');
  if (snapshot) put('snapshot.json', j(snapshot));

  // Whatever this attempt actually published, byte for byte as it was published. The
  // result is read from disk rather than re-serialised from the database, because the
  // database copy carries the derived statistics and would not reproduce (§4.3). The
  // OpenTimestamps proof is binary and is only evidence alongside the roll it proves.
  for (const [rel, abs] of [
    ['results.json', path.join(cfg.root, 'results.json')],
    ['snapshot.json.ots', path.join(cfg.root, 'events', 'snapshot.json.ots')],
    ['sync.json', path.join(cfg.root, 'events', 'sync.json')],
  ]) {
    if (fs.existsSync(abs)) put(rel, fs.readFileSync(abs));
  }
  for (const r of rows) {
    put(`submissions/${r.local_id}.json`,
      j({ local_id: r.local_id, ciphertext: r.ciphertext, received_at: r.received_at }));
  }

  const manifest = {
    target_round: targetRound,
    // From the roll when the freeze has already moved on, and null rather than a value
    // copied out of a protocol.json these ciphertexts were never sealed against. A
    // manifest that states the wrong chain is worse than one that states none.
    submission_cutoff_utc: frozenIsThisAttempt
      ? cfg.protocol.submission_cutoff_utc
      : (snapshot?.cutoff_utc ?? null),
    chain_hash: frozenIsThisAttempt ? cfg.protocol.chain_hash : null,
    chain_public_key: frozenIsThisAttempt ? cfg.protocol.chain_public_key : null,
    status,
    reason,
    quorum: cfg.protocol.quorum,
    total_slots: cfg.protocol.total_slots,
    frozen_parameters_archived: frozenIsThisAttempt,
    submitted_local_ids: rows.map((r) => r.local_id),
    submitted_count: rows.length,
    archived_at: new Date().toISOString(),
    how_to_verify:
      `drand round ${targetRound} is public. Once it has landed, these ciphertexts can be ` +
      'opened by anybody:\n' +
      (frozenIsThisAttempt
        ? `  node tools/decrypt-submissions.js --dir ${archiveRel(targetRound)}/submissions ` +
          `--protocol ${archiveRel(targetRound)}/protocol.json\n`
        : '  (this attempt was closed after the next event had already been frozen, so the\n' +
          '   protocol.json it ran under is not here. Take the round and the chain from the\n' +
          '   tag it was frozen at.)\n') +
      (status === 'done'
        ? `and the seat plan recomputed from the result beside them:\n` +
          `  node generate.js --verify ${archiveRel(targetRound)}/results.json\n` +
          `${rows.length} submissions were received before the cutoff, against a quorum of ` +
          `${cfg.protocol.quorum}. Both checks need nothing from the organiser.`
        : `${rows.length} submissions were received before the cutoff, against a quorum of ` +
          `${cfg.protocol.quorum}. That is why this attempt is recorded as ${status}, and it ` +
          'is checkable without trusting anyone.'),
    files,
  };
  const manifestBody = j(manifest);
  writeLocal(cfg.root, `${archiveRel(targetRound)}/manifest.json`, manifestBody);
  mirror?.enqueue?.(`${archiveRel(targetRound)}/manifest.json`, manifestBody,
    `archive attempt ${targetRound}: manifest`);

  // The index chains the manifests, so a reader needs one file to know how many attempts
  // there were and what each one's evidence hashes to. The index is itself anchored only
  // by the mirror's commit history, which is the third party in this arrangement.
  const attempts = readIndex(cfg);
  const entry = {
    attempt: attempts.length + 1,
    target_round: targetRound,
    submission_cutoff_utc: manifest.submission_cutoff_utc,
    status,
    reason,
    submitted_count: rows.length,
    quorum: cfg.protocol.quorum,
    archive: archiveRel(targetRound),
    manifest_sha256: sha256(Buffer.from(manifestBody, 'utf8')),
  };
  attempts.push(entry);
  const indexBody = j({ attempts });
  writeLocal(cfg.root, INDEX_PATH, indexBody);
  mirror?.enqueue?.(INDEX_PATH, indexBody, `attempt ${targetRound} archived as ${status}`);

  log.info?.(`[rounds] attempt ${entry.attempt} (round ${targetRound}) archived: ` +
    `${rows.length} ciphertexts, ${Object.keys(files).length + 1} files`);
  return entry;
}

/**
 * Recompute every digest in an archive's manifest.
 *
 * @returns {{ok: boolean, problems: string[], manifest: object|null}}
 */
function verifyArchive(cfg, targetRound) {
  const dir = archiveAbs(cfg, targetRound);
  const manifestFile = path.join(dir, 'manifest.json');
  if (!fs.existsSync(manifestFile)) {
    return { ok: false, problems: [`no archive at ${archiveRel(targetRound)}`], manifest: null };
  }
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  } catch (err) {
    return { ok: false, problems: [`manifest.json is not readable: ${err.message}`], manifest: null };
  }
  const problems = [];
  for (const [rel, expect] of Object.entries(manifest.files || {})) {
    const abs = path.join(dir, rel);
    if (!fs.existsSync(abs)) { problems.push(`missing: ${rel}`); continue; }
    const got = sha256(fs.readFileSync(abs));
    if (got !== expect.sha256) problems.push(`digest mismatch: ${rel}`);
  }
  const n = (manifest.submitted_local_ids || []).length;
  const onDisk = Object.keys(manifest.files || {}).filter((f) => f.startsWith('submissions/')).length;
  if (n !== onDisk) problems.push(`manifest lists ${n} submissions but ${onDisk} files`);
  return { ok: problems.length === 0, problems, manifest };
}

/**
 * Clear the LIVE state so the next attempt can open. Archives nothing and deletes
 * nothing that is not reproducible from the archive.
 *
 * Every refusal below is a rule from §8 rather than a precaution. The last one is the
 * important one: the reset is legal only once the new freeze is already in place, so
 * there is never a moment when the organiser holds an open round with no announced
 * target. Deciding what to do after seeing who has submitted is the manipulable step
 * §8 exists to remove.
 *
 * @param {object} opts `dryRun: true` runs every check and changes nothing.
 * @returns {{ok: boolean, error?: string, archived?: object, cleared?: number}}
 */
function resetForNewRound(cfg, store, opts = {}) {
  const log = opts.log || console;

  if (fs.existsSync(path.join(cfg.root, 'results.json'))) {
    return { ok: false, error: 'this run has a published results.json — a completed draw is never restarted' };
  }
  const voidFile = path.join(cfg.root, 'events', 'void.json');
  if (!fs.existsSync(voidFile)) {
    return {
      ok: false,
      error:
        'no events/void.json — only a round that was actually declared void may be reset. ' +
        'Restarting an open round after seeing who has submitted is the step §8 forbids.',
    };
  }
  let notice;
  try {
    notice = JSON.parse(fs.readFileSync(voidFile, 'utf8'));
  } catch (err) {
    return { ok: false, error: `events/void.json is not readable: ${err.message}` };
  }
  const voided = notice.target_round;
  if (!Number.isInteger(voided)) {
    return { ok: false, error: 'events/void.json names no target_round' };
  }

  const check = verifyArchive(cfg, voided);
  if (!check.ok) {
    return {
      ok: false,
      error: `the archive for attempt ${voided} is missing or does not verify:\n  ` +
        check.problems.join('\n  ') +
        '\nThe previous attempt is evidence. Nothing is cleared until it is safely recorded.',
    };
  }

  // The new freeze must already be in place.
  if (cfg.protocol.target_round === voided) {
    return {
      ok: false,
      error:
        `data/protocol.json still names the voided round ${voided}. Choose a new target_round ` +
        'first (tools/pick-round.js --in 72h --write), commit, re-tag, and announce the tag. ' +
        'Only then reset.',
    };
  }
  if (cfg.protocol.target_round <= voided) {
    return {
      ok: false,
      error: `the new target_round ${cfg.protocol.target_round} is not after the voided round ${voided}`,
    };
  }
  if (cfg.protocol.cutoff_ms <= (opts.now ?? Date.now())) {
    return { ok: false, error: 'the new submission_cutoff_utc is already in the past' };
  }

  if (opts.dryRun) {
    return { ok: true, dryRun: true, archived: check.manifest, voided, cleared: 0 };
  }

  // The notice stops being the top-level answer phaseOf gives for the CURRENT round.
  // It is not deleted: the archived copy at events/rounds/<voided>/void.json is the
  // record, and verifyArchive above has just confirmed it byte for byte.
  const cleared = store.clearRound();
  fs.rmSync(voidFile);

  log.info?.(`[rounds] attempt ${voided} closed and archived; ` +
    `${cleared} submission(s) cleared, now open for round ${cfg.protocol.target_round}`);
  return { ok: true, archived: check.manifest, cleared, voided };
}

/** The files one event leaves live in the tree, as opposed to archived. */
const LIVE_FILES = [
  'results.json',
  'events/snapshot.json',
  'events/snapshot.json.ots',
  'events/sync.json',
  'events/void.json',
];

/**
 * Close out an event, so the checkout can hold the next one.
 *
 * There was a documented way to start a run and no documented way to finish one, and the
 * gap is not cosmetic. Everything an event leaves behind outlives it: `var/` keeps the
 * phase and the seat plan, `events/` keeps the roll and the result. Freeze a second event
 * over the top and the first one's state is still what answers — `phaseOf` reads the
 * persisted phase when no results.json is on disk, so the new event's players are shown
 * the old event's result, and a configured mirror is offered the old event's roll under
 * the new event's name.
 *
 * This is not `resetForNewRound`. That one is §8's retry: the same twelve players, the
 * same event, a new target_round, and a set of refusals that exist so an organiser cannot
 * restart a round after seeing who has submitted. This is the other thing — the event is
 * over, or is being given up on, and what has to survive is the evidence.
 *
 * So: archive first, verify the archive, and only then clear. Nothing is deleted that the
 * archive does not already hold, and if the archive does not verify, nothing is deleted
 * at all.
 *
 * @param {object} opts `dryRun`, `abandon`, `mirror`, `log`, `now`
 * @returns {{ok: boolean, error?: string, status?: string, archived?: object, cleared?: number, removed?: string[]}}
 */
/** Which round the evidence in this tree is about, whatever protocol.json says now. */
function attemptRound(cfg, store) {
  const fromJson = (abs, field) => {
    try { return JSON.parse(fs.readFileSync(abs, 'utf8'))[field]; } catch { return undefined; }
  };
  const candidates = [
    store.get('result')?.round_used,
    fromJson(path.join(cfg.root, 'results.json'), 'round_used'),
    fromJson(path.join(cfg.root, 'events', 'void.json'), 'target_round'),
    cfg.protocol.target_round,
  ];
  return candidates.find(Number.isInteger);
}

function endEvent(cfg, store, opts = {}) {
  const log = opts.log || console;
  const now = opts.now ?? Date.now();
  const targetRound = attemptRound(cfg, store);

  const resultsFile = path.join(cfg.root, 'results.json');
  const voidFile = path.join(cfg.root, 'events', 'void.json');
  const done = fs.existsSync(resultsFile) || store.get('phase') === 'done';
  const isVoid = fs.existsSync(voidFile) || store.get('phase') === 'void';
  const rows = store.listSubmissions();
  const live = LIVE_FILES.filter((rel) => fs.existsSync(path.join(cfg.root, rel)));

  if (!done && !isVoid && !rows.length && !live.length && !store.get('snapshot')) {
    return { ok: false, error: 'nothing to close: no submissions, no roll, no result, no void notice' };
  }

  // An event that has not reached an end of its own is being given up on, and that is a
  // decision rather than a tidy-up. Saying so on the command line is the whole of the
  // safeguard, but it is the difference between ending an event and quietly discarding
  // a round after seeing who turned up — which is the step §8 exists to remove.
  const status = done ? 'done' : isVoid ? 'void' : 'abandoned';
  if (status === 'abandoned' && !opts.abandon) {
    const when = now < cfg.protocol.cutoff_ms ? 'is still open' : 'has passed its cutoff without drawing';
    return {
      ok: false,
      error:
        `round ${targetRound} ${when}, with ${rows.length} submission(s) in hand. Ending it now is ` +
        'abandoning it, not closing it, and abandoning a round after seeing who has submitted is ' +
        'the manipulable step §8 exists to remove.\n' +
        'If the draw simply has not happened yet, wait for it. If this really is being given up ' +
        'on, say so: node tools/end-event.js --abandon',
    };
  }

  const existing = fs.existsSync(path.join(archiveAbs(cfg, targetRound), 'manifest.json'));
  // Said in the dry run as well as during the archive, because it is the one thing here
  // a reader might still be able to do something about.
  const frozenMoved = targetRound !== cfg.protocol.target_round;
  if (opts.dryRun) {
    return {
      ok: true, dryRun: true, status, targetRound, frozenMoved,
      archived: existing ? verifyArchive(cfg, targetRound).manifest : null,
      willArchive: { submissions: rows.length, files: live, already: existing },
      removed: live,
      cleared: rows.length,
    };
  }

  archiveAttempt(cfg, store, { status, targetRound, reason: opts.reason || null }, opts.mirror, log);
  const check = verifyArchive(cfg, targetRound);
  if (!check.ok) {
    return {
      ok: false,
      error:
        `the archive for round ${targetRound} does not verify:\n  ${check.problems.join('\n  ')}\n` +
        'Nothing has been cleared. The evidence comes first.',
    };
  }

  const removed = [];
  for (const rel of live) {
    fs.rmSync(path.join(cfg.root, rel));
    removed.push(rel);
  }
  // The per-submission mirror copies. Every one of them is inside the archive, and they
  // are the files a new event would otherwise appear to have received before it opened.
  const subsDir = path.join(cfg.root, 'events', 'submissions');
  if (fs.existsSync(subsDir)) {
    fs.rmSync(subsDir, { recursive: true, force: true });
    removed.push('events/submissions/');
  }
  const cleared = store.clearRound();

  log.info?.(`[rounds] event closed: round ${targetRound} archived as ${status}, ` +
    `${cleared} submission(s) and ${removed.length} live path(s) cleared`);
  return { ok: true, status, targetRound, frozenMoved, archived: check.manifest, cleared, removed };
}

module.exports = {
  archiveVoidedAttempt, archiveAttempt, verifyArchive, resetForNewRound, endEvent, attemptRound, readIndex, attemptsInThisRun,
  ROUNDS_DIR, INDEX_PATH, archiveRel, LIVE_FILES,
};
