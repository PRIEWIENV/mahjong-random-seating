'use strict';

/**
 * The exclusion roll-call (PROTOCOL.md §4.3, IMPLEMENTATION_NOTES 2).
 *
 * `results.json` now reproduces byte for byte with no carve-out, which means
 * `excluded_local_ids` is inside the claim rather than annotated onto it. That is
 * necessary but not sufficient: `--verify` recomputes FROM the file, so a file that
 * omits a player from both `revealed` and `excluded_local_ids` is still perfectly
 * self-consistent. events/snapshot.json is what makes that detectable, and these tests
 * pin both halves.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { generate, serialise, normaliseExcluded, rollCall } = require('../generate');
const { ROOT, makeRoster, makeProtocol, makeDecrypted, template, SAMPLE_SIG } = require('./helpers');

const TEMPLATE = template();
const roster = makeRoster();
const protocol = makeProtocol();

const base = (over = {}) => ({
  decrypted: makeDecrypted(12), roster, protocol, template: TEMPLATE, signature: SAMPLE_SIG, ...over,
});

// ---------------------------------------------------------------------------
// excluded_local_ids is produced by generate.js, not attached afterwards
// ---------------------------------------------------------------------------

test('excluded_local_ids is always present, empty list included', () => {
  const r = generate(base());
  // A conditional key would make "nobody was excluded" and "the field was dropped"
  // indistinguishable in the published file.
  assert.deepEqual(r.excluded_local_ids, []);
  assert.ok('excluded_local_ids' in r);
});

test('exclusions are canonically ordered, so two honest runs agree', () => {
  const r = generate(base({
    decrypted: makeDecrypted(10),
    excluded: [{ local_id: 12, reason: 'b' }, { local_id: 11, reason: 'a' }],
  }));
  assert.deepEqual(r.excluded_local_ids, [
    { local_id: 11, reason: 'a' },
    { local_id: 12, reason: 'b' },
  ]);
});

test('a local_id cannot be both a participant and excluded', () => {
  assert.throws(
    () => generate(base({ excluded: [{ local_id: 1, reason: 'nope' }] })),
    /both a participant and excluded/
  );
});

test('an exclusion outside the roster is refused', () => {
  assert.throws(
    () => generate(base({ decrypted: makeDecrypted(11), excluded: [{ local_id: 99, reason: 'x' }] })),
    /not in roster\.json/
  );
});

test('an exclusion without a reason is refused', () => {
  assert.throws(
    () => generate(base({ decrypted: makeDecrypted(11), excluded: [{ local_id: 12 }] })),
    /no reason/
  );
  assert.throws(
    () => generate(base({ decrypted: makeDecrypted(11), excluded: [{ local_id: 12, reason: '  ' }] })),
    /no reason/
  );
});

test('the same local_id cannot be excluded twice', () => {
  assert.throws(
    () => normaliseExcluded(
      [{ local_id: 12, reason: 'a' }, { local_id: 12, reason: 'b' }], [1], roster
    ),
    /twice/
  );
});

test('exclusions do not enter the seed — they took no part in R', () => {
  const clean = generate(base({ decrypted: makeDecrypted(10) }));
  const withExclusions = generate(base({
    decrypted: makeDecrypted(10),
    excluded: [{ local_id: 11, reason: 'x' }, { local_id: 12, reason: 'y' }],
  }));
  assert.equal(withExclusions.seed, clean.seed);
  assert.deepEqual(withExclusions.permutation, clean.permutation);
});

// ---------------------------------------------------------------------------
// the roll-call against the published snapshot
// ---------------------------------------------------------------------------

const snapshotOf = (ids) => ({
  cutoff_utc: protocol.submission_cutoff_utc,
  local_ids: ids,
});

test('a results.json that accounts for every submission passes the roll-call', () => {
  const r = generate(base({
    decrypted: makeDecrypted(10),
    excluded: [{ local_id: 11, reason: 'x' }, { local_id: 12, reason: 'y' }],
  }));
  const rc = rollCall(r, snapshotOf([1,2,3,4,5,6,7,8,9,10,11,12]), protocol);
  assert.ok(rc.ok, rc.lines.join('\n'));
  assert.match(rc.lines[0], /12 submitted at the cutoff = 10 participating \+ 2 excluded/);
});

test('a player dropped from BOTH lists is caught — the byte check cannot see it', () => {
  // The scenario the byte-for-byte comparison is blind to: player 12 submitted, and
  // results.json simply does not mention them anywhere. Recomputing from the file's own
  // revealed payloads reproduces perfectly; only the snapshot shows the omission.
  const r = generate(base({ decrypted: makeDecrypted(11) }));
  assert.equal(serialise(r), serialise(generate(base({
    decrypted: makeDecrypted(11), excluded: r.excluded_local_ids,
  }))), 'the doctored file is internally self-consistent');

  const rc = rollCall(r, snapshotOf([1,2,3,4,5,6,7,8,9,10,11,12]), protocol);
  assert.equal(rc.ok, false);
  assert.match(rc.lines.join('\n'), /accounted for nowhere: 12/);
});

test('a participant who never submitted is caught too', () => {
  const r = generate(base());
  const rc = rollCall(r, snapshotOf([1,2,3,4,5,6,7,8,9,10,11]), protocol);
  assert.equal(rc.ok, false);
  assert.match(rc.lines.join('\n'), /not in the snapshot: 12/);
});

test('a snapshot from a different run is refused rather than compared', () => {
  const r = generate(base());
  const wrong = { cutoff_utc: '2020-01-01T00:00:00Z', local_ids: [1,2,3,4,5,6,7,8,9,10,11,12] };
  const rc = rollCall(r, wrong, protocol);
  assert.equal(rc.ok, false);
  assert.match(rc.lines.join('\n'), /snapshot is for cutoff/);
});

// ---------------------------------------------------------------------------
// the CLI, end to end
// ---------------------------------------------------------------------------

function scratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mahjong-rc-'));
  fs.mkdirSync(path.join(dir, 'data'));
  fs.mkdirSync(path.join(dir, 'events'));
  fs.writeFileSync(path.join(dir, 'data', 'roster.json'), JSON.stringify(roster, null, 2));
  fs.writeFileSync(path.join(dir, 'data', 'protocol.json'), JSON.stringify(protocol, null, 2));
  return dir;
}

const runVerify = (dir, extra = []) => {
  const args = [
    path.join(ROOT, 'generate.js'), '--verify', path.join(dir, 'results.json'),
    '--roster', path.join(dir, 'data', 'roster.json'),
    '--protocol', path.join(dir, 'data', 'protocol.json'),
    '--template', path.join(ROOT, 'data', 'schedule_template.json'),
    ...extra,
  ];
  try {
    return { code: 0, out: execFileSync(process.execPath, args, { encoding: 'utf8' }) };
  } catch (err) {
    return { code: err.status, out: (err.stdout || '') + (err.stderr || '') };
  }
};

test('--verify covers the whole file, with no fields set aside', () => {
  const dir = scratch();
  const r = generate(base({
    decrypted: makeDecrypted(10),
    excluded: [{ local_id: 11, reason: 'x' }, { local_id: 12, reason: 'y' }],
  }));
  fs.writeFileSync(path.join(dir, 'results.json'), serialise(r));
  fs.writeFileSync(path.join(dir, 'events', 'snapshot.json'),
    JSON.stringify(snapshotOf([1,2,3,4,5,6,7,8,9,10,11,12]), null, 2));

  const { code, out } = runVerify(dir);
  assert.equal(code, 0, out);
  assert.match(out, /the whole file, no fields set aside/);
  assert.match(out, /12 submitted at the cutoff = 10 participating \+ 2 excluded/);
  assert.doesNotMatch(out, /not covered/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('--verify finds the snapshot beside results.json without being told', () => {
  const dir = scratch();
  fs.writeFileSync(path.join(dir, 'results.json'), serialise(generate(base())));
  fs.writeFileSync(path.join(dir, 'events', 'snapshot.json'),
    JSON.stringify(snapshotOf([1,2,3,4,5,6,7,8,9,10,11,12]), null, 2));
  const { code, out } = runVerify(dir);
  assert.equal(code, 0, out);
  assert.match(out, /12 submitted at the cutoff = 12 participating \+ 0 excluded/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('--verify says so, loudly, when there is no snapshot to check against', () => {
  const dir = scratch();
  fs.writeFileSync(path.join(dir, 'results.json'), serialise(generate(base())));
  const { code, out } = runVerify(dir);
  // Still a valid answer to "does this file reproduce", so not a failure — but the
  // reader must not come away thinking the roll-call was checked.
  assert.equal(code, 0, out);
  assert.match(out, /roll-call NOT checked/);
  assert.match(out, /nothing here\s+shows that list is complete/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('--verify exits non-zero when the roll-call does not add up', () => {
  const dir = scratch();
  fs.writeFileSync(path.join(dir, 'results.json'), serialise(generate(base({ decrypted: makeDecrypted(11) }))));
  fs.writeFileSync(path.join(dir, 'events', 'snapshot.json'),
    JSON.stringify(snapshotOf([1,2,3,4,5,6,7,8,9,10,11,12]), null, 2));
  const { code, out } = runVerify(dir);
  assert.equal(code, 1);
  assert.match(out, /FAIL {2}roll-call/);
  assert.match(out, /accounted for nowhere: 12/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a tampered seat plan still fails the byte comparison', () => {
  const dir = scratch();
  const r = generate(base());
  r.permutation = [...r.permutation].reverse();
  fs.writeFileSync(path.join(dir, 'results.json'), serialise(r));
  const { code, out } = runVerify(dir);
  assert.equal(code, 1);
  assert.match(out, /does NOT reproduce/);
  fs.rmSync(dir, { recursive: true, force: true });
});
