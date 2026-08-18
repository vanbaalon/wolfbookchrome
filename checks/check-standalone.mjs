#!/usr/bin/env node
// Browser check for the STANDALONE viewer page — the .wb-outside-Overleaf path.
//
//   node checks/check-standalone.mjs
//
// WHY a separate suite: check-browser.mjs drives the viewer modules directly,
// with its own scaffold page. This one loads the REAL viewer/standalone.html —
// the file the Finder "Open With" entry opens — and lets it do its own module
// loading, fetching and rendering. That is where its risk actually lives: it
// runs as a page rather than a content script, and its ?src= plumbing has no
// equivalent anywhere else in the extension.
//
// It runs over plain HTTP with no extension present, which is deliberate:
// Chrome no longer allows --load-extension, so an extension-only page could not
// be tested at all. standalone.js resolves its imports relative to itself when
// chrome.runtime is absent, precisely so this check can exist.

import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
if (!fs.existsSync(CHROME)) {
  console.log(`SKIP — Chrome not found at ${CHROME} (set CHROME=...)`);
  process.exit(0);
}
if (!fs.existsSync(path.join(root, 'fixtures', 'sample.wb'))) {
  console.error('missing fixtures/sample.wb — run: node fixtures/make-fixture.mjs');
  process.exit(1);
}

const TYPES = {
  '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json',
  '.html': 'text/html', '.css': 'text/css', '.wb': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png',
};

// Injected into the real page, just before </body>: poll until the viewer has
// mounted, then report. The page uses top-level await, so --dump-dom captures
// it too early — the results are POSTed back instead.
const PROBE = `
<script type="module">
const out = [];
const say = (label, cond, extra) => out.push((cond ? 'ok   ' : 'FAIL ') + label + (extra ? '  — ' + extra : ''));
const deadline = Date.now() + 25000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
try {
  const wantsNotebook = new URLSearchParams(location.search).has('src');
  const host = document.querySelector('#sv-host');
  let shadow = null;
  while (Date.now() < deadline) {
    const mount = host.firstElementChild;
    if (mount && mount.shadowRoot && mount.shadowRoot.querySelector('.wb-cell')) {
      shadow = mount.shadowRoot; break;
    }
    if (!wantsNotebook && host.querySelector('.sv-drop')) break;
    await sleep(100);
  }

  if (wantsNotebook) {
    say('the page renders a notebook from ?src=', !!shadow);
    if (shadow) {
      const cells = shadow.querySelectorAll('.wb-cell');
      say('all cells render', cells.length > 5, cells.length + ' cells');
      say('stored KaTeX output renders', !!shadow.querySelector('.katex'));
      say('code cells are highlighted', shadow.querySelectorAll('[class^="wl-hl-"]').length > 0);
      const md = shadow.querySelector('.wb-cell-md .wb-math .katex');
      say('markdown math is typeset', !!md);
    }
    const note = document.querySelector('.sv-note').textContent;
    say('the toolbar reports what was loaded', /\\d+ cells/.test(note), note);
    say('the file name reaches the toolbar and the title',
        document.querySelector('.sv-name').textContent === 'sample.wb'
        && /sample\\.wb/.test(document.title), document.title);
    say('Download is enabled once a notebook is open',
        !document.querySelector('button[data-act=download]').disabled);
    say('the viewer is isolated in a shadow root', !!shadow && document.querySelector('.wb-cell') === null);
    // WL_CSS sets :root{--fraction-line-width}. If the shadow root leaked, the
    // toolbar of THIS page would be restyled by a notebook it opened.
    const leaked = getComputedStyle(document.documentElement)
        .getPropertyValue('--fraction-line-width').trim();
    say('notebook CSS does not leak onto the page chrome', leaked === '', leaked || 'clean');
    say('the module exposes its state for scripting', !!globalThis.__wbStandalone?.state?.model);
    // Standing alone there is no pane around the notebook, so the page itself
    // has to inset it — text flush against the window frame is what this pins.
    const firstCell = shadow && shadow.querySelector('.wb-cell');
    const left = firstCell ? firstCell.getBoundingClientRect().left : 0;
    say('the notebook is inset from the window edge', left >= 16, Math.round(left) + 'px');
  } else {
    say('with no ?src= the page offers a way to open one', !!host.querySelector('.sv-drop'));
    say('the drop zone names both routes',
        /Drop a \\.wb file here/.test(host.textContent) && /Open/.test(host.textContent));
    say('Download stays disabled with nothing open',
        document.querySelector('button[data-act=download]').disabled);
    say('no chrome.* API is required to load the page', true);
  }
} catch (e) {
  say('page threw: ' + (e && e.message), false);
}
await fetch('/__result', { method: 'POST', body: out.join('\\n') });
</script>
`;

let onResult = null;
const server = http.createServer((req, res) => {
  if (req.url === '/__result' && req.method === 'POST') {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => { res.writeHead(204); res.end(); onResult?.(body); });
    return;
  }
  const url = decodeURIComponent(req.url.split('?')[0]);
  const file = path.join(root, url);
  if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); res.end('not found'); return;
  }
  if (url === '/viewer/standalone.html') {
    const html = fs.readFileSync(file, 'utf8').replace('</body>', PROBE + '</body>');
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);
    return;
  }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});

await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wbstandalone-'));
const args = ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
              '--disable-dev-shm-usage', `--user-data-dir=${profile}`];

async function visit(url) {
  const chrome = spawn(CHROME, [...args, url], { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  chrome.stderr.on('data', (d) => { stderr += d; });
  const body = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 45_000);
    onResult = (b) => { clearTimeout(timer); resolve(b); };
    chrome.on('error', () => { clearTimeout(timer); resolve(null); });
  });
  chrome.kill('SIGKILL');
  if (body == null) {
    console.error(`the page never reported results: ${url}`);
    if (stderr.trim()) console.error(stderr.split('\n').slice(-10).join('\n'));
  }
  return body || 'FAIL page reported nothing';
}

let all = '';
try {
  all += await visit(`${base}/viewer/standalone.html?src=/fixtures/sample.wb`) + '\n';
  all += await visit(`${base}/viewer/standalone.html`) + '\n';
} finally {
  server.close();
  fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

console.log(all.trim());
const failures = (all.match(/^FAIL/gm) || []).length;
console.log(failures ? `\n${failures} FAILURE(S)` : '\nall standalone-viewer checks passed');
process.exit(failures ? 1 : 0);
