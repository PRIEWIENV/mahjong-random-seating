'use strict';

/**
 * The SSE hub (server/events.js).
 *
 * The waiting stage is where players sit, possibly for days, and the draw itself is
 * performed by a different process (PROTOCOL.md §4.3). So this hub is the only thing
 * that carries a finished result to an open page. Its failures are quieter than they
 * look: a stream that stops updating degrades to polling and merely feels slow, but a
 * client left in the set after its socket closed leaks, and a heartbeat that never
 * stops keeps a timer alive for a server with nobody on it.
 *
 * §9's non-negotiable also passes through here — a broadcast is the easiest of the
 * three places to leak a payload by accident, so what goes out is pinned too.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { EventHub, HEARTBEAT_MS } = require('../server/events');

/** Stands in for an http response: records what was written, and can refuse to be. */
function fakeRes() {
  const res = new EventEmitter();
  res.chunks = [];
  res.head = null;
  res.ended = false;
  res.broken = false;
  res.writeHead = (status, headers) => { res.head = { status, headers }; return res; };
  res.write = (s) => {
    if (res.broken) throw new Error('socket closed');
    res.chunks.push(s);
    return true;
  };
  res.end = () => { res.ended = true; };
  res.text = () => res.chunks.join('');
  /** Parsed status frames, in order. */
  res.frames = () => res.chunks
    .filter((c) => c.startsWith('event: status\n'))
    .map((c) => JSON.parse(c.slice(c.indexOf('data: ') + 6).trim()));
  return res;
}

// ---------------------------------------------------------------------------
// attaching
// ---------------------------------------------------------------------------

test('a new stream gets the SSE headers a proxy has to be told about', () => {
  const hub = new EventHub();
  const res = fakeRes();
  hub.add(res, new EventEmitter());

  assert.equal(hub.size, 1);
  assert.equal(res.head.status, 200);
  assert.match(res.head.headers['content-type'], /text\/event-stream/);
  assert.equal(res.head.headers['cache-control'], 'no-store');
  // nginx honours this on its own, which is why the deployment works even when the
  // proxy config forgets to disable buffering. Losing it is silent.
  assert.equal(res.head.headers['x-accel-buffering'], 'no');
  // The browser's reconnect delay, sent before anything else.
  assert.match(res.text(), /^retry: 5000\n\n/);
  hub.close();
});

test('a stream that arrives after the last broadcast is caught up immediately', () => {
  // Otherwise a player who opens the page between two status changes sees nothing at
  // all until the next one, which on a quiet day is fifteen seconds of blank.
  const hub = new EventHub();
  hub.broadcast({ phase: 'open', submitted_count: 3 });

  const res = fakeRes();
  hub.add(res, new EventEmitter());
  assert.deepEqual(res.frames(), [{ phase: 'open', submitted_count: 3 }]);
  hub.close();
});

test('a stream that arrives before any broadcast is not sent a null status', () => {
  const hub = new EventHub();
  const res = fakeRes();
  hub.add(res, new EventEmitter());
  assert.deepEqual(res.frames(), []);
  hub.close();
});

// ---------------------------------------------------------------------------
// broadcasting
// ---------------------------------------------------------------------------

test('every attached stream gets the status, and only the status', () => {
  const hub = new EventHub();
  const a = fakeRes(); const b = fakeRes();
  hub.add(a, new EventEmitter());
  hub.add(b, new EventEmitter());

  const status = { phase: 'open', submitted_count: 1, submitted_local_ids: [4] };
  assert.equal(hub.broadcast(status), true);
  assert.deepEqual(a.frames(), [status]);
  assert.deepEqual(b.frames(), [status]);
  // §9: the hub forwards the object it is given and adds nothing. If a payload ever
  // reaches a browser it will be because a caller put it in the status, not because
  // this widened it on the way out.
  assert.equal(a.text().includes('user_input'), false);
  hub.close();
});

test('an identical status is not re-sent', () => {
  // The status is pushed on a timer as well as on submission, so most ticks carry
  // nothing new. Re-sending them would wake every phone for no reason.
  const hub = new EventHub();
  const res = fakeRes();
  hub.add(res, new EventEmitter());

  assert.equal(hub.broadcast({ phase: 'open', n: 1 }), true);
  assert.equal(hub.broadcast({ phase: 'open', n: 1 }), false);
  assert.equal(hub.broadcast({ phase: 'open', n: 2 }), true);
  assert.deepEqual(res.frames(), [{ phase: 'open', n: 1 }, { phase: 'open', n: 2 }]);
  hub.close();
});

test('a status that changes back is sent again', () => {
  // Suppression compares against the last payload, not against everything ever sent.
  const hub = new EventHub();
  const res = fakeRes();
  hub.add(res, new EventEmitter());
  hub.broadcast({ n: 1 });
  hub.broadcast({ n: 2 });
  assert.equal(hub.broadcast({ n: 1 }), true);
  assert.equal(res.frames().length, 3);
  hub.close();
});

test('broadcasting with nobody listening still records what to replay', () => {
  const hub = new EventHub();
  assert.equal(hub.broadcast({ phase: 'done' }), true);
  const res = fakeRes();
  hub.add(res, new EventEmitter());
  assert.deepEqual(res.frames(), [{ phase: 'done' }]);
  hub.close();
});

// ---------------------------------------------------------------------------
// leaving
// ---------------------------------------------------------------------------

test('a closed request detaches its stream', () => {
  const hub = new EventHub();
  const req = new EventEmitter();
  const res = fakeRes();
  hub.add(res, req);
  assert.equal(hub.size, 1);

  req.emit('close');
  assert.equal(hub.size, 0);
  assert.equal(res.ended, true);
  hub.close();
});

test('detaching twice is harmless', () => {
  const hub = new EventHub();
  const req = new EventEmitter();
  const detach = hub.add(fakeRes(), req);
  detach();
  req.emit('close');
  detach();
  assert.equal(hub.size, 0);
  hub.close();
});

test('a stream whose socket has gone is dropped on the next write', () => {
  // A client can vanish without either event firing — a laptop lid, a dead tunnel.
  // The write is what discovers it, and it must not throw into the caller.
  const hub = new EventHub();
  const alive = fakeRes(); const dead = fakeRes();
  hub.add(alive, new EventEmitter());
  hub.add(dead, new EventEmitter());
  dead.broken = true;

  assert.doesNotThrow(() => hub.broadcast({ phase: 'open' }));
  assert.equal(hub.size, 1);
  assert.deepEqual(alive.frames(), [{ phase: 'open' }]);
  hub.close();
});

test('close ends every stream and forgets them', () => {
  const hub = new EventHub();
  const a = fakeRes(); const b = fakeRes();
  hub.add(a, new EventEmitter());
  hub.add(b, new EventEmitter());
  hub.close();
  assert.equal(hub.size, 0);
  assert.equal(a.ended, true);
  assert.equal(b.ended, true);
});

// ---------------------------------------------------------------------------
// the heartbeat
// ---------------------------------------------------------------------------

test('the heartbeat runs only while somebody is listening', async () => {
  const hub = new EventHub({ heartbeatMs: 10 });
  assert.equal(hub.timer, null, 'a hub with no clients should hold no timer');

  const req = new EventEmitter();
  const res = fakeRes();
  hub.add(res, req);
  assert.notEqual(hub.timer, null);

  await new Promise((r) => setTimeout(r, 35));
  assert.ok(res.text().includes(': keepalive'), 'no keepalive was written');

  req.emit('close');
  assert.equal(hub.timer, null, 'the last client left and the timer stayed');
  hub.close();
});

test('a second stream does not start a second heartbeat', () => {
  const hub = new EventHub({ heartbeatMs: 10 });
  const r1 = new EventEmitter(); const r2 = new EventEmitter();
  hub.add(fakeRes(), r1);
  const first = hub.timer;
  hub.add(fakeRes(), r2);
  assert.equal(hub.timer, first);

  // And one of two leaving does not stop it for the other.
  r1.emit('close');
  assert.equal(hub.timer, first);
  r2.emit('close');
  assert.equal(hub.timer, null);
  hub.close();
});

test('a keepalive to a dead socket drops it rather than throwing on a timer', async () => {
  // This one runs inside setInterval, where a throw has no caller to catch it.
  const hub = new EventHub({ heartbeatMs: 10 });
  const res = fakeRes();
  hub.add(res, new EventEmitter());
  res.broken = true;
  await new Promise((r) => setTimeout(r, 35));
  assert.equal(hub.size, 0);
  hub.close();
});

test('the default cadence comes from runtime.js, not from a number written twice', () => {
  const { DEFAULTS } = require('../server/runtime');
  assert.equal(HEARTBEAT_MS, DEFAULTS.server.sse_heartbeat_ms);
  assert.equal(new EventHub().heartbeatMs, DEFAULTS.server.sse_heartbeat_ms);
  // Under the 30 s idle timeout proxies usually apply, or the stream is closed for
  // being quiet and the page falls back to polling for no reason.
  assert.ok(HEARTBEAT_MS < 30_000);
});
