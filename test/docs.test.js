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

/**
 * Generated, and legal text rather than prose: translating a licence would be claiming
 * that the translation is the licence, which it is not. It is excluded by name so that
 * adding a second generated file does not silently widen the exemption.
 */
const NOT_A_DOCUMENT = new Set(['THIRD-PARTY-NOTICES.md']);

test('no markdown document is left out of the pairing', () => {
  const listed = new Set([...PAIRS.flat(), ...NOT_A_DOCUMENT]);
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
 * The bundle is committed, so this repository redistributes every library inside it in
 * binary form, and MIT and BSD-3-Clause both ask for their notices to travel with that.
 * `tools/build-client.js` regenerates the file from esbuild's metafile; this checks the
 * committed copy has not fallen behind the committed bundle — which is the state a
 * checkout would be in if somebody added a dependency and did not rebuild.
 */
test('every library in the committed bundle has its notice reproduced', () => {
  const notices = read('THIRD-PARTY-NOTICES.md');
  // The four that are imported by name in the client; the rest arrive transitively and
  // are exactly what the generator exists to catch.
  for (const name of ['react', 'react-dom', 'tlock-js', 'buffer']) {
    assert.ok(notices.includes(`## ${name} `), `THIRD-PARTY-NOTICES.md does not cover ${name}`);
  }
  // ieee754 is the one package here that is not MIT, and its second condition names
  // binary redistribution explicitly. If it ever drops out of the file, that is the row
  // worth failing on.
  assert.ok(notices.includes('## ieee754 '), 'the BSD-3-Clause notice is missing');
  assert.ok(notices.includes('Redistributions in binary form'), 'the BSD conditions are not reproduced');

  // Every row of the summary table must have a section with its text underneath.
  const rows = [...notices.matchAll(/^\| `([^`]+)` \| ([^|]+) \|/gm)].map((m) => m[1]);
  assert.ok(rows.length >= 15, `expected the full bundle, got ${rows.length} rows`);
  for (const name of rows) {
    assert.ok(notices.includes(`## ${name} `), `${name} is listed but its licence text is missing`);
  }
});

test('the licence file exists and agrees with package.json', () => {
  const licence = read('LICENSE');
  assert.match(licence, /^MIT License/, 'LICENSE does not open as MIT');
  assert.match(licence, /Copyright \(c\) \d{4}/, 'LICENSE carries no copyright line');
  assert.equal(require('../package.json').license, 'MIT', 'package.json disagrees with LICENSE');
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

/**
 * A deployment document cannot know your tag, so it must not print one.
 *
 * `git checkout frozen-v1` sat in the install block as a copyable line. There is no tag
 * called that and there never was: RUNBOOK step 11 creates one under whatever name the
 * organiser chooses, on a different machine. A new operator following the document
 * top to bottom stopped on the second line with "pathspec 'frozen-v1' did not match",
 * and nothing above it said the freeze was a prerequisite at all.
 *
 * The rule is the narrow one that was actually broken: where a document tells somebody
 * to check something out, the thing checked out is a placeholder.
 */
test('no deployment document checks out a tag name it invented', () => {
  for (const rel of ['deploy/README.md', 'deploy/README.zh.md', 'docs/RUNBOOK.md', 'docs/RUNBOOK.zh.md']) {
    for (const m of read(rel).matchAll(/git checkout +(\S+)/g)) {
      assert.match(m[1], /^<.+>$/,
        `${rel} says "git checkout ${m[1]}" — that name exists only on the machine that froze it`);
    }
  }
});

/**
 * The install block has to survive being run in order on a fresh clone, and `chmod 600
 * .env` cannot: at that point there is no .env. It failed with "cannot access '.env'"
 * two lines after the checkout that had already failed. It belongs beside the section
 * that writes the file.
 */
test('the deploy documents protect .env only after writing it', () => {
  for (const rel of ['deploy/README.md', 'deploy/README.zh.md']) {
    const text = read(rel);
    const chmod = text.indexOf('chmod 600 .env');
    assert.ok(chmod > 0, `${rel} never tells anyone to protect .env`);
    const written = text.indexOf('ADMIN_TOKEN=');
    assert.ok(written > 0 && chmod > written,
      `${rel} tells you to chmod .env before it tells you how to write it`);
  }
});

/** Every document that is part of the reading order, in both languages. */
const DOCS = PAIRS.flat();

/**
 * A cross-reference that does not resolve is worse than no cross-reference: it is an
 * instruction to go somewhere, and the reader who follows it is the one who most needed
 * the answer. Cheap to check and easy to break, since half of these links cross a
 * directory boundary and the other half do not.
 */
test('every relative link between documents resolves', () => {
  const broken = [];
  for (const rel of DOCS) {
    for (const m of read(rel).matchAll(/\]\(([^)\s]+)\)/g)) {
      const target = m[1];
      if (/^(https?:|mailto:|#)/.test(target)) continue;
      const [file] = target.split('#');
      if (!file) continue;
      if (!fs.existsSync(path.resolve(path.dirname(path.join(ROOT, rel)), file))) {
        broken.push(`${rel} -> ${target}`);
      }
    }
  }
  assert.deepEqual(broken, [], `dangling links:\n  ${broken.join('\n  ')}`);
});

/**
 * The one piece of ordering an operator cannot derive from either document alone.
 *
 * Deployment is a step inside the runbook, between B and C, because RUNBOOK step 11
 * creates the tag that deploy/README §1 checks out. Neither document said so, and a new
 * operator who opened the deployment document first got as far as its second line.
 * Both directions, so whichever one they land on carries the other.
 */
test('the runbook and the deployment document each point at the other', () => {
  for (const [runbook, deploy] of [
    ['docs/RUNBOOK.md', 'deploy/README.md'],
    ['docs/RUNBOOK.zh.md', 'deploy/README.zh.md'],
  ]) {
    assert.ok(read(runbook).includes(`../${deploy}`),
      `${runbook} never says where deployment happens`);
    assert.ok(read(deploy).includes(`../${runbook}`),
      `${deploy} never sends the reader to the checklist it is a step of`);
  }
});

/**
 * In-page anchors break silently when a heading is renamed, and both READMEs carry a
 * contents line made entirely of them. Renaming "Quick start" to "Start here" broke one
 * in each language, in the same commit that wrote the new section.
 */
test('every in-page anchor points at a heading that exists', () => {
  const slug = (h) => h.toLowerCase().replace(/[^\w一-鿿\- ]/g, '').trim().replace(/ +/g, '-');
  const broken = [];
  for (const rel of DOCS) {
    const text = read(rel);
    const headings = [...text.matchAll(/^#{2,6} (.+)$/gm)].map((m) => slug(m[1]));
    for (const m of text.matchAll(/\]\(#([^)]+)\)/g)) {
      if (!headings.includes(m[1])) broken.push(`${rel} -> #${m[1]}`);
    }
  }
  assert.deepEqual(broken, [], `dangling anchors:\n  ${broken.join('\n  ')}`);
});
