/** Thin wrappers over the backend (PROTOCOL.md §6). */

async function req(url, opts = {}) {
  const res = await fetch(url, {
    credentials: 'same-origin',
    headers: { accept: 'application/json', ...(opts.body ? { 'content-type': 'application/json' } : {}) },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error(body?.message || `${url} → HTTP ${res.status}`);
    err.status = res.status;
    err.code = body?.error;
    err.body = body;
    throw err;
  }
  return body;
}

export const getStatus = () => req('/api/status');
export const getMe = () => req('/api/me');
export const getResult = () => req('/api/result');
export const getProtocol = () => req('/protocol.json');
export const createSession = (person_id, auth_token) => req('/api/session', { method: 'POST', body: { person_id, auth_token } });
export const postSubmit = (ciphertext) => req('/api/submit', { method: 'POST', body: { ciphertext } });
export const signOut = () => req('/api/session', { method: 'DELETE' });

/**
 * PANTHEON-INTEGRATION.md §2: the browser authenticates against Frey directly and
 * hands the backend only the resulting {person_id, auth_token}. This app never
 * receives a Pantheon password — which is why the call goes out to Frey from here
 * rather than being proxied.
 *
 * `stub` mode is the development stand-in used when no Frey is reachable; the server
 * refuses that endpoint in production.
 */
export async function authorize({ email, password, personId, authMode, freyBaseUrl, freyAuthorizePath }) {
  if (authMode === 'stub') {
    return req('/api/dev-authorize', { method: 'POST', body: { person_id: Number(personId) } });
  }
  const base = String(freyBaseUrl || '').replace(/\/+$/, '');
  // Served by /api/status rather than compiled in: a live Pantheon answers on
  // /v2/common.Frey/Authorize, and where it answers is operational configuration.
  const path = freyAuthorizePath || '/v2/common.Frey/Authorize';
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    const err = new Error('Pantheon did not recognise that email and password.');
    err.code = 'bad_credentials';
    throw err;
  }
  const j = await res.json();
  return { person_id: j.person_id ?? j.personId, auth_token: j.auth_token ?? j.authToken };
}

/**
 * SSE with a polling fallback (§6, UI-SPEC §5).
 *
 * "If the stream drops, fall back to polling /api/status and show a subdued
 * reconnecting note." Both run through one callback so the UI never has to care which
 * is feeding it.
 *
 * The cadence is served in /api/status (`status_poll_interval_ms`, runtime.json §4.2)
 * rather than compiled in here, so changing it is a config change on the server and not
 * a rebuild of a bundle that is committed and hash-pinned. Until the first status
 * arrives there is nothing to poll *for*, so the documented default only has to cover
 * the case where the very first request is what failed.
 */
const DEFAULT_POLL_MS = 15_000; // UI-SPEC §5; overridden by the first status received

export function subscribeStatus(onStatus, onConnection) {
  let es = null;
  let poll = null;
  let stopped = false;
  let pollMs = DEFAULT_POLL_MS;

  const relay = (s) => {
    // Adopt the server's cadence, and restart an already-running poll if it changed.
    const next = Number(s?.status_poll_interval_ms);
    if (Number.isFinite(next) && next > 0 && next !== pollMs) {
      pollMs = next;
      if (poll) { clearInterval(poll); poll = null; startPolling(); }
    }
    onStatus(s);
  };

  function startPolling() {
    if (poll || stopped) return;
    onConnection?.('polling');
    poll = setInterval(async () => {
      try { relay(await getStatus()); } catch { /* next tick retries */ }
    }, pollMs);
  }
  const stopPolling = () => { if (poll) { clearInterval(poll); poll = null; } };

  const connect = () => {
    if (stopped) return;
    try {
      es = new EventSource('/api/events');
    } catch {
      startPolling();
      return;
    }
    es.addEventListener('open', () => { stopPolling(); onConnection?.('live'); });
    es.addEventListener('status', (ev) => {
      try { relay(JSON.parse(ev.data)); } catch { /* ignore a malformed frame */ }
    });
    es.addEventListener('error', () => {
      // EventSource retries on its own; poll meanwhile so the view keeps moving.
      startPolling();
    });
  };

  getStatus().then(onStatus).catch(() => {});
  connect();

  return () => {
    stopped = true;
    stopPolling();
    try { es?.close(); } catch { /* already closed */ }
  };
}
