#!/usr/bin/env node
// THE capstone check: Overleaf → extension → wolfbook-serve → real kernel →
// a real SVG rendered in the browser.
//
//   node checks/check-serve-integration.mjs
//
// Everything below the extension is genuine: a real wolfbook-serve instance
// driving a real Wolfram kernel. Only the `chrome` layer is a shim, and it does
// no work of its own — it forwards to the actual server exactly as background.js
// does, so what is proven is that the kernel's own HTML survives the whole
// journey and its images load over HTTP inside the page.
//
// Skips cleanly when no kernel or no installed extension is available.

import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const SERVE = path.join(root, 'server');
const PROJECT_ID = '0123456789abcdef01234567';

const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
if (!fs.existsSync(CHROME)) { console.log('SKIP — Chrome not found'); process.exit(0); }

const { resolveHost } = await import(path.join(SERVE, 'host.mjs'));
const pre = resolveHost();
if (!pre.kernelExecutable || !pre.extensionDir) {
  console.log('SKIP — no Wolfram kernel or no installed wolfbook extension');
  process.exit(0);
}

const { startServer } = await import(path.join(SERVE, 'server.mjs'));
console.log('starting wolfbook-serve…');
const wb = await startServer({ port: 0 });
console.log(`wolfbook-serve on ${wb.url} (kernel from ${wb.host.source})`);

const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>overleaf + serve</title>
<meta name="ol-csrfToken" content="tok">
<meta name="ol-rootFolder" content='[{"_id":"0123456789abcdef01234566","name":"rootFolder"}]'>
<link rel="stylesheet" href="/content.css"></head>
<body style="margin:0;font:14px system-ui">
  <div role="tablist"><div role="tab" aria-selected="true">sample.wb</div></div>
  <div class="file-tree"><ul><li role="treeitem"><span class="entity-name">sample.wb</span></li></ul></div>
  <div id="panel-source-editor" style="height:100vh;position:relative">
    <div class="file-view" style="height:100%">
      <div class="file-view-buttons">
        <a id="dl" href="/project/${PROJECT_ID}/blob/abc" download="sample.wb">Download</a>
      </div>
      <p class="no-preview">Sorry, no preview is available.</p>
    </div>
  </div>
  <pre id="result" style="display:none">PENDING</pre>

<script>
// The shim forwards to the REAL server, the way background.js does.
const SERVE_URL = ${JSON.stringify(wb.url)};
const SERVE_TOKEN = ${JSON.stringify(wb.token)};
const SERVE_PORT = ${wb.port};
window.__prompted = 0;
window.__attachCount = 0;
window.__WB_ATTACH_HEARTBEAT_MS = 500;
window.prompt = () => { window.__prompted++; return SERVE_TOKEN; };
let rpcResponse = null;
async function ensureRpcStream() {
  if (rpcResponse) return rpcResponse;
  rpcResponse = await fetch(SERVE_URL + '/v1/events?token=' + encodeURIComponent(SERVE_TOKEN));
  // Consume the stream so the connection remains live for reverse RPC.
  (async () => {
    const reader = rpcResponse.body.getReader();
    try { while (!(await reader.read()).done) {} } catch (_) {}
  })();
  return rpcResponse;
}
window.chrome = {
  storage: { local: {
    _v: {},   // deliberately empty: exercise the "ask on first evaluate" path
    set(o, cb) { Object.assign(this._v, o); if (cb) cb(); },
    get(k, cb) { cb({ [k]: this._v[k] }); },
  } },
  runtime: {
    // A live extension always has an id; content.js treats its absence as an
    // orphaned content script (the extension reloaded under the tab).
    id: 'wolfbook-check',
    lastError: null,
    getURL: (p) => '/' + String(p).replace(/^\\//, ''),
    sendMessage: (msg, cb) => {
      (async () => {
        try {
          if (msg.cmd === 'serve-status') {
            const h = await (await fetch(SERVE_URL + '/health')).json();
            const stored = window.chrome.storage.local._v.wbServeToken;
            const i = stored
              ? await fetch(SERVE_URL + '/v1/info', { headers: { 'X-Wolfbook-Token': stored } })
              : { ok: false };
            return cb({ ok: true, connected: h.service === 'wolfbook-serve', port: SERVE_PORT,
                        authorised: !!i.ok, hasToken: !!stored,
                        info: i.ok ? await i.json() : null });
          }
          if (msg.cmd === 'serve-set-token') {
            const r = await fetch(SERVE_URL + '/v1/info', { headers: { 'X-Wolfbook-Token': msg.token } });
            if (r.ok) window.chrome.storage.local._v.wbServeToken = msg.token;
            return cb({ ok: true, connected: true, port: SERVE_PORT, authorised: r.ok });
          }
          if (msg.cmd === 'serve-eval') {
            const stored = window.chrome.storage.local._v.wbServeToken;
            if (!stored) return cb({ ok: false, error: 'wolfbook-serve rejected the token.' });
            const r = await fetch(SERVE_URL + '/v1/eval', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'X-Wolfbook-Token': stored },
              body: JSON.stringify(msg.args || {}),
            });
            if (!r.ok) return cb({ ok: false, error: 'HTTP ' + r.status });
            return cb({ ok: true, result: await r.json() });
          }
          if (msg.cmd === 'serve-attach') {
            const stored = window.chrome.storage.local._v.wbServeToken;
            if (!stored) return cb({ ok: false, error: 'no token' });
            await ensureRpcStream();
            const r = await fetch(SERVE_URL + '/v1/notebooks/attach', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'X-Wolfbook-Token': stored },
              body: JSON.stringify(msg.notebook || {}),
            });
            const body = await r.json();
            window.__attachCount++;
            return cb({ ok: r.ok, result: r.ok ? body : null, error: r.ok ? null : body.error });
          }
          if (msg.cmd === 'serve-detach') return cb({ ok: true });
          if (msg.cmd === 'mcp-status') return cb({ ok: true, connected: false });
          cb({ ok: false, error: 'unhandled ' + msg.cmd });
        } catch (e) { cb({ ok: false, error: String(e.message || e) }); }
      })();
    },
  },
};
</script>
<script src="/content.js"></script>

<script>
const out = [];
const say = (l, c, extra) => out.push((c ? 'ok   ' : 'FAIL ') + l + (extra ? '  — ' + extra : ''));
const wait = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
 try {
  const deadline = Date.now() + 40000;
  let shadow = null, runBtns = [];
  while (Date.now() < deadline) {
    const host = document.getElementById('wolfbook-overleaf-host');
    shadow = host && host.shadowRoot;
    runBtns = shadow ? [...shadow.querySelectorAll('button.wb-run')] : [];
    if (runBtns.length) break;
    await wait(250);
  }
  say('the extension connected to wolfbook-serve', runBtns.length > 0,
      runBtns.length + ' Run button(s)');

  if (runBtns.length) {
    const dot = shadow.querySelector('.wb-dot');
    say('the status dot names wolfbook-serve', /wolfbook-serve/.test(dot?.title || ''), dot?.title);
    say('no browser dialog is used at all', window.__prompted === 0);
    say('no token bar before any evaluation', !shadow.querySelector('.wb-token-bar'));

    // ── a plot: the whole point ─────────────────────────────────────────
    const plotCell = [...shadow.querySelectorAll('.wb-cell-code')]
        .find(c => /Plot\\[/.test(c.__wbCode || ''));

    // Clicking Run is what should surface the token bar — not opening the file.
    const running = plotCell.__wbRun();
    await wait(500);
    const bar = shadow.querySelector('.wb-token-bar');
    say('the token bar appears on the first evaluation', !!bar);
    if (bar) {
      say('it explains how to get the token',
          /cli\.mjs token/.test(bar.textContent), bar.textContent.replace(/[\\s\\n]+/g, ' ').trim().slice(0, 70));
      bar.querySelector('.wb-token-input').value = SERVE_TOKEN;
      bar.querySelector('[data-act="token-ok"]').click();
      await wait(800);
      say('the bar closes once the token is accepted', !shadow.querySelector('.wb-token-bar'));
    }
    const attachedDeadline = Date.now() + 5000;
    let advertised = [];
    while (Date.now() < attachedDeadline) {
      const r = await fetch(SERVE_URL + '/v1/notebooks', {
        headers: { 'X-Wolfbook-Token': SERVE_TOKEN },
      });
      advertised = (await r.json()).notebooks || [];
      if (advertised.some(p => /sample\.wb$/.test(p))) break;
      await wait(100);
    }
    say('the open Overleaf notebook is advertised to MCP',
        advertised.some(p => /sample\.wb$/.test(p)), JSON.stringify(advertised));
    const attachedOnce = window.__attachCount;
    await wait(1200);
    say('attachment is renewed even while its previous id exists',
        window.__attachCount > attachedOnce,
        attachedOnce + ' → ' + window.__attachCount + ' attach call(s)');
    await running;
    // The first click was refused for want of a token; run it again now.
    await plotCell.__wbRun();
    const live = plotCell.querySelector('.wb-live');
    say('the result is labelled as coming from wolfbook-serve',
        /wolfbook-serve/.test(live?.textContent || ''), (live?.textContent || '').slice(0, 40));

    const img = live.querySelector('img');
    say('a Plot renders as a real IMAGE, not a text description', !!img,
        img ? img.getAttribute('src').slice(0, 60) : live.textContent.slice(0, 80));
    if (img) {
      say('the image points at the local server',
          /^http:\\/\\/127\\.0\\.0\\.1:\\d+\\/img\\//.test(img.src), img.src.slice(0, 70));
      // Did the browser actually LOAD it?
      await new Promise((r) => {
        if (img.complete && img.naturalWidth > 0) return r();
        img.addEventListener('load', r, { once: true });
        img.addEventListener('error', r, { once: true });
        setTimeout(r, 4000);
      });
      say('the browser successfully loaded the image',
          img.naturalWidth > 20 && img.naturalHeight > 20,
          img.naturalWidth + 'x' + img.naturalHeight);
    }

    // ── maths ───────────────────────────────────────────────────────────
    const mathCell = [...shadow.querySelectorAll('.wb-cell-code')]
        .find(c => /Integrate\\[/.test(c.__wbCode || ''));
    await mathCell.__wbRun();
    const mlive = mathCell.querySelector('.wb-live');
    say('an integral is typeset with KaTeX in the browser',
        !!mlive.querySelector('.katex'),
        (mlive.textContent || '').replace(/\\s+/g, ' ').slice(0, 60));

    // ── untruncated output + Print ──────────────────────────────────────
    const bigCell = [...shadow.querySelectorAll('.wb-cell-code')]
        .find(c => /Range\\[400\\]/.test(c.__wbCode || ''));
    await bigCell.__wbRun();
    const btxt = bigCell.querySelector('.wb-live')?.textContent || '';
    say('large output is not truncated', /\\b399\\b/.test(btxt), btxt.length + ' chars');

    const printCell = [...shadow.querySelectorAll('.wb-cell-code')]
        .find(c => /Print\\[/.test(c.__wbCode || ''));
    await printCell.__wbRun();
    say('Print output is shown',
        /hello from the kernel/.test(printCell.querySelector('.wb-live')?.textContent || ''));

    // ── state is shared across cells, as in a notebook ──────────────────
    const setCell = [...shadow.querySelectorAll('.wb-cell-code')].find(c => /wbX = 6/.test(c.__wbCode || ''));
    const useCell = [...shadow.querySelectorAll('.wb-cell-code')].find(c => /wbX \\* 7/.test(c.__wbCode || ''));
    await setCell.__wbRun();
    await useCell.__wbRun();
    say('kernel state persists between cells',
        /42/.test(useCell.querySelector('.wb-live')?.textContent || ''),
        (useCell.querySelector('.wb-live')?.textContent || '').replace(/\\s+/g, ' ').slice(0, 40));
  }

  // ── the round trip: run a plot, save it, check the picture is in the file ──
  const plot2 = [...shadow.querySelectorAll('.wb-cell-code')]
      .find(c => (c.__wbCode || '').includes('Plot['));
  await plot2.__wbRun();
  await wait(500);
  say('the stale saved output is hidden once the cell is re-run',
      !!plot2.querySelector('.wb-superseded-note')
      || plot2.querySelectorAll('.wb-output:not(.wb-output-superseded)').length === 0);

  const sBtn = shadow.querySelector('[data-act="save"]');
  say('running a cell makes the notebook savable', !!sBtn && !sBtn.hidden, sBtn && sBtn.textContent);
  sBtn.click();
  // Overleaf swaps the Download link to the new blob once the replace lands;
  // without simulating that, verification correctly reports the save as
  // ineffective — and a loose /Saved/ test would then pass on the words
  // "Saved to wrong place?", which is the opposite of what it claims to check.
  (async () => {
    for (let i = 0; i < 60; i++) {
      await wait(250);
      const h = (await (await fetch('/__hash')).json()).hash;
      if (h) {
        const dl = document.getElementById('dl');
        if (dl) dl.setAttribute('href', '/project/${PROJECT_ID}/blob/' + h);
        break;
      }
    }
  })();
  const dlS = Date.now() + 40000;
  while (Date.now() < dlS && !/Saved ✓|failed|wrong place/.test(sBtn.textContent)) await wait(400);
  say('the save completed and was verified', sBtn.textContent.includes('Saved ✓'), sBtn.textContent);

  const saved = await (await fetch('/__saved')).json();
  let wb = null;
  try { wb = JSON.parse(saved.text); } catch (e) {}
  say('the uploaded file is valid .wb JSON', !!wb, saved.text.slice(0, 40));
  if (wb) {
    const cell = wb.cells.find(c => (c.value || '').includes('Plot['));
    const htmlItem = (cell?.outputs?.[0]?.items || []).find(i => i.mime.includes('wolfram-language-html'));
    say('the NEW output was written into the file', !!htmlItem);
    if (htmlItem) {
      // Plain string tests, not regexes: this whole page is a template literal
      // in the harness, and an escaped slash collapses there — turning a valid
      // regex into a syntax error that kills the script before it reports.
      say('the plot image travelled with it as a data: URI',
          htmlItem.data.includes('src="data:image/svg'), htmlItem.data.slice(0, 60));
      say('no local temp path leaked into the file', !htmlItem.data.includes('data-wl-img'));
      say('no stale session epoch was written', !htmlItem.data.includes('data-session-epoch'));
      say('the saved output needs no sidecar files',
          !htmlItem.data.includes('data-wl-plot-src') && !htmlItem.data.includes('data-wl-mesh-src'));
    }
  }

 } catch (err) {
  say('the check ran to completion', false, String(err && err.message || err));
 }
 document.getElementById('result').textContent = out.join('\\n');
 try { await fetch('/__result', { method: 'POST', body: out.join('\\n') }); } catch (e) {}
})();
</script></body></html>`;

let onResult = () => {};
let savedText = '';
let uploadedHash = null;
const server = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  if (req.method === 'POST' && url === '/__result') {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => { res.writeHead(204); res.end(); onResult(body); });
    return;
  }
  if (req.method === 'POST' && url === `/project/${PROJECT_ID}/upload`) {
    const chunks = [];
    req.on('data', (d) => chunks.push(d));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const m = /filename="[^"]+"\r\nContent-Type:[^\r]*\r\n\r\n([\s\S]*?)\r\n------/.exec(body);
      savedText = m ? m[1] : '';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      uploadedHash = 'deadbeef';
      res.end(JSON.stringify({ success: true, entity_id: 'e1', entity_type: 'file', hash: uploadedHash }));
    });
    return;
  }
  if (url === '/__hash') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ hash: uploadedHash }));
    return;
  }
  if (url === '/__saved') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ text: savedText }));
    return;
  }
  if (url === `/project/${PROJECT_ID}`) {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(PAGE);
    return;
  }
  if (url.startsWith(`/project/${PROJECT_ID}/blob/`)) {
    const wbDoc = { cells: [
      { kind: 1, value: '# Live evaluation via wolfbook-serve', languageId: 'markdown', outputs: [] },
      { kind: 2, value: 'Plot[Sin[x], {x, 0, 2 Pi}]', languageId: 'wolfram', outputs: [] },
      { kind: 2, value: 'Integrate[1/(1 + x^3), x]', languageId: 'wolfram', outputs: [] },
      { kind: 2, value: 'Range[400]', languageId: 'wolfram', outputs: [] },
      { kind: 2, value: 'Print["hello from the kernel"]; 1', languageId: 'wolfram', outputs: [] },
      { kind: 2, value: 'wbX = 6;', languageId: 'wolfram', outputs: [] },
      { kind: 2, value: 'wbX * 7', languageId: 'wolfram', outputs: [] },
    ] };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(wbDoc));
    return;
  }
  const file = path.join(root, url);
  if (file.startsWith(root) && fs.existsSync(file) && !fs.statSync(file).isDirectory()) {
    const TYPES = { '.js': 'text/javascript', '.mjs': 'text/javascript',
                    '.css': 'text/css', '.json': 'application/json' };
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
    '--disable-dev-shm-usage', '--enable-logging=stderr', '--v=0',
    `--user-data-dir=${profile}`, pageUrl,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  chrome.stderr.on('data', (d) => { stderr += d; });

  const results = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 150_000);
    onResult = (b) => { clearTimeout(timer); resolve(b); };
    chrome.on('error', () => { clearTimeout(timer); resolve(null); });
  });
  chrome.kill('SIGKILL');
  if (results == null) {
    console.error('the page never reported results.');
    console.error(stderr.split('\n').filter((l) => /CONSOLE|Uncaught|SyntaxError/.test(l)).slice(-8).join('\n') || stderr.slice(-800));
    process.exit(1);
  }
  console.log(results);
  failures = (results.match(/^FAIL/gm) || []).length;
} finally {
  server.close();
  await wb.close();
  fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nOverleaf ↔ wolfbook-serve integration passed');
process.exit(failures ? 1 : 0);
