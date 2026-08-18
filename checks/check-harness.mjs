#!/usr/bin/env node
// Parses the inline page scripts inside every browser check.
//
//   node checks/check-harness.mjs
//
// Those pages are built as TEMPLATE LITERALS in the harness, which adds an
// escaping layer between what is written and what the browser receives. Four
// separate bugs came from it: a backtick in a comment ending the literal early,
// and `\[` / `\/` collapsing so a valid regex became a syntax error.
//
// Every one of them killed the page script outright, so the check reported
// "the page never reported results" — a harness failure that looks exactly like
// a product failure, and takes a Chrome stderr dive to tell apart. Parsing the
// rendered page here turns all of that into an instant, precise error.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
let failures = 0;
const ok = (l, extra) => console.log(`ok   ${l}${extra ? `  — ${extra}` : ''}`);
const bad = (l, extra) => { console.log(`FAIL ${l}${extra ? `  — ${extra}` : ''}`); failures++; };

// Names that are already globals inside the template must not be stubbed over,
// or `${JSON.stringify(x)}` becomes "stub.stringify is not a function".
const GLOBALS = new Set(['JSON', 'Math', 'String', 'Number', 'Boolean', 'Date', 'Object',
                         'Array', 'encodeURIComponent', 'decodeURIComponent', 'process']);

const self = path.basename(fileURLToPath(import.meta.url));
for (const file of fs.readdirSync(here)
    .filter((f) => f.startsWith('check-') && f.endsWith('.mjs') && f !== self)) {
  const src = fs.readFileSync(path.join(here, file), 'utf8');
  const start = src.indexOf('const PAGE = `');
  if (start < 0) continue;

  // Render the template with plausible stand-ins for whatever it interpolates.
  const bodyStart = src.indexOf('`', start) + 1;
  const bodyEnd = src.indexOf('`;', bodyStart);
  const body = src.slice(bodyStart, bodyEnd);
  const names = [...new Set([...body.matchAll(/\$\{(\w+)/g)].map((m) => m[1]))]
    .filter((n) => !GLOBALS.has(n));
  let page;
  try {
    const stubs = names.map((n) => (n === 'wb' ? { url: 'http://x', token: 't', port: 1 } : 'stub'));
    page = new Function(...names, 'return `' + body + '`')(...stubs);
  } catch (e) {
    bad(`${file}: the page template itself parses`, e.message);
    continue;
  }

  const scripts = [...page.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)]
    .map((m) => ({ attrs: m[1] || '', code: m[2] }))
    .filter((s) => s.code.trim());
  let bad_ = 0;
  scripts.forEach((sc, i) => {
    // A module script may use top-level await, which `new Function` rejects;
    // wrapping it in an async body parses the same source under the same rules.
    const source = /type\s*=\s*["']module["']/.test(sc.attrs)
      ? `return (async () => {${sc.code}\n});`
      : sc.code;
    try { new Function(source); }
    catch (e) { bad(`${file}: inline script ${i} parses`, e.message); bad_++; }
  });
  if (!bad_) ok(`${file}: ${scripts.length} inline script(s) parse`);
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall harness pages parse');
process.exit(failures ? 1 : 0);
