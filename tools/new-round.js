#!/usr/bin/env node
'use strict';

/**
 * Open a new attempt after a voided round (PROTOCOL.md §8, RUNBOOK "Fewer than 8").
 *
 * §8 says: void the round, announce a new target_round, and have all twelve submit
 * again. This is the command that makes the third part possible. Until it exists, a
 * voided round is a dead end — the phase stays void, the lapsed ciphertexts still count
 * towards the new quorum, and every player is told they have already submitted.
 *
 * The previous attempt is not cleared. It was archived the moment it was declared void,
 * into events/rounds/<target_round>/, with its ciphertexts, the roll taken at the
 * cutoff, the frozen parameters it ran under, and a manifest of SHA-256 digests. This
 * command re-verifies that archive and refuses to touch anything if it does not check
 * out. What it clears is only the LIVE tables, so the next attempt can open.
 *
 * The order matters and is enforced: re-freeze first, reset second. There is never a
 * moment when the organiser holds an open round with no announced target, because
 * deciding what to do after seeing who has submitted is the manipulable step §8 exists
 * to remove.
 *
 *   node tools/new-round.js --dry-run     # say what would happen, change nothing
 *   node tools/new-round.js               # do it
 */

const path = require('node:path');

const { load } = require('../server/config');
const { Store } = require('../server/db');
const { resetForNewRound, verifyArchive, readIndex, archiveRel } = require('../server/rounds');

const ROOT = path.join(__dirname, '..');

function main(argv) {
  const dryRun = argv.includes('--dry-run');
  const cfg = load({});
  const store = new Store(path.join(cfg.root, 'var', 'state.sqlite'));

  try {
    const attempts = readIndex(cfg);
    process.stdout.write(`\n  attempts so far        ${attempts.length}\n`);
    for (const a of attempts) {
      process.stdout.write(
        `    #${a.attempt}  round ${a.target_round}  ${a.status}  ` +
          `${a.submitted_count}/${a.quorum} submitted  ->  ${a.archive}\n`
      );
    }
    process.stdout.write(`  protocol.json now says target_round ${cfg.protocol.target_round}, ` +
      `cutoff ${cfg.protocol.submission_cutoff_utc}\n\n`);

    if (dryRun) {
      const probe = resetForNewRound(cfg, store, { dryRun: true, log: QUIET });
      if (!probe.ok) {
        process.stderr.write(`  WOULD REFUSE\n  ${probe.error.replace(/\n/g, '\n  ')}\n`);
        return 1;
      }
      process.stdout.write(
        `  would clear ${store.submittedLocalIds().length} live submission(s) and open ` +
          `round ${cfg.protocol.target_round}.\n  attempt ${probe.voided} stays at ` +
          `${archiveRel(probe.voided)}/ — verified, and not touched by this.\n`
      );
      process.stdout.write('  (dry run — nothing changed)\n');
      return 0;
    }

    const out = resetForNewRound(cfg, store, {});
    if (!out.ok) {
      process.stderr.write(`\n  REFUSED\n  ${out.error.replace(/\n/g, '\n  ')}\n\n`);
      return 1;
    }

    const check = verifyArchive(cfg, out.voided);
    process.stdout.write(
      `  attempt ${out.voided} archived and verified: ${check.manifest.submitted_count} ciphertext(s), ` +
        `${Object.keys(check.manifest.files).length} files under ${archiveRel(out.voided)}\n`
    );
    process.stdout.write(`  ${out.cleared} live submission(s) cleared; sessions kept\n\n`);
    process.stdout.write(`  Round ${cfg.protocol.target_round} is now open until ${cfg.protocol.submission_cutoff_utc}.\n`);
    process.stdout.write('  Tell the players: the tag, that ALL twelve must submit again, and that the\n');
    process.stdout.write(`  previous attempt is published at ${archiveRel(out.voided)}/ for anyone who\n`);
    process.stdout.write('  wants to confirm it really was short of quorum.\n');
    return 0;
  } finally {
    store.close();
  }
}

const QUIET = { info() {}, warn() {}, error() {} };

if (require.main === module) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (err) {
    process.stderr.write(`  ERROR ${err.message}\n`);
    process.exit(1);
  }
}

module.exports = { main, ROOT };
