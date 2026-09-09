'use strict';

/**
 * The bytes in a checkout must be the bytes that were committed.
 *
 * Everything the freeze promises rests on that and nothing checks it, because it is not
 * a property of any code in this repository — it is a property of how git is configured
 * on the machine doing the checkout.
 *
 * It was not true here. The blob for public/app.js is 347717 bytes with no CR; a fresh
 * clone on Windows with default settings (core.autocrlf=true) checked it out at 347738
 * bytes with 21 CRs, and `build-client.js --verify-hash` refused it. That command is
 * what deploy/README.md has the VPS run, and what a participant runs to confirm that the
 * code handling their number is the code that was tagged. A mismatch there reads as
 * tampering, not as a line-ending setting.
 *
 * .gitattributes fixes it. This is what stops it being quietly deleted or narrowed.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const attributes = fs.readFileSync(path.join(ROOT, '.gitattributes'), 'utf8');

/** Files whose exact bytes are pinned somewhere a mismatch would be read as tampering. */
const BYTE_PINNED = [
  'public/app.js',
  'public/app.css',
  'public/app.js.sha256',
  'generate.js',
];

test('every byte-pinned artefact is exempt from line-ending translation', () => {
  for (const f of BYTE_PINNED) {
    const line = attributes.split('\n').find((l) => l.trim().startsWith(f));
    assert.ok(line, `${f} has no .gitattributes rule — a CRLF checkout would break its digest`);
    assert.match(line, /-text/, `${f} must be marked -text`);
  }
  // The frozen data artefacts are matched by a glob rather than named one by one.
  assert.match(attributes, /^data\/\*\.json\s+-text$/m);
});

test('the repository defaults to LF in the working tree, not just in the object store', () => {
  // eol=lf is what makes a Windows clone come out byte-identical to a Linux one. Without
  // it, `* text=auto` alone still normalises on commit but converts on checkout.
  assert.match(attributes, /^\*\s+text=auto\s+eol=lf$/m);
});

test('the committed bundle hashes to its committed digest', () => {
  // The same comparison build-client.js --verify-hash makes, run on every test run
  // rather than only when someone remembers. In a working tree this passes trivially;
  // in CI, or on a checkout, it is the whole question.
  const js = fs.readFileSync(path.join(ROOT, 'public', 'app.js'));
  const css = fs.readFileSync(path.join(ROOT, 'public', 'app.css'));
  const digest = crypto.createHash('sha256').update(Buffer.concat([js, css])).digest('hex');
  const committed = fs.readFileSync(path.join(ROOT, 'public', 'app.js.sha256'), 'utf8')
    .trim().split(/\s+/)[0];
  assert.equal(digest, committed,
    'public/app.js + app.css do not hash to public/app.js.sha256 — either the bundle was ' +
    'rebuilt without updating the hash, or this checkout translated line endings');
});

test('no byte-pinned artefact carries a CR', () => {
  // The failure mode is invisible: the file still parses, still runs, still looks right
  // in an editor. Only the digest changes.
  for (const f of BYTE_PINNED) {
    const buf = fs.readFileSync(path.join(ROOT, f));
    const crs = buf.reduce((n, b) => n + (b === 0x0d ? 1 : 0), 0);
    assert.equal(crs, 0, `${f} contains ${crs} CR bytes; its digest will not match a LF checkout`);
  }
});
