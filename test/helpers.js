'use strict';

/** Shared fixtures. */

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const QUICKNET_HASH = '52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971';
const QUICKNET_PK =
  '83cf0f2896adee7eb8b5f01fcad3912212c437e0073e911fb90022d3e760183c8c4b450b6a0a6c3ac6a5776a2d10645' +
  '10d1fec758c921cc22b0e17e63aaf4bcb5ed66304de9cf809bd274ca73bab4af5a6e9c76a4bc09e76eae8991ef5ece45a';

// A real quicknet signature, used wherever a well-formed one is needed offline.
const SAMPLE_SIG =
  '98217fc1a119b9e1cbc9bf369618031c8f18764c538061a6fa13378be589a4af70df841446c20f791e7ecc7e69c043b2';

const TITLES = ['阿明', '小美', '老陈', '阿杰', '小婷', '大伟', '阿芳', '志强', '小雨', '建国', '慧敏', '文彬'];

/** Roster of n players; person_id is deterministic so tests can sign in as anyone. */
function makeRoster(n = 12, eventId = 42) {
  return {
    pantheon_event_id: eventId,
    players: Array.from({ length: n }, (_, i) => ({
      local_id: i + 1,
      person_id: 1000 + i + 1,
      title: TITLES[i] || `Player ${i + 1}`,
    })),
  };
}

function makeProtocol(over = {}) {
  return {
    drand_chain: 'quicknet',
    chain_hash: QUICKNET_HASH,
    chain_public_key: QUICKNET_PK,
    target_round: 1_000_000,
    submission_cutoff_utc: new Date(Date.now() + 3_600_000).toISOString(),
    quorum: 8,
    total_slots: 12,
    user_input_max: 255,
    seed_domain_separation: 'mahjong-seating-v1',
    schedule_template_ref: 'data/schedule_template.json@test',
    generate_script_ref: 'generate.js@test',
    // Only the frozen half (§4.1). Base URLs are operational and live in runtime.json.
    pantheon: { wind_shuffle_mode: 'WIND_SHUFFLE_MODE_PRESCRIPTED' },
    ...over,
  };
}

/** The operational half (§4.2) — deliberately not frozen, and pointed at dead ports. */
function makeRuntime(over = {}) {
  return {
    drand: { api: 'https://api.drand.sh' },
    pantheon: {
      frey_base_url: 'http://127.0.0.1:14001',
      mimir_base_url: 'http://127.0.0.1:14002',
      // The backend reaches Frey over loopback; the browser cannot. A deployment that
      // does not say where the browser should go is not a clean one, so the fixture for
      // a clean deployment says.
      frey_public_url: 'https://pantheon.example.com',
    },
    ...over,
  };
}

/** A deterministic set of decrypted payloads for n players. */
function makeDecrypted(n = 12) {
  return Array.from({ length: n }, (_, i) => ({
    local_id: i + 1,
    user_input: (i * 37) % 256,
    client_nonce: Buffer.alloc(16, i + 1).toString('hex'),
    client_timestamp: `2026-09-10T19:59:0${i % 10}.000Z`,
  }));
}

/**
 * A structurally valid tlock ciphertext that decrypts to nothing.
 *
 * The relay never decrypts (§6), so for testing the API this is as good as a real
 * one and keeps the unit tests offline and instant. e2e uses real tlock.
 */
function fakeCiphertext(round = 1_000_000, chainHash = QUICKNET_HASH) {
  const age =
    'age-encryption.org/v1\n' +
    `-> tlock ${round} ${chainHash}\n` +
    crypto.randomBytes(48).toString('base64') +
    '\n--- ' + crypto.randomBytes(32).toString('base64') + '\n' +
    crypto.randomBytes(32).toString('binary');
  const b64 = Buffer.from(age, 'binary').toString('base64').replace(/(.{64})/g, '$1\n');
  return `-----BEGIN AGE ENCRYPTED FILE-----\n${b64}\n-----END AGE ENCRYPTED FILE-----`;
}

/** A throwaway data/ dir with roster.json, protocol.json, runtime.json and the template. */
function makeDataDir(opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mahjong-test-'));
  const roster = makeRoster(opts.n ?? 12, opts.eventId ?? 42);
  const protocol = makeProtocol(opts.protocol);
  const runtime = makeRuntime(opts.runtime);
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'data', 'roster.json'), JSON.stringify(roster, null, 2));
  fs.writeFileSync(path.join(dir, 'data', 'protocol.json'), JSON.stringify(protocol, null, 2));
  fs.writeFileSync(path.join(dir, 'data', 'runtime.json'), JSON.stringify(runtime, null, 2));
  fs.copyFileSync(
    path.join(ROOT, 'data', 'schedule_template.json'),
    path.join(dir, 'data', 'schedule_template.json')
  );
  return { dir, dataDir: path.join(dir, 'data'), roster, protocol, runtime };
}

const template = () =>
  JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'schedule_template.json'), 'utf8'));

const cleanup = (dir) => fs.rmSync(dir, { recursive: true, force: true });

module.exports = {
  ROOT, QUICKNET_HASH, QUICKNET_PK, SAMPLE_SIG, TITLES,
  makeRoster, makeProtocol, makeRuntime, makeDecrypted, fakeCiphertext, makeDataDir,
  template, cleanup,
};
