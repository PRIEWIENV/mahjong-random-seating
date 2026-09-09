'use strict';

/**
 * The §4.1 boundary, tested from both sides.
 *
 * The freeze only means anything if the set of frozen things is exactly the set that
 * could change the outcome. Too small and a manipulable parameter is left loose; too
 * large and the organiser eventually has a legitimate reason to edit a tagged file,
 * which is the habit the freeze exists to prevent. Both directions are checked here.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { load } = require('../server/config');
const { loadRuntime, DEFAULTS } = require('../server/runtime');
const { ENCODING_LIMITS } = require('../generate.js');
const { makeDataDir, cleanup } = require('./helpers');

/** Rewrite protocol.json in a throwaway data dir, then try to load it. */
function withProtocol(mutate) {
  const fx = makeDataDir();
  const file = path.join(fx.dataDir, 'protocol.json');
  const p = JSON.parse(fs.readFileSync(file, 'utf8'));
  mutate(p);
  fs.writeFileSync(file, JSON.stringify(p, null, 2));
  try {
    return { cfg: load({ dataDir: fx.dataDir }), fx };
  } finally {
    cleanup(fx.dir);
  }
}

const failsWith = (mutate, re) =>
  assert.throws(() => withProtocol(mutate), re);

// ---------------------------------------------------------------------------
// what must be frozen
// ---------------------------------------------------------------------------

test('chain_public_key is required — the hash alone is not a pin (§4)', () => {
  failsWith((p) => { delete p.chain_public_key; }, /chain_public_key/);
  failsWith((p) => { p.chain_public_key = 'nothex'; }, /chain_public_key/);
  // A 64-char value is the shape of a chain hash, not a G1 or G2 group key. Accepting
  // it would pass a wrong-but-plausible value straight through to drand-client.
  failsWith((p) => { p.chain_public_key = 'a'.repeat(64); }, /chain_public_key/);
});

test('a G2 (192 hex) chain public key is accepted as well as G1 (96)', () => {
  const { cfg } = withProtocol((p) => { p.chain_public_key = 'a'.repeat(192); });
  assert.equal(cfg.protocol.chain_public_key.length, 192);
});

test('user_input_max is required and bounded by the one-byte encoding (§7)', () => {
  failsWith((p) => { delete p.user_input_max; }, /user_input_max/);
  failsWith((p) => { p.user_input_max = ENCODING_LIMITS.user_input_max + 1; }, /user_input_max/);
});

test('a quorum that is not a majority is a freeze error (§8)', () => {
  failsWith((p) => { p.quorum = 6; }, /not a majority/);
  failsWith((p) => { p.quorum = 13; }, /quorum must be in/);
  const { cfg } = withProtocol((p) => { p.quorum = 7; });
  assert.equal(cfg.protocol.quorum, 7);
});

test('local_id bounds come from generate.js, not from a copy in the validator', () => {
  // The bound exists because §7 encodes local_id as one unsigned byte. If the encoding
  // ever changed, this is what would catch a validator left behind at the old number.
  assert.equal(ENCODING_LIMITS.local_id_max, 255);
  const fx = makeDataDir();
  const file = path.join(fx.dataDir, 'roster.json');
  const r = JSON.parse(fs.readFileSync(file, 'utf8'));
  r.players[0].local_id = ENCODING_LIMITS.local_id_max + 1;
  fs.writeFileSync(file, JSON.stringify(r, null, 2));
  assert.throws(() => load({ dataDir: fx.dataDir }), /local_id must be an integer in 1\.\.255/);
  cleanup(fx.dir);
});

// ---------------------------------------------------------------------------
// what must NOT be frozen
// ---------------------------------------------------------------------------

test('an operational key in protocol.json is refused, and named (§4.1)', () => {
  failsWith((p) => { p.drand_api = 'https://api.drand.sh'; }, /drand_api.*operational/s);
  failsWith((p) => { p.pantheon.frey_base_url = 'http://localhost:4001'; }, /frey_base_url.*operational/s);
  failsWith((p) => { p.pantheon.mimir_base_url = 'http://localhost:4002'; }, /mimir_base_url.*operational/s);
});

test('the error says where the setting belongs instead', () => {
  assert.throws(
    () => withProtocol((p) => { p.drand_api = 'https://api.drand.sh'; }),
    /runtime\.json → drand\.api/
  );
});

test('wind_shuffle_mode stays frozen — it decides what the sync writes', () => {
  failsWith((p) => { p.pantheon.wind_shuffle_mode = 'WIND_SHUFFLE_MODE_RANDOM'; }, /PRESCRIPTED/);
});

// ---------------------------------------------------------------------------
// runtime.json
// ---------------------------------------------------------------------------

test('runtime.json is optional and every key falls back to a default', () => {
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'mahjong-rt-'));
  const r = loadRuntime(dir, {});
  assert.equal(r.drand.api, DEFAULTS.drand.api);
  assert.equal(r.ui.status_poll_interval_ms, DEFAULTS.ui.status_poll_interval_ms);
  assert.equal(r.server.session_ttl_days, DEFAULTS.server.session_ttl_days);
  cleanup(dir);
});

test('a partial runtime.json overrides only what it names', () => {
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'mahjong-rt-'));
  fs.writeFileSync(path.join(dir, 'runtime.json'), JSON.stringify({ ui: { status_poll_interval_ms: 5000 } }));
  const r = loadRuntime(dir, {});
  assert.equal(r.ui.status_poll_interval_ms, 5000);
  assert.equal(r.drand.api, DEFAULTS.drand.api);
  cleanup(dir);
});

test('the configured drand api is always among the mirrors it is cross-checked against', () => {
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'mahjong-rt-'));
  fs.writeFileSync(path.join(dir, 'runtime.json'), JSON.stringify({
    drand: { api: 'https://mirror.example', mirrors: ['https://api.drand.sh'] },
  }));
  // §9's agreement check is meaningless if it covers a different set of endpoints from
  // the one the draw actually used.
  const r = loadRuntime(dir, {});
  assert.ok(r.drand.mirrors.includes('https://mirror.example'));
  cleanup(dir);
});

test('a typo in runtime.json is an error, not a silently ignored setting', () => {
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'mahjong-rt-'));
  fs.writeFileSync(path.join(dir, 'runtime.json'), JSON.stringify({ ui: { status_poll_interval: 5000 } }));
  assert.throws(() => loadRuntime(dir, {}), /unknown key ui\.status_poll_interval/);
  cleanup(dir);
});

test('operational settings can be overridden from the environment without a re-tag', () => {
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'mahjong-rt-'));
  const r = loadRuntime(dir, { DRAND_API: 'https://api2.drand.sh' });
  assert.equal(r.drand.api, 'https://api2.drand.sh');
  cleanup(dir);
});

test('/api/status serves the operational half so the bundle need not embed it', () => {
  const fx = makeDataDir();
  const cfg = load({ dataDir: fx.dataDir });
  assert.equal(cfg.runtime.pantheon.frey_base_url, 'http://127.0.0.1:14001');
  assert.equal(cfg.protocol.pantheon.frey_base_url, undefined);
  cleanup(fx.dir);
});
