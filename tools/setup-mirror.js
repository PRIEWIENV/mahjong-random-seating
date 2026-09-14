#!/usr/bin/env node
'use strict';

/**
 * The mirror's GitHub credential, obtained and checked without hand-editing .env
 * (deploy/README.md §6).
 *
 *   node tools/setup-mirror.js                  # ask, verify, write .env
 *   node tools/setup-mirror.js --check          # verify what .env already has
 *   node tools/setup-mirror.js --repo o/r --branch main --no-probe
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS NOT FULLY AUTOMATIC
 *
 * It cannot be. A GitHub token is issued by GitHub to a human who authenticates in a
 * browser, and there is no API that mints one. The two ways to move that step into a
 * program both cost more than they save here:
 *
 *   - OAuth device flow needs a registered OAuth App's client_id. Whoever registered it
 *     would become a third party every operator of this code depends on, for a project
 *     whose whole premise is that you run your own copy. The operator would still open
 *     github.com and type a code, so the browser step does not even go away.
 *   - A GitHub App would scope better but has the same owner problem, plus a private key
 *     to distribute.
 *
 * So one browser visit stays. Everything around it is automated here, and that is most
 * of what made the old instructions painful: working out the repo, knowing which of the
 * two token types and which permission, getting the value into .env without it landing
 * in shell history or a world-readable file, and — the part that actually bites —
 * finding out whether the token WORKS. A token with the wrong permission looks exactly
 * like a good one until the first ciphertext arrives, and that is during the submission
 * window, when the ciphertexts that fail to mirror are the evidence the draw's fairness
 * argument rests on (PROTOCOL.md §5).
 *
 * Hence the write probe. GET /repos reports `permissions.push` for the USER, not for
 * the token, so a read-only fine-grained PAT on a repo you own still reports push:true.
 * The only honest check is to write a file and delete it, which is exactly what the
 * mirror does. It leaves two commits; --no-probe skips it and says what is unchecked.
 *
 * The token is read from a hidden prompt, never echoed, never logged, and never passed
 * as an argument — an argv token is visible in `ps` and lands in shell history.
 * ---------------------------------------------------------------------------
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const API = 'https://api.github.com';
const TIMEOUT_MS = 20_000;
const LF = String.fromCharCode(10);
const PROBE_PATH = '.mirror-check';
const NEW_TOKEN_URL = 'https://github.com/settings/personal-access-tokens/new';

// ---------------------------------------------------------------------------
// Pure helpers, exported so the parts that are easy to get quietly wrong have tests.
// ---------------------------------------------------------------------------

/**
 * "owner/repo" out of any form `git remote get-url` produces.
 *
 * Returns null rather than guessing: a remote that is not GitHub (a mirror on a private
 * gitlab, say) must not be silently written into .env as if it were.
 */
function parseRemote(url) {
  if (typeof url !== 'string') return null;
  const u = url.trim().replace(/\.git$/, '');
  // git@github.com:owner/repo  |  ssh://git@github.com/owner/repo
  // https://github.com/owner/repo  |  https://user@github.com/owner/repo
  const m = u.match(/^(?:git@|ssh:\/\/git@|https?:\/\/(?:[^@/]*@)?)github\.com[:/]+([^/]+)\/([^/]+)$/);
  if (!m) return null;
  return `${m[1]}/${m[2]}`;
}

/**
 * `.env` with these keys set, everything else byte-identical.
 *
 * Rewritten in place rather than regenerated, because .env also holds settings this
 * tool knows nothing about — the optional Pantheon service account, ADMIN_TOKEN, PORT —
 * and a tool that rewrites a file it only half understands will eventually drop one of
 * them. A key that is present is replaced where it stands, so comments keep the lines
 * they were written about; a key that is absent is appended.
 */
function upsertEnv(text, updates) {
  let out = typeof text === 'string' ? text : '';
  const missing = [];
  for (const [key, value] of Object.entries(updates)) {
    if (value == null) continue;
    const line = `${key}=${value}`;
    // Only an assignment at the start of a line, so a key named inside a comment
    // ("# MIRROR_TOKEN is a fine-grained PAT") is left alone instead of being eaten.
    const re = new RegExp(`^${key}=.*$`, 'm');
    if (re.test(out)) out = out.replace(re, line);
    else missing.push(line);
  }
  if (missing.length) {
    if (out && !out.endsWith(LF)) out += LF;
    out += missing.join(LF) + LF;
  }
  return out;
}

/** Everything after the first `=`, so a token containing `=` survives. */
function readEnvFile(file) {
  const env = {};
  if (!fs.existsSync(file)) return env;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const at = line.indexOf('=');
    if (at < 1) continue;
    let v = line.slice(at + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    env[line.slice(0, at).trim()] = v;
  }
  return env;
}

/** A token shown in full is a token in a screenshot. */
const mask = (t) => (typeof t === 'string' && t.length > 12 ? `${t.slice(0, 7)}…${t.slice(-4)} (${t.length} chars)` : '(set)');

// ---------------------------------------------------------------------------
// Terminal
// ---------------------------------------------------------------------------

function askHidden(prompt) {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    if (!stdin.isTTY) {
      // Piped. Read the first line, then let go of stdin completely: leaving a listener
      // on a closing handle and then exiting aborts the process on Windows with a libuv
      // assertion, which looks like a crash in the middle of an otherwise clean report.
      let data = '';
      const onData = (d) => { data += d; };
      const done = () => {
        stdin.off('data', onData);
        stdin.off('end', done);
        stdin.pause();
        resolve(data.split(LF)[0].replace(String.fromCharCode(13), '').trim());
      };
      stdin.setEncoding('utf8');
      stdin.on('data', onData);
      stdin.on('end', done);
      return;
    }
    process.stdout.write(prompt);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let v = '';
    const onData = (chunk) => {
      for (const ch of chunk) {
        const c = ch.charCodeAt(0);
        if (c === 13 || c === 10 || c === 4) {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off('data', onData);
          process.stdout.write(LF);
          resolve(v.trim());
          return;
        }
        if (c === 3) { process.stdout.write(LF); process.exit(130); }
        if (c === 127 || c === 8) v = v.slice(0, -1);
        else v += ch;
      }
    };
    stdin.on('data', onData);
  });
}

function askVisible(prompt, fallback = '') {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY) return resolve(fallback);
    process.stdout.write(prompt);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    const onData = (d) => {
      process.stdin.pause();
      process.stdin.off('data', onData);
      resolve(String(d).split(LF)[0].trim() || fallback);
    };
    process.stdin.on('data', onData);
  });
}

const quiet = (fn, fallback = null) => { try { return fn(); } catch { return fallback; } };

// ---------------------------------------------------------------------------
// GitHub
// ---------------------------------------------------------------------------

async function api(token, method, pathname, body) {
  const res = await fetch(`${API}${pathname}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'content-type': 'application/json',
      'user-agent': 'mahjong-random-seating',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON error body */ }
  return { ok: res.ok, status: res.status, json, message: json?.message || text.slice(0, 200) };
}

/**
 * The four questions the mirror will ask GitHub during the draw, asked now.
 * Returns true only when every one of them is answered the way the mirror needs.
 */
async function verify({ repo, branch, token, probe }) {
  let ok = true;

  const who = await api(token, 'GET', '/user');
  if (who.ok) {
    console.log(`  OK    token belongs to ${who.json?.login}`);
  } else if (who.status === 401) {
    console.log('  FAIL  GitHub rejected the token (401). It is wrong, revoked, or expired.');
    return false;
  } else {
    console.log(`  warn  GET /user -> ${who.status} ${who.message}`);
  }

  const r = await api(token, 'GET', `/repos/${repo}`);
  if (!r.ok) {
    console.log(`  FAIL  GET /repos/${repo} -> ${r.status} ${r.message}`);
    if (r.status === 404) {
      console.log('        404 here is usually one of: the name is wrong; the repository is private and');
      console.log('        this token was not granted it; or the token is fine-grained and its resource');
      console.log(`        owner is not ${repo.split('/')[0]}.`);
    }
    return false;
  }
  console.log(`  OK    repository ${r.json.full_name} is reachable${r.json.private ? ' (private)' : ''}`);

  const b = await api(token, 'GET', `/repos/${repo}/branches/${encodeURIComponent(branch)}`);
  if (b.ok) {
    console.log(`  OK    branch ${branch} exists`);
  } else {
    console.log(`  FAIL  branch ${branch} -> ${b.status} ${b.message}`);
    console.log(`        the default branch is ${r.json.default_branch}; set MIRROR_BRANCH to that, or push ${branch}.`);
    ok = false;
  }

  if (!probe) {
    console.log('  --    write probe skipped, so contents:write is NOT confirmed');
    console.log('        the first thing that finds out will be a player\'s submission');
    return ok;
  }

  // The real thing: create a file and delete it. See the header — no read-only call
  // can distinguish a token that may write from one that may not.
  const put = await api(token, 'PUT', `/repos/${repo}/contents/${PROBE_PATH}`, {
    message: 'setup-mirror: check contents:write',
    content: Buffer.from(`checked ${new Date().toISOString()}${LF}`, 'utf8').toString('base64'),
    branch,
  });
  if (!put.ok) {
    console.log(`  FAIL  write probe -> ${put.status} ${put.message}`);
    if (put.status === 403 || put.status === 404) {
      console.log('        the token can read this repository but not write to it.');
      console.log('        Fine-grained: Permissions -> Repository permissions -> Contents -> Read and write.');
      console.log('        Classic: the `repo` scope (or `public_repo` for a public repository).');
    }
    if (put.status === 409) console.log('        409 also means the branch is protected against direct pushes.');
    return false;
  }
  console.log('  OK    wrote a file: contents:write is real');

  const del = await api(token, 'DELETE', `/repos/${repo}/contents/${PROBE_PATH}`, {
    message: 'setup-mirror: remove check file',
    sha: put.json?.content?.sha,
    branch,
  });
  if (del.ok) console.log(`  OK    removed ${PROBE_PATH} again (two commits left in history)`);
  else console.log(`  warn  could not remove ${PROBE_PATH}: ${del.status} ${del.message} — delete it by hand`);

  return ok;
}

// ---------------------------------------------------------------------------

function printTokenInstructions(repo) {
  console.log('');
  console.log(`  Open  ${NEW_TOKEN_URL}`);
  console.log('  (Settings -> Developer settings -> Personal access tokens -> Fine-grained tokens');
  console.log('   -> Generate new token)');
  console.log('');
  console.log('    Token name           anything, e.g. "seating mirror"');
  console.log('    Expiration           past the day of the draw');
  console.log(`    Resource owner       ${repo.split('/')[0]}`);
  console.log(`    Repository access    Only select repositories -> ${repo}`);
  console.log('    Permissions          Repository permissions -> Contents -> Read and write');
  console.log('');
  console.log('  Generate token, then copy the github_pat_… value. It is shown once.');
  console.log('');
}

const usage = () => {
  console.error('usage: node tools/setup-mirror.js [--repo <owner/repo>] [--branch <name>] [--no-probe]');
  console.error('       node tools/setup-mirror.js --check');
  process.exit(2);
};

async function main(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) usage();
    const k = argv[i].slice(2);
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) args[k] = true;
    else { args[k] = v; i++; }
  }
  if (args.help || args.h) usage();
  if (args.token) {
    console.error('  ERROR --token is not accepted: an argv token is visible in `ps` and kept in shell history.');
    console.error('        Run without it and paste at the prompt, or pipe it: echo $TOK | node tools/setup-mirror.js');
    return 2;
  }

  const envFile = path.join(ROOT, '.env');
  const existing = readEnvFile(envFile);
  const probe = args.probe !== false && args['no-probe'] !== true;

  // ---- what repository ------------------------------------------------------
  let repo = typeof args.repo === 'string' ? args.repo : existing.MIRROR_REPO || null;
  let repoFrom = typeof args.repo === 'string' ? '--repo' : repo ? '.env' : null;
  if (!repo) {
    const remote = quiet(() =>
      execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    );
    const guess = parseRemote(remote);
    if (guess) { repo = guess; repoFrom = 'git remote origin'; }
  }
  if (!repo) repo = await askVisible('  Repository to mirror into (owner/repo): ');
  if (!repo || !/^[^/\s]+\/[^/\s]+$/.test(repo)) {
    console.error('  ERROR need a repository as owner/repo');
    return 2;
  }
  const branch = (typeof args.branch === 'string' ? args.branch : existing.MIRROR_BRANCH) || 'main';
  console.log(`  repository  ${repo}${repoFrom ? `  (from ${repoFrom})` : ''}`);
  console.log(`  branch      ${branch}`);

  // ---- --check: verify what is already configured, change nothing -----------
  if (args.check) {
    if (!existing.MIRROR_TOKEN) {
      console.log('  FAIL  .env has no MIRROR_TOKEN, so mirroring is off and no ciphertext will be published.');
      return 1;
    }
    console.log(`  token       ${mask(existing.MIRROR_TOKEN)} (from .env)`);
    console.log('');
    const ok = await verify({ repo, branch, token: existing.MIRROR_TOKEN, probe });
    console.log('');
    console.log(ok ? '  Mirroring is configured and works.' : '  Mirroring is NOT usable as configured. Run without --check to fix it.');
    return ok ? 0 : 1;
  }

  // ---- the token ------------------------------------------------------------
  let token = null;
  const gh = quiet(() => execFileSync('gh', ['auth', 'token'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
  if (gh && gh.trim() && process.stdin.isTTY) {
    console.log('');
    console.log('  The GitHub CLI is signed in here, so its token can be used without visiting the site.');
    console.log('  Note what that costs: it is your whole account\'s token, not one narrowed to this');
    console.log('  repository, and it will sit in .env on the server. A fine-grained PAT is the safer');
    console.log('  answer for a machine you leave running.');
    const use = await askVisible('  Use the GitHub CLI token? [y/N]: ', 'n');
    if (/^y/i.test(use)) token = gh.trim();
  }

  if (!token) {
    if (existing.MIRROR_TOKEN && process.stdin.isTTY) {
      console.log(`${LF}  .env already has a token: ${mask(existing.MIRROR_TOKEN)}`);
      const keep = await askVisible('  Keep it and just verify? [Y/n]: ', 'y');
      if (!/^n/i.test(keep)) token = existing.MIRROR_TOKEN;
    }
  }

  if (!token) {
    printTokenInstructions(repo);
    token = await askHidden('  Paste the token (not shown): ');
  }
  if (!token) {
    console.error('  ERROR no token given');
    return 2;
  }

  // ---- does it work ---------------------------------------------------------
  console.log('');
  const ok = await verify({ repo, branch, token, probe });
  console.log('');
  if (!ok) {
    console.log('  Nothing was written to .env. Fix the token or the repository and run this again.');
    return 1;
  }

  // ---- write it -------------------------------------------------------------
  const before = fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8') : '';
  const after = upsertEnv(before, { MIRROR_REPO: repo, MIRROR_BRANCH: branch, MIRROR_TOKEN: token });
  fs.writeFileSync(envFile, after, { mode: 0o600 });
  quiet(() => fs.chmodSync(envFile, 0o600));
  console.log(`  OK    wrote MIRROR_REPO, MIRROR_BRANCH and MIRROR_TOKEN into ${envFile} (mode 600)`);

  // .env is gitignored, but a repository that was configured before that line existed
  // would commit a password-equivalent token on the next `git add -A`.
  const tracked = quiet(() =>
    execFileSync('git', ['ls-files', '--error-unmatch', '.env'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  );
  if (tracked) {
    console.log('');
    console.log('  WARNING .env is TRACKED by git in this checkout. The token will be committed.');
    console.log('          git rm --cached .env      and make sure .gitignore covers it.');
  }

  console.log('');
  console.log('  Restart the server for it to pick this up. It logs `[mirror] disabled` when it did not.');
  return 0;
}

module.exports = { parseRemote, upsertEnv, readEnvFile };

if (require.main === module) {
  // exitCode rather than exit(): stdin may still be settling after a prompt, and killing
  // the process out from under it is what turns a clean "FAIL" into a libuv abort.
  main(process.argv.slice(2))
    .then((code) => { process.exitCode = code; })
    .catch((err) => {
      console.error(`  ERROR ${err.message}`);
      process.exitCode = 1;
    });
}
