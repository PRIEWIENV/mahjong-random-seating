#!/usr/bin/env node
'use strict';

/**
 * T1 of the final round: lock the standings and the beacon (PROTOCOL.md §11).
 *
 * The twelfth round's tables are earned — ranks 1-4 at table one, 5-8 at table two, 9-12
 * at table three — and only the winds are drawn. That makes two inputs, and both of them
 * have to be fixed before the randomness that uses them exists:
 *
 *   the standings   because who is at which table follows from them, and because a
 *                   standings table fetched twice can differ
 *   the round F     because a beacon chosen after seeing the standings is a beacon
 *                   chosen with the answer in hand
 *
 * They go in ONE file. Not for tidiness: one file is one digest, one timestamp, and one
 * short string for twelve people to read out to each other. Two files would be two
 * digests and an argument about which one was published first.
 *
 * WHAT THIS TOOL WILL NOT DO. It will not break a tie. A tie across a band boundary — the
 * 4|5 or 8|9 positions — decides which table somebody sits at, so it is refused outright
 * until a human names the league rule that settles it and that rule has been applied at
 * the source. Acknowledging it here records the reason in the published lock; it never
 * reorders anybody. A tool that silently sorted on a second key would be choosing tables
 * by a rule nobody had agreed to.
 *
 * ORDER OF OPERATIONS, and why. Write, mirror, drain, then stamp. The OpenTimestamps
 * anchor is best-effort but its failure is LOUD, because it cannot be repaired later: a
 * stamp made after F has been emitted proves nothing about before it, which is the only
 * thing it was ever there to prove.
 *
 *   node tools/lock-final.js                               dry run: fetch, check, print
 *   node tools/lock-final.js --in 45m --confirm            write it
 *   node tools/lock-final.js --at 2026-09-20T12:00:00Z --confirm
 *   node tools/lock-final.js --round 32200000 --confirm
 *   node tools/lock-final.js --relock --reason "..." --in 45m --confirm
 *   node tools/lock-final.js --tiebreak 4 --tiebreak-reason "league rule 6b: chips" --confirm
 *   node tools/lock-final.js --standings some.json         offline: skip Mimir
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { load } = require('../server/config');
const { Drand } = require('../server/drand');
const { Mirror, writeLocal } = require('../server/mirror');
const { createPantheon } = require('../server/pantheon');
const { stamp } = require('../server/ots');
const { generate, serialise } = require('../generate');

const LOCK_REL = 'events/final/lock.json';
const OTS_REL = `${LOCK_REL}.ots`;
const FINAL_REL = 'final.json';
/** Below this there is no room to mirror the lock, let alone anchor it. */
const MIN_LEAD_SECONDS = 60;

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
const isoSec = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

function parseArgs(argv) {
  const out = { tiebreak: [] };
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const k = argv[i].slice(2);
    const v = argv[i + 1];
    const value = v === undefined || v.startsWith('--') ? true : (i++, v);
    if (k === 'tiebreak') {
      out.tiebreak.push(...String(value).split(',').map((s) => Number(s.trim())));
    } else {
      out[k] = value;
    }
  }
  return out;
}

/** "45m", "2h" -> milliseconds. Same forms tools/pick-round.js takes. */
function parseDuration(s) {
  const m = /^(\d+(?:\.\d+)?)\s*(s|m|h|d)$/.exec(String(s).trim());
  if (!m) throw new Error(`cannot parse duration "${s}" — use forms like 45m, 2h, 1d`);
  return Number(m[1]) * { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2]];
}

// ---------------------------------------------------------------------------
// the standings, and everything that can be wrong with them
// ---------------------------------------------------------------------------

/**
 * Which sort keys this tool can recompute.
 *
 * The point of the list is not to police Mimir's enum — that enum is not documented
 * anywhere this project can see, and a guessed allowlist would reject valid keys while
 * still not catching invalid ones. It is that an order this tool cannot RECOMPUTE is an
 * order it cannot confirm, and confirming it is the whole reason an unverified order_by
 * is safe to depend on.
 */
const SORTABLE = {
  rating: (r) => r.rating,
  chips: (r) => r.chips,
  avg_place: (r) => r.avg_place,
  avg_score: (r) => r.avg_score,
  games_played: (r) => r.games_played,
};

/** The table a rank sits at: 1-4 → 1, 5-8 → 2, 9-12 → 3. */
const bandOf = (rank, blockSize) => Math.floor((rank - 1) / blockSize) + 1;

/**
 * Everything that has to be true before a standings table may be locked.
 *
 * Pure, and returns problems rather than throwing them one at a time, because an operator
 * three weeks into a tournament should see every reason at once rather than fix one and
 * rerun into the next.
 *
 * @param {Array}  rows        as returned by pantheon.getRatingTable — order is the ranking
 * @param {object} o
 * @param {object} o.roster     the frozen roster
 * @param {number} o.expectedGames  rounds in the template, i.e. 11
 * @param {number} o.blockSize  players per table, i.e. 4
 * @param {string} o.orderBy    the key Mimir was asked to sort on
 * @param {string} o.order      'asc' | 'desc'
 * @param {number[]} [o.tiebreak]       band boundaries a human has accepted, by rank
 * @param {string}  [o.tiebreakReason]  the rule they applied
 * @returns {{problems: string[], standings: number[], detail: Array, ties: Array}}
 */
function checkStandings(rows, { roster, expectedGames, blockSize, orderBy, order, tiebreak = [], tiebreakReason = null }) {
  const problems = [];
  const byPersonId = new Map(roster.players.map((p) => [p.person_id, p]));
  const total = roster.players.length;

  // 1. the twelve must be the frozen twelve ------------------------------------
  if (rows.length !== total) {
    problems.push(
      `Pantheon returned ${rows.length} players, the frozen roster has ${total}. The final round ` +
      'seats the roster, so a standings table that is not about exactly those people cannot seat it.');
  }
  const seen = new Set();
  for (const r of rows) {
    if (!byPersonId.has(r.person_id)) {
      problems.push(`person_id ${r.person_id} (${r.title ?? 'no title'}) is in the standings but not in the frozen roster`);
    }
    if (seen.has(r.person_id)) problems.push(`person_id ${r.person_id} appears twice in the standings`);
    seen.add(r.person_id);
  }
  for (const p of roster.players) {
    if (!seen.has(p.person_id)) {
      problems.push(`local_id ${p.local_id} (${p.title}) is in the frozen roster but not in the standings`);
    }
  }

  // 2. the round-robin must be finished ----------------------------------------
  for (const r of rows) {
    if (r.games_played !== expectedGames) {
      problems.push(
        `${r.title ?? r.person_id} has played ${r.games_played} of ${expectedGames} games. The final ` +
        'round is seated from the finished round-robin; seating it early would rank people on ' +
        'different numbers of games.');
    }
  }

  // 3. the order must be one we can recompute, and must recompute ---------------
  const keyOf = SORTABLE[orderBy];
  if (!keyOf) {
    problems.push(
      `cannot confirm an order sorted by "${orderBy}": the standings rows carry only ` +
      `${Object.keys(SORTABLE).join(', ')}. An order this tool cannot recompute is an order it ` +
      'cannot confirm, and confirming it is what makes an order_by nobody has verified safe to ' +
      'rely on. Set runtime.json → pantheon.rating_order_by to one of those, or pass --order-by.');
  } else {
    const dir = order === 'asc' ? 1 : -1;
    // A STABLE sort on the same key: where the key ties, the server's own order is kept,
    // so this compares what the key explains and stays silent about what it does not.
    // Ties are the next check's business, not this one's.
    const local = rows.map((r, i) => ({ r, i }))
      .sort((a, b) => (keyOf(a.r) === keyOf(b.r) ? a.i - b.i : (keyOf(a.r) < keyOf(b.r) ? -dir : dir)))
      .map((x) => x.r.person_id);
    const given = rows.map((r) => r.person_id);
    if (local.join(',') !== given.join(',')) {
      problems.push(
        `Mimir's order is not the order "${orderBy}" ${order} produces, so order_by was not applied ` +
        'and the ranking is something else.\n' +
        `        Mimir:      ${given.join(', ')}\n` +
        `        ${orderBy} ${order}:  ${local.join(', ')}`);
    }
  }

  // 4. ties ---------------------------------------------------------------------
  // Within a band a tie changes nothing about who sits where: the same four people are at
  // the same table either way, and the only thing that moves is a byte of the seed — which
  // is locked before the beacon and so cannot be polished against a result. Across a band
  // boundary it decides a table, and no ordering this tool could invent would be one the
  // field had agreed to.
  const ties = [];
  const accepted = new Set(tiebreak);
  if (keyOf) {
    for (let i = 1; i < rows.length; i++) {
      if (keyOf(rows[i - 1]) !== keyOf(rows[i])) continue;
      const crossesBand = bandOf(i, blockSize) !== bandOf(i + 1, blockSize);
      const tie = {
        ranks: [i, i + 1],
        crosses_band: crossesBand,
        order_by: orderBy,
        value: keyOf(rows[i]),
        players: [rows[i - 1], rows[i]].map((r) => ({
          person_id: r.person_id, title: r.title,
          rating: r.rating, chips: r.chips, avg_place: r.avg_place, avg_score: r.avg_score,
        })),
      };
      if (crossesBand) {
        // Either side of the boundary names it, so "the tie at 4" and "the tie at 5" are
        // the same acknowledgement and an operator cannot get it wrong by a rank.
        const named = accepted.has(i) || accepted.has(i + 1);
        if (!named || !tiebreakReason) {
          problems.push(
            `ranks ${i} and ${i + 1} are tied on ${orderBy} (${keyOf(rows[i])}), and that boundary ` +
            `decides whether they sit at table ${bandOf(i, blockSize)} or ${bandOf(i + 1, blockSize)}.\n` +
            `        ${rows[i - 1].title}  chips ${rows[i - 1].chips}  avg_place ${rows[i - 1].avg_place}  avg_score ${rows[i - 1].avg_score}\n` +
            `        ${rows[i].title}  chips ${rows[i].chips}  avg_place ${rows[i].avg_place}  avg_score ${rows[i].avg_score}\n` +
            '        This tool never breaks a tie and never breaks one silently. Settle it by the\n' +
            '        league\'s own rule, make the standings in Pantheon reflect it, and then record\n' +
            '        the rule here so it is published with the lock:\n' +
            `          node tools/lock-final.js --tiebreak ${i} --tiebreak-reason "league rule 6b: more chips" --confirm\n` +
            '        If the order above is NOT what your rule gives, fix it at the source — this\n' +
            '        tool will not reorder anybody.');
        } else {
          tie.accepted_reason = tiebreakReason;
        }
      }
      ties.push(tie);
    }
  }
  for (const rank of tiebreak) {
    if (!Number.isInteger(rank) || rank < 1 || rank > rows.length) {
      problems.push(`--tiebreak ${rank} is not a rank in a table of ${rows.length}`);
    } else if (!ties.some((t) => t.crosses_band && (t.ranks[0] === rank || t.ranks[1] === rank))) {
      // Loud rather than ignored: an acknowledgement of a tie that is not there means the
      // operator is looking at a different standings table from the one being locked.
      problems.push(
        `--tiebreak ${rank} names a tie that is not in these standings. Nothing is tied across a ` +
        'band boundary at that rank, so either the table has changed since you looked or the rank ' +
        'is wrong. Re-run the dry run and read what it prints.');
    }
  }
  if (tiebreakReason && !tiebreak.length) {
    problems.push('--tiebreak-reason was given without --tiebreak, so it is a reason for nothing');
  }

  const detail = rows.map((r, i) => ({
    rank: i + 1,
    local_id: byPersonId.get(r.person_id)?.local_id ?? null,
    person_id: r.person_id,
    title: r.title,
    table: bandOf(i + 1, blockSize),
    rating: r.rating,
    chips: r.chips,
    avg_place: r.avg_place,
    avg_score: r.avg_score,
    games_played: r.games_played,
  }));
  const standings = detail.map((d) => d.local_id);
  return { problems, standings, detail, ties };
}

// ---------------------------------------------------------------------------
// the rest of the checks, and the lock itself
// ---------------------------------------------------------------------------

/**
 * results.json has to be there, and has to be the draw it claims to be.
 *
 * Re-derived in process rather than shelling out to `node generate.js --verify`, so the
 * refusal is one exit code rather than two. Same computation, same file, same bytes.
 */
function verifyResults(cfg, resultsBytes) {
  const parsed = JSON.parse(resultsBytes.toString('utf8'));
  const decrypted = Object.entries(parsed.revealed).map(([local_id, v]) => ({
    local_id: Number(local_id),
    user_input: v.user_input,
    client_nonce: v.client_nonce,
    client_timestamp: v.client_timestamp,
  }));
  const recomputed = serialise(generate({
    decrypted,
    excluded: parsed.excluded_local_ids,
    roster: cfg.roster,
    protocol: cfg.protocol,
    template: cfg.template,
    signature: parsed.drand_signature,
    round: parsed.round_used,
  }));
  return { ok: recomputed === serialise(parsed), results: parsed };
}

function buildLock(o) {
  return {
    _comment:
      'The final round is seated from THESE standings and opened by THIS drand round ' +
      '(PROTOCOL.md §11). Both were fixed before the beacon existed, and this file was ' +
      'published and timestamped at that moment. Nothing about the twelfth round can ' +
      'change without changing these bytes.',
    event: 'final',
    pantheon_event_id: o.pantheonEventId,
    locked_at: o.lockedAt,

    target_round: o.targetRound,
    target_round_utc: o.targetRoundUtc,
    drand_chain: o.protocol.drand_chain,
    chain_hash: o.protocol.chain_hash,
    chain_public_key: o.protocol.chain_public_key,

    // What this lock is a lock ON. generate-final.js refuses if results.json has changed.
    results_sha256: o.resultsSha256,
    results_round_used: o.results.round_used,
    R: o.results.R,

    standings: o.standings,
    standings_detail: o.detail,
    standings_source: o.source,
    order_by: o.orderBy,
    order: o.order,
    ties: o.ties,
    tiebreak_reason: o.tiebreakReason,

    relock_of: o.relockOf,
    relock_reason: o.relockReason,

    seed_domain_separation: o.protocol.seed_domain_separation,
    schedule_template_ref: o.protocol.schedule_template_ref,
    generate_script_ref: o.protocol.generate_script_ref,
    // Which tagged code will open this lock. The tag was made before the tournament
    // started, so this is a statement that the rules were fixed before the standings were.
    generate_final_script_ref: o.protocol.generate_final_script_ref,

    how_to_verify:
      `Round ${o.targetRound} of drand ${o.protocol.drand_chain} is emitted at ` +
      `${o.targetRoundUtc}, and nobody can know its signature before then. When it lands:\n` +
      '  node generate-final.js --signature <sig>            # draws the winds\n' +
      '  node generate-final.js --verify final.json          # reproduces it byte for byte\n' +
      '  py tools/verify_final.py                            # a second implementation\n' +
      'The tables above are already decided by the standings; only the winds are drawn. ' +
      'Compare the sha256 of THIS file with the one the organiser announced, and with each ' +
      "other's, before that round is emitted — afterwards it proves nothing.",
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

/** The next free events/final/lock.<n>.json, so a superseded lock is never overwritten. */
function nextRelockIndex(dir) {
  if (!fs.existsSync(dir)) return 2;
  const used = fs.readdirSync(dir)
    .map((n) => /^lock\.(\d+)\.json$/.exec(n))
    .filter(Boolean)
    .map((m) => Number(m[1]));
  return used.length ? Math.max(...used) + 1 : 2;
}

async function main(argv, deps = {}) {
  const args = parseArgs(argv);
  const cfg = deps.cfg || load({});
  const env = deps.env || process.env;
  const log = deps.log || console;
  const now = deps.now ?? Date.now();
  const confirm = args.confirm === true;
  const { raw, ok, bad, warn, note } = writers(deps);

  const lockPath = path.join(cfg.root, LOCK_REL);
  const finalPath = path.join(cfg.root, FINAL_REL);
  const resultsPath = path.join(cfg.root, 'results.json');

  // ---- the round-robin has to be over, and its result has to be real ----------
  if (!fs.existsSync(resultsPath)) {
    bad('there is no results.json, so the first draw has not happened and there is nothing to rank.');
    return 1;
  }
  const resultsBytes = fs.readFileSync(resultsPath);
  const resultsSha256 = sha256(resultsBytes);
  const v = verifyResults(cfg, resultsBytes);
  if (!v.ok) {
    bad('results.json does not reproduce from its own payloads. Run "node generate.js --verify ' +
      'results.json" and do not lock anything until that passes — the final round is bound to ' +
      'these bytes.');
    return 1;
  }
  const results = v.results;

  // ---- an existing lock is a published promise --------------------------------
  let relockOf = null;
  if (fs.existsSync(lockPath)) {
    const existing = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    const existingSha = sha256(fs.readFileSync(lockPath));
    if (!args.relock) {
      bad(`${LOCK_REL} already exists — the standings and round ${existing.target_round} have ` +
        'already been published and timestamped.\n' +
        `        sha256 ${existingSha}\n` +
        '        If the beacon has landed, draw: node tools/draw-final.js\n' +
        '        If this really has to be replaced, say why, and say it before that beacon:\n' +
        '          node tools/lock-final.js --relock --reason "…" --in 45m --confirm');
      return 1;
    }
    if (fs.existsSync(finalPath)) {
      bad('the final round has already been drawn (final.json exists). A drawn round is not ' +
        're-locked; that would be redrawing it after seeing the answer.');
      return 1;
    }
    if (typeof args.reason !== 'string' || args.reason.trim() === '') {
      bad('--relock needs --reason "…". Replacing a published commitment is a decision, and the ' +
        'reason is published with the new lock.');
      return 1;
    }
    relockOf = {
      sha256: existingSha,
      target_round: existing.target_round,
      locked_at: existing.locked_at,
      // Decided here rather than when the file is actually moved, because it goes INTO
      // the new lock: the digest the dry run prints has to be the digest the written
      // file has, or the number twelve people were told to compare is the wrong one.
      archived_as: `events/final/lock.${nextRelockIndex(path.dirname(lockPath))}.json`,
    };
  }

  // ---- the standings ----------------------------------------------------------
  const orderBy = String(args['order-by'] || cfg.runtime.pantheon.rating_order_by);
  const order = String(args.order || cfg.runtime.pantheon.rating_order);
  let rows;
  let source;
  if (typeof args.standings === 'string') {
    // Offline. tools/rehearse.js and the tests use it; so does an organiser whose Mimir
    // is unreachable on the day, and the file they hand over is published in the lock.
    rows = JSON.parse(fs.readFileSync(args.standings, 'utf8'));
    if (!Array.isArray(rows)) { bad(`${args.standings} is not an array of standings rows`); return 1; }
    source = { from: 'file', path: args.standings, sha256: sha256(fs.readFileSync(args.standings)) };
  } else {
    const pantheon = deps.pantheon || createPantheon(cfg, env);
    try {
      rows = await pantheon.getRatingTable(cfg.roster.pantheon_event_id, orderBy, order,
        { admin: args['as-admin'] === true });
    } catch (err) {
      bad(`could not read the standings from Mimir: ${err.message}`);
      note('If Mimir is unreachable and the standings are settled, export them and pass');
      note('--standings <file>; the file is published inside the lock.');
      return 1;
    }
    source = { from: 'mimir', event_id: cfg.roster.pantheon_event_id, fetched_at: new Date(now).toISOString() };
  }

  const blockSize = cfg.template.n_players / cfg.template.n_tables;
  const check = checkStandings(rows, {
    roster: cfg.roster,
    expectedGames: cfg.template.rounds.length,
    blockSize,
    orderBy,
    order,
    tiebreak: args.tiebreak,
    tiebreakReason: typeof args['tiebreak-reason'] === 'string' ? args['tiebreak-reason'] : null,
  });

  raw(`\n  standings from ${source.from}, ordered by ${orderBy} ${order}\n\n`);
  for (const d of check.detail) {
    raw(
      `   ${String(d.rank).padStart(2)}.  table ${d.table}  ` +
      `${String(d.local_id ?? '??').padStart(2)}  ${String(d.title ?? '').padEnd(22)}` +
      `${orderBy} ${String(d[orderBy] ?? '?').padStart(8)}   ${d.games_played} games\n`);
    if (d.rank % blockSize === 0 && d.rank < check.detail.length) raw('        —\n');
  }
  raw('\n');
  for (const t of check.ties.filter((x) => !x.crosses_band)) {
    warn(`ranks ${t.ranks.join(' and ')} are tied on ${orderBy} (${t.value}), inside one table. ` +
      'That changes nobody\'s table — only a byte of the seed, which is fixed here, before the beacon.');
  }

  // ---- the beacon -------------------------------------------------------------
  const drand = deps.drand || new Drand(cfg.protocol.chain_hash, cfg.runtime.drand.mirrors);
  let targetRound;
  let targetRoundMs;
  try {
    const info = await drand.info();
    const { genesis_time: genesis, period } = info;
    if (args.round) {
      targetRound = Number(args.round);
      if (!Number.isInteger(targetRound) || targetRound < 1) throw new Error('--round must be a positive integer');
    } else {
      const wantMs = args.at ? Date.parse(String(args.at)) : now + parseDuration(args.in || '45m');
      if (Number.isNaN(wantMs)) throw new Error(`cannot parse --at "${args.at}"`);
      targetRound = Math.floor((Math.ceil(wantMs / 1000) - genesis) / period) + 2;
    }
    targetRoundMs = (genesis + (targetRound - 1) * period) * 1000;
  } catch (err) {
    bad(`could not reach drand to choose a round: ${err.message}`);
    return 1;
  }
  const leadSec = (targetRoundMs - now) / 1000;

  if (leadSec < MIN_LEAD_SECONDS) {
    check.problems.push(
      `round ${targetRound} is ${leadSec < 0 ? 'already past' : `only ${Math.round(leadSec)}s away`}. ` +
      'The lock has to be written, mirrored, timestamped and read out before its beacon exists; ' +
      `under ${MIN_LEAD_SECONDS}s there is no room for any of that, and a timestamp made after the ` +
      'beacon proves nothing at all. Try --in 45m.');
  }
  if (targetRound <= results.round_used) {
    check.problems.push(
      `round ${targetRound} is not after the first draw's round ${results.round_used}. The final ` +
      'round needs randomness that did not exist when the seat plan was published.');
  }

  if (check.problems.length) {
    raw('\n');
    for (const p of check.problems) bad(p);
    raw('\n');
    note('Nothing was written.');
    return 1;
  }

  const lock = buildLock({
    protocol: cfg.protocol,
    pantheonEventId: cfg.roster.pantheon_event_id,
    lockedAt: new Date(now).toISOString(),
    targetRound,
    targetRoundUtc: isoSec(targetRoundMs),
    resultsSha256,
    results,
    standings: check.standings,
    detail: check.detail,
    source,
    orderBy,
    order,
    ties: check.ties,
    tiebreakReason: typeof args['tiebreak-reason'] === 'string' ? args['tiebreak-reason'] : null,
    relockOf,
    relockReason: relockOf ? String(args.reason).trim() : null,
  });
  const body = JSON.stringify(lock, null, 2) + '\n';
  const digest = sha256(Buffer.from(body, 'utf8'));

  ok(`every check passed: ${check.standings.length} players, ${cfg.template.rounds.length} games each, ` +
    `order confirmed against ${orderBy} ${order}`);
  note(`final beacon    round ${targetRound} at ${isoSec(targetRoundMs)}  (${Math.round(leadSec / 60)} min from now)`);
  note(`lock sha256     ${digest}`);
  note(`tables          1: ${check.standings.slice(0, blockSize).join(', ')}`);
  for (let t = 1; t < cfg.template.n_tables; t++) {
    note(`                ${t + 1}: ${check.standings.slice(t * blockSize, (t + 1) * blockSize).join(', ')}`);
  }

  if (!confirm) {
    raw('\n');
    note('This was a dry run: nothing was written, mirrored or timestamped.');
    note('  node tools/lock-final.js --in 45m --confirm');
    return 0;
  }

  // ---- write, mirror, then anchor ---------------------------------------------
  const mirror = deps.mirror || new Mirror(env, log);

  if (relockOf) {
    // Moved aside, never overwritten. The superseded lock was published too, and
    // server/rounds.js archives every events/final/lock.<n>.json it finds.
    const base = relockOf.archived_as.replace('events/final/', '').replace(/\.json$/, '');
    for (const [from, to] of [[lockPath, `${base}.json`], [`${lockPath}.ots`, `${base}.json.ots`]]) {
      if (!fs.existsSync(from)) continue;
      const bytes = fs.readFileSync(from);
      writeLocal(cfg.root, `events/final/${to}`, bytes);
      mirror.enqueue?.(`events/final/${to}`, bytes, `superseded final lock: ${args.reason}`);
      fs.rmSync(from);
    }
    ok(`the superseded lock is kept at ${relockOf.archived_as}`);
  }

  writeLocal(cfg.root, LOCK_REL, body);
  mirror.enqueue?.(LOCK_REL, body, `final round locked: standings + drand round ${targetRound}`);
  ok(`wrote ${LOCK_REL}`);
  note(`sha256 ${digest}`);

  const drained = await mirror.drain?.(120_000);
  if (mirror.enabled === false) {
    warn('MIRROR_REPO and MIRROR_TOKEN are unset, so this lock exists only on this machine and ' +
      'events/ is gitignored. Publish it NOW, before the beacon: a commitment nobody else holds ' +
      'a copy of is not a commitment.');
  } else if (!drained) {
    warn('the mirror did not finish pushing. Check it and push by hand before the beacon.');
  } else {
    ok('mirrored');
  }

  // Last, because it is the slowest, and after the mirror because the copy other people
  // can read matters more than the anchor. Loud on failure: there is no second chance at
  // it — a stamp made after round F proves nothing about before round F.
  const stampFn = deps.stampFn || stamp;
  try {
    const out = await stampFn(Buffer.from(body, 'utf8'));
    writeLocal(cfg.root, OTS_REL, out.ots);
    mirror.enqueue?.(OTS_REL, out.ots, 'opentimestamps proof for the final-round lock');
    await mirror.drain?.(120_000);
    ok(`anchored with ${out.calendars.length} calendar(s): ${out.calendars.join(', ')}`);
  } catch (err) {
    warn(`NOT anchored: ${err.message}`);
    note('The digest above is still published and people can still compare it. What is lost is');
    note('the proof that survives everyone forgetting. It cannot be added later: an anchor made');
    note(`after round ${targetRound} says nothing about before it.`);
  }

  raw('\n');
  note('Announce this now, to all twelve, before the beacon:');
  note('');
  note(`  The final round is seated from the standings locked at ${lock.locked_at}.`);
  note(`  drand ${cfg.protocol.drand_chain} round ${targetRound}, emitted ${isoSec(targetRoundMs)}, draws the winds.`);
  note(`  ${LOCK_REL} sha256 ${digest}`);
  note('');
  note('Then, once that round has landed:');
  note('  node tools/draw-final.js --dry-run');
  note('  node tools/draw-final.js');
  return 0;
}

if (require.main === module) {
  main(process.argv.slice(2))
    .then((code) => { process.exitCode = code || 0; })
    .catch((err) => { bad(err.message); process.exitCode = 2; });
}

module.exports = { main, checkStandings, buildLock, bandOf, parseDuration, SORTABLE, LOCK_REL, OTS_REL };
