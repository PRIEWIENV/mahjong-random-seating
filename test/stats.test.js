'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { generate, buildPrescript } = require('../generate');
const { computeStats } = require('../server/stats');
const { StubPantheon, TwirpPantheon } = require('../server/pantheon');
const { syncToPantheon } = require('../server/finalise');
const { makeRoster, makeProtocol, makeDecrypted, template, SAMPLE_SIG } = require('./helpers');

const TEMPLATE = template();
const roster = makeRoster();
const results = generate({
  decrypted: makeDecrypted(12), roster, protocol: makeProtocol(), template: TEMPLATE, signature: SAMPLE_SIG,
});
const stats = computeStats(results.seating, roster.players);
const QUIET = { info() {}, warn() {}, error() {} };

// ---------------------------------------------------------------------------
// The statistics must reproduce the template's proved invariants. If they ever
// disagree, the figures shown to players would contradict verify_template.py, which
// participants are explicitly invited to run.
// ---------------------------------------------------------------------------

test('every player gets the {3,3,3,2} wind split', () => {
  for (const id of stats.player_order) {
    assert.deepEqual(stats.players[id].wind_split, [3, 3, 3, 2], `local_id ${id}`);
  }
});

test('nine players get 4-4-3 tables and exactly three get 5-3-3', () => {
  const shapes = stats.player_order.map((id) => stats.players[id].table_split.join('-'));
  assert.equal(shapes.filter((s) => s === '4-4-3').length, 9);
  assert.equal(shapes.filter((s) => s === '5-3-3').length, 3);
  assert.equal(stats.totals.imbalanced_players.length, 3);
});

test('every pair shares a table exactly 3 times and sits opposite exactly once', () => {
  for (const id of stats.player_order) {
    const p = stats.players[id];
    assert.equal(p.opponents.length, 11);
    for (const o of p.opponents) {
      assert.equal(o.same_table, 3, `${id} vs ${o.local_id}`);
      assert.equal(o.opposite, 1, `${id} vs ${o.local_id}`);
      assert.equal(o.you_upstream + o.they_upstream, 2, `${id} vs ${o.local_id} adjacency`);
    }
  }
});

test('55 of 66 pairs are perfect — the proved optimum', () => {
  assert.equal(stats.totals.pairs, 66);
  assert.equal(stats.totals.perfect_pairs, 55);
});

test('the per-player perfect counts sum to twice the pair total', () => {
  const sum = stats.player_order.reduce((n, id) => n + stats.players[id].perfect_pairs, 0);
  assert.equal(sum, 55 * 2, 'each perfect pair is counted by both its players');
});

test('a player marked imbalanced really has a 5 in their table counts', () => {
  for (const id of stats.player_order) {
    const p = stats.players[id];
    assert.equal(p.table_imbalanced, Object.values(p.tables).includes(5), `local_id ${id}`);
  }
});

test('the opponent relation is symmetric', () => {
  for (const id of stats.player_order) {
    for (const o of stats.players[id].opponents) {
      const back = stats.players[o.local_id].opponents.find((x) => x.local_id === id);
      assert.equal(back.you_upstream, o.they_upstream, `${id}/${o.local_id} upstream disagrees`);
      assert.equal(back.perfect, o.perfect);
    }
  }
});

test('each player appears in all eleven rounds', () => {
  for (const id of stats.player_order) {
    assert.equal(Object.keys(stats.players[id].rounds).length, 11);
  }
});

// ---------------------------------------------------------------------------
// With a twelfth round (PROTOCOL.md §11). Two scopes: winds and tables count every
// round played, pair figures count the template rounds only. The pair figures are
// properties OF THE TEMPLATE, proved by verify_template.py, and players are invited to
// run it — so they must keep meaning exactly that once a final round exists.
// ---------------------------------------------------------------------------

const finalFixture = (() => {
  const crypto = require('node:crypto');
  const { serialise } = require('../generate');
  const gf = require('../generate-final');
  const protocol = { ...makeProtocol(), generate_final_script_ref: 'generate-final.js@test' };
  const res = generate({
    decrypted: makeDecrypted(12, protocol), excluded: [], roster, protocol,
    template: TEMPLATE, signature: SAMPLE_SIG, round: protocol.target_round,
  });
  const lock = {
    results_sha256: crypto.createHash('sha256').update(Buffer.from(serialise(res), 'utf8')).digest('hex'),
    target_round: protocol.target_round + 5000,
    standings: [7, 2, 11, 4, 9, 1, 12, 5, 3, 10, 8, 6],
  };
  const final = gf.generateFinal({
    results: res, lock, signature: 'ab'.repeat(48), roster, protocol, template: TEMPLATE,
  });
  return { results: res, final, stats: computeStats(res.seating, roster.players, final.seating.rounds) };
})();

test('the eleven-round output is a strict superset: nothing already there moved', () => {
  // The guarantee that makes this change safe to deploy before the final round happens.
  const before = computeStats(results.seating, roster.players);
  const again = computeStats(results.seating, roster.players, []);
  for (const id of before.player_order) {
    for (const [k, v] of Object.entries(before.players[id])) {
      assert.deepEqual(again.players[id][k], v, `players[${id}].${k}`);
    }
  }
  for (const [k, v] of Object.entries(before.totals)) assert.deepEqual(again.totals[k], v, `totals.${k}`);
  assert.equal(again.rounds_counted, 11);
  assert.deepEqual(again.final_rounds, []);
});

test('winds are counted over twelve rounds and the template figures are kept apart', () => {
  const s = finalFixture.stats;
  assert.equal(s.rounds_counted, 12);
  assert.equal(s.pair_rounds_counted, 11);
  assert.deepEqual(s.final_rounds, [12]);
  let total = 0;
  for (const id of s.player_order) {
    const p = s.players[id];
    assert.deepEqual(p.wind_split_template, [3, 3, 3, 2], `local_id ${id} over eleven`);
    assert.ok(['3-3-3-3', '4-3-3-2'].includes(p.wind_split.join('-')), `local_id ${id}: ${p.wind_split}`);
    assert.equal(p.wind_complete, p.wind_split.join('-') === '3-3-3-3');
    assert.ok(['E', 'S', 'W', 'N'].includes(p.deficient_wind));
    total += Object.values(p.winds).reduce((x, y) => x + y, 0);
  }
  assert.equal(total, 144, 'twelve players x twelve rounds');
  assert.deepEqual(
    s.totals.wind_complete_players,
    finalFixture.final.completed_local_ids,
    'the stats and the draw disagree about who was completed'
  );
});

test('the template pair invariants survive the twelfth round untouched', () => {
  const s = finalFixture.stats;
  assert.equal(s.totals.pairs, 66);
  assert.equal(s.totals.perfect_pairs, 55);
  for (const id of s.player_order) {
    for (const o of s.players[id].opponents) {
      assert.equal(o.same_table, 3, `${id} vs ${o.local_id}`);
      assert.equal(o.opposite, 1, `${id} vs ${o.local_id}`);
      assert.equal(o.you_upstream + o.they_upstream, 2, `${id} vs ${o.local_id}`);
    }
  }
});

test('the final round keeps its pair relations in a place of their own', () => {
  const s = finalFixture.stats;
  let met = 0;
  for (const id of s.player_order) {
    for (const o of s.players[id].opponents) {
      assert.ok(o.final !== undefined, 'the final relation is missing entirely');
      if (o.final && o.final.same_table) met += 1;
    }
  }
  // Three tables of four: 6 pairs each, 18 pairs, counted from both sides.
  assert.equal(met, 36);
});

test('table balance is judged on the eleven rounds, not on the twelve', () => {
  // Over twelve rounds 5-4-3 is ordinary; judging on table_split would call most of the
  // field imbalanced. The claim is about the template, so it is measured on the template.
  const s = finalFixture.stats;
  const shapes = s.player_order.map((id) => s.players[id].table_split_template.join('-'));
  assert.equal(shapes.filter((x) => x === '4-4-3').length, 9);
  assert.equal(shapes.filter((x) => x === '5-3-3').length, 3);
  assert.equal(s.totals.imbalanced_players.length, 3);
  for (const id of s.player_order) {
    assert.equal(s.players[id].table_imbalanced, s.players[id].table_split_template.join('-') !== '4-4-3');
  }
});

test('the template point survives the twelfth round, which has none', () => {
  // The regression: counting round 12 in the same pass set every point to undefined,
  // which JSON drops, so nothing broke loudly and the explorer lost its geometry.
  const s = finalFixture.stats;
  for (const id of s.player_order) {
    const point = s.players[id].point;
    assert.ok(Number.isInteger(point) && point >= 0 && point < 12, `local_id ${id} point ${point}`);
  }
  assert.equal(new Set(s.player_order.map((id) => s.players[id].point)).size, 12);
});

test('the grid carries all twelve rounds, the last one with a rank instead of a point', () => {
  const s = finalFixture.stats;
  for (const id of s.player_order) {
    const rounds = s.players[id].rounds;
    assert.equal(Object.keys(rounds).length, 12);
    for (let r = 1; r <= 11; r++) assert.ok(Number.isInteger(rounds[r].point), `round ${r}`);
    assert.equal(rounds[12].point, undefined);
    assert.ok(Number.isInteger(rounds[12].rank) && rounds[12].rank >= 1 && rounds[12].rank <= 12);
    assert.ok([1, 2, 3].includes(rounds[12].table));
  }
});

// ---------------------------------------------------------------------------
// Pantheon sync (PANTHEON-INTEGRATION.md §3, §4)
// ---------------------------------------------------------------------------

test('a successful sync writes the prescript and reads it back', async () => {
  const p = new StubPantheon({ roster });
  const out = await syncToPantheon({ roster }, results, p, QUIET);
  assert.equal(out.status, 'ok');
  assert.equal(p.prescript, results.pantheon_prescript);
  assert.equal(p.nextSessionIndex, 1, '§3: next_session_index is 1 for a fresh plan');
});

test('a sync that stores something different is caught by the read-back', async () => {
  // RUNBOOK A6 calls this the step most likely to be silently wrong.
  const p = new StubPantheon({ roster });
  p.setPrescript = async function (eventId, prescript) { this.prescript = prescript.replace('1', '9'); };
  const out = await syncToPantheon({ roster }, results, p, QUIET, { attempts: 1 });
  assert.equal(out.status, 'failed');
  assert.match(out.error, /read back different/);
});

test('a failing sync is recorded, retried, and never re-draws', async () => {
  const p = new StubPantheon({ roster });
  p.setPrescript = async () => { throw new Error('mimir down'); };
  const out = await syncToPantheon({ roster }, results, p, QUIET, { attempts: 2, baseDelayMs: 1 });
  assert.equal(out.status, 'failed');
  assert.equal(out.attempts, 2);
  assert.match(out.remedy, /Do NOT re-run the draw/);
  assert.match(out.remedy, /WIND_SHUFFLE_MODE_PRESCRIPTED/);
});

test('a transient failure that then succeeds is reported as ok', async () => {
  const p = new StubPantheon({ roster });
  p.failNext = new Error('temporary');
  const out = await syncToPantheon({ roster }, results, p, QUIET, { attempts: 3, baseDelayMs: 1 });
  assert.equal(out.status, 'ok');
  assert.equal(out.attempts, 2);
});

test('the prescript Pantheon receives round-trips back to the same seat plan', async () => {
  // Parse it the way EventPrescript::unpackScript does and check it reconstructs the
  // seating, winds included — the thing WIND_SHUFFLE_MODE_PRESCRIPTED must preserve.
  const p = new StubPantheon({ roster });
  await syncToPantheon({ roster }, results, p, QUIET);
  const sessions = p.prescript.split('\n\n');
  assert.equal(sessions.length, 11);
  sessions.forEach((block, r) => {
    block.split('\n').forEach((line, t) => {
      const ids = line.split('-').map(Number);
      const seats = results.seating.rounds[r].tables[t].seats;
      assert.deepEqual(ids, [seats.E, seats.S, seats.W, seats.N].map((s) => s.local_id),
        `round ${r + 1} table ${t + 1}`);
    });
  });
});

// ---------------------------------------------------------------------------
// The Twirp client, against what a live Pantheon actually does.
//
// Every value below was read off a running instance (Pantheon cdda3fc) rather than off
// the proto files, because the two disagreed in four places and each disagreement was
// silent. The old version of this test pinned the guesses.

/** A fetch that records what was sent and replies with whatever the test wants. */
function recorder(reply) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body), headers: init.headers });
    const r = typeof reply === 'function' ? reply(url, calls.length - 1) : reply;
    const status = r.status ?? 200;
    return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(r.body ?? {}) };
  };
  return { calls, fetch };
}

const client = (fetch, env = { PANTHEON_ADMIN_PERSON_ID: '1', PANTHEON_ADMIN_TOKEN: 'tok' }) =>
  new TwirpPantheon({ frey_base_url: 'http://f', mimir_base_url: 'http://m' }, env, { fetch });

test('the Twirp client posts to the paths a live Pantheon serves', async () => {
  // /v2, not /twirp: both services mount the handler under /v2 (Mimir in
  // www/twirp/index.php, Frey in app/server.ts). And the protobuf package is `common`
  // for both, so the service segment is common.Frey / common.Mimir — not frey.Frey.
  const { calls, fetch } = recorder({ body: { authSuccess: true, players: [] } });
  const p = client(fetch);
  await p.verifyToken(7, 'abc');
  await p.getEventRoster(42);
  await p.setPrescript(42, 'x', 1);

  assert.equal(calls[0].url, 'http://f/v2/common.Frey/QuickAuthorize');
  assert.equal(calls[1].url, 'http://m/v2/common.Mimir/GetAllRegisteredPlayers');
  assert.equal(calls[2].url, 'http://m/v2/common.Mimir/UpdatePrescriptedEventConfig');
  // Requests may stay snake_case; both services accept it.
  assert.deepEqual(calls[1].body, { event_ids: [42] });
  assert.equal(calls[2].body.next_session_index, 1);
});

test('responses are read in lowerCamelCase, which is what the wire carries', async () => {
  // Observed: {"personId":1,"authToken":"..."}, {"authSuccess":true},
  // {"players":[{"id":2,"title":"...","tenhouId":"...","lastUpdate":"..."}]}.
  const { fetch } = recorder({ body: {
    players: [{ id: 2, title: 'playerplayer1', localId: 5, ignoreSeating: true }],
  } });
  const roster = await client(fetch).getEventRoster(1);
  assert.deepEqual(roster, [{ person_id: 2, title: 'playerplayer1', local_id: 5, ignore_seating: true }]);
});

test('a field holding its default is absent from the response, and reads as the default', async () => {
  // The seeded event returns players with no localId and no ignoreSeating at all,
  // because protobuf JSON omits an unset optional and a false bool. Reading those as
  // "the server did not say" rather than as unassigned/false is how a roster of twelve
  // silently became twelve players with no local ids.
  const { fetch } = recorder({ body: { players: [{ id: 2, title: 'x' }] } });
  const roster = await client(fetch).getEventRoster(1);
  assert.equal(roster[0].local_id, null, 'an absent localId means unassigned');
  assert.equal(roster[0].ignore_seating, false, 'an absent ignoreSeating means false');
});

test('a bad credential pair is a refusal, not an outage', async () => {
  // Frey answers a wrong token with 400 invalid_argument "Password check failed" and an
  // unknown person with 404 not_found — never with a 200 carrying false. Letting those
  // propagate made server.js report a mistyped password as 503 "Cannot reach Pantheon
  // right now", where UI-SPEC §3 requires a 401 the player can act on.
  for (const status of [400, 401, 403, 404]) {
    const { fetch } = recorder({ status, body: { code: 'invalid_argument', msg: 'Password check failed' } });
    assert.equal(await client(fetch).verifyToken(1, 'wrong'), false, `status ${status} must read as a refusal`);
  }
});

test('an outage is still an outage', async () => {
  // The distinction only works if the other direction holds: 5xx and 429 must keep
  // throwing, so the player is told to try again rather than that their password is wrong.
  for (const status of [500, 502, 503, 429]) {
    const { fetch } = recorder({ status, body: { code: 'internal', msg: 'boom' } });
    await assert.rejects(() => client(fetch).verifyToken(1, 'tok'), /QuickAuthorize/, `status ${status}`);
  }
});

test('sign-in needs the response to say yes, and an unreadable body does not', async () => {
  const yes = recorder({ body: { authSuccess: true } });
  assert.equal(await client(yes.fetch).verifyToken(1, 'tok'), true);

  // A bool that is true is always serialised; false is always omitted. So an empty body
  // is a false, and anything unrecognisable is a refusal. This used to return true.
  for (const body of [{}, { authSuccess: false }, { nonsense: 1 }, null]) {
    const r = recorder({ body });
    assert.equal(await client(r.fetch).verifyToken(1, 'tok'), false, `body ${JSON.stringify(body)}`);
  }
});

test('admin calls carry the event scope Mimir checks rights against', async () => {
  // Mimir/src/Meta.php reads X-Auth-Token, X-Current-Person-Id and X-Current-Event-Id,
  // and event admin and referee rights are scoped by the third. Without it the prescript
  // write is refused — after the draw, when nothing can be changed.
  const { calls, fetch } = recorder({ body: {} });
  await client(fetch).setPrescript(42, 'plan', 1);
  assert.equal(calls[0].headers['x-auth-token'], 'tok');
  assert.equal(calls[0].headers['x-current-person-id'], '1');
  assert.equal(calls[0].headers['x-current-event-id'], '42');

  // The sign-in path is not an admin path and must never send credentials (§3).
  const s = recorder({ body: { authSuccess: true } });
  await client(s.fetch).verifyToken(1, 'tok');
  assert.equal(s.calls[0].headers['x-auth-token'], undefined);
});

test('the sync path refuses to run without admin credentials', async () => {
  const p = new TwirpPantheon({}, {}, { fetch: async () => ({ ok: true, status: 200, text: async () => '{}' }) });
  await assert.rejects(() => p.setPrescript(42, 'x'), /no admin credentials/);
  // …but the player sign-in path needs none of that (§3: never mixed).
  await assert.doesNotReject(() => p.verifyToken(1, 'tok'));
});

test('the standings come back in the order Mimir gave them, ranked by position', async () => {
  // PlayerInRating has no place field. The rank is the position in the list, so re-sorting
  // here — even into an order that looks more sensible — would invent the one number the
  // final round's tables are read from (PROTOCOL.md §11).
  const { calls, fetch } = recorder({ body: { list: [
    { id: 9, title: 'third by rating', rating: 1400, gamesPlayed: 11 },
    { id: 4, title: 'first by rating', rating: 1600, gamesPlayed: 11 },
    { id: 7, title: 'second by rating', rating: 1500, gamesPlayed: 11 },
  ] } });
  const rows = await client(fetch).getRatingTable(42, 'rating', 'desc');

  assert.equal(calls[0].url, 'http://m/v2/common.Mimir/GetRatingTable');
  assert.deepEqual(calls[0].body, { event_id_list: [42], order_by: 'rating', order: 'desc' });
  assert.deepEqual(rows.map((r) => [r.rank, r.person_id]), [[1, 9], [2, 4], [3, 7]],
    'the list order is the ranking, whatever the ratings say');
  // Reading standings is not an admin operation by default, so no credentials are sent.
  assert.equal(calls[0].headers['x-auth-token'], undefined);
});

test('a standings row with everything at its default still reads as zero, not as silence', async () => {
  // Protobuf JSON omits a field holding its default, so someone who has played no games
  // arrives as {id, title} and nothing else. games_played reading as 0 rather than
  // undefined is exactly what lets lock-final.js refuse to seat an unfinished event.
  const { fetch } = recorder({ body: { list: [
    { id: 3, title: 'has not played' },
    { id: 5, title: 'has', rating: 1500.5, chips: 2, avgPlace: 2.25, avgScore: 1200, gamesPlayed: 11 },
  ] } });
  const rows = await client(fetch).getRatingTable(42);
  assert.deepEqual(rows[0], {
    rank: 1, person_id: 3, title: 'has not played',
    rating: 0, chips: 0, avg_place: 0, avg_score: 0, games_played: 0,
  });
  assert.deepEqual(rows[1], {
    rank: 2, person_id: 5, title: 'has',
    rating: 1500.5, chips: 2, avg_place: 2.25, avg_score: 1200, games_played: 11,
  });
});

test('the standings read carries admin headers only when it is asked to', async () => {
  // Whether Mimir needs them for a rating table is unverified against a live instance
  // (test/e2e.js settles it), so it is opt-in rather than a guess in either direction.
  const { calls, fetch } = recorder({ body: { list: [] } });
  await client(fetch).getRatingTable(42, 'rating', 'desc', { admin: true });
  assert.equal(calls[0].headers['x-auth-token'], 'tok');
  assert.equal(calls[0].headers['x-current-event-id'], '42');
});

test('the stub ranks by position too, and cannot be handed a rank', async () => {
  // A stub that let a caller supply the rank could disagree with the real client about
  // the one property the final round depends on.
  // The test fixture's roster, not data/roster.json: this is about the stub's contract,
  // and it should not start failing because a real event was frozen with ten players.
  const p = new StubPantheon({ roster });
  const byDefault = await p.getRatingTable(roster.pantheon_event_id);
  assert.equal(byDefault.length, 12);
  assert.deepEqual(byDefault.map((r) => r.rank), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  assert.ok(byDefault.every((r) => r.games_played === 11), 'the default stands up a finished round-robin');

  p.setStandings([{ person_id: 46, title: 'x', rank: 99, games_played: 11 }]);
  const scripted = await p.getRatingTable(roster.pantheon_event_id);
  assert.equal(scripted[0].rank, 1, 'position wins over anything the caller wrote');
  assert.equal(scripted.length, 1, 'a short table is representable, so it can be refused');
});
