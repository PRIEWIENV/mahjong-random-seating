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

const { DEFAULTS } = require('./runtime');

// Operational (§4.2): the submission window can be days long, and how long a cookie
// outlives it changes nothing about the draw. runtime.json -> server.session_ttl_days.
const SESSION_TTL_MS = DEFAULTS.server.session_ttl_days * 24 * 3600 * 1000;

/** Sessions are looked up by hash, so a database dump does not yield usable cookies. */
const hashToken = (token) => crypto.createHash('sha256').update(String(token), 'utf8').digest('hex');

class Store {
  /**
   * The only state keys that outlive a round. `finalise_tick` records that the draw job
   * is firing at all, which is a property of the deployment rather than of any one
   * attempt, and clearing it would make a fresh round look like a dead schedule.
   * Everything else describes one attempt and must not be carried into the next.
   */
  static KEPT_ACROSS_ROUNDS = ['finalise_tick'];

  constructor(file, opts = {}) {
    this.sessionTtlMs = opts.sessionTtlMs ?? SESSION_TTL_MS;
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
  createSession(localId, personId, nowMs, ttlMs = this.sessionTtlMs) {
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
  /**
   * Clear the live state of one attempt so the next can open (§8).
   *
   * Sessions survive: a player's identity did not change, only the round did, and
   * making twelve people sign in again buys nothing. The submissions do not survive
   * here because they are bound to the lapsed round and cannot be reused — but they are
   * not lost either. server/rounds.js archives every ciphertext, the roll taken at the
   * cutoff and the frozen parameters before this is ever called, and refuses to let it
   * be called until that archive verifies.
   *
   * The state keys are cleared by exclusion rather than by a list of what to remove, and
   * the difference was a real bug. The old list named four keys and missed
   * `roll_published`, which guards `publishRoll`: every attempt after the first therefore
   * skipped publishing its own roll, and the waiting page showed the previous attempt's
   * digest through the interval. That is the whole of PROTOCOL.md §9 silently not
   * happening, from one key added in one file and not added in another. Anything new is
   * now assumed to belong to the round unless it is named below.
   *
   * @returns {number} how many submissions were cleared
   */
  clearRound() {
    const n = this.db.prepare('SELECT COUNT(*) AS n FROM submissions').get().n;
    this.db.exec('DELETE FROM submissions');
    const keep = Store.KEPT_ACROSS_ROUNDS.map((k) => `'${k}'`).join(', ');
    this.db.prepare(`DELETE FROM state WHERE key NOT IN (${keep})`).run();
    return n;
  }

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
