'use strict';

/**
 * OpenTimestamps, with no dependencies (PROTOCOL.md §9).
 *
 * §9's attack is a player who never submits colluding with the organiser, who forges a
 * twelfth submission after the beacon lands and claims it arrived in time. The defence
 * is that the roll taken at the cutoff is fixed before the key exists, and the thing
 * that fixes it has to be outside the organiser's reach. That is what a timestamp
 * anchored in Bitcoin is: the organiser cannot move a block.
 *
 * The official JavaScript client would do this, and its dependency list is why it is not
 * used here: web3, bitcore-lib, a keccak binding that needs a compiler, and the
 * deprecated `request`. The server's only production dependency is tlock-js, and a
 * project whose argument rests on being auditable should not answer "can I read all of
 * this?" with fourteen transitive packages.
 *
 * What is implemented is the smallest correct subset: stamp one digest against the
 * public calendars and write a .ots file that the standard `ots verify` accepts. No
 * verification, no upgrading, no Bitcoin — those are what the reader does with their own
 * client, and doing them here would be this program marking its own homework.
 *
 * The format (github.com/opentimestamps/python-opentimestamps, serialize.py):
 *
 *   <magic> <version varint> <file-hash op> <32-byte digest> <timestamp>
 *
 * where a timestamp is a sequence of operations on the current message, ending in
 * attestations. Several branches from one message are separated by 0xff. An attestation
 * is 0x00, an 8-byte tag, then its payload as varbytes. The calendars return exactly the
 * branch that follows our digest, so the file is a header and their answer.
 */

const crypto = require('node:crypto');

// "\x00OpenTimestamps\x00\x00Proof\x00\xbf\x89\xe2\xe8\x84\xe8\x92\x94"
const MAGIC = Buffer.from(
  '004f70656e54696d657374616d7073000050726f6f6600bf89e2e884e89294',
  'hex'
);
const MAJOR_VERSION = 1;
const OP_SHA256 = 0x08;

/** The public calendars the reference client uses by default. */
const CALENDARS = [
  'https://a.pool.opentimestamps.org',
  'https://b.pool.opentimestamps.org',
  'https://a.pool.eternitywall.com',
  'https://ots.btc.catallaxy.com',
];

/** Protocol varuint: seven bits a byte, high bit means "more to come". */
function varuint(n) {
  const out = [];
  let v = n;
  for (;;) {
    const b = v & 0x7f;
    v = Math.floor(v / 128);
    out.push(v === 0 ? b : b | 0x80);
    if (v === 0) break;
  }
  return Buffer.from(out);
}

/**
 * Ask one calendar to stamp a digest.
 *
 * The reply is the serialized timestamp for exactly the digest submitted: the operations
 * the calendar applied on top of it, ending in a pending attestation naming where the
 * upgraded proof will be found. It is opaque to us and is copied into the file as is.
 */
async function submitToCalendar(url, digest, { timeoutMs = 10_000, fetchImpl = fetch } = {}) {
  const res = await fetchImpl(`${url.replace(/\/+$/, '')}/digest`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/vnd.opentimestamps.v1',
      'user-agent': 'mahjong-random-seating',
    },
    body: digest,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  const body = Buffer.from(await res.arrayBuffer());
  if (body.length === 0) throw new Error(`${url} returned an empty timestamp`);
  return body;
}

/**
 * Stamp a buffer. Returns the .ots bytes and which calendars answered.
 *
 * Every calendar that answers becomes a separate branch, because they are independent
 * witnesses and one being unreachable on the day should not cost the others. Branches
 * from the same message are written back to back with 0xff before each but the last.
 *
 * Best-effort by design: with no calendar reachable this throws, and the caller is
 * expected to carry on. The digest published to the players is the part that must not
 * depend on anyone else being up.
 */
async function stamp(content, opts = {}) {
  const digest = crypto.createHash('sha256').update(content).digest();
  const calendars = opts.calendars || CALENDARS;

  const settled = await Promise.allSettled(
    calendars.map((url) => submitToCalendar(url, digest, opts).then((branch) => ({ url, branch })))
  );
  const ok = settled.filter((r) => r.status === 'fulfilled').map((r) => r.value);
  const failed = settled
    .map((r, i) => (r.status === 'rejected' ? { url: calendars[i], error: r.reason.message } : null))
    .filter(Boolean);

  if (ok.length === 0) {
    throw new Error(`no calendar could be reached: ${failed.map((f) => f.error).join('; ')}`);
  }

  const parts = [MAGIC, varuint(MAJOR_VERSION), Buffer.from([OP_SHA256]), digest];
  ok.forEach((c, i) => {
    if (i < ok.length - 1) parts.push(Buffer.from([0xff]));
    parts.push(c.branch);
  });

  return {
    ots: Buffer.concat(parts),
    digest: digest.toString('hex'),
    calendars: ok.map((c) => c.url),
    failed,
  };
}

module.exports = { stamp, CALENDARS, varuint, MAGIC };
