#!/usr/bin/env node
'use strict';

/**
 * Bundles client/ into public/app.js.
 *
 * Vendored rather than pulled from a CDN, deliberately. The submission stage is the
 * one place a player's plaintext number exists, so the code running there is part of
 * what has to be frozen. A <script src="https://some-cdn/…"> would leave the organiser
 * or the CDN able to serve different code to one player on the day — exactly the
 * manipulation the rest of the protocol rules out.
 *
 * The bundle's SHA-256 is written alongside so it can go into the freeze commit.
 *
 *   node tools/build-client.js                 build, write app.js + .sha256
 *   node tools/build-client.js --check         rebuild and diff against what is committed
 *   node tools/build-client.js --verify-hash   compare the committed bundle to its .sha256
 *   node tools/build-client.js --watch         rebuild on change (development)
 *
 * --check needs esbuild, so it belongs on a dev machine or in CI. --verify-hash needs
 * nothing at all, which is what the VPS runs: deployment installs with
 * `npm ci --omit=dev` and esbuild is a devDependency.
 *
 * Two things that will bite anyone regenerating this: tlock-js 0.9.0 is CommonJS, so
 * `export *` from it yields an empty module (esbuild cannot enumerate CJS names
 * statically) — re-export by name; and timelockEncrypt wants a Buffer, whose global
 * has to be installed from a module the entry point *imports*, not assigned in its
 * body, because module bodies run after all imports have been evaluated.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const ENTRY = path.join(ROOT, 'client', 'index.jsx');
const OUT = path.join(ROOT, 'public', 'app.js');
// esbuild emits the imported CSS as a sibling file rather than inlining it, so the
// freeze — and the hash that pins it — has to cover both artefacts.
const OUT_CSS = path.join(ROOT, 'public', 'app.css');
const SHIM = path.join(ROOT, 'client', 'buffer-shim.js');

const buildOptions = (outfile) => ({
  entryPoints: [ENTRY],
  outfile,
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['es2022'],
  jsx: 'automatic',
  minify: true,
  sourcemap: false,
  legalComments: 'none',
  inject: [SHIM],
  loader: { '.js': 'jsx', '.jsx': 'jsx' },
  define: { 'process.env.NODE_ENV': '"production"', global: 'globalThis' },
  logLevel: 'warning',
});

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/** Digest of a js/css pair, in that order. Both ship to the player's browser. */
function digestOf(jsPath) {
  const cssPath = jsPath.replace(/\.js$/, '.css');
  return sha(Buffer.concat([
    fs.readFileSync(jsPath),
    fs.existsSync(cssPath) ? fs.readFileSync(cssPath) : Buffer.alloc(0),
  ]));
}

async function build(outfile) {
  const esbuild = require('esbuild'); // lazy: --verify-hash must work without devDeps
  await esbuild.build(buildOptions(outfile));
  return { digest: digestOf(outfile), bytes: fs.statSync(outfile).size };
}

function verifyHash() {
  const shaFile = OUT + '.sha256';
  if (!fs.existsSync(OUT) || !fs.existsSync(shaFile)) {
    console.error('  FAIL  public/app.js or its .sha256 is missing from the checkout');
    return 1;
  }
  const expected = fs.readFileSync(shaFile, 'utf8').trim().split(/\s+/)[0];
  const actual = digestOf(OUT);
  if (expected !== actual) {
    console.error(`  FAIL  bundle does not match its committed hash\n        expected ${expected}\n        actual   ${actual}`);
    return 1;
  }
  console.log(`  OK    committed bundle matches its hash: ${actual}`);
  return 0;
}

async function watch() {
  const esbuild = require('esbuild');
  const ctx = await esbuild.context({ ...buildOptions(OUT), minify: false });
  await ctx.watch();
  console.log('  watching client/ — rebuilding public/app.js on change (ctrl-c to stop)');
}

async function main() {
  if (process.argv.includes('--verify-hash')) return verifyHash();
  if (process.argv.includes('--watch')) { await watch(); return new Promise(() => {}); }

  const check = process.argv.includes('--check');
  // --check builds to a scratch name so a mismatching rebuild cannot overwrite the
  // committed artefacts it is meant to be comparing against.
  const target = check ? OUT.replace(/\.js$/, '.check.js') : OUT;
  const { digest, bytes } = await build(target);

  if (check) {
    fs.rmSync(target, { force: true });
    fs.rmSync(target.replace(/\.js$/, '.css'), { force: true });
    if (!fs.existsSync(OUT)) {
      console.error('  FAIL  public/app.js is missing — run: node tools/build-client.js');
      return 1;
    }
    const committed = digestOf(OUT);
    if (committed !== digest) {
      console.error(`  FAIL  committed bundle ${committed}\n        rebuild produces ${digest}`);
      return 1;
    }
    console.log(`  OK    bundle reproduces: sha256 ${digest}`);
    return 0;
  }

  fs.writeFileSync(OUT + '.sha256', `${digest}  public/app.js + public/app.css\n`);
  const v = (p) => require(path.join(ROOT, 'node_modules', p, 'package.json')).version;
  console.log(`  OK    public/app.js ${(bytes / 1024).toFixed(1)} KiB + public/app.css`);
  console.log(`        react ${v('react')}, tlock-js ${v('tlock-js')}, drand-client ${v('drand-client')}`);
  console.log(`        sha256 ${digest}`);
  console.log('        commit this file and its .sha256 as part of the freeze.');
  return 0;
}

main().then((code) => process.exit(code ?? 0)).catch((err) => {
  console.error(err);
  process.exit(1);
});
