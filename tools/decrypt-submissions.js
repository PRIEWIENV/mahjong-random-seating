#!/usr/bin/env node
'use strict';

/**
 * Participant-side verification, referenced by the result stage.
 *
 * Reads the published ciphertexts out of events/submissions/, opens them with the
 * drand signature for the target round, and writes the payload list generate.js takes
 * as input. Nothing here is privileged: after the round has landed its signature is
 * public, so anyone can run this and get the same numbers the organiser got.
 *
 *   node tools/decrypt-submissions.js --dir events/submissions --out decrypted.json
 *
 * Then:
 *   node generate.js --decrypted decrypted.json --signature <sig> --round <n> --out mine.json
 *   diff mine.json results.json
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dir = path.resolve(ROOT, typeof args.dir === 'string' ? args.dir : 'events/submissions');
  const outPath = path.resolve(ROOT, typeof args.out === 'string' ? args.out : 'decrypted.json');
  const protocolPath = path.resolve(ROOT, typeof args.protocol === 'string' ? args.protocol : 'data/protocol.json');
  const protocol = JSON.parse(fs.readFileSync(protocolPath, 'utf8'));
  // Operational, not frozen (§4.2): a participant checking the draw may well need a
  // different mirror from the one the organiser used, and it cannot change the answer.
  const { loadRuntime } = require('../server/runtime');
  const cfg = { protocol, runtime: loadRuntime(path.dirname(protocolPath), process.env) };

  if (!fs.existsSync(dir)) {
    console.error(`  ERROR ${dir} does not exist. Clone the repository at the published tag first.`);
    return 1;
  }
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  if (files.length === 0) {
    console.error(`  ERROR no submission files in ${dir}`);
    return 1;
  }

  const { decryptPayload } = require('../server/tlock');
  const { contribution } = require('../generate');

  const realLog = console.log; // tlock-js narrates every decrypt
  const decrypted = [];
  const failed = [];
  for (const f of files) {
    const rec = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    try {
      console.log = () => {};
      const payload = await decryptPayload(rec.ciphertext, cfg);
      console.log = realLog;
      decrypted.push({ local_id: rec.local_id, ...payload });
      console.log(`  local_id ${String(rec.local_id).padStart(2)}  ->  ${String(payload.user_input).padStart(3)}` +
        `   nonce ${payload.client_nonce.slice(0, 12)}…  ${payload.client_timestamp}`);
    } catch (err) {
      console.log = realLog;
      failed.push({ local_id: rec.local_id, reason: err.message });
      console.error(`  local_id ${String(rec.local_id).padStart(2)}  ->  FAILED: ${err.message}`);
    }
  }

  decrypted.sort((a, b) => a.local_id - b.local_id);
  fs.writeFileSync(outPath, JSON.stringify(decrypted, null, 2) + '\n');

  // The exclusions are an input to generate.js, not a note appended to its output
  // (PROTOCOL.md §4.3), so write them in the shape --excluded expects. Without this the
  // manual re-run would silently produce a results.json whose roll-call does not add up.
  failed.sort((a, b) => a.local_id - b.local_id);
  const excludedPath = outPath.replace(/\.json$/, '') + '.excluded.json';
  fs.writeFileSync(excludedPath, JSON.stringify(failed, null, 2) + '\n');

  // Recompute R here too, so a mismatch shows up before generate.js is even run.
  const domain = protocol.seed_domain_separation;
  const max = protocol.user_input_max;
  const R = Buffer.alloc(32);
  for (const d of decrypted) {
    const c = contribution(d, domain, max);
    for (let i = 0; i < 32; i++) R[i] ^= c[i];
  }

  console.log(`\n  ${decrypted.length} opened -> ${path.relative(ROOT, outPath)}`);
  console.log(`  R = ${R.toString('hex')}`);
  console.log(`  ${failed.length} could not be opened -> ${path.relative(ROOT, excludedPath)}`);
  console.log('\n  Compare R against results.json, then re-run generate.js and diff the output:');
  console.log(`    node generate.js --decrypted ${path.relative(ROOT, outPath)} \\`);
  console.log(`                     --excluded ${path.relative(ROOT, excludedPath)} \\`);
  console.log('                     --signature <hex> --out my-results.json');
  return 0;
}

main().then((c) => process.exit(c || 0)).catch((err) => {
  console.error(`  ERROR ${err.message}`);
  process.exit(1);
});
