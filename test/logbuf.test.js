'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const logbuf = require('../server/logbuf');

/**
 * The in-memory log the dashboard reads (server/logbuf.js).
 *
 * Three properties, and every one of them is a thing that goes wrong in production
 * rather than a thing that looks wrong in review: it must not swallow output, it must
 * not grow, and it must not put a secret somewhere new.
 */

/** Runs `fn` with capture on, and always detaches — a leaked tee breaks every later test. */
function captured(fn) {
  logbuf.reset();
  const detach = logbuf.attach();
  try { return fn(); } finally { detach(); logbuf.reset(); }
}

test('a captured line still reaches the real stream', () => {
  const seen = [];
  const real = process.stdout.write;
  process.stdout.write = (chunk) => { seen.push(String(chunk)); return true; };
  try {
    captured(() => { process.stdout.write('[server] listening\n'); });
  } finally {
    process.stdout.write = real;
  }
  assert.deepEqual(seen, ['[server] listening\n'],
    'capture must be a tee, not a diversion: journald and a terminal still get everything');
});

test('stdout and stderr are kept apart, because one of them means something', () => {
  const out = captured(() => {
    process.stdout.write('[server] phase -> open\n');
    process.stderr.write('[schedule] the final-round draw job exited 1\n');
    return logbuf.since(0);
  });
  assert.equal(out.lines.length, 2);
  assert.equal(out.lines[0].stream, 'out');
  assert.equal(out.lines[1].stream, 'err');
  assert.match(out.lines[1].text, /exited 1/);
});

test('one write of several lines is several lines, and blank ones are dropped', () => {
  const out = captured(() => {
    process.stdout.write('a\nb\n\n  \nc\n');
    return logbuf.since(0);
  });
  assert.deepEqual(out.lines.map((l) => l.text), ['a', 'b', 'c']);
  assert.deepEqual(out.lines.map((l) => l.seq), [1, 2, 3]);
});

test('since() returns only what is new, which is what makes polling cheap', () => {
  const [first, second, empty] = captured(() => {
    process.stdout.write('one\ntwo\n');
    const a = logbuf.since(0);
    process.stdout.write('three\n');
    const b = logbuf.since(a.last_seq);
    const c = logbuf.since(b.last_seq);
    return [a, b, c];
  });
  assert.deepEqual(first.lines.map((l) => l.text), ['one', 'two']);
  assert.deepEqual(second.lines.map((l) => l.text), ['three']);
  assert.deepEqual(empty.lines, [], 'a quiet second costs one empty response');
  assert.equal(empty.last_seq, 3);
});

test('the ring is bounded, and says so rather than pretending it was quiet', () => {
  // A job that loops printing must cost the same memory as one that does not. And a
  // client that was away longer than the ring cannot tell a gap from a silence, so the
  // gap has to be reported: those two look identical and mean opposite things.
  const { all, after } = captured(() => {
    for (let i = 1; i <= logbuf.MAX_LINES + 50; i++) process.stdout.write(`line ${i}\n`);
    return { all: logbuf.since(0), after: logbuf.since(10) };
  });
  assert.equal(all.lines.length, logbuf.MAX_LINES);
  assert.equal(all.lines[0].text, 'line 51', 'the oldest lines are the ones dropped');
  assert.equal(all.last_seq, logbuf.MAX_LINES + 50);
  assert.equal(after.dropped, 40, 'a reader last seen at seq 10 missed 40 lines');
  assert.equal(all.dropped, 0, 'a first read has missed nothing by definition');
});

test('a registered secret never enters the buffer', () => {
  // The dashboard can now show this log, and the admin token is the one string the
  // server holds that hands somebody the dashboard. Scrubbed on the way IN, so it is
  // never in memory to leak through a later bug.
  const out = captured(() => {
    logbuf.redact('s3cret-admin-token-value');
    process.stdout.write('[server] open /admin?token=s3cret-admin-token-value now\n');
    return logbuf.since(0);
  });
  assert.doesNotMatch(out.lines[0].text, /s3cret/);
  assert.match(out.lines[0].text, /«redacted»/);
});

test('a null or trivially short secret is not registered, or everything would match', () => {
  const out = captured(() => {
    logbuf.redact(null);
    logbuf.redact('ab');
    process.stdout.write('abc def\n');
    return logbuf.since(0);
  });
  assert.equal(out.lines[0].text, 'abc def');
});

test('terminal colour is stripped: the dashboard is not a terminal', () => {
  const out = captured(() => {
    process.stdout.write(`  ${'[32m'}OK${'[0m'}  locked\n`);
    return logbuf.since(0);
  });
  assert.equal(out.lines[0].text, '  OK  locked');
});

test('a very long line is truncated rather than stored whole', () => {
  const out = captured(() => {
    process.stdout.write(`${'x'.repeat(9000)}\n`);
    return logbuf.since(0);
  });
  assert.ok(out.lines[0].text.length < 9000);
  assert.match(out.lines[0].text, /…$/);
});

test('attaching twice does not tee the tee', () => {
  logbuf.reset();
  const first = logbuf.attach();
  const second = logbuf.attach();
  try {
    process.stdout.write('once\n');
    assert.equal(logbuf.since(0).lines.length, 1, 'a doubled tee would store every line twice');
  } finally {
    second(); first(); logbuf.reset();
  }
});
