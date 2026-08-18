#!/usr/bin/env node
// Integration check: a .wb that Overleaf holds as a DOC, not a binary file.
//
//   node checks/check-doc-notebook.mjs
//
// WHY THIS EXISTS
//   Overleaf stores a project entry one of two ways. Anything UPLOADED is a
//   binary "file": no preview, a Download link, and a content-addressed blob —
//   which is what check-extension.mjs covers. Anything CREATED inside Overleaf,
//   including every "New file", is a "doc": it opens in CodeMirror like a .tex,
//   there is no download link and no blob url.
//
//   A brand-new .wb is therefore an EMPTY DOC, and it went wrong twice over:
//   nothing in the source chain would read an empty buffer (the editor fast
//   path required the text to start with "{"), and a blank string reached
//   JSON.parse, so the first thing anyone saw of a notebook they had just
//   created was a parse error.
//
//   Saving differs too. Uploading over a doc would leave the project holding a
//   doc AND a file of the same name, so a doc is written back through
//   CodeMirror — a transaction, exactly what typing does, which Overleaf's own
//   OT extension syncs.
//
// The CodeMirror view here is a stand-in with the two members page-bridge.js
// actually touches (`state.doc`, `dispatch`); page-bridge.js itself is the real
// file, so the message protocol between it and content.js is genuinely covered.

import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const PROJECT_ID = '0123456789abcdef01234567';

const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
if (!fs.existsSync(CHROME)) {
  console.log(`SKIP — Chrome not found at ${CHROME} (set CHROME=...)`);
  process.exit(0);
}

const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>fake overleaf (doc mode)</title>
<link rel="stylesheet" href="/content.css"></head>
<body style="margin:0;display:flex;height:100vh;font:14px system-ui">
  <div class="file-tree" style="width:220px;border-right:1px solid #ccc">
    <ul>
      <li role="treeitem" aria-selected="false"><span class="entity-name">main.tex</span></li>
      <li role="treeitem" aria-selected="true"><span class="entity-name">test.wb</span></li>
    </ul>
  </div>
  <div style="flex:1;display:flex;flex-direction:column">
    <div role="tablist" style="display:flex;border-bottom:1px solid #ccc">
      <div role="tab" aria-selected="false">main.tex</div>
      <div role="tab" aria-selected="true">test.wb<button>&times;</button></div>
    </div>
    <!-- NO .file-view and NO download link: this is the doc case. Overleaf
         shows its ordinary editor, and the file is empty. -->
    <div id="panel-source-editor" style="flex:1;position:relative">
      <div class="cm-editor" style="height:100%">
        <div class="cm-scroller"><div class="cm-content" contenteditable="true"></div></div>
      </div>
    </div>
  </div>
  <pre id="result" style="display:none">PENDING</pre>

<script>
// A CodeMirror 6 stand-in exposing only what page-bridge.js reaches for.
const cmDoc = { text: '' };
const mkDoc = () => ({ toString: () => cmDoc.text, get length() { return cmDoc.text.length; } });
window.__cmDoc = cmDoc;
document.querySelector('.cm-content').cmView = {
  view: {
    state: { get doc() { return mkDoc(); } },
    dispatch(tr) {
      const c = tr && tr.changes;
      if (!c) return;
      cmDoc.text = cmDoc.text.slice(0, c.from) + (c.insert || '') + cmDoc.text.slice(c.to);
    },
  },
};

window.chrome = {
  runtime: {
    lastError: null,
    getURL: (p) => '/' + String(p).replace(/^\\//, ''),
    sendMessage: (msg, cb) => { if (typeof cb === 'function') cb({ ok: true, connected: false }); },
  },
};
</script>
<script src="/page-bridge.js"></script>
<script src="/content.js"></script>

<script>
const out = [];
const say = (l, c, extra) => out.push((c ? 'ok   ' : 'FAIL ') + l + (extra ? '  — ' + extra : ''));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const deadline = Date.now() + 40000;

(async function run() {
  let shadow = null;
  while (Date.now() < deadline) {
    const host = document.getElementById('wolfbook-overleaf-host');
    shadow = host && host.shadowRoot;
    if (shadow && (shadow.querySelector('.wb-notebook') || shadow.querySelector('.wb-error-box'))) break;
    await sleep(200);
  }

  say('a .wb held as a doc still mounts a panel', !!shadow);
  const errBox = shadow && shadow.querySelector('.wb-error-box');
  say('an empty .wb is not reported as broken JSON', !errBox,
      errBox ? errBox.textContent.slice(0, 90) : '');

  const nb = shadow && shadow.querySelector('.wb-notebook');
  say('it renders as an empty notebook', !!nb && nb.querySelectorAll('.wb-cell').length === 0,
      nb ? nb.querySelectorAll('.wb-cell').length + ' cells' : 'no notebook');

  // With no cells there is exactly one gap — the trailing strip — and without
  // it a new notebook would have no way to gain its first cell at all.
  const gapBtns = shadow ? shadow.querySelectorAll('.wb-gap .wb-gap-btn') : [];
  say('a new notebook still offers +Code / +Markdown', gapBtns.length >= 2,
      gapBtns.length + ' button(s)');

  if (gapBtns.length) {
    gapBtns[0].click();                       // + Code
    await sleep(400);
    say('the first cell can be inserted',
        shadow.querySelectorAll('.wb-cell').length === 1,
        shadow.querySelectorAll('.wb-cell').length + ' cells');

    const saveBtn = shadow.querySelector('[data-act="save"]');
    let ready = Date.now() + 4000;
    while (saveBtn && saveBtn.hidden && Date.now() < ready) await sleep(200);
    say('Save appears once the notebook has content', !!saveBtn && !saveBtn.hidden,
        saveBtn ? saveBtn.textContent : 'no save button');

    if (saveBtn && !saveBtn.hidden) {
      saveBtn.click();
      const until = Date.now() + 8000;
      while (!window.__cmDoc.text && Date.now() < until) await sleep(150);
      say('saving writes back through CodeMirror', !!window.__cmDoc.text,
          window.__cmDoc.text.length + ' bytes');
      let parsed = null;
      try { parsed = JSON.parse(window.__cmDoc.text); } catch (_) {}
      say('what it wrote is valid .wb JSON', !!parsed && Array.isArray(parsed.cells),
          parsed ? parsed.cells.length + ' cells' : 'unparseable');
      const counts = await (await fetch('/__counts')).json();
      say('a doc is never uploaded as a file', counts.uploads === 0,
          counts.uploads + ' upload(s)');
    }
  }

  document.getElementById('result').textContent = out.join('\\n');
  fetch('/__result', { method: 'POST', body: out.join('\\n') });
})();
</script>
</body></html>`;

let onResult = null;
let uploads = 0;
const server = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  if (url === '/__result' && req.method === 'POST') {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => { res.writeHead(204); res.end(); onResult?.(body); });
    return;
  }
  if (url.includes('/upload')) {          // must never be reached in doc mode
    uploads++;
    req.resume();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true }));
    return;
  }
  if (url === '/__counts') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ uploads }));
    return;
  }
  if (url === `/project/${PROJECT_ID}`) {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(PAGE);
    return;
  }
  if (url.endsWith('/download/zip')) {    // the fallback we must NOT need here
    res.writeHead(404); res.end('no zip in this fixture');
    return;
  }
  const file = path.join(root, url);
  if (file.startsWith(root) && fs.existsSync(file) && !fs.statSync(file).isDirectory()) {
    const TYPES = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
                    '.json': 'application/json', '.png': 'image/png' };
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
    return;
  }
  res.writeHead(404); res.end('not found');
});

await new Promise((r) => server.listen(0, '127.0.0.1', r));
const pageUrl = `http://127.0.0.1:${server.address().port}/project/${PROJECT_ID}`;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wbdoc-'));

let failures = 0;
try {
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    '--disable-dev-shm-usage', `--user-data-dir=${profile}`, pageUrl,
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  chrome.stderr.on('data', (d) => { stderr += d; });

  const results = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 75_000);
    onResult = (b) => { clearTimeout(timer); resolve(b); };
    chrome.on('error', () => { clearTimeout(timer); resolve(null); });
  });
  chrome.kill('SIGKILL');

  if (results == null) {
    console.error('the page never reported results.');
    const noisy = stderr.split('\n').filter((l) => /error/i.test(l));
    if (noisy.length) console.error(noisy.slice(-12).join('\n'));
    process.exit(1);
  }
  console.log(results);
  failures = (results.match(/^FAIL/gm) || []).length;
} finally {
  server.close();
  fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nempty-doc notebook checks passed');
process.exit(failures ? 1 : 0);
