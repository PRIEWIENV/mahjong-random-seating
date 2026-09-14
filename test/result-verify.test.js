'use strict';

/**
 * The "check the result" panel's fetch instructions (client/stages/Result.jsx).
 *
 * Source invariants rather than a render, for the same reason styles.test.js is: the
 * component is right in every case it is given, and the bug was in which case it was
 * given. A deployed build told twelve people to run
 *
 *     git clone https://github.com/youruser/mahjong-random-seating draw
 *
 * because the repository was a constant copied out of the deployment guide. That address
 * reads as real, it clones, and what the player then verifies is a stranger's draw — a
 * failure that looks like success, which is the only kind this panel can have. The
 * repository now comes from MIRROR_REPO by way of /api/status.
 *
 * The second invariant is the case that replaced it. With mirroring off there is no
 * address, and a placeholder inside a copyable code block is still something people
 * paste; worse, the panel's other claim — that every ciphertext was public as it
 * arrived — is simply false then, and it is the one claim on the page a player cannot
 * check for themselves.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { ROOT } = require('./helpers');

const SRC = path.join(ROOT, 'client', 'stages', 'Result.jsx');
const src = fs.readFileSync(SRC, 'utf8');
// The bundle players are actually served. The source being right is not the claim.
// esbuild emits non-ASCII as \uXXXX, so every Chinese string in it has to be decoded
// before it can be searched for — grepping the raw file finds none of them and a test
// that only ever looks for English would pass on a bundle with no Chinese at all.
const bundle = fs
  .readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8')
  .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));

test('no repository owner is hard-coded anywhere a player can copy it', () => {
  for (const ghost of ['youruser', 'yourorg', '<owner>', 'example.com/mahjong']) {
    assert.ok(!src.includes(ghost), `${ghost} is back in Result.jsx`);
    assert.ok(!bundle.includes(ghost), `${ghost} is in the built bundle`);
  }
});

test('the clone URL is built from the status payload, not from a literal', () => {
  assert.match(src, /git clone https:\/\/github\.com\/\$\{status\.mirror_repo\}/);
});

test('with no mirror there is no clone command at all', () => {
  // A placeholder in a <code className="block"> is a thing people paste. The guard has
  // to be on the block, not only on the string inside it.
  assert.match(src, /const mirrored = Boolean\(status\?\.mirror_repo\)/);
  assert.match(src, /const fetchCmd = mirrored[\s\S]{0,400}: null;/);
  assert.match(src, /\{fetchCmd && <code className="block">\{fetchCmd\}<\/code>\}/);
});

test('with no mirror the panel does not claim the ciphertexts were published', () => {
  // Both languages need the alternative wording, and both have to be reachable: a
  // string that exists but is never rendered is the same bug with extra steps.
  for (const key of ['v1NoMirror', 'v2NoMirror']) {
    assert.equal((src.match(new RegExp(`${key}:`, 'g')) || []).length, 2, `${key} is not in both languages`);
  }
  assert.match(src, /\{mirrored \? t\.v1get : t\.v1NoMirror\}/);
  assert.match(src, /mirrored$[\s\S]{0,200}t\.v2NoMirror|\{mirrored[\s\S]{0,300}v2na/m);
});

test('the built bundle carries both wordings, so the check is of what is served', () => {
  for (const phrase of ['events/submissions/', '没有被镜像到公开仓库', 'were not mirrored anywhere public']) {
    assert.ok(bundle.includes(phrase), `the bundle is stale: ${phrase} is missing — run node tools/build-client.js`);
  }
});
