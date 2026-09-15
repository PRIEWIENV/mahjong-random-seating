'use strict';

/**
 * What the page says about the twelfth round (PROTOCOL.md §11, UI-SPEC.md §7).
 *
 * Two kinds of check, for two kinds of failure.
 *
 * The pure joining logic in client/rounds.js is exercised directly: it decides whether a
 * player sees twelve rounds or eleven, and "the final round is simply missing from the
 * page" is a failure that throws nothing anywhere.
 *
 * Everything else is a source invariant, the way test/result-verify.test.js is, because
 * the components are right in every case they are given and the bug is in which case
 * they are given. Three sentences in PlayerDetail were TRUE of eleven rounds and FALSE of
 * twelve — "everybody's winds fall in this same split" stops holding the moment some
 * players finish 3-3-3-3 and others 4-3-3-2. A page that goes on stating a proved
 * property about a round nobody proved anything about is worse than one that says less,
 * and nothing about it looks broken.
 *
 * The bundle is checked as well as the source, because the bundle is what is served.
 *
 * Importing client/rounds.js prints one MODULE_TYPELESS_PACKAGE_JSON warning: the package
 * has no "type", so Node parses a .js file as CommonJS, finds ESM syntax and reparses.
 * Left alone on purpose. Adding {"type": "module"} under client/ silences it and also
 * flips esbuild's CommonJS interop for every file in there — the Buffer shim that makes
 * tlock-js work in a browser included — and nothing in this suite runs the bundle in a
 * browser, so that change could not be verified here. A warning is a better trade than
 * an unverifiable change to the file twelve people are served.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { ROOT } = require('./helpers');

const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
// esbuild escapes non-ASCII to \uXXXX, so the Chinese has to be decoded before it can be
// searched for. A test that only looked for English would pass on a bundle with none.
const bundle = read('public', 'app.js')
  .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));

// ---------------------------------------------------------------------------
// the joining logic
// ---------------------------------------------------------------------------

const seat = (id, extra) => ({ local_id: id, title: `P${id}`, ...extra });
const templateRound = (n) => ({
  round: n,
  tables: [
    { table: 1, seats: { E: seat(1, { point: 0 }), S: seat(2, { point: 1 }), W: seat(3, { point: 2 }), N: seat(4, { point: 3 }) } },
    { table: 2, seats: { E: seat(5, { point: 4 }), S: seat(6, { point: 5 }), W: seat(7, { point: 6 }), N: seat(8, { point: 7 }) } },
    { table: 3, seats: { E: seat(9, { point: 8 }), S: seat(10, { point: 9 }), W: seat(11, { point: 10 }), N: seat(12, { point: 11 }) } },
  ],
});
const finalRound = {
  round: 12,
  tables: [
    { table: 1, seats: { E: seat(1, { rank: 1 }), S: seat(2, { rank: 2 }), W: seat(3, { rank: 3 }), N: seat(4, { rank: 4 }) } },
    { table: 2, seats: { E: seat(5, { rank: 5 }), S: seat(6, { rank: 6 }), W: seat(7, { rank: 7 }), N: seat(8, { rank: 8 }) } },
    { table: 3, seats: { E: seat(9, { rank: 9 }), S: seat(10, { rank: 10 }), W: seat(11, { rank: 11 }), N: seat(12, { rank: 12 }) } },
  ],
};
const eleven = { seating: { rounds: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map(templateRound) } };
const twelve = { ...eleven, final: { seating: { rounds: [finalRound] } } };

test('a player sees eleven rounds until the twelfth is drawn, and twelve after', async () => {
  const { allRounds, hasFinal, isFinal } = await import('../client/rounds.js');

  assert.equal(allRounds(eleven).length, 11);
  assert.equal(hasFinal(eleven), false);
  assert.equal(allRounds(twelve).length, 12);
  assert.equal(hasFinal(twelve), true);
  assert.deepEqual(allRounds(twelve).map((r) => r.round), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);

  // The two kinds of round are told apart by asking, not by the number: a template
  // round's seats carry `point` and the final round's carry `rank`.
  assert.equal(isFinal(twelve, 11), false);
  assert.equal(isFinal(twelve, 12), true);
  assert.equal(isFinal(eleven, 12), false, 'an eleven-round result has no final round at all');

  // And an absent result is not a crash. The page renders before the fetch lands.
  assert.deepEqual(allRounds(undefined), []);
  assert.equal(hasFinal(null), false);
});

test('the 1/m figure counts only the people who needed the same wind', async () => {
  // The number that makes the fairness statement honest: exactly one player at a table
  // can be given any particular wind, so m of them needing the same one means each had a
  // 1/m chance and the rest finish 4-3-3-2.
  const { sameDeficitCount } = await import('../client/rounds.js');
  const deficits = { 1: 'E', 2: 'E', 3: 'S', 4: 'W', 5: 'N', 6: 'N', 7: 'N', 8: 'E', 9: 'E', 10: 'S', 11: 'W', 12: 'N' };
  const stats = {
    players: Object.fromEntries(Object.entries(deficits).map(([id, w]) => [id, { deficient_wind: w }])),
  };
  const rounds = allRoundsOf(twelve);

  assert.equal(sameDeficitCount(stats, rounds, 1), 2, 'players 1 and 2 both needed East');
  assert.equal(sameDeficitCount(stats, rounds, 3), 1, 'player 3 was the only one who needed South');
  assert.equal(sameDeficitCount(stats, rounds, 5), 3, 'players 5, 6 and 7 all needed North');
  assert.equal(sameDeficitCount(stats, rounds, 8), 1, 'the count is per TABLE, not across the field');

  // No final round, nothing to count — rather than a confident 1.
  assert.equal(sameDeficitCount(stats, eleven.seating.rounds, 1), 0);
});

function allRoundsOf(result) {
  return [...result.seating.rounds, ...(result.final?.seating?.rounds || [])];
}

// ---------------------------------------------------------------------------
// the three sentences that stopped being true
// ---------------------------------------------------------------------------

test('every claim that is only true of eleven rounds is conditioned on there being eleven', () => {
  const src = read('client', 'explorer', 'PlayerDetail.jsx');

  // The condition itself, read from the statistics rather than from a round count: the
  // server is the one that knows which rounds it counted into which figure.
  assert.match(src, /const played12 = \(stats\.final_rounds \|\| \[\]\)\.length > 0;/);

  // Each of the three has a twelve-round variant, and each is actually chosen by the
  // condition rather than merely defined next to it.
  for (const key of ['windsNote', 'tablesImbalanced', 'tablesIdeal', 'perfectAll', 'perfectSome']) {
    assert.ok(src.includes(`t.${key}`), `${key} is no longer used`);
  }
  for (const key of ['windsComplete', 'windsShort', 'tablesImbalancedEleven', 'tablesIdealEleven',
    'perfectAllEleven', 'perfectSomeEleven']) {
    assert.ok(src.includes(`t.${key}`), `${key} is defined but never rendered`);
  }
  assert.match(src, /\{!played12\s*\n\s*\? t\.windsNote/, 'the winds note must branch on played12');
  assert.match(src, /\{played12\s*\n\s*\? \(p\.table_imbalanced/, 'the tables note must branch on played12');
  assert.match(src, /\(played12 \? t\.perfectAllEleven : t\.perfectAll\)/);

  // The table and pair figures, once there are twelve rounds, must be the ELEVEN-round
  // ones: 4-4-3 and "11 of the 66 pairs" are properties of the template that
  // tools/verify_template.py proves, and players are invited to run it.
  assert.match(src, /t\.tablesImbalancedEleven\(p\.table_split_template\.join\('-'\)\)/);
  assert.match(src, /t\.tablesIdealEleven\(p\.table_split_template\.join\('-'\)\)/);
});

test('a player left on 4-3-3-2 is told the odds, in both languages', () => {
  // Not "you were unlucky". The rule maximises how many people finish on three of every
  // wind, and the price is that people short of the SAME wind share one seat. Saying 1/m
  // is what makes the fairness claim checkable instead of comforting.
  const src = read('client', 'explorer', 'PlayerDetail.jsx');
  assert.match(src, /windsShort: \(wind, m\) => `十二轮之后仍是 4-3-3-2/);
  assert.match(src, /windsShort: \(wind, m\) => `Still 4-3-3-2 after twelve rounds/);
  assert.match(src, /\$\{m\} 分之一/, 'the Chinese must state the 1/m odds');
  assert.match(src, /1 in \$\{m\}/, 'the English must state the 1/m odds');

  for (const phrase of ['分之一', '1 in ', 'share one seat', '同缺一门风的人要分这一个位置']) {
    assert.ok(bundle.includes(phrase), `the served bundle is missing "${phrase}"`);
  }
});

test('the zero-sum reason for aiming at 3-3-3-3 is on the page, not only in the docs', () => {
  // The whole justification for the final round's design in one sentence, where the
  // person it applies to can read it.
  const src = read('client', 'explorer', 'PlayerDetail.jsx');
  assert.match(src, /零和/, 'the Chinese should say mahjong is zero-sum');
  assert.match(src, /zero-sum/, 'the English should say mahjong is zero-sum');
  assert.ok(bundle.includes('zero-sum'), 'and it must survive into the bundle');
});

// ---------------------------------------------------------------------------
// the result page
// ---------------------------------------------------------------------------

test('the fetch block gets final.json too, or a reader ends up with eleven rounds', () => {
  const src = read('client', 'stages', 'Result.jsx');
  assert.match(src, /git checkout origin\/HEAD -- results\.json final\.json events\//);
});

test('the frozen-file list on the result page names all five', () => {
  // It is the list a player is told was tagged before submissions opened. Leaving
  // generate-final.js out of it would understate the freeze by exactly the file that
  // draws the round they are about to play.
  const src = read('client', 'stages', 'Result.jsx');
  for (const text of ['冻结的五个文件', 'The five frozen files']) {
    assert.ok(src.includes(text), `Result.jsx no longer says "${text}"`);
  }
  assert.equal((src.match(/generate-final\.js/g) || []).length >= 3, true);
  assert.ok(bundle.includes('generate-final.js'), 'and the bundle names it');
});

test('the headline is about the round the player is walking to, not always round 1', () => {
  const src = read('client', 'stages', 'Result.jsx');
  assert.match(src, /function headlineRound\(result\) \{[\s\S]{0,200}hasFinal\(result\) \? rounds\[rounds\.length - 1\] : rounds\[0\]/);
  assert.match(src, /isFinalHeadline \? '决赛轮'/);
  assert.match(src, /isFinalHeadline \? 'Final round'/);
});

test('the final round has its own verification block, with the second implementation', () => {
  const src = read('client', 'stages', 'Result.jsx');
  assert.ok(src.includes('node generate-final.js --verify final.json'));
  assert.ok(src.includes('python3 tools/verify_final.py'));
  for (const cmd of ['node generate-final.js --verify final.json', 'python3 tools/verify_final.py']) {
    assert.ok(bundle.includes(cmd), `the bundle does not offer "${cmd}"`);
  }
});

// ---------------------------------------------------------------------------
// the refetch defect
// ---------------------------------------------------------------------------

test('the result is refetched when the final round moves, not only once ever', () => {
  // `phase` is 'done' from the first draw onwards and stays 'done' through the lock and
  // the twelfth round. With `!result` as the only guard, a page left open — or reopened
  // weeks later — held a result fetched before the final round existed and never asked
  // again: the player would be told the draw was complete while the round they were
  // about to sit down for was missing from it.
  const src = read('client', 'app.jsx');
  assert.match(src, /const finalKey = state\.status\?\.final/);
  assert.match(src, /\$\{state\.status\.final\.state\}:\$\{state\.status\.final\.lock_sha256 \|\| ''\}/,
    'a --relock changes the digest without changing the state, so both are in the key');
  assert.match(src, /if \(result && fetchedFor\.current === finalKey\) return;/);
  assert.match(src, /\}, \[stage, result, finalKey\]\);/);
  // Claimed before the request and released on failure: no double fetch, no permanent
  // silence after one that never arrived.
  assert.match(src, /fetchedFor\.current = finalKey;\s*\n\s*api\.getResult\(\)/);
  assert.match(src, /\.catch\(\(\) => \{ fetchedFor\.current = null; \}\)/);
});

// ---------------------------------------------------------------------------
// the lock card
// ---------------------------------------------------------------------------

test('the lock card asks for the comparison while it still proves something', () => {
  // Before the beacon, comparing the digest with eleven other people is evidence. After
  // it, the same digest is a number the organiser is reading out. So the ask is shown
  // only while the round is locked and not yet drawn.
  const src = read('client', 'FinalCard.jsx');
  assert.match(src, /\{!drawn && <p className="roll-ask">\{t\.ask\}<\/p>\}/);
  assert.match(src, /final\.anchored \? t\.anchored : t\.notAnchored/,
    'a missing timestamp must be stated, not omitted');
  // The tables are shown before the draw on purpose: they were decided by the standings,
  // not by the beacon. What nobody knows yet is who sits East.
  assert.match(src, /\{final\.standings && \(/);
  assert.match(src, /\{!drawn && <p className="note dim">\{t\.waiting\}<\/p>\}/);
});

test('the lock card offers the files a player would need to check it themselves', () => {
  const src = read('client', 'FinalCard.jsx');
  for (const href of ['/final-lock.json', '/final-lock.json.ots', '/final.json']) {
    assert.ok(src.includes(`href="${href}"`), `the card does not offer ${href}`);
  }
  // And the server actually serves those three names, from an explicit map rather than
  // by exposing the directory — a superseded --relock lock lives in there too.
  const server = read('server', 'server.js');
  assert.match(server, /const FINAL_FILES = new Map\(\[/);
  for (const name of ['final-lock.json', 'final-lock.json.ots', 'final.json']) {
    assert.ok(server.includes(`['${name}',`), `${name} is not served`);
  }
});
