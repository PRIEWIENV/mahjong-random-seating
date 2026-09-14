'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  saveAdminCredential, loadAdminCredential, clearAdminCredential,
} = require('../server/admin-credential');
const { TwirpPantheon } = require('../server/pantheon');

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mjs-cred-'));
  return { file: path.join(dir, 'admin-credential.json'), dir };
}

test('a captured credential round-trips and absence is not an error', () => {
  const { file, dir } = tmpFile();
  try {
    assert.equal(loadAdminCredential(file), null, 'absent reads as null, never throws');
    saveAdminCredential({ person_id: 42, auth_token: 'x'.repeat(96), title: 'Feiyang', event_id: 2, captured_at: '2026-09-14T00:00:00Z' }, file);
    const back = loadAdminCredential(file);
    assert.equal(back.person_id, 42);
    assert.equal(back.auth_token, 'x'.repeat(96));
    assert.equal(back.title, 'Feiyang');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a later capture overwrites the earlier one', () => {
  const { file, dir } = tmpFile();
  try {
    saveAdminCredential({ person_id: 42, auth_token: 'first' }, file);
    saveAdminCredential({ person_id: 2, auth_token: 'second' }, file);
    assert.equal(loadAdminCredential(file).person_id, 2);
    assert.equal(loadAdminCredential(file).auth_token, 'second');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('save refuses a credential missing its token', () => {
  const { file, dir } = tmpFile();
  try {
    assert.throws(() => saveAdminCredential({ person_id: 42 }, file));
    assert.equal(loadAdminCredential(file), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a corrupt file reads as absent, not a crash', () => {
  const { file, dir } = tmpFile();
  try {
    fs.writeFileSync(file, '{ not json');
    assert.equal(loadAdminCredential(file), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('clear removes it', () => {
  const { file, dir } = tmpFile();
  try {
    saveAdminCredential({ person_id: 42, auth_token: 'x' }, file);
    assert.ok(loadAdminCredential(file));
    clearAdminCredential(file);
    assert.equal(loadAdminCredential(file), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

if (process.platform !== 'win32') {
  test('the file is written 0600 — it holds a password-equivalent token', () => {
    const { file, dir } = tmpFile();
    try {
      saveAdminCredential({ person_id: 42, auth_token: 'x' }, file);
      assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

test('the real Twirp client falls back to a captured credential when the env is silent', () => {
  const { file, dir } = tmpFile();
  try {
    saveAdminCredential({ person_id: 7, auth_token: 'captured-token' }, file);
    const p = new TwirpPantheon({}, {}, { adminCredentialFile: file });
    assert.equal(p.adminPersonId, 7);
    assert.equal(p.adminToken, 'captured-token');
    assert.equal(p.adminCredentialSource, 'captured');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the environment wins over a captured credential', () => {
  const { file, dir } = tmpFile();
  try {
    saveAdminCredential({ person_id: 7, auth_token: 'captured-token' }, file);
    const p = new TwirpPantheon({}, { PANTHEON_ADMIN_PERSON_ID: '99', PANTHEON_ADMIN_TOKEN: 'env-token' }, { adminCredentialFile: file });
    assert.equal(p.adminPersonId, 99);
    assert.equal(p.adminToken, 'env-token');
    assert.equal(p.adminCredentialSource, 'env');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('without the opt-in the client never reads any credential file', () => {
  // A unit test constructing the class directly must not pick up a developer's captured
  // token; only createPantheon turns the fallback on.
  const p = new TwirpPantheon({}, {});
  assert.equal(p.adminToken, null);
  assert.equal(p.adminPersonId, null);
  assert.equal(p.adminCredentialSource, null);
});
