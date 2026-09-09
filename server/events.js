'use strict';

/**
 * Server-Sent Events hub for GET /api/events (PROTOCOL.md §6, UI-SPEC.md §5).
 *
 * The waiting stage is where most players will actually sit, possibly for days, and
 * UI-SPEC asks that it update itself rather than be refreshed. So status changes are
 * pushed; polling /api/status is the documented fallback when the stream drops, not
 * the primary path. Both cadences are operational settings in runtime.json (§4.2).
 *
 * Only the public status object is ever broadcast. What anyone submitted is not in it
 * — §9's non-negotiable is "not in an endpoint, not in a payload, not in a debug
 * header", and a broadcast is the easiest of the three to leak by accident.
 */

const { DEFAULTS } = require('./runtime');

// Under the usual 30 s idle timeout of proxies. Operational (§4.2) — a deployment
// behind something stricter changes runtime.json, not anything frozen.
const HEARTBEAT_MS = DEFAULTS.server.sse_heartbeat_ms;

class EventHub {
  constructor(opts = {}) {
    this.clients = new Set();
    this.lastPayload = null;
    this.heartbeatMs = opts.heartbeatMs ?? HEARTBEAT_MS;
    this.timer = null;
  }

  /** Attach an http response as an SSE stream. Returns a detach function. */
  add(res, req) {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      // Nginx/Caddy buffering would defeat the whole point of the stream.
      'x-accel-buffering': 'no',
    });
    res.write('retry: 5000\n\n');

    const client = { res };
    this.clients.add(client);
    if (this.lastPayload) this.#write(client, 'status', this.lastPayload);

    const detach = () => {
      if (!this.clients.has(client)) return;
      this.clients.delete(client);
      try { res.end(); } catch { /* already gone */ }
      if (this.clients.size === 0) this.#stopHeartbeat();
    };
    req?.on?.('close', detach);
    res.on('close', detach);
    res.on('error', detach);

    this.#startHeartbeat();
    return detach;
  }

  #write(client, event, data) {
    try {
      client.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch {
      this.clients.delete(client);
    }
  }

  /** Broadcast a status object. Repeated identical payloads are suppressed. */
  broadcast(status) {
    const json = JSON.stringify(status);
    if (json === this._lastJson) return false;
    this._lastJson = json;
    this.lastPayload = status;
    for (const c of [...this.clients]) this.#write(c, 'status', status);
    return true;
  }

  #startHeartbeat() {
    if (this.timer || this.clients.size === 0) return;
    this.timer = setInterval(() => {
      for (const c of [...this.clients]) {
        try { c.res.write(': keepalive\n\n'); } catch { this.clients.delete(c); }
      }
    }, this.heartbeatMs);
    this.timer.unref?.();
  }

  #stopHeartbeat() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  close() {
    for (const c of [...this.clients]) { try { c.res.end(); } catch { /* ignore */ } }
    this.clients.clear();
    this.#stopHeartbeat();
  }

  get size() { return this.clients.size; }
}

module.exports = { EventHub, HEARTBEAT_MS };
