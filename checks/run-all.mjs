#!/usr/bin/env node
// Runs every check in order, cheapest first.
//
//   node checks/run-all.mjs [--screenshot]
//
// The browser checks SKIP (exit 0) when Chrome is not installed, so this is
// safe to run anywhere; the unit checks always run.

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const shot = process.argv.includes('--screenshot');

const SUITES = [
  ['module parse', 'check-parse.mjs', []],
  ['harness pages', 'check-harness.mjs', []],
  ['zip reader', 'check-zip.mjs', []],
  ['markdown', 'check-md.mjs', []],
  ['wolfram tokenizer', 'check-wl-highlight.mjs', []],
  ['viewer in a browser', 'check-browser.mjs', shot ? ['--screenshot'] : []],
  ['standalone viewer page', 'check-standalone.mjs', []],
  ['content.js integration', 'check-extension.mjs', []],
  ['empty .wb held as a doc', 'check-doc-notebook.mjs', []],
  ['evaluation', 'check-evaluate.mjs', []],
  ['overleaf folder id', 'check-folder-id.mjs', []],
  ['save to overleaf', 'check-save.mjs', []],
  ['diagnostics', 'check-diagnostics.mjs', []],
  // Needs a real kernel + installed extension; skips cleanly without them.
  ['wolfbook-serve integration', 'check-serve-integration.mjs', []],
];

let failed = 0;
for (const [label, file, args] of SUITES) {
  console.log(`\n── ${label} ──`);
  const code = await new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(here, file), ...args], { stdio: 'inherit' });
    p.on('close', resolve);
    p.on('error', () => resolve(1));
  });
  if (code !== 0) { failed++; console.log(`   ^ ${label} FAILED (exit ${code})`); }
}

console.log(failed ? `\n${failed} suite(s) failed` : '\nall suites passed');
process.exit(failed ? 1 : 0);
