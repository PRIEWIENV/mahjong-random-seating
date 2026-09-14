'use strict';

/**
 * The mirror credential helper (tools/setup-mirror.js).
 *
 * The GitHub round trip needs a real token and is out of reach here, the same way it is
 * in mirror.test.js. What is in reach is the part that would fail silently and
 * expensively: the `.env` rewrite. That file also holds the Pantheon service account and
 * ADMIN_TOKEN, and a tool that drops one of them while setting a third leaves a server
 * that starts, runs, and is wrong about something nobody looks at until the draw.
 *
 * Also the remote parser, because guessing "owner/repo" from a URL that is not GitHub
 * would write a repository the mirror can never reach into .env as if it were checked.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { parseRemote, upsertEnv, readEnvFile } = require('../tools/setup-mirror');

const LF = String.fromCharCode(10);

test('every form git remote get-url produces yields owner/repo', () => {
  const want = 'someone/seating';
  for (const url of [
    'https://github.com/someone/seating.git',
    'https://github.com/someone/seating',
    'https://someone@github.com/someone/seating.git',
    'git@github.com:someone/seating.git',
    'git@github.com:someone/seating',
    'ssh://git@github.com/someone/seating.git',
    '  https://github.com/someone/seating.git  ' + LF,
  ]) {
    assert.equal(parseRemote(url), want, url);
  }
});

test('a remote that is not GitHub is not guessed at', () => {
  // Writing one of these into MIRROR_REPO would produce a server that looks configured
  // and mirrors nothing.
  for (const url of [
    'https://gitlab.com/someone/seating.git',
    'git@gitea.example.org:someone/seating.git',
    'https://github.example.com/someone/seating.git',
    '/srv/git/seating.git',
    '',
    null,
    undefined,
  ]) {
    assert.equal(parseRemote(url), null, String(url));
  }
});

test('an existing key is replaced where it stands, not appended', () => {
  const before = [
    'PORT=8080',
    'MIRROR_REPO=old/repo',
    'MIRROR_TOKEN=github_pat_old',
    'ADMIN_TOKEN=deadbeef',
    '',
  ].join(LF);
  const after = upsertEnv(before, { MIRROR_REPO: 'new/repo', MIRROR_TOKEN: 'github_pat_new' });
  assert.equal(
    after,
    ['PORT=8080', 'MIRROR_REPO=new/repo', 'MIRROR_TOKEN=github_pat_new', 'ADMIN_TOKEN=deadbeef', ''].join(LF)
  );
});

test('nothing else in .env is touched', () => {
  const before = [
    '# operational, not secret',
    'PORT=8080',
    'HOST=127.0.0.1',
    'NODE_ENV=production',
    'PANTHEON_ADMIN_PERSON_ID=17',
    'PANTHEON_ADMIN_TOKEN=abc123',
    'ADMIN_TOKEN=deadbeef',
    '',
  ].join(LF);
  const after = upsertEnv(before, { MIRROR_REPO: 'a/b', MIRROR_BRANCH: 'main', MIRROR_TOKEN: 't' });
  for (const line of before.split(LF).filter(Boolean)) assert.ok(after.includes(line), `lost: ${line}`);
  const env = readEnvFile(writeTmp(after));
  assert.equal(env.PANTHEON_ADMIN_TOKEN, 'abc123');
  assert.equal(env.ADMIN_TOKEN, 'deadbeef');
  assert.equal(env.MIRROR_REPO, 'a/b');
});

test('a key named inside a comment is not mistaken for the setting', () => {
  // The shipped .env in deploy/README.md documents MIRROR_TOKEN in a comment directly
  // above the real line. Replacing the comment would both lose the explanation and
  // leave the actual assignment untouched.
  const before = ['# MIRROR_TOKEN is a fine-grained PAT', 'MIRROR_TOKEN=old', ''].join(LF);
  const after = upsertEnv(before, { MIRROR_TOKEN: 'new' });
  assert.equal(after, ['# MIRROR_TOKEN is a fine-grained PAT', 'MIRROR_TOKEN=new', ''].join(LF));
});

test('keys that are absent are appended, with a newline first when one is missing', () => {
  assert.equal(upsertEnv('PORT=8080', { MIRROR_REPO: 'a/b' }), `PORT=8080${LF}MIRROR_REPO=a/b${LF}`);
  assert.equal(upsertEnv('', { MIRROR_REPO: 'a/b' }), `MIRROR_REPO=a/b${LF}`);
  assert.equal(upsertEnv(undefined, { MIRROR_REPO: 'a/b' }), `MIRROR_REPO=a/b${LF}`);
});

test('a null value writes nothing rather than the string "null"', () => {
  assert.equal(upsertEnv('PORT=8080' + LF, { MIRROR_BRANCH: null }), 'PORT=8080' + LF);
});

test('a token containing = survives the read back', () => {
  // Base64-ish values happen, and splitting on every `=` would truncate one silently.
  const file = writeTmp(upsertEnv('', { MIRROR_TOKEN: 'abc==def=' }));
  assert.equal(readEnvFile(file).MIRROR_TOKEN, 'abc==def=');
});

test('reading .env ignores comments, blanks and quotes', () => {
  const file = writeTmp(['# a comment', '', 'MIRROR_REPO="a/b"', "MIRROR_BRANCH='main'", 'BAD', '=nokey', ''].join(LF));
  const env = readEnvFile(file);
  assert.equal(env.MIRROR_REPO, 'a/b');
  assert.equal(env.MIRROR_BRANCH, 'main');
  assert.equal(env.BAD, undefined);
});

test('a missing .env reads as empty rather than throwing', () => {
  assert.deepEqual(readEnvFile(path.join(os.tmpdir(), 'no-such-file-' + Date.now(), '.env')), {});
});

function writeTmp(text) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-mirror-'));
  const file = path.join(dir, '.env');
  fs.writeFileSync(file, text);
  return file;
}
