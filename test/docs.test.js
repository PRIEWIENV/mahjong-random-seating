'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { ROOT } = require('./helpers');

/**
 * Every document a developer or an operator is expected to read exists in both
 * languages, and each one points at the other.
 *
 * This is a structural check, not a translation check — nothing here can tell you the
 * Chinese says what the English says. What it can tell you is that a new document, or a
 * renamed one, did not quietly leave half the readership behind, which is the failure
 * mode that actually happens: someone adds `docs/SOMETHING.md`, nobody notices for a
 * month, and by then it is a translation job rather than a paragraph.
 *
 * `test/md-to-page.test.js` carries the stronger check for the one document that is
 * rendered into the app, where the two versions must agree section for section.
 */

const PAIRS = [
  ['README.md', 'README.zh.md'],
  ['docs/PROTOCOL.md', 'docs/PROTOCOL.zh.md'],
  ['docs/UI-SPEC.md', 'docs/UI-SPEC.zh.md'],
  ['docs/RUNBOOK.md', 'docs/RUNBOOK.zh.md'],
  ['docs/PANTHEON-INTEGRATION.md', 'docs/PANTHEON-INTEGRATION.zh.md'],
  ['docs/IMPLEMENTATION_NOTES.md', 'docs/IMPLEMENTATION_NOTES.zh.md'],
  ['docs/seating-design.md', 'docs/seating-design.zh.md'],
  ['deploy/README.md', 'deploy/README.zh.md'],
];

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('every document exists in both languages', () => {
  for (const [en, zh] of PAIRS) {
    assert.ok(fs.existsSync(path.join(ROOT, en)), `${en} is missing`);
    assert.ok(fs.existsSync(path.join(ROOT, zh)), `${zh} is missing — ${en} has no translation`);
  }
});

test('no markdown document is left out of the pairing', () => {
  const listed = new Set(PAIRS.flat());
  const found = [];
  for (const dir of ['docs', 'deploy', '.']) {
    const abs = path.join(ROOT, dir);
    for (const f of fs.readdirSync(abs)) {
      if (!f.endsWith('.md')) continue;
      found.push(dir === '.' ? f : `${dir}/${f}`);
    }
  }
  const orphans = found.filter((f) => !listed.has(f));
  assert.deepEqual(orphans, [], `these documents are in neither column: ${orphans.join(', ')}`);
});

test('each document links to its counterpart', () => {
  for (const [en, zh] of PAIRS) {
    const enText = read(en);
    const zhText = read(zh);
    const enName = path.basename(en);
    const zhName = path.basename(zh);
    assert.ok(enText.includes(`(${zhName})`), `${en} does not link to ${zhName}`);
    assert.ok(zhText.includes(`(${enName})`), `${zh} does not link to ${enName}`);
  }
});

test('the implementation notes keep the same section numbering in both languages', () => {
  const numbers = (text) => (text.match(/^## [0-9]+[a-z]?\./gm) || []);
  const en = numbers(read('docs/IMPLEMENTATION_NOTES.md'));
  const zh = numbers(read('docs/IMPLEMENTATION_NOTES.zh.md'));
  assert.ok(en.length > 10, 'the English notes lost their numbered sections');
  assert.deepEqual(zh, en, 'the two versions of the implementation notes have diverged');
});

/**
 * The freeze is a promise about four files, and the README states it. If that list ever
 * grows in the code without growing here, the document players are pointed at is wrong
 * about the thing it exists to describe.
 */
test('both READMEs name the same four frozen artefacts', () => {
  const { FROZEN } = require('../tools/freeze');
  for (const rel of ['README.md', 'README.zh.md']) {
    const text = read(rel);
    for (const f of FROZEN) {
      const name = path.basename(f);
      assert.ok(text.includes(name), `${rel} does not mention the frozen ${name}`);
    }
  }
});
