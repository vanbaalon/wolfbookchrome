// Parses every module the extension ships, by actually IMPORTING it.
//
//   node checks/check-parse.mjs
//
// WHY THIS IS NOT REDUNDANT WITH `node --check`: that only parses the file you
// name, and never the modules it imports. A stray backtick inside a template
// literal in theme-css.js — a CSS comment mentioning a Wolfram context prefix —
// terminated the string early and broke the whole viewer in the browser, while
// every Node-side suite stayed green because none of them imported that file.
// Importing is the only check that covers a module no unit test happens to use.
//
// vendor/ is included: a bad sync-assets.sh run would otherwise surface as a
// mystifying blank panel on Overleaf.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

// Page modules: ES modules that touch `document` / `location` the moment they
// load, because they ARE the page rather than a library it uses. Importing one
// in Node fails on the DOM, not on anything wrong with the file — so they are
// parsed instead, in a child Node with the module goal. That still catches the
// class of bug this suite exists for: `node --check` rejects an unterminated
// template literal and a duplicate lexical declaration alike.
const PAGE_MODULES = ['viewer/standalone.js', 'viewer/popup.js'];

const MODULES = [];
for (const dir of ['viewer', 'vendor']) {
  const d = path.join(root, dir);
  if (!fs.existsSync(d)) continue;
  for (const f of fs.readdirSync(d).sort()) {
    const rel = path.join(dir, f);
    if ((f.endsWith('.js') || f.endsWith('.mjs')) && !PAGE_MODULES.includes(rel)) MODULES.push(rel);
  }
}

// Classic (non-module) scripts: these run as content scripts, so they cannot be
// imported. Parse them with the same machinery the browser would use.
const SCRIPTS = ['content.js', 'background.js', 'page-bridge.js'];

let failures = 0;
const ok = (label, extra) => console.log(`ok   ${label}${extra ? `  — ${extra}` : ''}`);
const bad = (label, extra) => { console.log(`FAIL ${label}${extra ? `  — ${extra}` : ''}`); failures++; };

for (const rel of MODULES) {
  try {
    const mod = await import(pathToFileURL(path.join(root, rel)).href);
    ok(rel, Object.keys(mod).length ? `exports: ${Object.keys(mod).slice(0, 4).join(', ')}` : 'no exports');
  } catch (e) {
    bad(rel, `${e.name}: ${e.message}`);
  }
}

for (const rel of PAGE_MODULES) {
  const file = path.join(root, rel);
  if (!fs.existsSync(file)) { bad(rel, 'missing'); continue; }
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
    ok(rel, 'parses (page module)');
  } catch (e) {
    bad(rel, String(e.stderr || e.message).split('\n').find((l) => /Error/.test(l)) || 'parse failed');
  }
}

for (const rel of SCRIPTS) {
  const file = path.join(root, rel);
  if (!fs.existsSync(file)) { bad(rel, 'missing'); continue; }
  try {
    // new Function parses without executing, and rejects the same syntax the
    // browser would (including an unterminated template literal).
    new Function(fs.readFileSync(file, 'utf8'));
    ok(rel, 'parses');
  } catch (e) {
    bad(rel, `${e.name}: ${e.message}`);
  }
}

// Reverse MCP routing must find the same Overleaf URL variants that receive
// the content script. A bare overleaf.com tab used to attach successfully but
// then disappear when the background worker tried to route an agent call.
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const backgroundSource = fs.readFileSync(path.join(root, 'background.js'), 'utf8');
for (const pattern of manifest.content_scripts?.[0]?.matches || []) {
  if (backgroundSource.includes(`'${pattern}'`) || backgroundSource.includes(`"${pattern}"`)) {
    ok(`background routes ${pattern}`);
  } else {
    bad(`background routes ${pattern}`, 'missing from queryOverleafTabs');
  }
}
if (/chrome\.tabs\.query\(\{\}\)/.test(backgroundSource)) {
  ok('background has an unfiltered tab-query fallback');
} else {
  bad('background has an unfiltered tab-query fallback');
}

// No stray control characters in shipped source.
//
// A literal NUL byte once landed in an option value where a space was meant.
// Everything still "worked" — the file parsed, the tests passed, the rendered
// text looked identical — but a string comparison against the same-looking
// literal failed, and grep silently treated the file as binary. Cheap to check,
// very expensive to debug.
for (const rel of [...MODULES.filter((m) => !m.startsWith('vendor/')), ...PAGE_MODULES, ...SCRIPTS]) {
  const buf = fs.readFileSync(path.join(root, rel));
  const found = [];
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i];
    if (b < 0x09 || (b > 0x0d && b < 0x20)) found.push(`0x${b.toString(16)}@${i}`);
  }
  if (found.length) bad(`${rel} free of control characters`, found.slice(0, 3).join(' '));
  else ok(`${rel} free of control characters`);
}

// Extension PAGES reference their script and icons by relative path, which no
// module graph and no manifest can vouch for.
for (const page of ['viewer/standalone.html', 'viewer/popup.html']) {
  const file = path.join(root, page);
  if (!fs.existsSync(file)) { bad(page, 'missing'); continue; }
  const html = fs.readFileSync(file, 'utf8');
  const refs = [...html.matchAll(/(?:src|href)="([^"#:]+)"/g)].map((mm) => mm[1]);
  const gone = refs.filter((r) => !fs.existsSync(path.resolve(path.dirname(file), r)));
  if (gone.length) bad(`${page} references existing files`, gone.join(', '));
  else ok(`${page} references existing files`, refs.length + ' ref(s)');
}

// The manifest must stay valid JSON and reference files that exist.
try {
  const m = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  // Icons and the popup are included deliberately: Chrome refuses to load the
  // WHOLE extension if any icon path is wrong, and reports it only in a corner
  // of chrome://extensions — a failure that looks like "the extension vanished".
  const referenced = [
    m.background?.service_worker,
    ...(m.content_scripts || []).flatMap((cs) => [...(cs.js || []), ...(cs.css || [])]),
    ...Object.values(m.icons || {}),
    m.action?.default_popup,
    ...Object.values(m.action?.default_icon || {}),
  ].filter(Boolean);
  const missing = referenced.filter((f) => !fs.existsSync(path.join(root, f)));
  if (missing.length) bad('manifest references existing files', missing.join(', '));
  else ok('manifest references existing files', referenced.length + ' file(s)');
} catch (e) {
  bad('manifest.json is valid JSON', e.message);
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall modules parse');
process.exit(failures ? 1 : 0);
