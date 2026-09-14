'use strict';

/**
 * The seat-plan sync's admin credential, captured at sign-in (PANTHEON-INTEGRATION.md §4).
 *
 * Writing the prescript back to Pantheon needs an account that administers the event.
 * There are two ways to give the sync one:
 *
 *   1. a fixed service account in the environment — PANTHEON_ADMIN_PERSON_ID /
 *      PANTHEON_ADMIN_TOKEN, read by server/pantheon.js;
 *   2. the credential of whoever signed in as an event admin through the ordinary page.
 *
 * (2) is what this file is. Obtaining an admin token by hand means signing in against
 * Frey with curl and copying a 96-character string into `.env` without it touching the
 * shell history — a step the first deployments got wrong. But an event admin who opens
 * the page has already handed Frey their password and received exactly that token, and
 * `Frey.GetOwnedEventIds` says whether they administer this event. So the sign-in path
 * can capture it, and the operator sets nothing.
 *
 * What is stored is password-equivalent (PANTHEON-INTEGRATION.md §1: the auth_token
 * opens the same door as the password), so it is treated like the `.env` it replaces:
 *
 *   - written 0600, to var/ which .gitignore already excludes, and named so the ignore
 *     catches it even if var/ ever stops being ignored;
 *   - never logged, never echoed by any endpoint, never mirrored;
 *   - captured ONLY for a person GetOwnedEventIds reports as an admin of this event, and
 *     ONLY against a real Pantheon — never in stub mode, where the token is a fake and
 *     would poison a later real sync that fell back to it.
 *
 * The finalise job (a separate process) reads it fresh when it constructs its Pantheon
 * client, so the most recent admin sign-in is the one the sync uses. Nothing here is on
 * the fairness path: the draw is already final and published by the time it is read.
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

/**
 * Where the credential lives under a given checkout root.
 *
 * Taken as a parameter rather than only as the constant below because server/rounds.js
 * clears it relative to `cfg.root`, and a test's cfg.root is a temporary directory. A
 * module constant there would have deleted the developer's own captured credential.
 */
const adminCredentialFileIn = (root) => path.join(root, 'var', 'admin-credential.json');

const ADMIN_CREDENTIAL_FILE = adminCredentialFileIn(ROOT);

/**
 * Store the captured credential, replacing any previous one atomically.
 * @param {object} cred {person_id, auth_token, event_id, title, captured_at}
 * @param {string} [file]
 */
function saveAdminCredential(cred, file = ADMIN_CREDENTIAL_FILE) {
  if (!cred || !cred.person_id || !cred.auth_token) {
    throw new Error('saveAdminCredential needs person_id and auth_token');
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cred), { mode: 0o600 });
  try { fs.chmodSync(tmp, 0o600); } catch { /* best effort on platforms without POSIX modes */ }
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch { /* as above */ }
}

/**
 * Read it back, or null when absent or unreadable. Absence is normal — no admin has
 * signed in yet — and never an error.
 * @param {string} [file]
 * @returns {{person_id:number, auth_token:string, event_id?:number, title?:string, captured_at?:string}|null}
 */
function loadAdminCredential(file = ADMIN_CREDENTIAL_FILE) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch { return null; }
  try {
    const c = JSON.parse(raw);
    if (c && c.person_id && c.auth_token) return c;
  } catch { /* a half-written or corrupt file is treated as absent */ }
  return null;
}

/**
 * Remove it. Returns whether there was one to remove.
 *
 * Called when an event is closed (server/rounds.js `endEvent`, which tools/end-event.js
 * drives). Frey's tokens do not expire: they stand until that person changes their
 * password. So a captured one left on disk outlives by an unbounded margin the event it
 * was captured for, and the close is the moment there is nothing left that needs it.
 *
 * It is deliberately NOT in rounds.js's LIVE_FILES. Those are archived into `events/`
 * and mirrored to GitHub before they are cleared, and this is the one file in the tree
 * that must never be archived anywhere. The rule "nothing is deleted that the archive
 * does not already hold" protects evidence; a secret is its exact opposite, and is
 * deleted precisely because the archive does not and must not hold it.
 */
function clearAdminCredential(file = ADMIN_CREDENTIAL_FILE) {
  try { fs.unlinkSync(file); return true; }
  catch { return false; }
}

module.exports = {
  saveAdminCredential,
  loadAdminCredential,
  clearAdminCredential,
  adminCredentialFileIn,
  ADMIN_CREDENTIAL_FILE,
};
