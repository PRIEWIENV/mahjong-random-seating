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

// ---------------------------------------------------------------------------
// the one caller that legitimately has no roster yet

test('a missing roster is a startup failure everywhere except the command that writes it', () => {
  const fx = makeDataDir();
  fs.rmSync(path.join(fx.dataDir, 'roster.json'));

  // The server, the finalisation job, generate.js: all of them get the refusal.
  assert.throws(() => load({ dataDir: fx.dataDir }), /roster\.json/);

  // tools/freeze.js is the exception, because writing that file is what it is for.
  const cfg = load({ dataDir: fx.dataDir, rosterOptional: true });
  assert.equal(cfg.roster, null);
  assert.match(cfg.rosterError.message, /roster\.json/);
  assert.equal(cfg.protocol.total_slots, 12, 'the rest of the configuration still loads');
  cleanup(fx.dir);
});

test('rosterOptional tolerates the placeholder roster, not a broken protocol', () => {
  // Copying roster.example.json is the other way to arrive with no usable roster: the
  // file exists, and every person_id in it is 0.
  const fx = makeDataDir();
  const placeholder = {
    pantheon_event_id: 0,
    players: Array.from({ length: 12 }, (_, i) => ({ local_id: i + 1, person_id: 0, title: 'Player' })),
  };
  fs.writeFileSync(path.join(fx.dataDir, 'roster.json'), JSON.stringify(placeholder));
  const cfg = load({ dataDir: fx.dataDir, rosterOptional: true });
  assert.equal(cfg.roster, null);
  assert.match(cfg.rosterError.message, /pantheon_event_id/);

  // It relaxes the roster and nothing else. A protocol this command cannot fix still
  // stops it dead, which is what keeps "freeze" from meaning "freeze whatever is lying
  // around".
  const p = JSON.parse(fs.readFileSync(path.join(fx.dataDir, 'protocol.json'), 'utf8'));
  p.target_round = 0;
  fs.writeFileSync(path.join(fx.dataDir, 'protocol.json'), JSON.stringify(p));
  assert.throws(() => load({ dataDir: fx.dataDir, rosterOptional: true }), /target_round/);
  cleanup(fx.dir);
});

test('with a roster present, rosterOptional changes nothing at all', () => {
  const fx = makeDataDir();
  const strict = load({ dataDir: fx.dataDir });
  const lenient = load({ dataDir: fx.dataDir, rosterOptional: true });
  assert.deepEqual(lenient.roster, strict.roster);
  assert.equal(lenient.rosterError, null);
  assert.equal(lenient.byLocalId.size, 12);
  cleanup(fx.dir);
});

test('/api/status serves the operational half so the bundle need not embed it', () => {
  const fx = makeDataDir();
  const cfg = load({ dataDir: fx.dataDir });
  assert.equal(cfg.runtime.pantheon.frey_base_url, 'http://127.0.0.1:14001');
  assert.equal(cfg.protocol.pantheon.frey_base_url, undefined);
  cleanup(fx.dir);
});

// ---------------------------------------------------------------------------
// trust_proxy (§4.2)
// ---------------------------------------------------------------------------

test('trust_proxy defaults to off', () => {
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'mahjong-rt-'));
  try {
    // Believing X-Forwarded-For when nothing in front sets it lets any caller claim any
    // address and collect a rate-limit allowance for each one.
    assert.equal(loadRuntime(dir, {}).server.trust_proxy, false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('trust_proxy has to be a boolean, not a string that looks like one', () => {
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'mahjong-rt-'));
  try {
    fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
    const write = (v) => fs.writeFileSync(
      path.join(dir, 'data', 'runtime.json'),
      JSON.stringify({ server: { trust_proxy: v } })
    );
    write(true);
    assert.equal(loadRuntime(path.join(dir, 'data'), {}).server.trust_proxy, true);
    // "false" is truthy, and a deployment that wrote it would be trusting the header
    // while believing it had turned the setting off.
    write('false');
    assert.throws(() => loadRuntime(path.join(dir, 'data'), {}), /trust_proxy must be true or false/);
    write(1);
    assert.throws(() => loadRuntime(path.join(dir, 'data'), {}), /trust_proxy must be true or false/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('trust_proxy is operational, so the frozen file may not carry it', () => {
  const { OPERATIONAL_KEYS } = require('../server/runtime');
  assert.ok(OPERATIONAL_KEYS['server.trust_proxy']);
});

// ---------------------------------------------------------------------------
// the interval between the cutoff and the key (section 9)
// ---------------------------------------------------------------------------

test('the cutoff and the round it waits for are separated, not simultaneous', () => {
  // The whole point of the field. With the two at the same instant there is no
  // moment in which the roll of who submitted is settled and the key does not yet
  // exist, so publishing that roll cannot show which came first.
  const fx = makeDataDir();
  const cfg = load({ dataDir: fx.dataDir });
  assert.equal(cfg.protocol.target_round_ms - cfg.protocol.cutoff_ms,
    cfg.protocol.reveal_gap_seconds * 1000);
  assert.ok(cfg.protocol.reveal_gap_seconds >= 60);
  cleanup(fx.dir);
});

test('a protocol.json whose three time fields disagree is refused', () => {
  // They are written together by tools/pick-round.js. A file where they disagree is
  // one somebody edited by hand, and the interval it promises is not the interval it
  // has.
  const fx = makeDataDir();
  const file = path.join(fx.dataDir, 'protocol.json');
  const p = JSON.parse(fs.readFileSync(file, 'utf8'));
  p.target_round_utc = p.submission_cutoff_utc; // the old behaviour: no interval
  fs.writeFileSync(file, JSON.stringify(p, null, 2));
  assert.throws(() => load({ dataDir: fx.dataDir }), /reveal_gap_seconds says 600/);
  cleanup(fx.dir);
});

test('an interval too short to publish anything in is refused', () => {
  const fx = makeDataDir({ protocol: { reveal_gap_seconds: 30 } });
  assert.throws(() => load({ dataDir: fx.dataDir }), /at least 60/);
  cleanup(fx.dir);
});

test('a missing interval names the command that writes it', () => {
  // Every existing protocol.json predates this field, so the error has to say what
  // to run rather than only what is wrong.
  const fx = makeDataDir();
  const file = path.join(fx.dataDir, 'protocol.json');
  const p = JSON.parse(fs.readFileSync(file, 'utf8'));
  delete p.reveal_gap_seconds;
  fs.writeFileSync(file, JSON.stringify(p, null, 2));
  assert.throws(() => load({ dataDir: fx.dataDir }), /pick-round/);
  cleanup(fx.dir);
});

test('the shipped example carries an interval, so a copy of it is not silently wrong', () => {
  const example = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', 'data', 'protocol.example.json'), 'utf8'));
  assert.equal(example.reveal_gap_seconds, 600);
  assert.equal(
    Date.parse(example.target_round_utc) - Date.parse(example.submission_cutoff_utc),
    600_000
  );
});
