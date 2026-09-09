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
 * Copy one attempt's evidence into events/rounds/<target_round>/ and record it.
 *
 * @param {object} notice the void notice as published, already on disk
 * @returns {object} the index entry that was appended
 */
function archiveVoidedAttempt(cfg, store, notice, mirror, log = console) {
  const targetRound = cfg.protocol.target_round;
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
  for (const name of ['protocol.json', 'roster.json']) {
    put(name, fs.readFileSync(path.join(cfg.dataDir, name)));
  }
  put('void.json', j(notice));
  const snapshot = store.get('snapshot');
  if (snapshot) put('snapshot.json', j(snapshot));
  for (const r of rows) {
    put(`submissions/${r.local_id}.json`,
      j({ local_id: r.local_id, ciphertext: r.ciphertext, received_at: r.received_at }));
  }

  const manifest = {
    target_round: targetRound,
    submission_cutoff_utc: cfg.protocol.submission_cutoff_utc,
    chain_hash: cfg.protocol.chain_hash,
    chain_public_key: cfg.protocol.chain_public_key,
    status: 'void',
    reason: notice.reason,
    quorum: cfg.protocol.quorum,
    total_slots: cfg.protocol.total_slots,
    submitted_local_ids: rows.map((r) => r.local_id),
    submitted_count: rows.length,
    archived_at: new Date().toISOString(),
    how_to_verify:
      `drand round ${targetRound} is public. Once it has landed, these ciphertexts can be ` +
      'opened by anybody:\n' +
      `  node tools/decrypt-submissions.js --dir ${archiveRel(targetRound)}/submissions ` +
      `--protocol ${archiveRel(targetRound)}/protocol.json\n` +
      `${rows.length} submissions were received before the cutoff, against a quorum of ` +
      `${cfg.protocol.quorum}. That is why this attempt was void, and it is checkable ` +
      'without trusting anyone.',
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
    submission_cutoff_utc: cfg.protocol.submission_cutoff_utc,
    status: 'void',
    reason: notice.reason,
    submitted_count: rows.length,
    quorum: cfg.protocol.quorum,
    archive: archiveRel(targetRound),
    manifest_sha256: sha256(Buffer.from(manifestBody, 'utf8')),
  };
  attempts.push(entry);
  const indexBody = j({ attempts });
  writeLocal(cfg.root, INDEX_PATH, indexBody);
  mirror?.enqueue?.(INDEX_PATH, indexBody, `attempt ${targetRound} voided and archived`);

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

module.exports = {
  archiveVoidedAttempt, verifyArchive, resetForNewRound, readIndex,
  ROUNDS_DIR, INDEX_PATH, archiveRel,
};
