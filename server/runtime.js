'use strict';

/**
 * Operational settings (PROTOCOL.md §4.2).
 *
 * The counterpart to config.js. config.js loads what is frozen; this loads what is
 * deliberately not, and the boundary between the two is drawn by one question:
 *
 *   Could changing this value, after submissions have opened, change the outcome or
 *   let somebody steer it?
 *
 * Everything here answers no. Which drand mirror the beacon is fetched from cannot
 * influence the result, because the chain is pinned by chain_hash AND chain_public_key
 * in the frozen protocol.json and every signature is verified against that key — so a
 * swapped or hostile endpoint can only fail loudly. The same goes for where Pantheon
 * lives on the host, how often the browser falls back to polling, and how long a
 * session cookie lasts.
 *
 * Keeping these out of the freeze is not tidiness. Freeze a mirror URL and a mirror
 * outage during the submission window has no remedy short of voiding the round, for a
 * failure that provably cannot change the answer. Worse, it teaches everyone that
 * frozen files get edited when the organiser has a good reason — which is the habit
 * the freeze exists to prevent.
 *
 * data/runtime.json is optional, and so is every key in it. Absent values fall back to
 * DEFAULTS below, so a deployment that is happy with the defaults ships no file at all.
 */

const fs = require('node:fs');
const path = require('node:path');

const DEFAULTS = {
  drand: {
    // Where beacons are fetched from.
    api: 'https://api.drand.sh',
    // Who the answer is cross-checked against before the draw is allowed to proceed.
    // §9: two mirrors disagreeing about a round is a stop-everything event, not
    // something to resolve by taking the first answer.
    mirrors: [
      'https://api.drand.sh',
      'https://api2.drand.sh',
      'https://api3.drand.sh',
      'https://drand.cloudflare.com',
    ],
    // Background refresh of the liveness figure shown on the waiting screen. The fast
    // cadence takes over in the last minutes before the cutoff: quicknet emits a beacon
    // every three seconds, and a round number that has not moved in half a minute is
    // indistinguishable from a page that has stopped working.
    health_poll_ms: 30_000,
    health_poll_fast_ms: 3_000,
  },
  pantheon: {
    // Pantheon's own docker compose publishes Mimir on 4001 and Frey on 4004. Both
    // container nginx configs match on server_name, and both have a catch-all that
    // answers 404, so this has to be a hostname Pantheon answers to and not an IP.
    frey_base_url: 'http://frey.pantheon.local:4004',
    mimir_base_url: 'http://mimir.pantheon.local:4001',
    // Frey is the one service reached from TWO vantage points. The backend calls it
    // from the server, where deploy/README.md rightly says to use localhost; the
    // BROWSER calls it too (PANTHEON-INTEGRATION.md §2), from a phone on which
    // localhost is that phone. One field cannot be right for both, and when it was one
    // field the failure was silent: the browser got a refused connection and the page
    // reported it as a wrong password. Null means "the same as frey_base_url", which is
    // correct whenever that URL is publicly resolvable.
    frey_public_url: null,
    // PANTHEON-INTEGRATION.md: field and path naming drifts between Pantheon
    // deployments, so it is configuration rather than code. These values are the ones
    // confirmed against a live instance (Pantheon cdda3fc): both services mount Twirp
    // under /v2, and both protobuf packages are `common`.
    twirp_path_template: '/v2/{service}/{method}',
    frey_service: 'common.Frey',
    mimir_service: 'common.Mimir',
    // What the page calls this draw, e.g. "2026 Spring Open". Normally left null and
    // read from Mimir at boot; set it here for a deployment whose Mimir is not
    // reachable from the server, or to override the name players see. Purely a label:
    // no value it can take changes who sits where, which is why it belongs on this
    // side of the boundary rather than in the freeze.
    event_title: null,
  },
  ui: {
    // UI-SPEC §5's documented fallback cadence when the SSE stream drops. Served to
    // the browser in /api/status so the number lives in one place, not two. Only used
    // when the stream is down, so it can afford to be brisk.
    status_poll_interval_ms: 5_000,
  },
  server: {
    sse_heartbeat_ms: 25_000, // under the usual 30 s idle timeout of proxies
    session_ttl_days: 30, // the submission window can be days long
    rate_limit_per_minute: 30,
    // How often the status is pushed down every open stream. The draw's phase is
    // derived from files that a *different* process writes (§4.3), so this poll is the
    // only thing that can carry a finished result to a browser.
    status_push_ms: 15_000,
    status_push_fast_ms: 2_000,
    // Whether X-Forwarded-For may be believed. Behind a reverse proxy — which is how
    // §10 deploys this — every connection arrives from 127.0.0.1, so per-IP rate
    // limiting silently becomes one shared allowance for everybody. Off by default
    // because believing that header when nothing sets it lets any caller claim any
    // address and have a limit of its own.
    trust_proxy: false,
    // Whether the server runs the draw job itself, on a timer (server/schedule.js).
    // On by default because the alternative is a deployment that serves the page
    // perfectly and never draws. Turn it off only where something else already runs
    // server/finalise.js on a schedule — a systemd timer or cron on a box you have
    // root on — so the two do not both fire.
    run_finalise: true,
    // How often the draw job runs, and, whoever runs it, the budget after which "the
    // beacon is out and the phase has not moved" stops being normal and becomes
    // something the organiser has to go and fix.
    finalise_interval_seconds: 60,
  },
};

/** Keys that belong here and must never appear in the frozen protocol.json. */
const OPERATIONAL_KEYS = {
  drand_api: 'runtime.json → drand.api',
  drand_mirrors: 'runtime.json → drand.mirrors',
  'pantheon.frey_base_url': 'runtime.json → pantheon.frey_base_url',
  'pantheon.mimir_base_url': 'runtime.json → pantheon.mimir_base_url',
  'pantheon.frey_public_url': 'runtime.json → pantheon.frey_public_url',
  'server.trust_proxy': 'runtime.json → server.trust_proxy',
  'server.finalise_interval_seconds': 'runtime.json → server.finalise_interval_seconds',
  'server.run_finalise': 'runtime.json → server.run_finalise',
  'pantheon.twirp_path_template': 'runtime.json → pantheon.twirp_path_template',
  'pantheon.frey_service': 'runtime.json → pantheon.frey_service',
  'pantheon.mimir_service': 'runtime.json → pantheon.mimir_service',
  'pantheon.event_title': 'runtime.json → pantheon.event_title',
};

function posInt(section, key, value) {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`runtime.json: ${section}.${key} must be a positive integer, got ${JSON.stringify(value)}`);
  }
  return value;
}

function baseUrl(section, key, value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`runtime.json: ${section}.${key} must be a non-empty URL`);
  }
  try {
    // eslint-disable-next-line no-new
    new URL(value);
  } catch {
    throw new Error(`runtime.json: ${section}.${key} is not a valid URL: ${JSON.stringify(value)}`);
  }
  return value.replace(/\/+$/, '');
}

function validate(r) {
  baseUrl('drand', 'api', r.drand.api);
  if (!Array.isArray(r.drand.mirrors) || r.drand.mirrors.length === 0) {
    throw new Error('runtime.json: drand.mirrors must be a non-empty array of base URLs');
  }
  r.drand.mirrors = r.drand.mirrors.map((m, i) => baseUrl('drand', `mirrors[${i}]`, m));
  r.drand.api = baseUrl('drand', 'api', r.drand.api);
  // The configured api is what tlock seals against, so it has to be one of the mirrors
  // the draw will later cross-check — otherwise the agreement check silently covers a
  // different set of endpoints than the one that mattered.
  if (!r.drand.mirrors.includes(r.drand.api)) r.drand.mirrors = [r.drand.api, ...r.drand.mirrors];
  posInt('drand', 'health_poll_ms', r.drand.health_poll_ms);
  posInt('drand', 'health_poll_fast_ms', r.drand.health_poll_fast_ms);

  baseUrl('pantheon', 'frey_base_url', r.pantheon.frey_base_url);
  baseUrl('pantheon', 'mimir_base_url', r.pantheon.mimir_base_url);
  r.pantheon.frey_base_url = r.pantheon.frey_base_url.replace(/\/+$/, '');
  r.pantheon.mimir_base_url = r.pantheon.mimir_base_url.replace(/\/+$/, '');
  if (r.pantheon.frey_public_url != null) {
    baseUrl('pantheon', 'frey_public_url', r.pantheon.frey_public_url);
    r.pantheon.frey_public_url = r.pantheon.frey_public_url.replace(/\/+$/, '');
  }
  if (r.pantheon.event_title != null) {
    if (typeof r.pantheon.event_title !== 'string' || r.pantheon.event_title.trim() === '') {
      throw new Error('runtime.json: pantheon.event_title must be a non-empty string, or null to read it from Mimir');
    }
    r.pantheon.event_title = r.pantheon.event_title.trim();
  }
  for (const k of ['twirp_path_template', 'frey_service', 'mimir_service']) {
    if (typeof r.pantheon[k] !== 'string' || r.pantheon[k] === '') {
      throw new Error(`runtime.json: pantheon.${k} must be a non-empty string`);
    }
  }
  if (!r.pantheon.twirp_path_template.includes('{service}') || !r.pantheon.twirp_path_template.includes('{method}')) {
    throw new Error('runtime.json: pantheon.twirp_path_template must contain {service} and {method}');
  }

  posInt('ui', 'status_poll_interval_ms', r.ui.status_poll_interval_ms);
  posInt('server', 'sse_heartbeat_ms', r.server.sse_heartbeat_ms);
  posInt('server', 'session_ttl_days', r.server.session_ttl_days);
  posInt('server', 'rate_limit_per_minute', r.server.rate_limit_per_minute);
  if (typeof r.server.trust_proxy !== 'boolean') {
    throw new Error(`runtime.json: server.trust_proxy must be true or false, got ${JSON.stringify(r.server.trust_proxy)}`);
  }
  posInt('server', 'finalise_interval_seconds', r.server.finalise_interval_seconds);
  if (typeof r.server.run_finalise !== 'boolean') {
    throw new Error(`runtime.json: server.run_finalise must be true or false, got ${JSON.stringify(r.server.run_finalise)}`);
  }
  posInt('server', 'status_push_ms', r.server.status_push_ms);
  posInt('server', 'status_push_fast_ms', r.server.status_push_fast_ms);
  return r;
}

/** Shallow-merge each known section over its defaults; unknown sections are rejected. */
function merge(file) {
  const out = {};
  for (const section of Object.keys(DEFAULTS)) {
    out[section] = { ...DEFAULTS[section], ...(file[section] || {}) };
    for (const k of Object.keys(file[section] || {})) {
      if (!(k in DEFAULTS[section])) {
        // A typo in an operational setting is silent otherwise, and only shows up as
        // "the timeout I configured did nothing".
        throw new Error(`runtime.json: unknown key ${section}.${k}`);
      }
    }
  }
  for (const k of Object.keys(file)) {
    if (k.startsWith('_')) continue; // _comment and friends
    if (!(k in DEFAULTS)) throw new Error(`runtime.json: unknown section "${k}"`);
  }
  return out;
}

/**
 * @param {string} dataDir directory holding runtime.json, if there is one
 * @param {object} env process.env — a few settings accept an override for deployment
 */
function loadRuntime(dataDir, env = process.env) {
  const file = path.join(dataDir, 'runtime.json');
  let raw = {};
  if (fs.existsSync(file)) {
    try {
      raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      throw new Error(`runtime.json: ${err.message}`);
    }
  }
  const r = validate(merge(raw));

  // Env overrides for the two things a deployment most often needs to point elsewhere
  // without editing a file. Neither is frozen, so neither needs a re-tag.
  if (env.DRAND_API) r.drand.api = baseUrl('drand', 'api', env.DRAND_API);
  if (env.PANTHEON_FREY_URL) r.pantheon.frey_base_url = baseUrl('pantheon', 'frey_base_url', env.PANTHEON_FREY_URL);
  if (env.PANTHEON_MIMIR_URL) r.pantheon.mimir_base_url = baseUrl('pantheon', 'mimir_base_url', env.PANTHEON_MIMIR_URL);
  if (env.PANTHEON_EVENT_TITLE) r.pantheon.event_title = env.PANTHEON_EVENT_TITLE.trim() || null;
  if (env.PANTHEON_FREY_PUBLIC_URL) {
    r.pantheon.frey_public_url = baseUrl('pantheon', 'frey_public_url', env.PANTHEON_FREY_PUBLIC_URL).replace(/\/+$/, '');
  }
  // The scheduler, for the two cases where editing a file is the wrong shape: a
  // rehearsal that wants a faster tick, and a box where cron already runs the job.
  if (env.FINALISE_INTERVAL_SECONDS) {
    const n = Number(env.FINALISE_INTERVAL_SECONDS);
    if (!Number.isInteger(n) || n < 1) {
      throw new Error(
        `FINALISE_INTERVAL_SECONDS must be a positive whole number of seconds, got ${env.FINALISE_INTERVAL_SECONDS}`);
    }
    r.server.finalise_interval_seconds = n;
  }
  if (env.RUN_FINALISE !== undefined && env.RUN_FINALISE !== '') {
    r.server.run_finalise = !/^(0|false|no|off)$/i.test(env.RUN_FINALISE);
  }
  if (!r.drand.mirrors.includes(r.drand.api)) r.drand.mirrors = [r.drand.api, ...r.drand.mirrors];

  return r;
}

/**
 * The Frey URL to hand the BROWSER. Falls back to the backend's own, which is right
 * whenever that address is publicly resolvable and wrong in exactly one way — a
 * loopback or private address that means the server here and the player's own device
 * there. `freyPublicUrlIsLocal` names that case so a deployment can be told before a
 * player finds it.
 */
function freyPublicUrl(runtime) {
  return runtime.pantheon.frey_public_url || runtime.pantheon.frey_base_url;
}

const LOCAL_HOST = /^(localhost|127\.|0\.0\.0\.0$|\[?::1\]?$|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/i;

/**
 * A name that resolves on one machine and nowhere a player will be.
 *
 * The check above only ever looked at IP literals, and so was silent for the one value
 * it most needed to catch: `frey.pantheon.local`, which is the shipped default and what
 * a local Pantheon in Docker answers to. It resolves through an `/etc/hosts` entry on
 * the box running the containers and nowhere else, so a browser is told to sign in at an
 * address it cannot reach, and the symptom a player reports is a wrong password.
 *
 * A bare hostname with no dot is the same case, from the other direction: it resolves by
 * whatever search domain the machine happens to have.
 */
const LOCAL_NAME = /^[^.]+$|\.(local|internal|localdomain|lan|home|home\.arpa)$/i;

function freyPublicUrlIsLocal(runtime) {
  try {
    const { hostname } = new URL(freyPublicUrl(runtime));
    return LOCAL_HOST.test(hostname) || LOCAL_NAME.test(hostname);
  } catch {
    return false;
  }
}

module.exports = { loadRuntime, DEFAULTS, OPERATIONAL_KEYS, freyPublicUrl, freyPublicUrlIsLocal };
