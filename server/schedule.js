'use strict';

/**
 * Running the draw on a clock, from inside the server process.
 *
 * The draw is a separate program (server/finalise.js) and has to stay one: it is
 * deliberately not an HTTP endpoint, because §9 requires that nothing an outsider can
 * poke may trigger, retry or re-time it. But "separate program" was being read as
 * "somebody else's problem to schedule", and the only scheduler documented was a
 * systemd timer. That asks for root on a machine the organiser may not own, and does
 * not exist at all on Windows, where this is developed and rehearsed. The result was a
 * deployment that served the page perfectly and never drew: the countdown reached zero
 * and nothing happened.
 *
 * So the server runs it on a timer of its own. That is not an endpoint — no request can
 * reach it, and the interval comes from a file on the box — so §9 is untouched. What it
 * changes is who has to remember.
 *
 * It **spawns** the job rather than calling run() in-process, which keeps three
 * properties worth having:
 *
 *   - the page stays responsive while a dozen tlock decryptions happen
 *   - a crash in the draw cannot take the server down with it
 *   - it is the same command a cron or systemd deployment runs, so what is rehearsed
 *     here is what runs there
 *
 * Overlap is the one hazard, and it is handled by not starting a second child while the
 * first is alive. Two concurrent draws would not corrupt anything — the job is
 * deterministic and idempotent by construction, which is the whole point of the
 * protocol — but they would stamp the roll twice and write to Pantheon twice, and
 * external side effects are worth not doing twice.
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const JOB = path.join(__dirname, 'finalise.js');

/**
 * @param {object}   o
 * @param {object}   o.cfg        loaded config; cfg.root is the job's working directory
 * @param {object}   [o.log]      console-like
 * @param {number}   [o.intervalMs]  defaults to runtime server.finalise_interval_seconds
 * @param {Function} [o.spawnFn]  injectable for tests
 * @param {string}   [o.jobPath]  injectable for tests
 */
function startScheduler(o) {
  const { cfg, log = console, spawnFn = spawn, jobPath = JOB } = o;
  const intervalMs = o.intervalMs ?? cfg.runtime.server.finalise_interval_seconds * 1000;
  // What to run, and whether to run it at all this tick. Both exist for the final round
  // (PROTOCOL.md 11): its job refuses outright when there is no lock yet, or when the
  // beacon has not landed, and refusing is right -- for a person. For a timer it would be
  // an error in the log every few seconds for the length of a tournament. The gate is a
  // pure file check, so the child is only started when it can actually succeed.
  const jobArgs = o.jobArgs || ['--no-wait'];
  const gate = o.gate || (() => true);
  const label = o.label || 'draw';

  let child = null;
  let stopped = false;
  let runs = 0;
  let skipped = 0;

  function forward(stream, level) {
    if (!stream) return;
    let buf = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      buf += chunk;
      const lines = buf.split(/\r?\n/);
      buf = lines.pop();
      // The job prefixes its own lines with [finalise]; passing them through unchanged
      // means the server log reads the same whether the timer is here or in systemd.
      for (const line of lines) if (line.trim()) log[level]?.(line);
    });
  }

  function tick() {
    if (stopped) return;
    if (child) {
      // A job that has not finished before the next tick is normal exactly once — the
      // run that does the draw — and a symptom if it keeps happening.
      skipped += 1;
      log.warn?.(`[schedule] previous ${label} job still running; skipping this tick (${skipped} so far)`);
      return;
    }
    if (!gate()) return;
    runs += 1;
    let proc;
    try {
      proc = spawnFn(process.execPath, [jobPath, ...jobArgs], {
        cwd: cfg.root,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      log.error?.(`[schedule] could not start the ${label} job: ${err.message}`);
      return;
    }
    child = proc;
    forward(proc.stdout, 'info');
    forward(proc.stderr, 'warn');
    proc.on('error', (err) => {
      log.error?.(`[schedule] the ${label} job could not be run: ${err.message}`);
      child = null;
    });
    proc.on('exit', (code) => {
      // Non-zero is worth saying out loud. §8 treats a late beacon as a delay and the
      // job exits 0 for it, so a failure here is something else.
      if (code !== 0) log.error?.(`[schedule] the ${label} job exited ${code}`);
      child = null;
    });
  }

  // At boot as well as on the interval. A server restarted after the round has to draw
  // now, not in a minute, and a restart is the most likely reason it has not drawn yet.
  const first = setTimeout(tick, 0);
  const timer = setInterval(tick, intervalMs);
  // Neither keeps the process alive on its own; the listening socket does that.
  first.unref?.();
  timer.unref?.();

  return {
    stop() {
      stopped = true;
      clearTimeout(first);
      clearInterval(timer);
      // Deliberately not killed. It is a draw: let it finish writing results.json and
      // syncing rather than leaving a half-published round behind.
    },
    tick,
    get running() { return Boolean(child); },
    get runs() { return runs; },
    get skipped() { return skipped; },
  };
}

/**
 * The final round draws itself, on the same timer and for the same reason (PROTOCOL.md 11).
 *
 * T2 contributes nothing of its own: the tables come from a lock published before the
 * beacon existed, the winds from a script frozen before the tournament started, and the
 * randomness from a drand round the lock names. There is no decision in it, so there is
 * nobody who needs to be present for it -- and asking a tournament organiser to open a
 * terminal between two rounds, with twelve people already sitting down, is how a draw
 * does not happen.
 *
 * This is a timer, not an endpoint: no request can reach it, so 9 is as untouched here as
 * it is for the first draw. The gate is three file checks and a clock, with no network,
 * so the job is spawned only once it can succeed.
 */
const FINAL_JOB = path.join(__dirname, '..', 'tools', 'draw-final.js');

function startFinalScheduler(o) {
  const { cfg, log = console } = o;
  const lockPath = path.join(cfg.root, 'events', 'final', 'lock.json');
  const finalPath = path.join(cfg.root, 'final.json');
  const nowFn = o.now || (() => Date.now());

  return startScheduler({
    ...o,
    label: 'final-round draw',
    jobPath: o.jobPath || FINAL_JOB,
    jobArgs: ['--no-wait'],
    gate() {
      if (cfg.protocol.final_round?.enabled !== true) return false;
      if (!fs.existsSync(lockPath)) return false;       // nothing locked yet
      if (fs.existsSync(finalPath)) return false;       // already drawn; T2 is idempotent
      let due;
      try {
        due = Date.parse(JSON.parse(fs.readFileSync(lockPath, 'utf8')).target_round_utc);
      } catch (err) {
        log.warn?.(`[schedule] cannot read the final lock: ${err.message}`);
        return false;
      }
      // Before the beacon there is nothing to draw from, and --no-wait would exit 1.
      return Number.isFinite(due) && nowFn() >= due;
    },
  });
}

module.exports = { startScheduler, startFinalScheduler, JOB, FINAL_JOB };
