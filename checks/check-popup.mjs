#!/usr/bin/env node
// Browser check for the toolbar popup's server state, recovery instructions,
// and component-version table.

import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const extensionVersion = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8')).version;
const chromeBin = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
if (!fs.existsSync(chromeBin)) { console.log('SKIP — Chrome not found'); process.exit(0); }

const popup = fs.readFileSync(path.join(root, 'viewer', 'popup.html'), 'utf8');
const page = (online) => popup.replace(
  '<script type="module" src="popup.js"></script>',
  `<script>
  window.chrome = {
    runtime: {
      getManifest: () => ({ version: ${JSON.stringify(extensionVersion)} }), lastError: null,
      getURL: p => '/' + p,
      sendMessage: (msg, cb) => cb(${online ? JSON.stringify({
        ok: true, connected: true, running: true, port: 27300, authorised: true,
        health: { serverVersion: '0.3.0', versions: {
          wolfbook: '2.9.0', wolfbookBuildDate: '2026-08-19',
          wstp: '1.1.26', wstpBuildDate: '2026-08-18',
          btl: '2.2.33', btlBuildDate: '2026-08-17',
        } },
      }) : JSON.stringify({ ok: true, connected: false, running: false })}),
    },
    tabs: { create() {}, query(_q, cb) { cb([]); }, update() {} },
    windows: { update() {} },
  };
  </script>
  <script type="module">
    import '/viewer/popup.js';
    await new Promise(r => setTimeout(r, 250));
    const rows = Object.fromEntries([...document.querySelectorAll('[data-version]')]
      .map(el => [el.dataset.version, el.textContent.trim()]));
    await fetch('/result', { method: 'POST', body: JSON.stringify({
      text: document.querySelector('.status').textContent.trim(),
      help: document.querySelector('.help').classList.contains('visible'), rows,
    }) });
  </script>`
);

async function run(online) {
  let finish;
  const result = new Promise(r => { finish = r; });
  const server = http.createServer((req, res) => {
    if (req.url === '/result' && req.method === 'POST') {
      let raw = '';
      req.on('data', d => { raw += d; });
      req.on('end', () => { res.writeHead(204); res.end(); finish(JSON.parse(raw)); });
      return;
    }
    const url = req.url === '/' ? '/viewer/popup.html' : req.url;
    if (url === '/viewer/popup.html') {
      res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(page(online)); return;
    }
    const file = path.join(root, url);
    if (file.startsWith(root) && fs.existsSync(file)) {
      res.writeHead(200, { 'Content-Type': url.endsWith('.js') ? 'text/javascript' : 'application/octet-stream' });
      fs.createReadStream(file).pipe(res); return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wbpopup-'));
  const child = spawn(chromeBin, ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    `--user-data-dir=${profile}`, `http://127.0.0.1:${server.address().port}/`]);
  const value = await Promise.race([result, new Promise(r => setTimeout(() => r(null), 15000))]);
  child.kill('SIGKILL'); server.close();
  fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  return value;
}

let failures = 0;
const check = (label, ok, extra = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failures++;
};

const online = await run(true);
check('running server is shown as running', /Local server running/.test(online?.text || ''), online?.text);
check('running server shows its port', /27300/.test(online?.text || ''), online?.text);
check('running server hides startup help', online?.help === false);
check('popup exposes server, Wolfbook, WSTP and BTL versions',
  online?.rows?.server === 'v0.3.0' && online?.rows?.wolfbook.startsWith('v2.9.0')
  && online?.rows?.wstp.startsWith('v1.1.26') && online?.rows?.btl.startsWith('v2.2.33'),
  JSON.stringify(online?.rows));

const offline = await run(false);
check('stopped server is shown as not running', /not running/.test(offline?.text || ''), offline?.text);
check('stopped server shows actionable startup help', offline?.help === true);
check('Chrome-extension version remains visible offline', offline?.rows?.chrome === `v${extensionVersion}`);

console.log(failures ? `\n${failures} FAILURE(S)` : '\npopup checks passed');
process.exit(failures ? 1 : 0);
