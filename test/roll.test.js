'use strict';

/**
 * Publishing the roll inside the interval (server/finalise.js, PROTOCOL.md §9).
 *
 * §9's attack is a player who never submits colluding with the organiser, who forges a
 * twelfth submission once the beacon is out and says it arrived in time. Nothing
 * cryptographic stops that: a tlock ciphertext can be written at any moment before its
 * round, so it carries no evidence of its own age.
 *
 * What stops it is the roll being fixed and public while the beacon does not yet exist.
 * That is a claim about *ordering*, so these tests are mostly about when things happen
 * rather than what they contain: the roll must be written and stamped at the cutoff, not
 * at the draw, and neither a dead calendar nor a dead mirror may prevent it.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const {
  run, publishRoll, rollBody, rollDigest, takeSnapshot, retryNapMs, decryptSnapshot,
  BeaconNotReadyError, BeaconUnreachableError, isTransportFailure, KEY_ROLL,
} = require('../server/finalise');
const { Store } = require('../server/db');
const { StubPantheon } = require('../server/pantheon');
const { makeDataDir, cleanup, fakeCiphertext } = require('./helpers');
const { load } = require('../server/config');

const QUIET = { info() {}, warn() {}, error() {} };

function fixture() {
  const fx = makeDataDir();
  const cfg = load({ dataDir: fx.dataDir });
  cfg.root = fx.dir;
  const store = new Store(':memory:');
  return { fx, cfg, store, close: () => { store.close(); cleanup(fx.dir); } };
}

const SNAP = {
  cutoff_utc: '2026-09-10T20:00:00Z',
  taken_at: '2026-09-10T20:00:01Z',
  local_ids: [1, 2, 3],
  submissions: [{ local_id: 1, ciphertext: 'a', received_at: '2026-09-10T19:00:00Z' }],
};

const okStamp = (calendars = ['https://a.example', 'https://b.example']) => async (buf) => ({
  ots: Buffer.concat([Buffer.from('OTS'), crypto.createHash('sha256').update(buf).digest()]),
  digest: crypto.createHash('sha256').update(buf).digest('hex'),
  calendars,
  failed: [],
});

test('the roll is written where anyone can fetch it, and its digest recorded', async () => {
  const c = fixture();
  const mirrored = [];
  const rec = await publishRoll(c.cfg, c.store, SNAP, {
    mirror: { enqueue: (p, body, msg) => mirrored.push({ p, body, msg }) },
    log: QUIET,
    stampFn: okStamp(),
  });

  const onDisk = fs.readFileSync(path.join(c.fx.dir, 'events', 'snapshot.json'), 'utf8');
  assert.equal(onDisk, rollBody(SNAP));
  assert.equal(rec.digest, rollDigest(onDisk));
  // The digest has to be of the exact bytes served, or a player comparing it against a
  // file they downloaded gets a different answer and concludes the wrong thing.
  assert.equal(rec.digest, crypto.createHash('sha256').update(onDisk, 'utf8').digest('hex'));
  assert.deepEqual(rec.local_ids, [1, 2, 3]);
  assert.deepEqual(c.store.get(KEY_ROLL).digest, rec.digest);
  assert.ok(mirrored.some((m) => m.p === 'events/snapshot.json'));
  c.close();
});

test('the proof is written as bytes, not as text', async () => {
  // It is a binary format. Mirroring it through a utf8 decode would put something in the
  // repository that no ots client can read, which is the kind of failure nobody notices
  // until they try to verify.
  const c = fixture();
  const mirrored = [];
  await publishRoll(c.cfg, c.store, SNAP, {
    mirror: { enqueue: (p, body) => mirrored.push({ p, body }) },
    log: QUIET,
    stampFn: okStamp(),
  });
  const proof = mirrored.find((m) => m.p === 'events/snapshot.json.ots');
  assert.ok(proof, 'the proof was not mirrored');
  assert.ok(Buffer.isBuffer(proof.body), 'the proof was handed over as a string');
  const onDisk = fs.readFileSync(path.join(c.fx.dir, 'events', 'snapshot.json.ots'));
  assert.deepEqual([...onDisk], [...proof.body]);
  c.close();
});

test('a failed anchor is recorded and does not stop the draw', async () => {
  // The digest is the part twelve people can check between themselves, and it needs
  // nobody else to be up. Losing the anchor is bad and must be visible; stopping the
  // draw over it would be worse.
  const c = fixture();
  const errors = [];
  const rec = await publishRoll(c.cfg, c.store, SNAP, {
    mirror: { enqueue: () => {} },
    log: { ...QUIET, error: (s) => errors.push(s) },
    stampFn: async () => { throw new Error('no calendar could be reached'); },
  });
  assert.equal(rec.digest.length, 64, 'the roll was still published');
  assert.match(rec.ots.failed, /no calendar/);
  assert.equal(rec.ots.calendars, undefined);
  assert.ok(errors.some((e) => /NOT anchored/.test(e)));
  assert.equal(fs.existsSync(path.join(c.fx.dir, 'events', 'snapshot.json')), true);
  assert.equal(fs.existsSync(path.join(c.fx.dir, 'events', 'snapshot.json.ots')), false);
  c.close();
});

test('a dead mirror does not stop the roll being published locally', async () => {
  const c = fixture();
  const rec = await publishRoll(c.cfg, c.store, SNAP, { mirror: null, log: QUIET, stampFn: okStamp() });
  assert.equal(rec.digest.length, 64);
  assert.equal(fs.existsSync(path.join(c.fx.dir, 'events', 'snapshot.json')), true);
  c.close();
});

test('the anchor records which calendars witnessed it', async () => {
  const c = fixture();
  const rec = await publishRoll(c.cfg, c.store, SNAP, {
    mirror: { enqueue: () => {} },
    log: QUIET,
    stampFn: okStamp(['https://a.example', 'https://b.example', 'https://c.example']),
  });
  assert.equal(rec.ots.calendars.length, 3);
  assert.ok(rec.ots.at);
  c.close();
});

test('the roll is exactly what the snapshot held, no more and no less', async () => {
  // A roll that quietly differed from the snapshot the draw uses would make the whole
  // exercise a performance: players would be comparing a digest of something else.
  const c = fixture();
  const now = Date.parse(c.cfg.protocol.submission_cutoff_utc) - 60_000;
  for (const id of [2, 5, 9]) {
    c.store.insertSubmission(id, fakeCiphertext(c.cfg.protocol.target_round, c.cfg.protocol.chain_hash), now);
  }
  const snap = takeSnapshot(c.cfg, c.store, QUIET);
  const rec = await publishRoll(c.cfg, c.store, snap, {
    mirror: { enqueue: () => {} }, log: QUIET, stampFn: okStamp(),
  });
  const published = JSON.parse(fs.readFileSync(path.join(c.fx.dir, 'events', 'snapshot.json'), 'utf8'));
  assert.deepEqual(published.local_ids, [2, 5, 9]);
  assert.deepEqual(rec.local_ids, [2, 5, 9]);
  assert.equal(published.submissions.length, 3);
  assert.equal(published.cutoff_utc, c.cfg.protocol.submission_cutoff_utc);
  c.close();
});

test('with no stamper the roll is still published, and nothing is dialled', async () => {
  // The anchor belongs to a deployment, not to every caller of run(). A default that
  // reached the calendars made this offline suite depend on the network and cost a
  // second in every test that finalises anything, which is how it was noticed.
  const c = fixture();
  const saved = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('a unit test reached the network'); };
  try {
    const rec = await publishRoll(c.cfg, c.store, SNAP, { mirror: { enqueue: () => {} }, log: QUIET });
    assert.equal(rec.digest.length, 64, 'the roll was not published');
    assert.equal(rec.ots.skipped, true);
    assert.equal(fs.existsSync(path.join(c.fx.dir, 'events', 'snapshot.json.ots')), false);
  } finally {
    globalThis.fetch = saved;
    c.close();
  }
});

/**
 * Waiting out the interval (server/finalise.js).
 *
 * The job starts at the cutoff and the beacon does not exist until reveal_gap_seconds
 * later, so almost all of its life is spent waiting for something whose arrival time is
 * already written down in protocol.json. Polling blindly through that is both pointless
 * traffic and, worse, a random delay bolted onto the end of the draw: the round can land
 * a whole poll interval before anyone asks for it.
 */

const DUE = Date.parse('2026-09-10T20:10:00Z');
const POLL = 1_000;

test('before the round is due, it sleeps exactly until the round and not one interval', () => {
  const now = DUE - 600_000;
  assert.equal(retryNapMs(DUE, now, POLL), 600_000);
  assert.equal(retryNapMs(DUE, DUE - 1, POLL), 1);
});

test('once the round is due, it polls, because now the delay is propagation', () => {
  assert.equal(retryNapMs(DUE, DUE, POLL), POLL);
  assert.equal(retryNapMs(DUE, DUE + 5_000, POLL), POLL);
});

test('a protocol with no derived round time falls back to polling rather than to NaN', () => {
  // The only way this happens is a caller assembling a cfg by hand. A NaN nap is an
  // immediate spin, which would turn a missing field into a denial of service against
  // the drand mirrors.
  for (const bad of [undefined, null, NaN, 'soon']) {
    assert.equal(retryNapMs(bad, DUE, POLL), POLL);
  }
});

/**
 * Being decrypted too promptly must not cost anyone their place.
 *
 * Holding the beacon for a round and being allowed to open a ciphertext with it are two
 * different questions, asked of two different clocks. drand's servers decide the first.
 * tlock decides the second on its own, locally: genesis_time + (round - 1) * period
 * against Date.now(). A host running a second behind drand is handed the key and then
 * told it is too early to use it — and that was filed alongside a malformed ciphertext:
 * excluded, published as excluded, and final. A player could be thrown out of the draw
 * because the organiser's machine was slightly slow and its job slightly fast.
 *
 * It surfaced when the wait loop stopped polling every fifteen seconds and started
 * waking exactly at the round. The draw went from always several seconds late to
 * immediate, and the rehearsal lost first three players, then one — the first few
 * decryptions failing while the rest succeeded, because each one took long enough for
 * the clock to catch up.
 */

const TOO_EARLY = "It's too early to decrypt the ciphertext - decryptable at round 32098187";

const snapOf = (...ids) => ({
  cutoff_utc: SNAP.cutoff_utc,
  local_ids: ids,
  submissions: ids.map((local_id) => ({ local_id, ciphertext: `c${local_id}`, received_at: SNAP.taken_at })),
});

test('a beacon that has not propagated stops the pass instead of excluding anyone', async () => {
  const c = fixture();
  const seen = [];
  await assert.rejects(
    () => decryptSnapshot(snapOf(1, 2, 3), c.cfg, QUIET, {
      decryptFn: async (ct) => { seen.push(ct); throw new Error(TOO_EARLY); },
    }),
    (err) => err instanceof BeaconNotReadyError && /not yet servable/.test(err.message),
  );
  // And it gives up at the first one rather than working through the rest: they would
  // all fail the same way, and the point is that none of them is at fault.
  assert.deepEqual(seen, ['c1']);
  c.close();
});

test('a ciphertext that is genuinely unopenable is still excluded, one player only', async () => {
  // The distinction is the whole fix. One is about the clock and clears by itself; the
  // other is about the ciphertext and never will.
  const c = fixture();
  const { decrypted, excluded } = await decryptSnapshot(snapOf(1, 2, 3), c.cfg, QUIET, {
    decryptFn: async (ct) => {
      if (ct === 'c2') throw new Error('decrypted payload is not JSON');
      return { user_input: 7, client_nonce: 'a'.repeat(32), client_timestamp: SNAP.taken_at };
    },
  });
  assert.deepEqual(decrypted.map((d) => d.local_id), [1, 3]);
  assert.equal(excluded.length, 1);
  assert.equal(excluded[0].local_id, 2);
  assert.match(excluded[0].reason, /not JSON/);
  c.close();
});

/**
 * The network dropping mid-draw.
 *
 * tlock fetches the round's signature through an HTTP chain client inside every single
 * `timelockDecrypt`, so a link that goes down after the beacon-wait loop has already
 * succeeded makes all twelve throw at once. Before these, every one of them was recorded
 * as an undecryptable submission, the second quorum check failed against nothing, and
 * the round was voided — publishing twelve players as having sent ciphertexts that would
 * not open, when the ciphertexts were fine and the fault was entirely local. Seen for
 * real by pulling the network during `npm run demo`, which came back to a page reading
 * "only 12 sealed a number, short of the 8 required".
 */
test('a network that drops mid-decryption stops the pass instead of excluding everyone', async () => {
  const c = fixture();
  const seen = [];
  await assert.rejects(
    () => decryptSnapshot(snapOf(1, 2, 3), c.cfg, QUIET, {
      decryptFn: async (ct) => {
        seen.push(ct);
        // What node's fetch actually throws: a bare TypeError with the real reason
        // nested in `cause`. A predicate that only read `message` would miss it.
        throw Object.assign(new TypeError('fetch failed'), {
          cause: Object.assign(new Error('getaddrinfo ENOTFOUND api.drand.sh'), { code: 'ENOTFOUND' }),
        });
      },
    }),
    (err) => err instanceof BeaconUnreachableError && /cannot reach the drand chain/.test(err.message),
  );
  // First failure, not the twelfth: they would all fail identically and none is at fault.
  assert.deepEqual(seen, ['c1']);
  c.close();
});

test('the reported reason names the cause, not just "fetch failed"', async () => {
  // An operator reading the log has to be able to tell a dead DNS from a refused
  // connection, and undici hides that one level down.
  const c = fixture();
  await assert.rejects(
    () => decryptSnapshot(snapOf(1), c.cfg, QUIET, {
      decryptFn: async () => {
        throw Object.assign(new TypeError('fetch failed'), {
          cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:443'), { code: 'ECONNREFUSED' }),
        });
      },
    }),
    (err) => /fetch failed/.test(err.message) && /ECONNREFUSED/.test(err.message),
  );
  c.close();
});

test('transport failures are told apart from ciphertext failures', () => {
  // The two must never be confused in either direction. Excluding on a transient fault
  // is permanent and public; retrying on a permanent one only stalls a draw an operator
  // can see.
  for (const err of [
    Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET', message: 'socket hang up' } }),
    Object.assign(new Error('x'), { cause: { cause: { code: 'EAI_AGAIN', message: 'getaddrinfo EAI_AGAIN' } } }),
    Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }),
    new Error('Error fetching URL https://api.drand.sh/public/1 : 502'),
    Object.assign(new Error('failed'), { code: 'UND_ERR_CONNECT_TIMEOUT' }),
    new Error('network is unreachable'),
  ]) {
    assert.equal(isTransportFailure(err), true, err.message);
  }
  for (const err of [
    new Error('decrypted payload is not JSON'),
    new Error('Unable to decrypt the ciphertext'),
    new Error('user_input must be an integer in 0..100'),
    new Error('could not parse the age header'),
    new Error("It's too early to decrypt the ciphertext - decryptable at round 32098187"),
    new Error('invalid armor'),
  ]) {
    assert.equal(isTransportFailure(err), false, err.message);
  }
});

test('a dropped network leaves the round pending, never void', async () => {
  // The whole point. `awaiting_round` is recoverable the moment the link comes back;
  // a void is not recoverable at all — it costs twelve people a fresh submission each.
  const c = fixture();
  const now = Date.parse(c.cfg.protocol.submission_cutoff_utc) - 60_000;
  for (let id = 1; id <= 12; id++) {
    c.store.insertSubmission(id, fakeCiphertext(c.cfg.protocol.target_round, c.cfg.protocol.chain_hash), now);
  }
  const out = await run({
    cfg: c.cfg, store: c.store, log: QUIET, wait: false,
    now: c.cfg.protocol.target_round_ms + 1000,
    mirror: { enabled: false, enqueue() {}, flush: async () => {}, drain: async () => true },
    pantheon: new StubPantheon({ roster: c.fx.roster }),
    drand: { round: async () => ({ round: c.cfg.protocol.target_round, signature: 'ab'.repeat(48), mirrors: ['m'] }) },
    decryptFn: async () => {
      throw Object.assign(new TypeError('fetch failed'), {
        cause: Object.assign(new Error('getaddrinfo ENOTFOUND api.drand.sh'), { code: 'ENOTFOUND' }),
      });
    },
  });
  assert.equal(out.phase, 'awaiting_round');
  assert.equal(fs.existsSync(path.join(c.fx.dir, 'events', 'void.json')), false, 'a network blip voided the round');
  assert.equal(fs.existsSync(path.join(c.fx.dir, 'results.json')), false);
  c.close();
});

test('the scheduled job does nothing and waits, rather than drawing a round short', async () => {
  // The scheduler runs with --no-wait every minute, so the correct response to a beacon
  // that has not propagated is to leave the whole thing alone: no results, no void
  // notice, no exclusions, phase unchanged. The next run draws a complete round.
  const c = fixture();
  const now = Date.parse(c.cfg.protocol.submission_cutoff_utc) - 60_000;
  for (let id = 1; id <= 12; id++) {
    c.store.insertSubmission(id, fakeCiphertext(c.cfg.protocol.target_round, c.cfg.protocol.chain_hash), now);
  }
  const out = await run({
    cfg: c.cfg, store: c.store, log: QUIET, wait: false,
    now: c.cfg.protocol.target_round_ms + 1000,
    mirror: { enabled: false, enqueue() {}, flush: async () => {}, drain: async () => true },
    pantheon: new StubPantheon({ roster: c.fx.roster }),
    drand: { round: async () => ({ round: c.cfg.protocol.target_round, signature: 'ab'.repeat(48), mirrors: ['m'] }) },
    decryptFn: async () => { throw new Error(TOO_EARLY); },
  });
  assert.equal(out.phase, 'awaiting_round');
  assert.equal(fs.existsSync(path.join(c.fx.dir, 'results.json')), false, 'it drew anyway');
  assert.equal(fs.existsSync(path.join(c.fx.dir, 'events', 'void.json')), false, 'it voided a full round');
  c.close();
});

test('a clock short of the round waits for itself rather than excluding anyone', async () => {
  // The fix that makes the retry above almost unreachable: tlock's test is local, so
  // the answer is to satisfy it locally before asking. Four hundred milliseconds here,
  // a second or two on a host whose NTP has drifted.
  const c = fixture();
  const now = Date.parse(c.cfg.protocol.submission_cutoff_utc) - 60_000;
  for (let id = 1; id <= 12; id++) {
    c.store.insertSubmission(id, fakeCiphertext(c.cfg.protocol.target_round, c.cfg.protocol.chain_hash), now);
  }
  const due = Date.now() + 400;
  c.cfg.protocol.target_round_ms = due;

  const decryptedAt = [];
  const out = await run({
    cfg: c.cfg, store: c.store, log: QUIET, wait: false,
    now: Date.parse(c.cfg.protocol.submission_cutoff_utc) + 1000,
    mirror: { enabled: false, enqueue() {}, flush: async () => {}, drain: async () => true },
    pantheon: new StubPantheon({ roster: c.fx.roster }),
    drand: { round: async () => ({ round: c.cfg.protocol.target_round, signature: 'ab'.repeat(48), mirrors: ['m'] }) },
    decryptFn: async (ct) => {
      decryptedAt.push(Date.now());
      return { user_input: Number(ct.length % 7), client_nonce: 'b'.repeat(32), client_timestamp: SNAP.taken_at };
    },
  });
  assert.equal(out.phase, 'done');
  assert.equal(decryptedAt.length, 12, 'every player must be opened, not just the ones the clock allowed');
  assert.ok(decryptedAt[0] >= due, `the first decryption ran ${due - decryptedAt[0]}ms before the round's time`);
  c.close();
});
