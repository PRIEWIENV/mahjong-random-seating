'use strict';

/**
 * The drand client, and the one branch in this system that stops a draw outright.
 *
 * PROTOCOL.md §9 rests on a single live dependency: drand publishes the signature for
 * target_round, and anybody can fetch it from any public mirror. server/drand.js asks
 * every configured mirror and cross-checks the answers, because two mirrors disagreeing
 * about a round is not something to resolve by taking the first one.
 *
 * That check had never been executed. The only `new Drand` anywhere in the tests was in
 * test/e2e.js, with one mirror, where agreement is true by arithmetic — and e2e is not
 * in `npm test`, not in the freeze preflight, and deliberately not in CI. So the whole
 * of the cross-check, its two disagreement cases, and the flag the draw job reads to
 * decide whether to stop, were carried entirely by reading.
 *
 * The reason was structural rather than neglect: `Drand` had no injectable fetch, unlike
 * TwirpPantheon and Mirror, so exercising it meant finding two real mirrors that
 * disagree. It takes one now, and these are offline.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { Drand, DrandError } = require('../server/drand');
const { QUICKNET_HASH, QUICKNET_PK, SAMPLE_SIG } = require('./helpers');

const ROUND = 1_000_000;

const info = (over = {}) => ({
  public_key: QUICKNET_PK,
  period: 3,
  genesis_time: 1_692_803_367,
  hash: QUICKNET_HASH,
  ...over,
});

const beacon = (over = {}) => ({ round: ROUND, signature: SAMPLE_SIG, randomness: 'aa'.repeat(32), ...over });

/**
 * A fetch that answers per mirror, so a test can say "this one disagrees".
 *
 * @param {object} byHost host -> {info?, round?, status?}  — `status` refuses instead.
 */
function fakeFetch(byHost) {
  const calls = [];
  const impl = async (url) => {
    const { host, pathname } = new URL(url);
    calls.push(url);
    const spec = byHost[host];
    if (!spec) throw new Error(`no route for ${host}`);
    if (spec.status) return { ok: false, status: spec.status, json: async () => ({}) };
    const body = pathname.endsWith('/info') ? spec.info : spec.round;
    if (body === undefined) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => body };
  };
  impl.calls = calls;
  return impl;
}

const mirrorsFor = (hosts) => hosts.map((h) => `https://${h}`);

test('a round every mirror agrees about comes back with the mirrors that confirmed it', async () => {
  const hosts = ['a.example', 'b.example', 'c.example'];
  const fetchImpl = fakeFetch(Object.fromEntries(hosts.map((h) => [h, { round: beacon() }])));
  const d = new Drand(QUICKNET_HASH, mirrorsFor(hosts), { fetch: fetchImpl });

  const out = await d.round(ROUND);
  assert.equal(out.round, ROUND);
  assert.equal(out.signature, SAMPLE_SIG);
  assert.deepEqual(out.mirrors, mirrorsFor(hosts), 'every mirror that answered should be named');
  assert.equal(fetchImpl.calls.length, 3, 'all three are asked, not just the first');
});

/**
 * The one that matters. A mirror serving a different signature for the same round is
 * either compromised or broken, and either way the seat plan that would come out of it
 * is not the seat plan anybody else can recompute. §9's answer is to stop.
 */
test('two mirrors with different signatures for one round is a refusal, not a vote', async () => {
  const fetchImpl = fakeFetch({
    'a.example': { round: beacon() },
    'b.example': { round: beacon({ signature: 'bb'.repeat(48) }) },
  });
  const d = new Drand(QUICKNET_HASH, mirrorsFor(['a.example', 'b.example']), { fetch: fetchImpl });

  const err = await d.round(ROUND).then(() => null, (e) => e);
  assert.ok(err instanceof DrandError, `expected a DrandError, got ${err}`);
  assert.match(err.message, /DO NOT DRAW/);
  // Both answers are in the message: whoever has to investigate needs to know which
  // mirror said what, and this is the only place that pairing exists.
  assert.match(err.message, /a\.example/);
  assert.match(err.message, /b\.example/);
});

test('a disagreement is flagged, because the draw job stops on the flag', async () => {
  const fetchImpl = fakeFetch({
    'a.example': { round: beacon() },
    'b.example': { round: beacon({ signature: 'cc'.repeat(48) }) },
  });
  const d = new Drand(QUICKNET_HASH, mirrorsFor(['a.example', 'b.example']), { fetch: fetchImpl });
  const err = await d.round(ROUND).then(() => null, (e) => e);
  assert.equal(err.disagreement, true,
    'server/finalise.js rethrows on this flag; without it the draw would retry around a ' +
    'disagreement until it timed out and then report it as a late beacon');
});

test('every other failure is retryable, and says so by not being flagged', async () => {
  const d = new Drand(QUICKNET_HASH, mirrorsFor(['a.example', 'b.example']), {
    fetch: fakeFetch({ 'a.example': { status: 503 }, 'b.example': { status: 503 } }),
  });
  const err = await d.round(ROUND).then(() => null, (e) => e);
  assert.ok(err instanceof DrandError);
  assert.equal(err.disagreement, false, 'an outage is a delay; §8 says wait');
  assert.match(err.message, /no drand mirror answered/);
  // Each mirror's own refusal, so an operator can see whether it is one endpoint or all.
  assert.match(err.message, /HTTP 503/);
});

test('one mirror down does not stop a draw the others agree about', async () => {
  const d = new Drand(QUICKNET_HASH, mirrorsFor(['a.example', 'b.example', 'c.example']), {
    fetch: fakeFetch({
      'a.example': { status: 500 },
      'b.example': { round: beacon() },
      'c.example': { round: beacon() },
    }),
  });
  const out = await d.round(ROUND);
  assert.deepEqual(out.mirrors, ['https://b.example', 'https://c.example']);
});

test('a mirror answering with a different round is refused', async () => {
  const d = new Drand(QUICKNET_HASH, mirrorsFor(['a.example']), {
    fetch: fakeFetch({ 'a.example': { round: beacon({ round: ROUND + 1 }) } }),
  });
  await assert.rejects(d.round(ROUND), /asked for round 1000000, mirror answered with round 1000001/);
});

test('mirrors that disagree about the chain public key stop everything too', async () => {
  const d = new Drand(QUICKNET_HASH, mirrorsFor(['a.example', 'b.example']), {
    fetch: fakeFetch({
      'a.example': { info: info() },
      'b.example': { info: info({ public_key: 'ff'.repeat(48) }) },
    }),
  });
  const err = await d.info().then(() => null, (e) => e);
  assert.match(err.message, /disagree about the chain public key/);
  assert.equal(err.disagreement, true);
});

/**
 * The chain is pinned in the frozen protocol.json. An endpoint serving some other chain
 * is exactly what that pin exists to catch, and it must fail loudly rather than
 * silently substitute one (PROTOCOL.md §4.2).
 */
test('an endpoint serving a different chain is refused rather than adopted', async () => {
  const d = new Drand(QUICKNET_HASH, mirrorsFor(['a.example']), {
    fetch: fakeFetch({ 'a.example': { info: info({ hash: 'ab'.repeat(32) }) } }),
  });
  await assert.rejects(d.info(), /drand returned chain hash abab/);
});

test('the chain info is fetched once and then reused', async () => {
  const fetchImpl = fakeFetch({ 'a.example': { info: info() } });
  const d = new Drand(QUICKNET_HASH, mirrorsFor(['a.example']), { fetch: fetchImpl });
  await d.info();
  await d.info();
  assert.equal(fetchImpl.calls.length, 1, 'twelve waiting browsers must not become twelve upstream calls');
});

test('roundTimeMs follows the chain genesis and period', async () => {
  const d = new Drand(QUICKNET_HASH, mirrorsFor(['a.example']), {
    fetch: fakeFetch({ 'a.example': { info: info() } }),
  });
  assert.equal(await d.roundTimeMs(1), 1_692_803_367 * 1000);
  assert.equal(await d.roundTimeMs(101), (1_692_803_367 + 300) * 1000);
});

test('a duplicated or trailing-slashed mirror is asked once', async () => {
  const fetchImpl = fakeFetch({ 'a.example': { round: beacon() } });
  const d = new Drand(QUICKNET_HASH,
    ['https://a.example', 'https://a.example/', 'https://a.example'], { fetch: fetchImpl });
  assert.deepEqual(d.mirrors, ['https://a.example']);
  await d.round(ROUND);
  assert.equal(fetchImpl.calls.length, 1);
});
