'use strict';

/**
 * The OpenTimestamps writer (server/ots.js).
 *
 * A proof that does not verify is worse than no proof: it looks like evidence and is
 * not. The real judge is the reference implementation, and it has judged — the bytes
 * this produces deserialize in python-opentimestamps, report the intended digest, and
 * carry the calendars' pending attestations. That check needs Python and the network,
 * so it lives in the notes (IMPLEMENTATION_NOTES.md §6i) rather than here.
 *
 * What is here is everything that can be checked offline: the varuint encoding, the
 * file header, how several calendars become several branches, and the behaviour when
 * calendars are slow or down — which is the case that decides whether a draw stops.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { stamp, varuint, MAGIC, CALENDARS } = require('../server/ots');

const BODY = Buffer.from('{"cutoff_utc":"2026-09-10T20:00:00Z","local_ids":[1,2,3]}\n');
const DIGEST = crypto.createHash('sha256').update(BODY).digest();

/** A calendar that answers with a recognisable branch. */
const answers = (tag) => async () => new Response(Buffer.from(tag), { status: 200 });

function calendarStub(plan) {
  return async (url) => {
    const key = Object.keys(plan).find((k) => url.includes(k));
    const entry = plan[key];
    if (typeof entry === 'function') return entry(url);
    throw new Error(`no stub for ${url}`);
  };
}

test('a varuint is seven bits a byte, high bit meaning more', () => {
  assert.deepEqual([...varuint(0)], [0x00]);
  assert.deepEqual([...varuint(1)], [0x01]);
  assert.deepEqual([...varuint(127)], [0x7f]);
  assert.deepEqual([...varuint(128)], [0x80, 0x01]);
  assert.deepEqual([...varuint(300)], [0xac, 0x02]);
});

test('the file is the magic, the version, the hash op, the digest, then the calendars', async () => {
  const out = await stamp(BODY, {
    calendars: ['https://one.example'],
    fetchImpl: calendarStub({ 'one.example': answers('BRANCH-ONE') }),
  });
  const head = out.ots.subarray(0, MAGIC.length);
  assert.deepEqual([...head], [...MAGIC], 'magic header');
  assert.equal(out.ots[MAGIC.length], 0x01, 'major version');
  assert.equal(out.ots[MAGIC.length + 1], 0x08, 'OpSHA256');
  const digest = out.ots.subarray(MAGIC.length + 2, MAGIC.length + 34);
  assert.deepEqual([...digest], [...DIGEST], 'the digest of the content, not of anything else');
  assert.equal(out.digest, DIGEST.toString('hex'));
  assert.equal(out.ots.subarray(MAGIC.length + 34).toString(), 'BRANCH-ONE');
});

test('several calendars become several branches, separated by the fork marker', async () => {
  // They are independent witnesses. One being unreachable on the day should cost the
  // others nothing, so each gets its own branch rather than all sharing one.
  const out = await stamp(BODY, {
    calendars: ['https://one.example', 'https://two.example', 'https://three.example'],
    fetchImpl: calendarStub({
      'one.example': answers('AAA'),
      'two.example': answers('BBB'),
      'three.example': answers('CCC'),
    }),
  });
  const tail = out.ots.subarray(MAGIC.length + 34);
  // 0xff before every branch but the last: ff AAA ff BBB CCC
  assert.equal(tail.toString('binary'), '\xffAAA\xffBBB' + 'CCC');
  assert.equal(out.calendars.length, 3);
  assert.deepEqual(out.failed, []);
});

test('one calendar answering is enough, and the others are reported', async () => {
  const out = await stamp(BODY, {
    calendars: ['https://up.example', 'https://down.example'],
    fetchImpl: calendarStub({
      'up.example': answers('OK'),
      'down.example': async () => new Response('nope', { status: 503 }),
    }),
  });
  assert.deepEqual(out.calendars, ['https://up.example']);
  assert.equal(out.failed.length, 1);
  assert.match(out.failed[0].error, /503/);
  // A single branch carries no fork marker.
  assert.equal(out.ots.subarray(MAGIC.length + 34).toString(), 'OK');
});

test('an empty answer is a failure, not a proof of nothing', async () => {
  // A zero-length body would append nothing, leaving a file whose timestamp commits to
  // no attestation at all — syntactically a proof, evidentially worthless.
  await assert.rejects(
    stamp(BODY, {
      calendars: ['https://empty.example'],
      fetchImpl: calendarStub({ 'empty.example': async () => new Response(Buffer.alloc(0), { status: 200 }) }),
    }),
    /no calendar could be reached/
  );
});

test('with every calendar down it throws, naming what happened', async () => {
  // The caller carries on: the digest published to the players does not depend on any
  // of this, and a draw must not stop because a calendar is having an afternoon.
  await assert.rejects(
    stamp(BODY, {
      calendars: ['https://a.example', 'https://b.example'],
      fetchImpl: async () => { throw new TypeError('fetch failed'); },
    }),
    (err) => {
      assert.match(err.message, /no calendar could be reached/);
      assert.match(err.message, /fetch failed/);
      return true;
    }
  );
});

test('the digest submitted is the digest of the content', async () => {
  // The reference client submits a nonced hash for privacy. This roll is published in
  // full moments later, so there is nothing to hide, and submitting the bare digest is
  // what makes the file verifiable against the published snapshot.json directly.
  let sent = null;
  await stamp(BODY, {
    calendars: ['https://one.example'],
    fetchImpl: async (url, init) => { sent = init.body; return new Response(Buffer.from('X'), { status: 200 }); },
  });
  assert.deepEqual([...sent], [...DIGEST]);
});

test('the default calendars are the public pools, and there is more than one', async () => {
  assert.ok(CALENDARS.length >= 3, 'a single calendar is a single point of failure');
  for (const c of CALENDARS) assert.match(c, /^https:/);
});
