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

/**
 * The other thing a checkout can change: the case of a name.
 *
 * NTFS and APFS are case-insensitive, so on the machine this was written on
 * `client/app.jsx` and `client/App.jsx` are the same file and every spelling works.
 * Linux disagrees, and CI is Linux. A test that read `client/app.jsx` passed here for as
 * long as it took to push, then failed on the runner with ENOENT on a file that is
 * plainly there — which reads as a broken checkout rather than as a typo.
 *
 * Underneath it the working tree had drifted from the index: git recorded `App.jsx`,
 * the directory entry said `app.jsx`, and with core.ignorecase on nothing showed in
 * `git status`. So there are two checks here, because there are two ways to get it
 * wrong: a name on disk that git spells differently, and a name in source that git
 * spells differently. Only the index is authoritative — it is what a runner checks out.
 */

const { execFileSync } = require('node:child_process');

/** Paths as git records them, or null when this is not a git checkout. */
function trackedFiles() {
  try {
    return execFileSync('git', ['ls-files', '-z'], {
      cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).split('\0').filter(Boolean);
  } catch {
    return null;  // an export rather than a clone, or no git — not a failure
  }
}

test('every tracked file is on disk under exactly the name git records', (t) => {
  const tracked = trackedFiles();
  if (!tracked) return t.skip('not a git checkout');

  // readdir reports the real directory entry, which is where the drift shows. Cached per
  // directory: this walks the whole index.
  const entries = new Map();
  const listing = (dir) => {
    if (!entries.has(dir)) {
      try { entries.set(dir, new Set(fs.readdirSync(path.join(ROOT, dir)))); }
      catch { entries.set(dir, null); }
    }
    return entries.get(dir);
  };

  const wrong = [];
  for (const rel of tracked) {
    const dir = path.posix.dirname(rel) === '.' ? '' : path.posix.dirname(rel);
    const base = path.posix.basename(rel);
    const names = listing(dir);
    if (!names || names.has(base)) continue;
    // Absent entirely is a deleted file, which `git status` already reports. Present
    // under another case is the one this test exists for.
    const other = [...names].find((n) => n.toLowerCase() === base.toLowerCase());
    if (other) wrong.push(`${rel} is on disk as ${dir ? dir + '/' : ''}${other}`);
  }
  assert.deepEqual(wrong, [],
    'the working tree spells these differently from the index; a Linux checkout gets ' +
    'the index spelling, so anything opening the name you see here will not find it');
});

test('no source file opens a repository path by a name git spells differently', (t) => {
  const tracked = trackedFiles();
  if (!tracked) return t.skip('not a git checkout');

  const exact = new Set(tracked);
  const byLower = new Map(tracked.map((f) => [f.toLowerCase(), f]));

  // Two shapes reach a file: one literal holding the whole path, and a call whose
  // arguments are joined — read('client', 'App.jsx'), path.join(ROOT, 'docs', 'x.md').
  const TOP = '(?:client|server|tools|data|test|docs|public|deploy)';
  const WHOLE = new RegExp(`['"](${TOP}/[A-Za-z0-9_./-]+\.[A-Za-z0-9]+)['"]`, 'g');
  const CALL = /[A-Za-z_$][\w$.]*\s*\(([^()]*)\)/g;
  const ARG = /'([^']*)'|"([^"]*)"/g;

  const sources = tracked.filter((f) => /\.(js|jsx)$/.test(f) && !f.startsWith('public/'));
  const wrong = [];
  const check = (where, p) => {
    const rel = p.replace(/^\.\//, '').replace(/^(?:\.\.\/)+/, '');
    if (exact.has(rel)) return;
    const spelt = byLower.get(rel.toLowerCase());
    if (spelt) wrong.push(`${where}: "${p}" — git tracks ${spelt}`);
  };

  for (const f of sources) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    for (const m of src.matchAll(WHOLE)) check(f, m[1]);
    for (const m of src.matchAll(CALL)) {
      const args = [...m[1].matchAll(ARG)].map((a) => a[1] ?? a[2]).filter((a) => a !== '');
      if (args.length > 1) check(f, args.join('/'));
    }
  }
  assert.deepEqual(wrong, [],
    'these open a file by a spelling the index does not use; it works on a ' +
    'case-insensitive filesystem and is ENOENT on Linux');
});
