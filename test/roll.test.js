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

const { publishRoll, rollBody, rollDigest, takeSnapshot, KEY_ROLL } = require('../server/finalise');
const { Store } = require('../server/db');
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
