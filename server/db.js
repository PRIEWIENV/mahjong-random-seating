'use strict';

/**
 * SQLite state (PROTOCOL.md §10).
 *
 * node:sqlite ships with Node, so there is no native build step on the VPS and one
 * less dependency for an auditor to think about.
 *
 * Two kinds of row live here, and only one of them is secret:
 *   - submissions: ciphertexts, safe to publish, and mirrored to the repo as they arrive
 *   - sessions: opaque cookie tokens tying a browser to a local_id
 * Nothing stored here would let anyone open a ciphertext early.
 */

const { DatabaseSync } = require('node:sqlite');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS submissions (
  local_id    INTEGER PRIMARY KEY,
  ciphertext  TEXT    NOT NULL,
  received_at TEXT    NOT NULL,
  received_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT    PRIMARY KEY,
  local_id   INTEGER NOT NULL,
  person_id  INTEGER NOT NULL,
  created_ms INTEGER NOT NULL,
  expires_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_ms);

CREATE TABLE IF NOT EXISTS state (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

const SESSION_TTL_MS = 30 * 24 * 3600 * 1000; // the submission window can be days long

/** Sessions are looked up by hash, so a database dump does not yield usable cookies. */
const hashToken = (token) => crypto.createHash('sha256').update(String(token), 'utf8').digest('hex');

class Store {
  constructor(file) {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec(SCHEMA);
  }

  // ---- submissions ------------------------------------------------------
  insertSubmission(localId, ciphertext, nowMs) {
    const receivedAt = new Date(nowMs).toISOString();
    try {
      this.db
        .prepare('INSERT INTO submissions (local_id, ciphertext, received_at, received_ms) VALUES (?, ?, ?, ?)')
        .run(localId, ciphertext, receivedAt, nowMs);
      return { stored: true, received_at: receivedAt };
    } catch (err) {
      const existing = this.getSubmission(localId);
      if (existing) return { stored: false, reason: 'already_submitted', received_at: existing.received_at };
      throw err;
    }
  }

  getSubmission(localId) {
    return this.db.prepare('SELECT * FROM submissions WHERE local_id = ?').get(localId) || null;
  }

  listSubmissions() {
    return this.db.prepare('SELECT * FROM submissions ORDER BY local_id ASC').all();
  }

  /**
   * §8: the snapshot is taken at exactly submission_cutoff_utc. Anything received at
   * or after that instant does not count, even if the server accepted it by mistake.
   */
  snapshotAt(cutoffMs) {
    return this.db.prepare('SELECT * FROM submissions WHERE received_ms < ? ORDER BY local_id ASC').all(cutoffMs);
  }

  submittedLocalIds() {
    return this.listSubmissions().map((r) => r.local_id);
  }

  // ---- sessions ---------------------------------------------------------
  createSession(localId, personId, nowMs, ttlMs = SESSION_TTL_MS) {
    const token = crypto.randomBytes(32).toString('base64url');
    this.db
      .prepare('INSERT INTO sessions (token_hash, local_id, person_id, created_ms, expires_ms) VALUES (?, ?, ?, ?, ?)')
      .run(hashToken(token), localId, personId, nowMs, nowMs + ttlMs);
    return token;
  }

  getSession(token, nowMs) {
    if (!token) return null;
    const row = this.db.prepare('SELECT * FROM sessions WHERE token_hash = ?').get(hashToken(token));
    if (!row) return null;
    if (row.expires_ms <= nowMs) {
      this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(row.token_hash);
      return null;
    }
    return row;
  }

  deleteSession(token) {
    if (token) this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
  }

  purgeExpiredSessions(nowMs) {
    this.db.prepare('DELETE FROM sessions WHERE expires_ms <= ?').run(nowMs);
  }

  // ---- misc state -------------------------------------------------------
  get(key, fallback = null) {
    const row = this.db.prepare('SELECT value FROM state WHERE key = ?').get(key);
    return row ? JSON.parse(row.value) : fallback;
  }

  set(key, value) {
    this.db
      .prepare('INSERT INTO state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, JSON.stringify(value));
  }

  close() {
    this.db.close();
  }
}

module.exports = { Store, hashToken, SESSION_TTL_MS };
