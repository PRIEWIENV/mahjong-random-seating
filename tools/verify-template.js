#!/usr/bin/env node
'use strict';

/**
 * Cross-platform wrapper around tools/verify_template.py.
 *
 * The verifier itself is Python, deliberately: it is the one thing participants are
 * invited to run against the frozen template, and a second implementation in a second
 * language is worth more than a convenient one in the same language as the code it
 * checks.
 *
 * The wrapper exists only because the interpreter is not called the same thing
 * everywhere. `python3` does not exist on a stock Windows install — there it is `py`,
 * and a bare `python` may be the Microsoft Store stub that prints an advert and exits
 * 9009. Hardcoding any one of the three breaks the command for somebody.
 *
 *   node tools/verify-template.js [path/to/schedule_template.json]
 */

const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(__dirname, 'verify_template.py');
const CANDIDATES = ['py', 'python3', 'python'];

function usable(cmd) {
  const r = spawnSync(cmd, ['--version'], { encoding: 'utf8', shell: process.platform === 'win32' });
  if (r.error || r.status !== 0) return false;
  // The Windows Store stub exits 0 for some invocations but never prints a version.
  return /Python \d+\.\d+/.test(`${r.stdout || ''}${r.stderr || ''}`);
}

function main() {
  const target = process.argv[2] || path.join(ROOT, 'data', 'schedule_template.json');
  if (!fs.existsSync(target)) {
    console.error(`  ERROR ${target} does not exist`);
    return 2;
  }

  const python = CANDIDATES.find(usable);
  if (!python) {
    console.error(
      `  ERROR no Python interpreter found (tried: ${CANDIDATES.join(', ')}).\n` +
        '        The template verifier is Python. Install Python 3, or run it directly:\n' +
        `        <your-python> tools/verify_template.py ${path.relative(ROOT, target)}`
    );
    return 2;
  }

  const r = spawnSync(python, [SCRIPT, target], { stdio: 'inherit', shell: process.platform === 'win32' });
  return r.status === null ? 1 : r.status;
}

process.exit(main());
