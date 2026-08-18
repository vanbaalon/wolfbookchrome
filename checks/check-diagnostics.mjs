#!/usr/bin/env node
// Checks the DIAGNOSTICS, not the viewer.
//
//   node checks/check-diagnostics.mjs
//
// When the panel does not appear on the real Overleaf, this reporting is the
// only thing standing between "it silently does nothing" and a fix — so it gets
// its own test. The page below deliberately presents a layout content.js cannot
// use: a .wb is clearly open, but every container is too small to be a pane.
//
// Asserts that the extension notices, says so repeatedly, names which probe
// failed, and can produce a full report including a DOM outline.

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
<html><head><meta charset="utf-8"><title>unmountable overleaf</title>
<link rel="stylesheet" href="/content.css"></head>
<body style="margin:0;font:14px system-ui">
  <!-- A .wb is unmistakably open... -->
  <div role="tablist"><div role="tab" aria-selected="true">sample.wb</div></div>
  <div class="file-tree"><li role="treeitem" aria-selected="true">
    <span class="entity-name">sample.wb</span></li></div>
  <!-- ...but nothing here is big enough to be an editor pane. -->
  <main><div id="panel-source-editor" style="height:8px;width:8px">tiny</div></main>
<script>
window.__logs = [];
const realInfo = console.info.bind(console);
console.info = (...a) => { window.__logs.push(a.join(' ')); realInfo(...a); };
window.chrome = {
  runtime: {
    lastError: null,
    getURL: (p) => '/' + String(p).replace(/^\\//, ''),
    sendMessage: (m, cb) => { if (cb) cb({ ok: true, connected: false }); },
  },
  storage: { local: { set: (o) => { window.__stored = o; } } },
};
</script>
<script src="/content.js"></script>
<script src="/page-bridge.js"></script>
<script>
const out = [];
const say = (l, c, extra) => out.push((c ? 'ok   ' : 'FAIL ') + l + (extra ? '  — ' + extra : ''));

(async () => {
  // Two periodic ticks are 4s apart; wait long enough to see repetition.
  await new Promise(r => setTimeout(r, 10000));

  const reports = window.__logs.filter(l => l.includes('no panel yet'));
  say('reports that no panel mounted', reports.length >= 1,
      reports.length + ' report(s)');
  say('repeats without being asked', reports.length >= 2,
      reports.length + ' report(s) in 10s');
  say('numbers the attempts', reports.some(l => /check \\d+\\/\\d+/.test(l)));

  const any = reports[0] || '';
  say('names the file it found', any.includes('sample.wb'));
  say('reports the failing probe as (none found)', any.includes('editor pane    : (none found)'),
      (any.match(/editor pane.*/) || [''])[0]);
  say('shows the probes that DID work', any.includes('active tab     : sample.wb'));
  say('includes a DOM outline on the first report',
      window.__logs.some(l => l.includes('── file tree ──') && l.includes('── editor region ──')));
  say('persists the report to extension storage',
      !!(window.__stored && window.__stored.lastDiagnosis));

  // The page-world entry point must work in the default console context.
  say('__wolfbookDiagnose is defined in the page world',
      typeof window.__wolfbookDiagnose === 'function');
  if (typeof window.__wolfbookDiagnose === 'function') {
    const before = window.__logs.length;
    window.__wolfbookDiagnose('full');
    await new Promise(r => setTimeout(r, 800));
    say('__wolfbookDiagnose() produces a report', window.__logs.length > before);
  }

  try { await fetch('/__result', { method: 'POST', body: out.join('\\n') }); } catch (e) {}
})();
</script></body></html>`;

let onResult = () => {};
const server = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  if (req.method === 'POST' && url === '/__result') {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => { res.writeHead(204); res.end(); onResult(body); });
    return;
  }
  if (url === `/project/${PROJECT_ID}`) {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(PAGE);
    return;
  }
  const file = path.join(root, url);
  if (file.startsWith(root) && fs.existsSync(file) && !fs.statSync(file).isDirectory()) {
    const TYPES = { '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
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
    '--disable-dev-shm-usage', `--user-data-dir=${profile}`, pageUrl,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  const results = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 75_000);
    onResult = (b) => { clearTimeout(timer); resolve(b); };
    chrome.on('error', () => { clearTimeout(timer); resolve(null); });
  });
  chrome.kill('SIGKILL');

  if (results == null) { console.error('the page never reported results.'); process.exit(1); }
  console.log(results);
  failures = (results.match(/^FAIL/gm) || []).length;
} finally {
  server.close();
  fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\ndiagnostics checks passed');
process.exit(failures ? 1 : 0);
