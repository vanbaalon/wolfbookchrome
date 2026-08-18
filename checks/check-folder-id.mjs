#!/usr/bin/env node
// Checks that the Overleaf FOLDER id is deduced, never asked for.
//
//   node checks/check-folder-id.mjs
//
// Saving needs a folder id that is not in the URL, not in a meta tag, and not
// derivable from the project id. Guessing it from `data-file-id` once wrote a
// notebook into the image folder while reporting success, and prompting the user
// for a 24-hex id is not a real answer either.
//
// Overleaf's own client is TOLD the tree: the joinProject payload on its
// websocket carries rootFolder and every _id. This check serves a realistic
// socket.io frame and asserts the bridge learns from it — including that a file
// living in a subfolder resolves to THAT folder, not the root.

import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
if (!fs.existsSync(CHROME)) { console.log('SKIP — Chrome not found'); process.exit(0); }

const ROOT_FOLDER = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const SUB_FOLDER = 'bbbbbbbbbbbbbbbbbbbbbbbb';

// Shaped like what Overleaf actually sends: a socket.io text frame whose tail is
// the JSON payload, with the project object nested inside.
const JOIN_FRAME = '5:::' + JSON.stringify({
  name: 'joinProjectResponse',
  args: [{
    project: {
      _id: '0123456789abcdef01234567',
      rootFolder: [{
        _id: ROOT_FOLDER,
        name: 'rootFolder',
        docs: [{ _id: 'd1', name: 'main.tex' }],
        fileRefs: [{ _id: 'f1', name: 'RootNotebook.wb' }],
        folders: [{
          _id: SUB_FOLDER,
          name: 'notebooks',
          docs: [],
          fileRefs: [{ _id: 'f2', name: 'Nested.wb' }],
          folders: [],
        }],
      }],
    },
  }],
});

const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>folder id</title></head>
<body>
<pre id="result">PENDING</pre>
<script src="/page-bridge.js"></script>
<script>
const out = [];
const say = (l, c, extra) => out.push((c ? 'ok   ' : 'FAIL ') + l + (extra ? '  — ' + extra : ''));
const wait = (ms) => new Promise(r => setTimeout(r, ms));

let seq = 0;
function ask(action) {
  return new Promise((resolve) => {
    const id = 'q' + (++seq);
    const t = setTimeout(() => resolve(null), 3000);
    window.addEventListener('message', function onMsg(ev) {
      if (ev.source !== window || ev.data?.type !== 'wb-bridge-response' || ev.data.id !== id) return;
      clearTimeout(t); window.removeEventListener('message', onMsg); resolve(ev.data.payload);
    });
    window.postMessage({ type: 'wb-bridge-request', id, action }, location.origin);
  });
}

(async () => {
 try {
  const before = await ask('get-project-tree');
  say('the bridge answers before any socket traffic', !!before);
  say('and reports no folder yet', before && !before.rootFolderId, String(before && before.rootFolderId));

  // The page opens a socket AFTER the bridge loaded — the ordering the
  // document_start hook exists to guarantee.
  const ws = new WebSocket('ws://' + location.host + '/socket');
  await new Promise((r) => { ws.addEventListener('open', r); ws.addEventListener('error', r); });
  await wait(600);

  const after = await ask('get-project-tree');
  say('the project tree is learned from the websocket', !!(after && after.rootFolderId),
      after && after.source);
  say('the ROOT folder id is correct', after?.rootFolderId === '${ROOT_FOLDER}',
      String(after?.rootFolderId));

  const folders = after?.folders || [];
  say('every folder is recorded', folders.length === 2, folders.map(f => f.path).join(','));
  say('folder paths are distinct and named',
      folders.some(f => f.path === '/') && folders.some(f => f.path === '/notebooks'),
      folders.map(f => f.path).join(','));

  const rootOwner = folders.find(f => (f.fileNames || []).includes('RootNotebook.wb'));
  say('a root-level file maps to the root folder', rootOwner?.id === '${ROOT_FOLDER}',
      String(rootOwner?.id));

  const subOwner = folders.find(f => (f.fileNames || []).includes('Nested.wb'));
  say('a file in a SUBFOLDER maps to that subfolder, not the root',
      subOwner?.id === '${SUB_FOLDER}', subOwner?.path + ' -> ' + subOwner?.id);
  say('so a nested notebook is not written to the wrong place',
      subOwner?.id !== '${ROOT_FOLDER}');
 } catch (e) {
  say('the check ran to completion', false, String(e && e.message));
 }
 document.getElementById('result').textContent = out.join('\\n');
 try { await fetch('/__result', { method: 'POST', body: out.join('\\n') }); } catch (e) {}
})();
</script></body></html>`;

let onResult = () => {};
const server = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  if (req.method === 'POST' && url === '/__result') {
    let b = ''; req.on('data', (d) => { b += d; });
    req.on('end', () => { res.writeHead(204); res.end(); onResult(b); });
    return;
  }
  if (url === '/') { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(PAGE); return; }
  const file = path.join(root, url);
  if (file.startsWith(root) && fs.existsSync(file) && !fs.statSync(file).isDirectory()) {
    res.writeHead(200, { 'Content-Type': 'text/javascript' });
    fs.createReadStream(file).pipe(res); return;
  }
  res.writeHead(404); res.end('not found');
});

// A minimal RFC 6455 server: enough to push one text frame, so the hook is
// exercised against a genuine WebSocket rather than a stub.
server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  const accept = crypto.createHash('sha1')
    .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n'
    + 'Connection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  const payload = Buffer.from(JOIN_FRAME, 'utf8');
  const header = payload.length < 126
    ? Buffer.from([0x81, payload.length])
    : Buffer.concat([Buffer.from([0x81, 126]), (() => { const b = Buffer.alloc(2); b.writeUInt16BE(payload.length); return b; })()]);
  setTimeout(() => socket.write(Buffer.concat([header, payload])), 150);
});

await new Promise((r) => server.listen(0, '127.0.0.1', r));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wbchrome-'));
let failures = 0;
try {
  const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    '--disable-dev-shm-usage', `--user-data-dir=${profile}`,
    `http://127.0.0.1:${server.address().port}/`], { stdio: ['ignore', 'pipe', 'pipe'] });
  const results = await new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), 60_000);
    onResult = (b) => { clearTimeout(t); resolve(b); };
    chrome.on('error', () => { clearTimeout(t); resolve(null); });
  });
  chrome.kill('SIGKILL');
  if (results == null) { console.error('the page never reported results.'); process.exit(1); }
  console.log(results);
  failures = (results.match(/^FAIL/gm) || []).length;
} finally {
  server.close();
  fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
console.log(failures ? `\n${failures} FAILURE(S)` : '\nfolder-id checks passed');
process.exit(failures ? 1 : 0);
