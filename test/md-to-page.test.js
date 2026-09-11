'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { render } = require('../tools/md-to-page');
const { ROOT } = require('./helpers');

const read = (name) => fs.readFileSync(path.join(ROOT, 'docs', name), 'utf8');

/**
 * The explanation page is generated from the document, not written beside it, so these
 * tests are really about one property: what the renderer cannot do, it must refuse to
 * do loudly. A markdown renderer that drops a construct it does not recognise turns a
 * paragraph of the argument for why the draw cannot be steered into white space, and
 * nobody notices until a player asks about the missing step.
 */

test('the real document renders, and every section becomes a heading with an id', () => {
  const doc = render(read('seating-design.md'));
  assert.equal(doc.title, 'How the Seating Chart Was Built');
  assert.ok(doc.sections.length >= 8, `expected the document's sections, got ${doc.sections.length}`);
  for (const s of doc.sections) {
    assert.ok(s.id && s.title, 'a section needs both an id and a title');
    assert.ok(doc.html.includes(`id="${s.id}"`), `no heading carries id ${s.id}`);
  }
});

test('the two language versions have not drifted apart', () => {
  const en = render(read('seating-design.md'));
  const zh = render(read('seating-design.zh.md'));
  const count = (html, re) => (html.match(re) || []).length;

  assert.equal(zh.sections.length, en.sections.length, 'one version has gained or lost a section');
  assert.equal(count(zh.html, /<figure>/g), count(en.html, /<figure>/g), 'a figure is missing from one version');
  assert.equal(count(zh.html, /class="flow"/g), count(en.html, /class="flow"/g), 'a diagram is missing from one version');
  assert.equal(count(zh.html, /<table/g), count(en.html, /<table/g), 'the template table is missing from one version');
  // Every figure in one must be the same figure in the other: the caption is translated,
  // the picture is not.
  const srcs = (html) => (html.match(/src="([^"]+)"/g) || []).sort();
  assert.deepEqual(srcs(zh.html), srcs(en.html), 'the versions point at different figures');
});

test('a figure keeps the caption that follows it', () => {
  const doc = render('# T\n\n![alt text](figures/x.svg)\n\n*the caption*\n');
  assert.match(doc.html, /<figure><img src="\/figures\/x\.svg" alt="alt text"[^>]*\/><figcaption>the caption<\/figcaption><\/figure>/);
});

test('an italic paragraph that follows no figure stays a paragraph', () => {
  const doc = render('# T\n\n*just emphasis*\n');
  assert.match(doc.html, /<p><em>just emphasis<\/em><\/p>/);
});

test('an asterisk inside a code span is not emphasis', () => {
  const doc = render('# T\n\nuse `a * b` and **this** together.\n');
  assert.match(doc.html, /<code>a \* b<\/code>/);
  assert.match(doc.html, /<strong>this<\/strong>/);
});

test('markup in the document is escaped, not executed', () => {
  const doc = render('# T\n\na <script>alert(1)</script> and an & ampersand.\n');
  assert.ok(!doc.html.includes('<script>'), 'a script tag survived');
  assert.match(doc.html, /&lt;script&gt;/);
  assert.match(doc.html, /&amp; ampersand/);
});

test('a mermaid chain becomes its steps, in order', () => {
  const doc = render('# T\n\n```mermaid\nflowchart LR\n  A["first"] --> B["second"]\n  B --> C["third"]\n```\n');
  const steps = [...doc.html.matchAll(/<span class="flow-step">([^<]*)<\/span>/g)].map((m) => m[1]);
  assert.deepEqual(steps, ['first', 'second', 'third']);
});

test('a line break inside a node label survives, because it carries the citation', () => {
  const doc = render('# T\n\n```mermaid\nflowchart TB\n  A["claim<br/>source, 2001"] --> B["next"]\n```\n');
  assert.match(doc.html, /claim<br \/>source, 2001/);
});

test('a mermaid diagram that is not a chain is refused, not dropped', () => {
  const branching = '# T\n\n```mermaid\nflowchart TB\n  A["a"] --> B["b"]\n  A --> C["c"]\n```\n';
  assert.throws(() => render(branching), /not a chain/);
});

test('an unterminated code fence is refused', () => {
  assert.throws(() => render('# T\n\n```\nnever closed\n'), /unterminated/);
});

test('a document with no H1 is refused', () => {
  assert.throws(() => render('some prose with no title\n'), /no H1/);
});

test('a pipe table becomes a table with a row header', () => {
  const doc = render('# T\n\n| Round | E |\n|---|---|\n| 1 | 0 |\n');
  assert.match(doc.html, /<th scope="col">Round<\/th>/);
  assert.match(doc.html, /<th scope="row">1<\/th><td>0<\/td>/);
});

test('a link out of the document opens in a new tab; a relative one does not', () => {
  const doc = render('# T\n\n[out](https://example.com) and [in](#anchor)\n');
  assert.match(doc.html, /<a href="https:\/\/example\.com" target="_blank" rel="noreferrer">out<\/a>/);
  assert.match(doc.html, /<a href="#anchor">in<\/a>/);
});

test('a javascript: href is defused', () => {
  const doc = render('# T\n\n[click](javascript:alert(1))\n');
  assert.ok(!doc.html.includes('javascript:'), 'a javascript: href survived');
  assert.match(doc.html, /<a href="#">click<\/a>/);
});
