'use strict';

/**
 * Mirrors submission events and the final result into the GitHub repository
 * (PROTOCOL.md §5, §10).
 *
 * The point of mirroring is that the ciphertexts become public the moment they are
 * received, timestamped by a third party the organiser does not control. That is
 * what stops the organiser quietly dropping an inconvenient submission after seeing
 * the outcome: the ciphertext is already on GitHub with a commit time.
 *
 * Configured entirely from the environment, so the PAT never enters the repository:
 *   MIRROR_REPO    owner/repo            (mirroring is disabled when unset)
 *   MIRROR_BRANCH  default "main"
 *   MIRROR_TOKEN   GitHub PAT with contents:write, narrowed to this repo
 *
 * Failure to mirror never fails a player's submission — the ciphertext is already
 * durable in SQLite, and the alternative (telling a player "try again later" because
 * GitHub is down) is worse. Unmirrored events are retried on the next flush.
 */

const fs = require('node:fs');
const path = require('node:path');

const API = 'https://api.github.com';

class Mirror {
  /**
   * @param {object} env   MIRROR_REPO / MIRROR_BRANCH / MIRROR_TOKEN
   * @param {object} log
   * @param {object} [opts]
   * @param {number} [opts.retryBaseMs]  backoff step; a test needs this to not be 2 s
   */
  constructor(env = process.env, log = console, opts = {}) {
    this.repo = env.MIRROR_REPO || null;
    this.branch = env.MIRROR_BRANCH || 'main';
    this.token = env.MIRROR_TOKEN || null;
    this.log = log;
    this.retryBaseMs = opts.retryBaseMs ?? 2000;
    this.enabled = Boolean(this.repo && this.token);
    this.queue = [];
    this.flushing = false;
    if (!this.enabled) {
      this.log.warn?.(
        '[mirror] disabled (set MIRROR_REPO and MIRROR_TOKEN to mirror events to GitHub). ' +
          'Submissions are still stored locally.'
      );
    }
  }

  async #api(method, pathname, body) {
    const res = await fetch(`${API}${pathname}`, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'content-type': 'application/json',
        'user-agent': 'mahjong-random-seating',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* non-JSON error body */
    }
    if (!res.ok) {
      const err = new Error(`GitHub ${method} ${pathname} -> ${res.status} ${json?.message || text.slice(0, 200)}`);
      err.status = res.status;
      throw err;
    }
    return json;
  }

  /** Current blob sha of a path, or null when it does not exist yet. */
  async #sha(repoPath) {
    try {
      const j = await this.#api('GET', `/repos/${this.repo}/contents/${encodeURI(repoPath)}?ref=${encodeURIComponent(this.branch)}`);
      return Array.isArray(j) ? null : j.sha;
    } catch (err) {
      if (err.status === 404) return null;
      throw err;
    }
  }

  /** Create or update one file. */
  async put(repoPath, content, message) {
    if (!this.enabled) return { skipped: true };
    const sha = await this.#sha(repoPath);
    return await this.#api('PUT', `/repos/${this.repo}/contents/${encodeURI(repoPath)}`, {
      message,
      content: Buffer.from(content, 'utf8').toString('base64'),
      branch: this.branch,
      ...(sha ? { sha } : {}),
    });
  }

  /**
   * Queue a file for mirroring and kick off a flush. Never throws: mirroring is
   * best-effort by design (see the header comment).
   */
  enqueue(repoPath, content, message) {
    this.queue.push({ repoPath, content, message, attempts: 0 });
    this.flush();
  }

  async flush() {
    if (!this.enabled || this.flushing) return;
    this.flushing = true;
    try {
      while (this.queue.length) {
        const job = this.queue[0];
        try {
          await this.put(job.repoPath, job.content, job.message);
          this.queue.shift();
          this.log.info?.(`[mirror] ${job.repoPath}`);
        } catch (err) {
          job.attempts += 1;
          this.log.error?.(`[mirror] ${job.repoPath} failed (attempt ${job.attempts}): ${err.message}`);
          if (job.attempts >= 5) {
            this.queue.shift();
            this.log.error?.(`[mirror] giving up on ${job.repoPath}; mirror it by hand before publishing results`);
          } else {
            await new Promise((r) => setTimeout(r, this.retryBaseMs * job.attempts));
          }
        }
      }
    } finally {
      this.flushing = false;
    }
  }

  /** Wait for the queue to drain — used by the finalisation job before it exits. */
  async drain(timeoutMs = 120_000) {
    const deadline = Date.now() + timeoutMs;
    while ((this.queue.length || this.flushing) && Date.now() < deadline) {
      await this.flush();
      if (this.queue.length) await new Promise((r) => setTimeout(r, 500));
    }
    return this.queue.length === 0;
  }
}

/** Also keep a local copy, so the repository layout of §10 exists even without a PAT. */
function writeLocal(root, repoPath, content) {
  const dest = path.join(root, repoPath);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, content);
  return dest;
}

module.exports = { Mirror, writeLocal };
