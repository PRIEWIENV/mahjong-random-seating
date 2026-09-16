'use strict';

/**
 * The server's own log, kept in memory so the dashboard can show it.
 *
 * The organiser's machine is a VPS they reached once with ssh and would rather not reach
 * again during an event. Everything else they need is already on /admin; the one thing
 * that was not was the log, which is exactly what you want when the draw has not appeared
 * and you are trying to tell "the beacon is late" from "the job is dead".
 *
 * Captured by teeing `process.stdout.write` and `process.stderr.write` rather than by
 * wrapping the logger. Those two are the single point every line passes through: the
 * `console.*` calls scattered through server.js, the `log.info?.()` calls behind an
 * injected logger, and the finalise and draw jobs' output, which server/schedule.js pipes
 * back through `log.info`. Wrapping `console` would have missed whichever of those three
 * someone adds next.
 *
 * Three rules this file exists to keep:
 *
 *   1. It never swallows a line. The original write is always called, with its return
 *      value and callback passed through, so stdout still behaves like stdout and
 *      journald still gets everything.
 *   2. It never grows. A ring of MAX lines, each truncated, so a process that runs for a
 *      month and a job that loops printing both cost the same bounded memory.
 *   3. It never widens what /admin discloses. The buffer holds what the process already
 *      prints to a terminal; the dashboard is behind the same gate as everything else
 *      there. Strings registered with `redact()` — the admin token — are replaced before
 *      a line is stored, because a token that reaches this buffer would be readable by
 *      anyone who already has the token, which is circular but also one copy too many.
 *      ANSI escapes are stripped: they are markup for a terminal, and the dashboard is
 *      not one.
 */

const MAX_LINES = 500;
const MAX_LINE = 2000;
// eslint-disable-next-line no-control-regex
const ANSI = /\[[0-9;]*[A-Za-z]/g;

const lines = [];
let seq = 0;
let attached = false;
const secrets = new Set();

/** Registers a string that must never appear in the buffer. */
function redact(value) {
  if (typeof value === 'string' && value.length >= 8) secrets.add(value);
}

function scrub(text) {
  let out = text.replace(ANSI, '');
  for (const s of secrets) out = out.split(s).join('«redacted»');
  return out;
}

function push(stream, chunk) {
  const text = scrub(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (!line.trim()) continue;
    seq += 1;
    lines.push({
      seq,
      at: new Date().toISOString(),
      stream,
      text: line.length > MAX_LINE ? `${line.slice(0, MAX_LINE)}…` : line,
    });
    if (lines.length > MAX_LINES) lines.shift();
  }
}

/**
 * Starts capturing. Idempotent, because a second call would tee the tee.
 *
 * @returns {Function} detach, for tests and for a clean shutdown
 */
function attach() {
  if (attached) return () => {};
  attached = true;
  const originals = [];
  for (const [stream, name] of [[process.stdout, 'out'], [process.stderr, 'err']]) {
    const original = stream.write.bind(stream);
    originals.push([stream, stream.write]);
    stream.write = (chunk, encoding, callback) => {
      // Capture must never be the reason a line does not reach the terminal, so the
      // buffer is best-effort and the real write is not inside the try.
      try { push(name, chunk); } catch { /* never */ }
      return original(chunk, encoding, callback);
    };
  }
  return () => {
    for (const [stream, write] of originals) stream.write = write;
    attached = false;
  };
}

/**
 * Lines newer than `after`, oldest first.
 *
 * `dropped` is how many the ring discarded before the first line returned: a client that
 * was away longer than MAX_LINES needs to know it is looking at a gap rather than at a
 * quiet period, and there is no way to tell from the lines themselves.
 */
function since(after = 0, limit = MAX_LINES) {
  const from = Number.isFinite(after) ? after : 0;
  const fresh = lines.filter((l) => l.seq > from);
  const kept = fresh.slice(-limit);
  const oldest = lines.length ? lines[0].seq : seq + 1;
  return {
    lines: kept,
    last_seq: seq,
    dropped: from > 0 && oldest > from + 1 ? oldest - from - 1 : 0,
  };
}

/** For tests. */
function reset() {
  lines.length = 0;
  seq = 0;
  secrets.clear();
}

module.exports = { attach, since, redact, reset, MAX_LINES };
