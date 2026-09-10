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
    // Background refresh of the liveness figure shown on the waiting screen.
    health_poll_ms: 30_000,
  },
  pantheon: {
    // Pantheon's own docker compose publishes Mimir on 4001 and Frey on 4004. Both
    // container nginx configs match on server_name, and both have a catch-all that
    // answers 404, so this has to be a hostname Pantheon answers to and not an IP.
    frey_base_url: 'http://frey.pantheon.local:4004',
    mimir_base_url: 'http://mimir.pantheon.local:4001',
    // PANTHEON-INTEGRATION.md: field and path naming drifts between Pantheon
    // deployments, so it is configuration rather than code. These values are the ones
    // confirmed against a live instance (Pantheon cdda3fc): both services mount Twirp
    // under /v2, and both protobuf packages are `common`.
    twirp_path_template: '/v2/{service}/{method}',
    frey_service: 'common.Frey',
    mimir_service: 'common.Mimir',
  },
  ui: {
    // UI-SPEC §5's documented fallback cadence when the SSE stream drops. Served to
    // the browser in /api/status so the number lives in one place, not two.
    status_poll_interval_ms: 15_000,
  },
  server: {
    sse_heartbeat_ms: 25_000, // under the usual 30 s idle timeout of proxies
    session_ttl_days: 30, // the submission window can be days long
    rate_limit_per_minute: 30,
  },
};

/** Keys that belong here and must never appear in the frozen protocol.json. */
const OPERATIONAL_KEYS = {
  drand_api: 'runtime.json → drand.api',
  drand_mirrors: 'runtime.json → drand.mirrors',
  'pantheon.frey_base_url': 'runtime.json → pantheon.frey_base_url',
  'pantheon.mimir_base_url': 'runtime.json → pantheon.mimir_base_url',
  'pantheon.twirp_path_template': 'runtime.json → pantheon.twirp_path_template',
  'pantheon.frey_service': 'runtime.json → pantheon.frey_service',
  'pantheon.mimir_service': 'runtime.json → pantheon.mimir_service',
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

  baseUrl('pantheon', 'frey_base_url', r.pantheon.frey_base_url);
  baseUrl('pantheon', 'mimir_base_url', r.pantheon.mimir_base_url);
  r.pantheon.frey_base_url = r.pantheon.frey_base_url.replace(/\/+$/, '');
  r.pantheon.mimir_base_url = r.pantheon.mimir_base_url.replace(/\/+$/, '');
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
  if (!r.drand.mirrors.includes(r.drand.api)) r.drand.mirrors = [r.drand.api, ...r.drand.mirrors];

  return r;
}

module.exports = { loadRuntime, DEFAULTS, OPERATIONAL_KEYS };
