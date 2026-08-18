#!/usr/bin/env node
// Integration check: run the REAL content.js against a fake Overleaf page.
//
//   node checks/check-extension.mjs
//
// WHAT THIS PROVES
//   * content.js's Overleaf probes find a selected file and an editor pane,
//     and it mounts, renders, toggles to Source and tears down again;
//   * the whole same-origin zip download → unzip → resolve images → render
//     path works end to end in a real browser;
//   * "Open in Wolfbook" stays disabled when no local wolfbook answers.
//
// WHAT THIS DOES NOT PROVE — read before trusting a green run
//   * That the extension LOADS. Chrome 151 ignores --load-extension (Chrome
//     disabled the switch in M137), verified on this machine: no target for a
//     test extension ever appears. So content.js is injected here as an
//     ordinary page script with a small `chrome` shim, which means the
//     manifest, the isolated world, and — most importantly — dynamic import()
//     of a web_accessible_resource FROM the isolated world are all unverified.
//     That last one is the first thing to confirm on a real load; content.js
//     surfaces a visible error in the panel if it fails, rather than doing
//     nothing.
//   * That Overleaf's real DOM looks like the page below. It cannot: the
//     fixture page is built from the same selectors content.js probes for, so
//     this check validates our code, never our guess about Overleaf's markup.
//     Only a live session settles that.

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
const zipFixture = path.join(root, 'fixtures', 'sample-project.zip');
if (!fs.existsSync(zipFixture)) {
  console.error('missing fixtures/sample-project.zip — run: node fixtures/make-fixture.mjs');
  process.exit(1);
}

// ── fake Overleaf ───────────────────────────────────────────────────────────
// Only the hooks content.js probes for: a file tree with a selected .wb, and an
// editor pane to mount over. content.css is inlined and content.js is loaded as
// a page script behind a `chrome` shim (see the header note).
const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>fake overleaf</title>
<link rel="stylesheet" href="/content.css"></head>
<body style="margin:0;display:flex;height:100vh;font:14px system-ui">
  <div class="file-tree" style="width:220px;border-right:1px solid #ccc">
    <ul>
      <li role="treeitem" aria-selected="false"><span class="entity-name">main.tex</span></li>
      <li role="treeitem" aria-selected="true"><span class="entity-name">sample.wb</span></li>
    </ul>
  </div>
  <!-- COPIED FROM THE LIVE SITE (Experiments/test.txt). Overleaf classifies .wb
       as a binary file, so there is no CodeMirror editor at all — just this
       file-view, whose Download link names the file and points at its bytes. -->
  <div style="flex:1;display:flex;flex-direction:column">
    <div role="tablist" style="display:flex;border-bottom:1px solid #ccc">
      <div role="tab" aria-selected="false">main.tex</div>
      <div role="tab" aria-selected="true">sample.wb<button>×</button></div>
    </div>
    <div id="panel-source-editor" style="flex:1;position:relative">
      <div class="file-view" style="height:100%">
        <div class="file-view-buttons">
          <a tabindex="0" href="/project/${PROJECT_ID}/blob/e2bb58c8a95736b383ff1dd65cc1a88f"
             download="sample.wb" data-ol-loading="false" class="d-inline-grid btn btn-secondary">
            <span class="button-content" aria-hidden="false">
              <span class="material-symbols align-middle" aria-hidden="true">download</span>
              <span>Download</span></span></a>
        </div>
        <textarea aria-label="Invisible element to manage focus and prevent unintended behavior"
                  tabindex="-1" style="position: absolute; left: -9999px;"></textarea>
        <p class="no-preview">Sorry, no preview is available.</p>
      </div>
    </div>
  </div>
  <pre id="result" style="display:none">PENDING</pre>

<!-- Minimal stand-in for the extension APIs content.js uses. getURL maps
     extension paths onto this server; sendMessage reports "no local wolfbook",
     which is the state we want to assert on. -->
<script>
window.chrome = {
  runtime: {
    // A live extension always has an id; content.js treats its absence as
    // an orphaned content script (the extension reloaded under the tab).
    id: 'wolfbook-check',
    lastError: null,
    getURL: (p) => '/' + String(p).replace(/^\\//, ''),
    sendMessage: (msg, cb) => { if (typeof cb === 'function') cb({ ok: true, connected: false }); },
  },
};
</script>
<script src="/content.js"></script>

<script>
// Poll for the extension's panel, then inspect it from the page side. The
// shadow root is mode:'open' precisely so this kind of inspection is possible.
const out = [];
const say = (l, c, extra) => out.push((c ? 'ok   ' : 'FAIL ') + l + (extra ? '  — ' + extra : ''));
const deadline = Date.now() + 40000;

(async function poll() {
  const host = document.getElementById('wolfbook-overleaf-host');
  const shadow = host && host.shadowRoot;
  const nb = shadow && shadow.querySelector('.wb-notebook');
  const err = shadow && shadow.querySelector('.wb-error-box');
  const done = nb && nb.children.length > 0;

  if (!done && !err && Date.now() < deadline) return setTimeout(poll, 250);

  say('content.js mounted a panel over the editor', !!host);
  say('viewer modules imported and shadow root created', !!shadow,
      shadow ? '' : 'no shadow root — module import failed');
  if (err) say('no error shown in the panel', false, err.textContent.slice(0, 120));
  else say('no error shown in the panel', true);
  say('notebook rendered from the project zip', !!done,
      nb ? nb.children.length + ' cells' : 'nothing rendered');

  if (shadow) {
    const title = shadow.querySelector('.wb-title');
    say('panel titled with the selected file', title && title.textContent === 'sample.wb',
        title && title.textContent);
    const logo = shadow.querySelector('.wb-logo');
    say('the wolfbook logo is shown in the toolbar',
        !!logo && /wolfbook-icon\.png$/.test(logo.getAttribute('src') || ''),
        logo && logo.getAttribute('src'));
    say('KaTeX present in the rendered notebook', !!shadow.querySelector('.katex'));
    say('images resolved from the zip to blob: URLs',
        [...shadow.querySelectorAll('img')].some(i => (i.getAttribute('src') || '').startsWith('blob:')));
    const note = shadow.querySelector('.wb-note');
    say('status line populated', !!(note && note.textContent.includes('cells')),
        note && note.textContent);
    const openBtn = shadow.querySelector('[data-act="open"]');
    say('Open in Wolfbook disabled with no local server', !!(openBtn && openBtn.disabled));

    // The notebook must come from the Download link's blob URL, not the zip;
    // the zip is only for the images this fixture references.
    const counts = await (await fetch('/__counts')).json();
    say('notebook fetched from the blob endpoint', counts.blobRequests >= 1,
        'blob=' + counts.blobRequests + ' zip=' + counts.zipRequests);

    // Switching to Source must show the raw JSON.
    const srcBtn = [...shadow.querySelectorAll('button[data-mode]')]
        .find(b => b.dataset.mode === 'source');
    if (srcBtn) {
      srcBtn.click();
      await new Promise(r => setTimeout(r, 1500));
      const pre = shadow.querySelector('.wb-source');
      say('Source view shows raw .wb JSON',
          !!(pre && pre.textContent.trim().startsWith('{')));
    } else say('Source toggle exists', false);
  }

  // Switching to main.tex must remove the panel again. Overleaf opens a .tex in
  // CodeMirror, so the whole binary file-view goes away — simulate that, not
  // just the tab highlight, or the check would pass for the wrong reason.
  document.querySelectorAll('[role="tab"]').forEach(t =>
      t.setAttribute('aria-selected', t.textContent.startsWith('main.tex')));
  document.querySelectorAll('[role="treeitem"]').forEach(li =>
      li.setAttribute('aria-selected', li.querySelector('.entity-name').textContent === 'main.tex'));
  const fileView = document.querySelector('.file-view');
  if (fileView) {
    const ed = document.createElement('div');
    ed.className = 'cm-editor';
    ed.style.height = '100%';
    ed.textContent = '\\\\documentclass{article}';
    fileView.replaceWith(ed);
  }
  await new Promise(r => setTimeout(r, 1200));
  say('panel removed when a non-.wb file is selected',
      !document.getElementById('wolfbook-overleaf-host'));

  document.getElementById('result').textContent = out.join('\\n');
  try { await fetch('/__result', { method: 'POST', body: out.join('\\n') }); } catch (e) {}
})();
</script></body></html>`;

let onResult = () => {};
let blobRequests = 0, zipRequests = 0;
const server = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  if (req.method === 'POST' && url === '/__result') {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => { res.writeHead(204); res.end(); onResult(body); });
    return;
  }
  if (url === `/project/${PROJECT_ID}/download/zip`) {
    zipRequests++;
    res.writeHead(200, { 'Content-Type': 'application/zip' });
    fs.createReadStream(zipFixture).pipe(res);
    return;
  }
  // The blob endpoint behind Overleaf's Download link.
  if (url.startsWith(`/project/${PROJECT_ID}/blob/`)) {
    blobRequests++;
    res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
    fs.createReadStream(path.join(root, 'fixtures', 'sample.wb')).pipe(res);
    return;
  }
  if (url === '/__counts') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ blobRequests, zipRequests }));
    return;
  }
  if (url === `/project/${PROJECT_ID}`) {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(PAGE);
    return;
  }
  // Serve the extension's own files (content.js, viewer/*, vendor/*).
  const file = path.join(root, url);
  if (file.startsWith(root) && fs.existsSync(file) && !fs.statSync(file).isDirectory()) {
    const TYPES = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
                    '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
    return;
  }
  res.writeHead(404); res.end('not found');
});

await new Promise((r) => server.listen(0, '127.0.0.1', r));
const pageUrl = `http://127.0.0.1:${server.address().port}/project/${PROJECT_ID}`;

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wbchrome-'));
let failures = 0;
try {
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    '--disable-dev-shm-usage', `--user-data-dir=${profile}`,
    pageUrl,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
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
    const noisy = stderr.split('\n').filter((l) => /extension|manifest|error/i.test(l));
    if (noisy.length) console.error(noisy.slice(-15).join('\n'));
    process.exit(1);
  }
  console.log(results);
  failures = (results.match(/^FAIL/gm) || []).length;
} finally {
  server.close();
  fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nextension end-to-end checks passed');
process.exit(failures ? 1 : 0);
