'use strict';

/**
 * The sign-in classifier (client/api.js).
 *
 * PANTHEON-INTEGRATION.md §2 has the browser authenticate against Frey directly, so
 * this is the one request in the app whose failures nobody's server log ever sees. It
 * used to report every one of them as "Pantheon did not recognise that email and
 * password", which is true for exactly one of them and sends an operator hunting
 * through account settings for what is really a wrong base URL or a CSP entry.
 *
 * Every response body below was captured from a live Frey 1.28 (Pantheon dev instance,
 * docs/PANTHEON-INTEGRATION.md §6) rather than guessed, because guessing them wrong is
 * how the original bug got in.
 */

const test = require('node:test');
const assert = require('node:assert');

/** client/api.js is ESM; Node's module-syntax detection loads it from a .js file. */
async function api() {
  return import('../client/api.js');
}

/** Stand in for one fetch answer, then restore whatever was there. */
function withFetch(impl, fn) {
  const saved = globalThis.fetch;
  globalThis.fetch = impl;
  return fn().finally(() => { globalThis.fetch = saved; });
}

const jsonResponse = (status, body) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json' },
});

const CREDS = { email: 'seat-test-01@example.invalid', password: 'seat-test-pass-1', freyBaseUrl: 'http://frey.pantheon.local:4004' };

async function attempt(response, extra = {}) {
  const { authorize } = await api();
  return withFetch(async () => response(), async () => {
    try {
      return { ok: true, value: await authorize({ ...CREDS, ...extra }) };
    } catch (err) {
      return { ok: false, code: err.code, message: err.message, detail: err.detail };
    }
  });
}

test('a real Frey answer signs the player in', async () => {
  const r = await attempt(() => jsonResponse(200, {
    personId: 35,
    authToken: '192bf8083ba604a5c0eb209efcd1fc9761dc57f133c68a29f76adfcd9c39f07cadca74f7a843d8b669ca475afcb8bb22',
  }));
  assert.equal(r.ok, true, r.message);
  assert.equal(r.value.person_id, 35);
  assert.match(r.value.auth_token, /^[a-f0-9]{96}$/);
});

test('snake_case is accepted too, since only the responses are camelCase', async () => {
  const r = await attempt(() => jsonResponse(200, { person_id: 7, auth_token: 'abc' }));
  assert.equal(r.ok, true);
  assert.equal(r.value.person_id, 7);
});

test('a wrong password is the one case that is actually about credentials', async () => {
  const r = await attempt(() => jsonResponse(400, { code: 'invalid_argument', msg: 'Password check failed' }));
  assert.equal(r.code, 'bad_credentials');
  assert.match(r.detail, /400 invalid_argument: Password check failed/);
});

test('an email Frey has never seen is named as such, not as a wrong password', async () => {
  const r = await attempt(() => jsonResponse(404, { code: 'not_found', msg: 'Person not found in database' }));
  assert.equal(r.code, 'unknown_account');
});

test('a wrong service name is a deployment fault, not a player fault', async () => {
  // What Frey answers for /v2/frey.Frey/Authorize — the name this app guessed first.
  const r = await attempt(() => jsonResponse(404, { code: 'bad_route', msg: 'no handler for path POST /v2/frey.Frey/Authorize.' }));
  assert.equal(r.code, 'pantheon_misconfigured');
});

test('a 404 that is not Twirp at all is still a deployment fault', async () => {
  // A wrong version prefix misses the Twirp router entirely and Pantheon's nginx
  // answers with HTML. There is no credential in that exchange to be wrong about.
  const r = await attempt(() => new Response('<html>\n<head><title>404 Not Found</title></head>\n', {
    status: 404, headers: { 'content-type': 'text/html' },
  }));
  assert.equal(r.code, 'pantheon_misconfigured');
  assert.match(r.detail, /404/);
});

test('a 200 carrying no login is a deployment fault', async () => {
  const r = await attempt(() => jsonResponse(200, { hello: 'captive portal' }));
  assert.equal(r.code, 'pantheon_misconfigured');
});

test('a Pantheon error is reported as one', async () => {
  // Frey's metrics middleware awaits Hugin on every request; with Hugin down, every
  // call returns 500 (PANTHEON-INTEGRATION.md §6). That is not a bad password either.
  const r = await attempt(() => jsonResponse(500, { code: 'internal', msg: 'fetch failed' }));
  assert.equal(r.code, 'pantheon_error');
});

test('a request that never got an answer names the address it could not reach', async () => {
  // DNS, a refused connection, a CSP without the Frey origin, or mixed content on an
  // https page all land here, and none of them reaches any server that could log it.
  const r = await attempt(() => { throw new TypeError('Failed to fetch'); });
  assert.equal(r.code, 'pantheon_unreachable');
  assert.match(r.message, /frey\.pantheon\.local:4004/);
  assert.match(r.detail, /TypeError: Failed to fetch/);
});

test('the frey path is taken from the server, not compiled in', async () => {
  let seen = null;
  const { authorize } = await api();
  await withFetch(async (url) => { seen = url; return jsonResponse(200, { personId: 1, authToken: 'x' }); },
    () => authorize({ ...CREDS, freyAuthorizePath: '/v2/common.Frey/Authorize' }));
  assert.equal(seen, 'http://frey.pantheon.local:4004/v2/common.Frey/Authorize');
});

test('stub mode never touches Frey', async () => {
  let seen = null;
  const { authorize } = await api();
  await withFetch(async (url) => { seen = url; return jsonResponse(200, { person_id: 1001, auth_token: 't' }); },
    () => authorize({ authMode: 'stub', personId: '1001', freyBaseUrl: 'http://frey.pantheon.local:4004' }));
  assert.equal(seen, '/api/dev-authorize');
});

// ---------------------------------------------------------------------------
// signInProblem: what the page says about a failed sign-in, and what it must not say
// ---------------------------------------------------------------------------

/** An error the way req() in client/api.js builds one from a non-2xx answer. */
function relayAnswer(status, body) {
  const err = new Error(body?.message || `HTTP ${status}`);
  err.status = status;
  err.code = body?.error;
  err.body = body;
  return err;
}

test('nothing but a refusal of the credentials reads as a wrong password', async () => {
  // The first production sign-in failed with "Pantheon did not recognise that email and
  // password". The password was right. What the page could not tell apart from a wrong
  // password: nginx answering for a relay that was down, the relay's shared rate limit,
  // a 500, a network failure on the way to it, and a cookie the browser would not keep.
  const { signInProblem } = await api();
  const cases = [
    ['nginx 502 with the relay down (HTML, no JSON)', relayAnswer(502, null), 'relay_unreachable'],
    ['nginx 504', relayAnswer(504, null), 'relay_unreachable'],
    ['429 from the rate limit twelve people share behind one proxy',
      relayAnswer(429, { error: 'rate_limited', message: 'Too many attempts; wait a minute.' }), 'rate_limited'],
    ['500 from the relay', relayAnswer(500, { error: 'internal' }), 'relay_error'],
    ['no answer from the relay at all',
      Object.assign(new Error('Could not reach the draw server'), { code: 'relay_unreachable', detail: 'TypeError: Failed to fetch' }),
      'relay_unreachable'],
    ['sign-in over plain http in production',
      relayAnswer(400, { error: 'plain_http', message: 'This page reached the draw server over plain http.' }), 'plain_http'],
    ['a cookie the browser did not keep', Object.assign(new Error('x'), { code: 'session_not_kept' }), 'session_not_kept'],
    ['503 because the relay could not reach Pantheon',
      relayAnswer(503, { error: 'pantheon_unavailable', message: 'Cannot reach Pantheon right now.' }), 'pantheon_unavailable'],
    ['an answer with a code nobody expected', relayAnswer(418, { error: 'teapot' }), 'unexpected'],
  ];
  for (const [label, err, kind] of cases) {
    const p = signInProblem(err);
    assert.equal(p.kind, kind, label);
    assert.notEqual(p.kind, 'bad_credentials', `${label} must never read as a wrong password`);
    assert.ok(p.detail, `${label} must carry a technical line: ${JSON.stringify(p)}`);
  }

  // The two that really are about the credentials, and the one that is neither.
  assert.equal(signInProblem(relayAnswer(401, { error: 'bad_credentials', message: 'Pantheon did not recognise that email and password.' })).kind, 'bad_credentials');
  assert.equal(signInProblem(Object.assign(new Error('x'), { code: 'unknown_account' })).kind, 'unknown_account');
  const outsider = signInProblem(relayAnswer(403, { error: 'not_registered', message: 'That account is not registered for this event.' }));
  assert.equal(outsider.kind, 'not_registered');
  assert.equal(outsider.detail, null, 'not being in the twelve is information, not a fault to forward');
});

test('the relay not answering at all is a coded error, not a bare TypeError', async () => {
  // fetch() rejects with a TypeError when nothing answers. Left as it was, that reached
  // the sign-in stage with no code and no status and fell through to "wrong password".
  const { getMe } = await api();
  await withFetch(async () => { throw new TypeError('Failed to fetch'); }, async () => {
    await assert.rejects(getMe(), (err) =>
      err.code === 'relay_unreachable' && /draw server/.test(err.message) && /Failed to fetch/.test(err.detail));
  });
});
