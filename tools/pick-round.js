#!/usr/bin/env node
'use strict';

/**
 * RUNBOOK step 7: choose the drand target round and the matching cutoff.
 *
 * These two fields must agree. protocol.json's submission_cutoff_utc has to be the
 * scheduled emission time of target_round, because §7 snapshots at the cutoff and
 * §4 then waits for exactly that round. Setting them by hand is how you end up with
 * a cutoff that is three minutes off and a window nobody can explain afterwards, so
 * this derives one from the other against the live chain.
 *
 *   node tools/pick-round.js --in 72h            # 72 hours from now
 *   node tools/pick-round.js --at 2026-09-10T20:00:00Z
 *   node tools/pick-round.js --round 12345678    # go the other way
 *   node tools/pick-round.js --in 72h --write    # write it into data/protocol.json
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
// No chain hash hardcoded here. The chain is whatever protocol.json is frozen to; a
// second copy of it in a tool is a second place for it to be wrong. The endpoint used
// to look the chain up is operational (§4.2) and comes from runtime.json.
const { loadRuntime } = require('../server/runtime');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i].replace(/^--/, '');
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) out[k] = true;
    else { out[k] = v; i++; }
  }
  return out;
}

/** "72h", "90m", "3d" -> milliseconds */
function parseDuration(s) {
  const m = /^(\d+(?:\.\d+)?)\s*(s|m|h|d)$/.exec(String(s).trim());
  if (!m) throw new Error(`cannot parse duration "${s}" — use forms like 90m, 72h, 3d`);
  const mult = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2]];
  return Number(m[1]) * mult;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const protocolPath = path.join(ROOT, 'data', 'protocol.json');
  const examplePath = path.join(ROOT, 'data', 'protocol.example.json');
  const src = fs.existsSync(protocolPath) ? protocolPath : examplePath;
  const protocol = JSON.parse(fs.readFileSync(src, 'utf8'));

  const runtime = loadRuntime(path.join(ROOT, 'data'), process.env);
  const api = String(args.api || runtime.drand.api).replace(/\/+$/, '');
  const chainHash = String(args['chain-hash'] || protocol.chain_hash || '');
  if (!/^[0-9a-f]{64}$/.test(chainHash)) {
    throw new Error('no chain_hash in protocol.json — fill it in (or pass --chain-hash) before picking a round');
  }

  const info = await fetch(`${api}/${chainHash}/info`).then((r) => {
    if (!r.ok) throw new Error(`${api}/${chainHash}/info -> HTTP ${r.status}`);
    return r.json();
  });
  const { genesis_time: genesis, period } = info;
  const roundTimeMs = (round) => (genesis + (round - 1) * period) * 1000;
  const roundAfter = (ms) => Math.floor((Math.ceil(ms / 1000) - genesis) / period) + 2;

  let round;
  if (args.round) {
    round = Number(args.round);
    if (!Number.isInteger(round) || round < 1) throw new Error('--round must be a positive integer');
  } else {
    const targetMs = args.at ? Date.parse(String(args.at)) : Date.now() + parseDuration(args.in || '72h');
    if (Number.isNaN(targetMs)) throw new Error(`cannot parse --at "${args.at}"`);
    round = roundAfter(targetMs);
  }

  const emitMs = roundTimeMs(round);
  const cutoff = new Date(emitMs).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const nowRound = Math.floor((Math.floor(Date.now() / 1000) - genesis) / period) + 1;

  console.log(`  chain          ${info.metadata?.beaconID || '?'}  (${chainHash})`);
  console.log(`  public_key     ${info.public_key}`);
  console.log(`  period         ${period}s`);
  console.log(`  current round  ${nowRound}`);
  console.log('');
  console.log(`  target_round             ${round}`);
  console.log(`  submission_cutoff_utc    ${cutoff}`);
  console.log(`  window from now          ${((emitMs - Date.now()) / 3_600_000).toFixed(1)} hours`);

  if (emitMs <= Date.now()) {
    console.error('\n  REFUSING: that round is already in the past. Nothing would be secret.');
    return 1;
  }
  if (emitMs - Date.now() < 3_600_000) {
    console.warn('\n  WARNING: under an hour of submission window. RUNBOOK step 7 suggests 72 hours.');
  }

  if (args.write) {
    if (!fs.existsSync(protocolPath)) {
      console.error(`\n  data/protocol.json does not exist yet. Copy protocol.example.json to it first.`);
      return 1;
    }
    protocol.target_round = round;
    protocol.submission_cutoff_utc = cutoff;
    protocol.chain_hash = chainHash;
    protocol.chain_public_key = info.public_key;
    // Deliberately NOT written: the endpoint this was looked up through is operational
    // (§4.2) and does not belong in a frozen file. config.js rejects it if it appears.
    fs.writeFileSync(protocolPath, JSON.stringify(protocol, null, 2) + '\n');
    console.log(`\n  written to data/protocol.json (target_round, submission_cutoff_utc, chain_hash, chain_public_key)`);
    console.log('  now re-read it, then freeze and tag per RUNBOOK step 8.');
  } else {
    console.log('\n  (add --write to put these into data/protocol.json)');
  }
  return 0;
}

main().then((c) => process.exit(c || 0)).catch((err) => {
  console.error(`  ERROR ${err.message}`);
  process.exit(1);
});
