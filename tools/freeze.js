#!/usr/bin/env node
'use strict';

/**
 * RUNBOOK section B, steps 10 and 11 — the freeze, as one auditable command.
 *
 * Those steps were prose: pull the roster out of Pantheon by hand, retype twelve rows
 * into roster.json, remember to check the local ids, remember to re-verify the template,
 * remember that `--check` needs a dev machine, then commit exactly four files and tag
 * them. Every one of those is a step somebody performs once, under time pressure, on the
 * day, and half of them fail silently: a missing local_id does not surface until the
 * seat-plan sync, which happens after the draw, when nothing can be changed.
 *
 * So this snapshots the roster and refuses to freeze anything that would not survive the
 * run. It does not commit or tag unless asked: --tag <name> is the only thing that
 * writes to git, and without it this prints the two commands for you to run yourself.
 *
 *   node tools/freeze.js --event 42          first freeze: no roster.json exists yet
 *   node tools/freeze.js                     snapshot + check, write nothing
 *   node tools/freeze.js --write             write data/roster.json too
 *   node tools/freeze.js --write --tag frozen-v1     ...and commit and tag
 *
 * PANTHEON_MODE=stub exercises the whole thing without a Pantheon deployment;
 * tools/rehearse.js drives section B end to end that way, which is how the first-freeze
 * bug below was found.
 */

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const { load, readJson } = require('../server/config');
const { createPantheon } = require('../server/pantheon');
const { ENCODING_LIMITS } = require('../generate.js');

const ROOT = path.join(__dirname, '..');
const FROZEN = ['data/roster.json', 'data/protocol.json', 'data/schedule_template.json', 'generate.js'];

const ok = (s) => `  \x1b[32mOK\x1b[0m    ${s}`;
const bad = (s) => `  \x1b[31mFAIL\x1b[0m  ${s}`;
const warn = (s) => `  \x1b[33mWARN\x1b[0m  ${s}`;

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const k = a.slice(2);
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) out[k] = true;
    else { out[k] = v; i++; }
  }
  return out;
}

/**
 * Step 10: read the event roster out of Pantheon and turn it into roster.json.
 *
 * Every refusal here is a failure that would otherwise land after the draw. A missing
 * local_id blocks the seat-plan sync; a thirteenth registration changes who is in the
 * draw; a duplicate person_id lets one account submit twice.
 */
async function snapshotRoster(cfg, problems, injected, eventIdOverride) {
  const pantheon = injected || createPantheon(cfg, process.env);
  // On a first freeze there is no roster.json to read the event id out of, and it is the
  // one thing that cannot be derived from anything else — hence --event.
  const eventId = cfg.roster?.pantheon_event_id ?? Number(eventIdOverride ?? process.env.PANTHEON_EVENT_ID);
  if (!Number.isInteger(eventId) || eventId < 1) {
    problems.push('no pantheon_event_id: pass --event <id> (first freeze), put one in data/roster.json, or set PANTHEON_EVENT_ID');
    return null;
  }

  let registered;
  try {
    registered = await pantheon.getEventRoster(eventId);
  } catch (err) {
    problems.push(`Pantheon did not answer for event ${eventId}: ${err.message}`);
    return null;
  }

  const playing = registered.filter((p) => !p.ignore_seating);
  const { local_id_min: lo, local_id_max: hi } = ENCODING_LIMITS;

  if (playing.length !== cfg.protocol.total_slots) {
    problems.push(
      `Pantheon event ${eventId} has ${playing.length} seated players, protocol.json says ` +
        `${cfg.protocol.total_slots}. Fix the registrations before freezing, not after.`
    );
  }
  const missingLocal = playing.filter((p) => !Number.isInteger(p.local_id) || p.local_id < lo || p.local_id > hi);
  if (missingLocal.length) {
    problems.push(
      `no usable local_id for: ${missingLocal.map((p) => p.title || p.person_id).join(', ')}. ` +
        'Set them with UpdatePlayersLocalIds. The seat plan is written back in local ids, so a ' +
        'missing one blocks the sync — after the draw, when nothing can be changed.'
    );
  }
  const seen = new Set();
  for (const p of playing) {
    if (seen.has(p.person_id)) problems.push(`person_id ${p.person_id} is registered twice`);
    seen.add(p.person_id);
    if (!p.title || !String(p.title).trim()) problems.push(`person_id ${p.person_id} has no title`);
  }

  return {
    pantheon_event_id: eventId,
    players: playing
      .map((p) => ({ local_id: p.local_id, person_id: p.person_id, title: p.title }))
      .sort((a, b) => a.local_id - b.local_id),
  };
}

/**
 * Step 10's second half: decide whether the snapshot becomes data/roster.json.
 *
 * The guard on `problems` is the part that matters. snapshotRoster reports what is wrong
 * with the registrations but still returns the roster it read, so without it a refused
 * freeze wrote out a roster built from a registration list it had just refused — and the
 * next run, finding a file where there had been none, compared against that instead.
 * Found by tools/rehearse.js on its first pass through section B.
 */
function applyRosterSnapshot({ cfg, snapshot, problems, lines, write }) {
  if (!snapshot) return cfg;
  if (problems.length) {
    lines.push(warn('data/roster.json not written — fix the registrations above and run this again'));
    return cfg;
  }

  const writeRoster = () => {
    fs.writeFileSync(path.join(cfg.dataDir, 'roster.json'), JSON.stringify(snapshot, null, 2) + '\n');
    // Re-read it strictly. What was just written is what the server, the finalisation
    // job and every verifier will load, so the checks below should run against that
    // rather than against the object this process happens to be holding.
    try {
      // The same data directory that was just written to, not the default one: a re-read
      // that silently looks somewhere else would report on a file nobody edited.
      return load({ dataDir: cfg.dataDir });
    } catch (err) {
      problems.push(`data/roster.json was written but does not load: ${err.message}`);
      return cfg;
    }
  };

  if (cfg.rosterError) {
    if (!write) {
      const why = /^missing /.test(cfg.rosterError.message)
        ? 'the file does not exist yet'
        : cfg.rosterError.message;
      lines.push(warn(`no usable data/roster.json yet — ${why}`));
      lines.push('        re-run with --write to snapshot it from Pantheon; that is what step 10 is');
      return cfg;
    }
    const next = writeRoster();
    lines.push(ok(`data/roster.json created from Pantheon event ${snapshot.pantheon_event_id} (${snapshot.players.length} players)`));
    return next;
  }

  if (JSON.stringify(cfg.roster.players) === JSON.stringify(snapshot.players)) {
    lines.push(ok(`roster matches Pantheon event ${snapshot.pantheon_event_id} (${snapshot.players.length} players)`));
    return cfg;
  }
  if (write) {
    const next = writeRoster();
    lines.push(ok(`data/roster.json rewritten from Pantheon (${snapshot.players.length} players)`));
    return next;
  }
  lines.push(warn('data/roster.json differs from Pantheon — re-run with --write to snapshot it'));
  for (const p of snapshot.players) {
    const had = cfg.roster.players.find((q) => q.local_id === p.local_id);
    if (!had || had.person_id !== p.person_id || had.title !== p.title) {
      lines.push(`        local_id ${p.local_id}: ${had ? `${had.title} (${had.person_id})` : '—'} -> ${p.title} (${p.person_id})`);
    }
  }
  return cfg;
}

/** Step 11's checks, plus the ones RUNBOOK A leaves to memory. */
function preflight(cfg, lines, problems) {
  const now = Date.now();

  if (cfg.protocol.cutoff_ms <= now) {
    problems.push(`submission_cutoff_utc ${cfg.protocol.submission_cutoff_utc} is already in the past`);
  } else {
    const hours = (cfg.protocol.cutoff_ms - now) / 3_600_000;
    lines.push((hours < 24 ? warn : ok)(
      `submission window ${hours.toFixed(1)} hours` + (hours < 24 ? ' — RUNBOOK suggests 72' : '')
    ));
  }
  lines.push(ok(`target_round ${cfg.protocol.target_round}, quorum ${cfg.protocol.quorum} of ${cfg.protocol.total_slots}`));
  lines.push(ok(`chain pinned by hash and public key (${cfg.protocol.chain_hash.slice(0, 16)}…)`));

  // The tag refs name the tag this freeze is about to create, so they are the one part
  // of protocol.json that cannot be checked by config.js at load time.
  for (const k of ['schedule_template_ref', 'generate_script_ref']) {
    const v = cfg.protocol[k];
    if (typeof v !== 'string' || !v.includes('@')) problems.push(`protocol.json: ${k} must be "<path>@<tag>"`);
  }

  const run = (label, args) => {
    try {
      execFileSync(process.execPath, args, { cwd: ROOT, stdio: 'pipe', encoding: 'utf8' });
      lines.push(ok(label));
      return true;
    } catch (err) {
      const detail = String(err.stdout || '') + String(err.stderr || '');
      // The interesting lines, not the summary. A test runner's last line is always
      // "test failed", which tells an operator nothing about which one.
      const why = detail.split('\n').filter((l) => /^(not ok|✖|\s+error:)/.test(l)).slice(0, 4);
      problems.push(
        `${label}:\n        ` +
          (why.length ? why.join('\n        ') : detail.trim().split('\n').slice(-3).join('\n        '))
      );
      return false;
    }
  };

  run('the template re-derives every proved invariant', ['tools/verify-template.js']);
  // The strong bundle check needs esbuild, which the VPS does not have. Freezing is a
  // dev-machine job, so this is the right place for it — and the only place it happens.
  try {
    execFileSync(process.execPath, ['tools/build-client.js', '--check'], { cwd: ROOT, stdio: 'pipe' });
    lines.push(ok('the committed bundle rebuilds byte for byte from source'));
  } catch {
    try {
      execFileSync(process.execPath, ['tools/build-client.js', '--verify-hash'], { cwd: ROOT, stdio: 'pipe' });
      lines.push(warn('bundle matches its hash, but could not be rebuilt (esbuild missing?)'));
    } catch (err2) {
      problems.push(`the committed bundle does not match its hash: ${String(err2.stderr || err2.message).trim()}`);
    }
  }
  // The same set `npm test` runs. `--test test/` would sweep in e2e.js as well, which
  // wants the network and three minutes of waiting for a real drand round to land.
  const unitTests = fs.readdirSync(path.join(ROOT, 'test'))
    .filter((f) => f.endsWith('.test.js'))
    .map((f) => path.join('test', f));
  run(`the ${unitTests.length} unit test files pass`, ['--test', ...unitTests]);

  if (fs.existsSync(path.join(ROOT, 'results.json'))) {
    problems.push('results.json is present — this run has already drawn. Freezing over it would be a new run.');
  }
}

function gitStatus() {
  try {
    return execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' });
  } catch {
    return null;
  }
}

/**
 * The configuration as it stands *before* this command has done its job.
 *
 * data/roster.json is the file step 10 produces, so requiring a valid one in order to
 * start made the first freeze of an event impossible: the command that writes the twelve
 * rows refused to run until somebody had already typed the twelve rows. protocol.json is
 * a different case — a freeze with no target round is not a freeze, and pick-round.js is
 * what sets one — so that stays a hard precondition, and the error says where to go.
 */
function loadForFreeze() {
  try {
    return load({ rosterOptional: true });
  } catch (err) {
    if (/target_round|submission_cutoff/.test(err.message)) {
      throw new Error(
        `${err.message}\n        Run this first: node tools/pick-round.js --in 72h --write ` +
          '(RUNBOOK step 9 — it comes before this one)'
      );
    }
    throw err;
  }
}

async function main(argv) {
  const args = parseArgs(argv);
  const lines = [];
  const problems = [];

  let cfg = loadForFreeze();
  process.stdout.write(`\n\x1b[1mFreeze — RUNBOOK steps 10-11\x1b[0m\n\n`);

  // ---- step 10 ------------------------------------------------------------
  const snapshot = await snapshotRoster(cfg, problems, null, args.event);
  cfg = applyRosterSnapshot({ cfg, snapshot, problems, lines, write: Boolean(args.write) });

  // Everything below is about a set of twelve players: the checks, the four files, the
  // announcement. Without a roster there is nothing to freeze.
  if (!cfg.roster) problems.push('no data/roster.json — see above. Nothing was frozen.');

  // ---- step 11 ------------------------------------------------------------
  preflight(cfg, lines, problems);

  for (const l of lines) process.stdout.write(l + '\n');

  if (problems.length) {
    process.stdout.write('\n');
    for (const p of problems) process.stderr.write(bad(p) + '\n');
    process.stderr.write('\n  NOT FROZEN. Every one of these lands after the draw if it is left.\n\n');
    return 1;
  }

  // ---- step 11: commit and tag --------------------------------------------
  process.stdout.write('\n  Ready to freeze these four, and nothing else:\n');
  for (const f of FROZEN) process.stdout.write(`    ${f}\n`);
  process.stdout.write('  public/app.js and app.js.sha256 go with them (the submission code is frozen too).\n');

  const dirty = gitStatus();
  if (dirty === null) {
    process.stdout.write('\n' + warn('not a git repository — the tag is what players check, so this must be one') + '\n');
  }

  if (typeof args.tag !== 'string') {
    process.stdout.write('\n  Not tagged (pass --tag <name> to do it here). To do it by hand:\n');
    process.stdout.write(`    git add ${FROZEN.join(' ')} public/app.js public/app.css public/app.js.sha256\n`);
    process.stdout.write('    git commit -m "freeze: round ' + cfg.protocol.target_round + '"\n');
    process.stdout.write('    git tag <name>\n');
    return 0;
  }

  const git = (args_, label) => {
    try {
      return execFileSync('git', args_, { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' });
    } catch (err) {
      // git's own message, not "Command failed". At this point the checks have all
      // passed, so whatever git is objecting to is the only thing left to fix.
      throw new Error(`${label}:\n        ${String(err.stderr || err.stdout || err.message).trim()}`);
    }
  };

  git(['add', ...FROZEN, 'public/app.js', 'public/app.css', 'public/app.js.sha256'], 'git add');

  // Nothing staged is a legitimate state: the operator may have committed the four by
  // hand already. The tag is what players are told, so it still has to be created — but
  // over the commit that is actually there, and said out loud rather than assumed.
  const staged = git(['diff', '--cached', '--name-only'], 'git diff --cached').trim();
  if (staged) {
    git(['commit', '-m',
      `freeze: round ${cfg.protocol.target_round}, cutoff ${cfg.protocol.submission_cutoff_utc}`],
    'git commit');
  } else {
    process.stdout.write(`\n${warn('nothing to commit — the four artefacts are already committed; tagging HEAD')}\n`);
  }

  git(['tag', args.tag], 'git tag');
  const head = git(['rev-parse', '--short', 'HEAD'], 'git rev-parse').trim();
  process.stdout.write(`\n${ok(`${staged ? 'committed' : 'tagged existing commit'} ${head} as ${args.tag}`)}\n`);

  // ---- step 12: what to tell the players ----------------------------------
  process.stdout.write(`
\x1b[1m  Announcement (RUNBOOK step 12) — three things, no personal links:\x1b[0m

    抽签开始了。用你自己的 Pantheon 账号登录，选一个 0 到 ${cfg.userInputMax} 之间的
    整数提交，一次就好，提交后可以直接关掉页面。

    截止时间：${cfg.protocol.submission_cutoff_utc}（drand 第 ${cfg.protocol.target_round} 轮）
    ${cfg.protocol.total_slots} 人中至少 ${cfg.protocol.quorum} 人提交，抽签才会进行。

    冻结的四个文件已经打上 tag ${args.tag}，抽签结束后任何人都能用它自己复算一遍。

`);
  return 0;
}

if (require.main === module) {
  main(process.argv.slice(2))
    .then((c) => process.exit(c || 0))
    .catch((err) => {
      process.stderr.write(`  ERROR ${err.message}\n`);
      process.exit(1);
    });
}

module.exports = { snapshotRoster, applyRosterSnapshot, preflight, FROZEN };
