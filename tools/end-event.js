#!/usr/bin/env node
'use strict';

/**
 * Close out an event, so this checkout can hold the next one (RUNBOOK "After the event").
 *
 * There was a documented way to start a run and none to finish one. Everything an event
 * leaves behind outlives it: `var/` keeps the phase and the seat plan, `events/` keeps
 * the roll, the ciphertexts and the result. Freeze a second event over the top and the
 * first one's state is still what answers — the new event's players open the page and are
 * shown the previous event's result, because `phaseOf` reads the persisted phase when no
 * results.json is on disk.
 *
 * This is not `tools/new-round.js`. That one is §8's retry: same twelve players, same
 * event, a new target_round after a round fell short of quorum. This one is for an event
 * that is over.
 *
 * The order is archive, verify, then clear. Nothing is deleted that the archive does not
 * already hold, and if the archive does not verify, nothing is deleted at all.
 *
 * One thing is deleted for the opposite reason. `var/admin-credential.json` holds the
 * admin token captured when an event admin signed in (server/admin-credential.js), and
 * it is the one file that must never be archived or mirrored anywhere. Frey's tokens do
 * not expire, so it is cleared with the event rather than left to outlive it.
 *
 *   node tools/end-event.js --dry-run     say what would happen, change nothing
 *   node tools/end-event.js               do it
 *   node tools/end-event.js --abandon     ...for a round that never reached an end
 */

const path = require('node:path');

const { load } = require('../server/config');
const { Store } = require('../server/db');
const { Mirror } = require('../server/mirror');
const { endEvent, archiveRel } = require('../server/rounds');

const ok = (s) => process.stdout.write(`  \x1b[32mOK\x1b[0m    ${s}\n`);
const bad = (s) => process.stderr.write(`  \x1b[31mERROR\x1b[0m ${s}\n`);
const note = (s) => process.stdout.write(`        ${s}\n`);

/**
 * The one thing in this output a reader might still be able to act on.
 *
 * Closing an event is part of finishing it, and it belongs before the next freeze. After
 * it, the protocol.json that attempt ran under has been overwritten, so the archive holds
 * the ciphertexts but not the round and chain they were sealed against — and a manifest
 * that guessed those from the current file would be stating something false.
 */
function warnFrozenMoved(out, cfg) {
  note('');
  note(`NOTE: data/protocol.json already names round ${cfg.protocol.target_round}, while this`);
  note(`      evidence is from round ${out.targetRound}. The freeze it ran under is gone, so`);
  note('      the archive cannot carry it. Next time, close the event before freezing');
  note('      the one after it. If that round was tagged, the tag still has the file.');
}

/**
 * Said out loud in both branches, because --abandon means something narrower here than it
 * does anywhere else in this tool. The event drew and finished; what is being given up on
 * is a final round whose standings and beacon were already published and timestamped, and
 * which twelve people were asked to check against each other. The archive keeps the lock
 * and its .ots proof, so the promise stays readable — this is the line that records that
 * it was not kept.
 */
function warnFinalAbandoned(verb) {
  note('');
  note(`NOTE: this ${verb} events/final/lock.json with no final.json beside it. The`);
  note('      standings and the beacon it named were published and timestamped, and the');
  note('      final round was never drawn. Both are archived. Tell the players.');
}

function main(argv) {
  const dryRun = argv.includes('--dry-run');
  const abandon = argv.includes('--abandon');
  const cfg = load({});
  const store = new Store(path.join(cfg.root, 'var', 'state.sqlite'));

  try {
    // Best-effort, and disabled without a PAT. The archive is written locally either
    // way; mirroring it is what puts the evidence somewhere the organiser does not own.
    const mirror = new Mirror(process.env, { info() {}, warn() {}, error() {} });

    process.stdout.write(`\n  event in data/roster   ${cfg.roster.pantheon_event_id}\n`);
    process.stdout.write(`  round in data/protocol ${cfg.protocol.target_round}\n`);
    process.stdout.write(`  submissions in hand    ${store.listSubmissions().length}\n\n`);

    const out = endEvent(cfg, store, { dryRun, abandon, mirror, log: console });
    if (!out.ok) {
      bad(out.error);
      return 1;
    }

    if (out.dryRun) {
      ok(`round ${out.targetRound} would be archived as ${out.status}` +
        (out.willArchive.already ? ' (an archive is already there and would be kept)' : ''));
      note(`into ${archiveRel(out.targetRound)}/, with ${out.willArchive.submissions} ciphertext(s)`);
      note(out.removed.length ? `then cleared: ${out.removed.join(', ')}, events/submissions/` : 'then cleared: nothing live');
      note(`and ${out.cleared} submission row(s) from var/state.sqlite`);
      note(out.credentialCleared
        ? 'and var/admin-credential.json, the captured admin token, would be deleted'
        : 'no captured admin token on disk, so there is none to delete');
      if (out.frozenMoved) warnFrozenMoved(out, cfg);
      if (out.final.locked && !out.final.drawn) warnFinalAbandoned('would archive and then clear');
      note('nothing was changed');
      return 0;
    }

    ok(`round ${out.targetRound} archived as ${out.status} into ${archiveRel(out.targetRound)}/`);
    ok(`archive verified: ${Object.keys(out.archived.files).length} file(s), every digest recomputed`);
    ok(`cleared ${out.cleared} submission row(s) and ${out.removed.length} live path(s)`);
    if (out.credentialCleared) {
      ok('deleted var/admin-credential.json, the admin token captured at sign-in');
      note("Frey's tokens do not expire, so it is removed with the event rather than left");
      note('on disk. The next event captures a fresh one when an admin signs in.');
    }
    if (out.frozenMoved) warnFrozenMoved(out, cfg);
    if (out.final.locked && !out.final.drawn) warnFinalAbandoned('archived and then cleared');
    for (const rel of out.removed) note(`removed ${rel}`);

    if (!mirror.enabled) {
      note('');
      note('MIRROR_REPO and MIRROR_TOKEN are unset, so that archive exists only on this');
      note('machine, and events/ is gitignored. Copy it somewhere before you need it.');
    }
    note('');
    note('This checkout is ready for the next event: pick a round, freeze a roster.');
    note('  node tools/pick-round.js --in 72h --write');
    note('  node tools/freeze.js --event <id> --write');
    return 0;
  } finally {
    store.close();
  }
}

if (require.main === module) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (err) {
    bad(err.message);
    process.exit(2);
  }
}

module.exports = { main };
