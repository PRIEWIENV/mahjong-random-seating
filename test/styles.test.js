'use strict';

/**
 * One stylesheet invariant, because one stylesheet bug got through every other kind of
 * test here and was only ever visible to someone looking at the page.
 *
 * `.card.sealed { max-width: 460px }` was written for the confirmation a player sees the
 * moment their number is accepted: a small centred card, alone on the screen. The waiting
 * stage's timeline is `card timeline-card sealed` once the cutoff has passed, so it
 * matched the same rule, and the card that had been the full width of a 1120px dashboard
 * snapped to under half of it the instant submissions closed, centred its text and took
 * the wrong shadow.
 *
 * Nothing else could have caught it. The markup is right, the component is right, both
 * rules are right on their own; they only disagree about what the word "sealed" is
 * scoped to. So the invariant is about scope: a rule that sizes a card because of the
 * stage it is the whole of has to say which stage, or it reaches every card that happens
 * to share a word with it.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { ROOT } = require('./helpers');

const css = fs.readFileSync(path.join(ROOT, 'client', 'styles.css'), 'utf8');

/**
 * Every `selector { body }` pair, flattened. Crude, and this stylesheet is flat.
 *
 * Comments come out first. Left in, they are swept into the selector of whatever rule
 * follows them — and since every rule worth checking here has a comment above it, the
 * check quietly matched nothing. Found by breaking the stylesheet on purpose and
 * watching this pass.
 */
function* rules(text) {
  for (const m of text.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]*)\{([^}]*)\}/g)) {
    const body = m[2];
    for (const selector of m[1].split(',').map((s) => s.trim()).filter(Boolean)) {
      yield { selector, body };
    }
  }
}

test('a card sized by its stage says which stage', () => {
  const loose = [];
  for (const { selector, body } of rules(css)) {
    if (!/^\.card\.[a-z-]+$/.test(selector)) continue;
    if (!/(^|[\s;])(max-|min-)?width\s*:/.test(body)) continue;
    loose.push(selector);
  }
  assert.deepEqual(loose, [],
    `these size a card on a bare class, so they also size any other card that happens to `
    + `carry that word as a state: ${loose.join(', ')}. Scope them to their stage `
    + '(".stage.centre > .card.x").');
});

test('the timeline names its own states', () => {
  // The other half of the same fix. A component's state modifier shares an element with
  // every other class on it, so an unprefixed one is a claim on a word the whole
  // stylesheet can see.
  const states = [];
  for (const { selector } of rules(css)) {
    for (const m of selector.matchAll(/\.timeline-card\.([a-z-]+)/g)) states.push(m[1]);
  }
  assert.ok(states.length > 0, 'no timeline state rules found — has the class been renamed?');
  const bare = [...new Set(states)].filter((s) => !s.startsWith('tl-'));
  assert.deepEqual(bare, [], `timeline states must be prefixed tl-: ${bare.join(', ')}`);
});
