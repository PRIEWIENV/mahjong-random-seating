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

const { load, loadEnvFile } = require('../server/config');
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

test('the example runtime.json loads exactly as shipped', () => {
  // The README tells an operator to copy it and change what they need, and it could not be
  // copied at all. Its notes sit beside the settings they explain, as `_frey_public_url`
  // inside `pantheon`, and the loader only skipped `_` keys at the top level. Nothing
  // loaded the example, so nothing noticed until a real deployment refused to start.
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'mahjong-rt-'));
  fs.copyFileSync(path.join(__dirname, '..', 'data', 'runtime.example.json'), path.join(dir, 'runtime.json'));
  const r = loadRuntime(dir, {});
  assert.equal(r.pantheon.frey_base_url, 'http://frey.pantheon.local:4004');
  assert.equal(r.server.trust_proxy, false);
  cleanup(dir);
});

test('a note inside a section is skipped and never becomes a setting, while a typo is still refused', () => {
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'mahjong-rt-'));
  fs.writeFileSync(path.join(dir, 'runtime.json'), JSON.stringify({
    pantheon: { _frey_public_url: 'an explanation', frey_public_url: 'https://pantheon.example.com' },
  }));
  const r = loadRuntime(dir, {});
  assert.equal(r.pantheon.frey_public_url, 'https://pantheon.example.com');
  assert.ok(!('_frey_public_url' in r.pantheon), 'a note must not reach the settings object');

  // The escape hatch is the underscore, not any unknown name.
  fs.writeFileSync(path.join(dir, 'runtime.json'), JSON.stringify({ pantheon: { frey_publc_url: 'x' } }));
  assert.throws(() => loadRuntime(dir, {}), /unknown key pantheon.frey_publc_url/);
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

test('the window origin is optional, validated when present, and refused when backwards', () => {
  // Optional: every protocol.json written before the field existed lacks it. Present:
  // it has to be a real instant before the cutoff, or the waiting page draws a bar that
  // runs backwards from a date nobody chose.
  const fx = makeDataDir({});
  const file = path.join(fx.dataDir, 'protocol.json');
  const p = JSON.parse(fs.readFileSync(file, 'utf8'));

  delete p.submission_opens_utc;
  fs.writeFileSync(file, JSON.stringify(p, null, 2));
  assert.ok(load({ dataDir: fx.dataDir }).protocol, 'absence must not be an error');

  fs.writeFileSync(file, JSON.stringify({ ...p, submission_opens_utc: 'the day before' }, null, 2));
  assert.throws(() => load({ dataDir: fx.dataDir }), /ISO-8601/);

  const after = new Date(Date.parse(p.submission_cutoff_utc) + 1000).toISOString();
  fs.writeFileSync(file, JSON.stringify({ ...p, submission_opens_utc: after }, null, 2));
  assert.throws(() => load({ dataDir: fx.dataDir }), /before submission_cutoff_utc/);
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

// ---------------------------------------------------------------------------
// .env, which only systemd was reading
// ---------------------------------------------------------------------------

/**
 * deploy/README.md section 2 has the operator write a `.env` holding everything that
 * makes a deployment real rather than a demo: the Pantheon base URLs and admin
 * credentials, the mirror repository and its token, ADMIN_TOKEN, NODE_ENV. Only the
 * systemd unit read it, through `EnvironmentFile=`. Every other launcher the same
 * document recommends (tmux, nohup, a reboot crontab, or just running the command the
 * README's Production section gives) started a process that had never seen any of it.
 *
 * The symptom is not a crash. It is a relay that serves the right pages, accepts every
 * submission, and mirrors none of them, which quietly removes the section 5 property
 * that stops an organiser dropping an inconvenient ciphertext after the fact.
 */

const os = require('node:os');
const envDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mahjong-env-'));

test('a .env beside the checkout is read', () => {
  const dir = envDir();
  try {
    fs.writeFileSync(path.join(dir, '.env'), 'MIRROR_REPO=someone/their-event\nADMIN_TOKEN=abc123\n');
    delete process.env.MIRROR_REPO;
    delete process.env.ADMIN_TOKEN;
    assert.equal(loadEnvFile(dir), path.join(dir, '.env'));
    assert.equal(process.env.MIRROR_REPO, 'someone/their-event');
    assert.equal(process.env.ADMIN_TOKEN, 'abc123');
  } finally {
    delete process.env.MIRROR_REPO;
    delete process.env.ADMIN_TOKEN;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('what is already in the environment wins over the file', () => {
  // `PORT=9000 node server/server.js` is documented and has to keep meaning what it
  // says, and an operator overriding one value at a prompt is doing it deliberately.
  const dir = envDir();
  try {
    fs.writeFileSync(path.join(dir, '.env'), 'PANTHEON_MODE=twirp\n');
    process.env.PANTHEON_MODE = 'stub';
    loadEnvFile(dir);
    assert.equal(process.env.PANTHEON_MODE, 'stub');
  } finally {
    delete process.env.PANTHEON_MODE;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('no .env is normal, and silent', () => {
  // Development runs have none, and the freeze contains none.
  const dir = envDir();
  try {
    assert.equal(loadEnvFile(dir), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a .env that cannot be read stops the process rather than half-configuring it', () => {
  // Continuing would mean running with some of the settings, and the half that went
  // missing is announced nowhere.
  const dir = envDir();
  try {
    fs.mkdirSync(path.join(dir, '.env')); // a directory where a file should be
    assert.throws(() => loadEnvFile(dir, { error() {} }));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * The warning exists so a deployment is told, before a player finds out, that browsers
 * have been given a Frey address they cannot reach. It only ever looked at IP literals,
 * which made it silent for the one value it most needed to catch: `frey.pantheon.local`
 * is the shipped default and is what a local Pantheon in Docker answers to. It resolves
 * through an /etc/hosts entry on the box running the containers and nowhere else, and
 * what a player reports is a wrong password.
 */
test('a Frey address that resolves on one machine only is flagged', () => {
  const { freyPublicUrlIsLocal, DEFAULTS: D } = require('../server/runtime');
  const at = (url) => freyPublicUrlIsLocal({ pantheon: { frey_base_url: url, frey_public_url: null } });

  assert.equal(at(D.pantheon.frey_base_url), true, 'the shipped default is exactly this case');
  for (const url of [
    'http://frey.pantheon.local:4004',
    'http://frey.pantheon.internal:4004',
    'http://frey:4004',
    'http://mahjong.localdomain',
    'http://127.0.0.1:4004',
    'http://192.168.1.10:4004',
  ]) {
    assert.equal(at(url), true, `${url} should be flagged`);
  }
  // And a real address must not be, or the warning becomes noise a deployment learns
  // to ignore.
  for (const url of ['https://frey.example.com', 'https://pantheon.example.org:4004']) {
    assert.equal(at(url), false, `${url} must not be flagged`);
  }
});

/** assert.throws returns nothing, and these tests are about the message. */
function caught(fn) {
  try { fn(); } catch (err) { return err; }
  throw new assert.AssertionError({ message: 'expected a throw, and nothing was thrown' });
}

/**
 * The first thing a new operator sees when the deploy went wrong.
 *
 * This error used to say "copy the .example file, fill it in, and freeze it", which is
 * right on the machine where the event is prepared and actively harmful on a deployment
 * box: hand-writing protocol.json there produces a round that matches no tag, and the
 * tag is the whole of what a player is given to check against. The file is missing in
 * both places for the same reason — it is gitignored until the freeze commits it — so
 * the message has to name both situations and say which is which.
 */
test('a missing frozen file sends a deploying operator to the tag, not to the example', () => {
  const empty = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'no-freeze-'));
  const failed = caught(() => load({ dataDir: empty }));
  assert.match(failed.message, /missing .*protocol\.json/);
  assert.match(failed.message, /git checkout <tag>/, 'the deployment remedy must be a checkout');
  assert.match(failed.message, /git tag -l/, 'and it has to say how to find the tag');
  assert.match(failed.message, /pick-round|freeze\.js/, 'the preparing remedy is still named');
  assert.match(failed.message, /by hand/, 'and hand-writing it has to be called out as wrong');
  fs.rmSync(empty, { recursive: true, force: true });
});

test('the same guidance covers a roster that never made it into the tag', () => {
  // roster.json is the other half of the freeze and lands in exactly the same hole: a
  // clone of the default branch has protocol.json only if somebody committed it by hand.
  const fx = makeDataDir();
  fs.rmSync(path.join(fx.dataDir, 'roster.json'));
  const failed = caught(() => load({ dataDir: fx.dataDir }));
  assert.match(failed.message, /missing .*roster\.json/);
  assert.match(failed.message, /git checkout <tag>/);
  cleanup(fx.dir);
});

test('a configuration failure is an operator refusal, not a crash', () => {
  // server.js and finalise.js print err.message and exit 2 for these, and rethrow
  // anything else. Without the flag the remedy above arrived inside a stack trace, which
  // is how a message that says exactly what to run goes unread.
  const empty = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'no-freeze-'));
  assert.equal(caught(() => load({ dataDir: empty })).operator, true);
  fs.rmSync(empty, { recursive: true, force: true });

  const bad = caught(() => withProtocol((p) => { p.quorum = 2; }));
  assert.equal(bad.operator, true, 'a refused value is the operator’s to fix too');
});

// ---------------------------------------------------------------------------
// the twelfth round's rules (PROTOCOL.md §11)
// ---------------------------------------------------------------------------

test('an event with no final_round block at all still loads', () => {
  // Every protocol.json written before §11 existed lacks the block, including the copies
  // inside events/rounds/*/ archives. Absent means eleven rounds, which is exactly what
  // those files meant when they were written; refusing them would break the archives.
  const { cfg } = withProtocol((p) => { delete p.final_round; delete p.generate_final_script_ref; });
  assert.equal(cfg.protocol.final_round, undefined);
});

test('final_round.enabled must be said, not defaulted', () => {
  // Whether there is a twelfth round is a rule of the competition. Defaulting it either
  // way would mean a file that does not say could still produce, or suppress, a round.
  failsWith((p) => { delete p.final_round.enabled; }, /final_round\.enabled must be true or false/);
  failsWith((p) => { p.final_round.enabled = 'yes'; }, /final_round\.enabled must be true or false/);
  failsWith((p) => { p.final_round = []; }, /final_round must be an object/);
});

test('a disabled final round needs nothing else, and is not checked for anything else', () => {
  const { cfg } = withProtocol((p) => {
    p.final_round = { enabled: false };
    delete p.generate_final_script_ref;
  });
  assert.equal(cfg.protocol.final_round.enabled, false);
});

test('both final-round rules are pinned to one value each', () => {
  // They are hard-coded in generate-final.js too, and that is the point: protocol.json is
  // the file that gets tagged and quoted at people, so a value here that disagreed with
  // the script would be a published claim the code does not honour.
  failsWith((p) => { p.final_round.table_assignment = 'snake'; }, /table_assignment must be "rank_blocks"/);
  failsWith((p) => { delete p.final_round.table_assignment; }, /table_assignment must be "rank_blocks"/);
  failsWith((p) => { p.final_round.wind_draw = 'uniform'; }, /wind_draw must be "max_completion_then_uniform"/);
  failsWith((p) => { delete p.final_round.wind_draw; }, /wind_draw must be "max_completion_then_uniform"/);
});

test('a final round names the tagged script that will draw it', () => {
  // The same reason generate_script_ref exists: the algorithm is fixed before anybody
  // knows the standings. A final round with no named script is a rule written afterwards.
  failsWith((p) => { delete p.generate_final_script_ref; }, /generate_final_script_ref is missing/);
  failsWith((p) => { p.generate_final_script_ref = '  '; }, /generate_final_script_ref is missing/);
});

test('rank blocks need a field that divides into tables of four', () => {
  // The failure would otherwise surface as a short final table, after the round-robin had
  // already been played and there was nothing left to do about it.
  failsWith((p) => { p.total_slots = 10; }, /does not divide/);
});

test('the final beacon and the standings sort key are NOT frozen, and that is the point', () => {
  // F is chosen weeks after the freeze, at lock time, and lives in events/final/lock.json
  // where a timestamp can reach it. The sort key is a league decision. Freezing either
  // would be claiming to have committed in advance to something nobody had decided.
  assert.equal(DEFAULTS.pantheon.rating_order_by, 'rating');
  assert.equal(DEFAULTS.pantheon.rating_order, 'desc');
  failsWith((p) => { p.pantheon.rating_order_by = 'chips'; }, /operational setting and must not be frozen/);

  // ...and the runtime side validates the half of it that has only two legal values.
  const fx = makeDataDir({ runtime: { pantheon: { rating_order: 'sideways' } } });
  assert.throws(() => load({ dataDir: fx.dataDir }), /rating_order must be "asc" or "desc"/);
  cleanup(fx.dir);
});
