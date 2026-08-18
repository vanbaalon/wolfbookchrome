#!/usr/bin/env node
// Checks in-browser evaluation: Run buttons, Run all, the result format toggle,
// and how failures are presented.
//
//   node checks/check-evaluate.mjs
//
// The `chrome` shim here stands in for the background worker and reports a
// CONNECTED local wolfbook, answering wolfbook_evaluateExpression itself. So
// this exercises the whole path — evaluator wiring, per-cell run, sequential
// Run all, TeXForm typesetting, error rendering — without needing a Wolfram
// kernel, and it records the arguments content.js sent so the request shape is
// checked too (multiLine in particular: without it a multi-statement cell,
// which is most real cells, would fail to parse).

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
<html><head><meta charset="utf-8"><title>evaluate</title>
<link rel="stylesheet" href="/content.css"></head>
<body style="margin:0;font:14px system-ui">
  <div role="tablist"><div role="tab" aria-selected="true">sample.wb</div></div>
  <div id="panel-source-editor" style="height:100vh;position:relative">
    <div class="file-view" style="height:100%">
      <div class="file-view-buttons">
        <a href="/project/${PROJECT_ID}/blob/abc" download="sample.wb">Download</a>
      </div>
      <p class="no-preview">Sorry, no preview is available.</p>
    </div>
  </div>
  <pre id="result" style="display:none">PENDING</pre>

<script>
// A connected local wolfbook that answers evaluations itself.
window.__calls = [];
window.__logs = [];
window.__errors = [];
window.addEventListener('error', (e) => window.__errors.push(String(e.message)));
window.addEventListener('unhandledrejection', (e) => window.__errors.push(String(e.reason && e.reason.message || e.reason)));
const _i = console.info.bind(console), _e = console.error.bind(console);
console.info = (...a) => { window.__logs.push('INFO ' + a.join(' ')); _i(...a); };
console.error = (...a) => { window.__logs.push('ERR ' + a.join(' ')); _e(...a); };
window.addEventListener('error', e => window.__logs.push('UNCAUGHT ' + e.message));
window.addEventListener('unhandledrejection', e => window.__logs.push('REJECT ' + (e.reason && e.reason.message)));
window.chrome = {
  storage: { local: {
    _v: {},
    set(o) { Object.assign(this._v, o); },
    get(k, cb) { cb({ [k]: this._v[k] }); },
  } },
  runtime: {
    lastError: null,
    getURL: (p) => '/' + String(p).replace(/^\\//, ''),
    sendMessage: (msg, cb) => {
      if (msg.cmd === 'mcp-status') return cb({ ok: true, connected: true, port: 27182 });
      if (msg.cmd === 'mcp-clients') {
        // Copied from a live server: two windows, three kernels.
        return cb({ ok: true, port: 27182, clients: [
          { clientId: 'VSCode[VSCodeWolframExtension]', role: 'primary', notebooks: [],
            kernels: [
              { kernel_id: 'k-7ea69930', kernel_label: 'K2', is_default: true,  lifecycle: 'idle', busy: false },
              { kernel_id: 'k-97d818dc', kernel_label: 'K4', is_default: false, lifecycle: 'idle', busy: false }] },
          { clientId: 'VSCode[2026 2d SoV]', role: 'worker', notebooks: [],
            kernels: [
              { kernel_id: 'k-71be882b', kernel_label: 'K1', is_default: true, lifecycle: 'idle', busy: true }] },
        ] });
      }
      if (msg.cmd === 'mcp-call') {
        window.__calls.push(msg);
        if (msg.name !== 'wolfbook_evaluateExpression') return cb({ ok: true, result: { content: [] } });
        const code = msg.args.expression || '';
        window.__lastArgs = msg.args;
        // A cell that should fail, so the error path is exercised.
        if (/BOOM/.test(code)) {
          return setTimeout(() => cb({ ok: true, result: {
            content: [{ type: 'text', text: 'Syntax::sntx: invalid syntax' }], isError: true } }), 20);
        }
        const text = msg.args.outputForm === 'TeXForm'
          ? '\\\\frac{\\\\sqrt{\\\\pi}}{2}'
          : '{1, 2, 3}';
        return setTimeout(() => cb({ ok: true, result: { content: [{ type: 'text', text }] } }), 20);
      }
      return cb({ ok: false, error: 'unknown cmd' });
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
  // Wait for the panel, then for the re-render that adds Run buttons once the
  // local server has answered.
  const deadline = Date.now() + 30000;
  let shadow = null, runBtns = [];
  while (Date.now() < deadline) {
    const host = document.getElementById('wolfbook-overleaf-host');
    shadow = host && host.shadowRoot;
    runBtns = shadow ? [...shadow.querySelectorAll('button.wb-run')] : [];
    if (runBtns.length) break;
    await wait(250);
  }

  say('Run buttons appear when a local wolfbook is connected', runBtns.length > 0,
      runBtns.length + ' button(s)');
  if (!runBtns.length) {
    const host = document.getElementById('wolfbook-overleaf-host');
    out.push('  DEBUG host=' + !!host + ' shadow=' + !!(host && host.shadowRoot)
      + ' notebook=' + !!(shadow && shadow.querySelector('.wb-notebook'))
      + ' cells=' + (shadow ? shadow.querySelectorAll('.wb-cell-code').length : -1)
      + ' hostText=' + (host ? JSON.stringify(host.textContent.slice(0, 140)) : 'n/a'));
    out.push('  LOGS ' + JSON.stringify(window.__logs.slice(-6)));
  }
  // ── kernel picker ────────────────────────────────────────────────────
  const sel = shadow && shadow.querySelector('select.wb-kernel');
  say('a kernel picker is offered', !!sel);
  if (sel) {
    say('every kernel is listed', sel.querySelectorAll('option').length === 3,
        sel.querySelectorAll('option').length + ' option(s)');
    say('kernels are grouped by window', sel.querySelectorAll('optgroup').length === 2);
    const groups = [...sel.querySelectorAll('optgroup')].map(g => g.label);
    say('the window name is readable, not the raw client id',
        groups.some(l => l.includes('VSCodeWolframExtension (primary)')), JSON.stringify(groups));
    say('kernel labels and state are shown',
        [...sel.options].some(o => /K2 · default · idle/.test(o.textContent)),
        [...sel.options].map(o => o.textContent).join(' | '));
    say('a busy kernel says so', [...sel.options].some(o => /K1 · default · busy/.test(o.textContent)));
    say('the primary window default kernel is preselected',
        sel.value === 'k-7ea69930', sel.value);
  }

  const runGroup = shadow && shadow.querySelector('.wb-run-group');
  say('Run all controls are shown', !!(runGroup && !runGroup.hidden));
  const openBtn = shadow && shadow.querySelector('[data-act="open"]');
  say('Open in Wolfbook is enabled when connected', !!(openBtn && !openBtn.disabled));

  if (runBtns.length) {
    // ── one cell ────────────────────────────────────────────────────────
    runBtns[0].click();
    await wait(600);
    const live = shadow.querySelector('.wb-live');
    say('a live result area appears', !!(live && !live.hidden));
    say('the result text is shown', !!(live && live.textContent.includes('{1, 2, 3}')),
        live && live.textContent.replace(/\\s+/g, ' ').slice(0, 60));
    say('the result is labelled as coming from the local kernel',
        !!(live && /local kernel/i.test(live.textContent)));
    say('the live result is separate from stored outputs',
        !!(live && !live.closest('.wb-output')));

    const args = window.__lastArgs || {};
    say('multiLine is requested', args.multiLine === true);
    say('the chosen window is routed to per call',
        args.client_id === 'VSCode[VSCodeWolframExtension]', String(args.client_id));
    say('the chosen kernel is routed to per call',
        args.kernel_id === 'k-7ea69930', String(args.kernel_id));
    say('the whole cell source is sent', typeof args.expression === 'string' && args.expression.length > 0);
    say('a timeout is set', typeof args.timeoutSeconds === 'number', String(args.timeoutSeconds));

    // ── format toggle ───────────────────────────────────────────────────
    const formBtn = shadow.querySelector('[data-act="form"]');
    say('format toggle starts on Text', formBtn && formBtn.textContent.trim() === 'Text');
    formBtn.click();
    say('format toggle switches to Math', formBtn.textContent.trim() === 'Math');
    runBtns[0].click();
    await wait(600);
    const live2 = shadow.querySelector('.wb-live');
    say('TeXForm is requested when Math is selected', (window.__lastArgs || {}).outputForm === 'TeXForm');
    say('a TeXForm result is typeset with KaTeX', !!live2.querySelector('.katex'));
    formBtn.click();                                   // back to text

    // ── switching kernels ───────────────────────────────────────────────
    // A client id containing spaces and brackets — "VSCode[2026 2d SoV]" is a
    // real one — must survive being selected.
    sel.value = 'k-71be882b';
    sel.dispatchEvent(new Event('change'));
    runBtns[0].click();
    await wait(600);
    say('switching kernel changes where evaluation is routed',
        (window.__lastArgs || {}).kernel_id === 'k-71be882b'
          && (window.__lastArgs || {}).client_id === 'VSCode[2026 2d SoV]',
        (window.__lastArgs || {}).client_id + ' / ' + (window.__lastArgs || {}).kernel_id);
    say('the choice is remembered in extension storage',
        !!(chrome.storage.local._v.wbKernelTarget
           && chrome.storage.local._v.wbKernelTarget.kernelId === 'k-71be882b'));
    // restore the primary kernel for the remaining checks
    sel.value = 'VSCode[VSCodeWolframExtension] k-7ea69930';
    sel.dispatchEvent(new Event('change'));

    // ── errors ──────────────────────────────────────────────────────────
    const errCell = [...shadow.querySelectorAll('.wb-cell-code')].find(c => /BOOM/.test(c.__wbCode || ''));
    if (errCell) {
      await errCell.__wbRun();
      const el = errCell.querySelector('.wb-live');
      say('an error result is marked as an error', el && el.classList.contains('wb-live-error'));
      say('the error message is shown', el && el.textContent.includes('sntx'));
    } else say('a failing cell exists in the fixture', false);

    // ── editing (CodeMirror 6) ──────────────────────────────────────────
    const editCell = [...shadow.querySelectorAll('.wb-cell-code')]
        .find(c => /Range\\[3\\]/.test(c.__wbCode || ''));
    if (editCell) {
      const pre = editCell.querySelector('.wb-input pre');
      say('code is read-only until clicked', !editCell.querySelector('.cm-editor'));
      pre.click();
      const deadlineEd = Date.now() + 15000;
      while (Date.now() < deadlineEd && !editCell.querySelector('.cm-editor')) await wait(200);

      const cm = editCell.querySelector('.cm-editor');
      say('clicking a cell mounts a CodeMirror editor', !!cm);
      if (cm) {
        say('the editor holds the cell source',
            /Range\\[3\\]/.test(cm.textContent), cm.textContent.slice(0, 30));
        say('Wolfram syntax is highlighted in the editor',
            !!cm.querySelector('.cm-line span[class*="ͼ"], .cm-line span[style]'),
            (cm.querySelector('.cm-line span') || {}).className || 'no token spans');
        say('line numbers are shown', !!cm.querySelector('.cm-gutters'));

        // Type a change, then evaluate it: the EDITED text must be what runs.
        const view = editCell.querySelector('.wb-editor')?.__view || null;
        const cmContent = cm.querySelector('.cm-content');
        cmContent.focus();
        // Drive the document through CM's own API via the exported handle.
        const handle = editCell.__wbEditorHandle;
        if (handle) {
          handle.view.dispatch({
            changes: { from: 0, to: handle.view.state.doc.length, insert: 'Range[9]' },
          });
          await wait(200);
          say('typing updates the document', handle.getValue() === 'Range[9]', handle.getValue());
          await editCell.__wbRun();
          say('running an edited cell evaluates the NEW code',
              (window.__lastArgs || {}).expression === 'Range[9]',
              (window.__lastArgs || {}).expression);
          say('an edited cell is badged', !!editCell.querySelector('.wb-edited-badge'));
        } else say('the editor handle is exposed for tests', false);
      }
    } else say('an editable cell exists in the fixture', false);

    // A realistic multi-line cell — comment, strings, nested brackets — is what
    // exercises the tokenizer's state machine across lines. A this-dependent
    // tokenizer threw here the instant an editor was created, and the cell was
    // left visually EMPTY because the <pre> had already been hidden.
    const multi = [...shadow.querySelectorAll('.wb-cell-code')]
        .find(c => /Baxter solver/.test(c.__wbCode || ''));
    if (multi) {
      const mpre = multi.querySelector('.wb-input pre');
      const beforeLen = (multi.__wbCode || '').length;
      mpre.click();
      const dl = Date.now() + 15000;
      while (Date.now() < dl && !multi.querySelector('.cm-editor')) await wait(200);
      const mcm = multi.querySelector('.cm-editor');
      say('a multi-line cell opens an editor', !!mcm);
      say('the cell is never left blank',
          (multi.__wbCode || '').length === beforeLen && beforeLen > 0,
          (multi.__wbCode || '').slice(0, 26));
      if (mcm) {
        say('every line is present in the editor',
            /Baxter solver/.test(mcm.textContent) && /BSolver2D\.wl/.test(mcm.textContent));
        say('the multi-line cell is tokenised', !!mcm.querySelector('.cm-line span'));
      }
      say('no uncaught errors while editing', (window.__errors || []).length === 0,
          (window.__errors || []).slice(0, 2).join(' | ') || 'none');
    } else say('a multi-line cell exists in the fixture', false);

    // ── run all ─────────────────────────────────────────────────────────
    const runAll = shadow.querySelector('[data-act="run-all"]');
    runAll.click();
    // Checked with no await: the handler reveals Stop synchronously, and the
    // mock kernel is fast enough that a delay here would see the run already
    // finished and Stop correctly hidden again.
    say('Stop appears while running', !shadow.querySelector('[data-act="stop"]').hidden);
    await wait(400);
    const deadline2 = Date.now() + 25000;
    while (Date.now() < deadline2 && runAll.disabled) await wait(200);
    const lives = shadow.querySelectorAll('.wb-live:not([hidden])');
    say('Run all evaluated every code cell', lives.length === runBtns.length,
        lives.length + '/' + runBtns.length);
    const note = shadow.querySelector('.wb-note');
    say('Run all reports what happened', /ran \\d+\\/\\d+ cell/.test(note.textContent),
        note.textContent);
    say('Stop is hidden again afterwards', shadow.querySelector('[data-act="stop"]').hidden);
  }

  document.getElementById('result').textContent = out.join('\\n');
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
  if (url.startsWith(`/project/${PROJECT_ID}/blob/`)) {
    // A small notebook: three code cells, one of which must fail.
    const wb = {
      cells: [
        { kind: 1, value: '# Evaluation fixture', languageId: 'markdown', outputs: [] },
        { kind: 2, value: 'Range[3]', languageId: 'wolfram', outputs: [] },
        { kind: 2, languageId: 'wolfram', outputs: [], value:
          '(* Load the Baxter solver. *)\n'
          + 'root = ParentDirectory[ParentDirectory[NotebookDirectory[]]];\n'
          + 'Get[FileNameJoin[{root, "External", "BSolver", "BSolver2D.wl"}]];' },
        { kind: 2, value: 'a = 1;\nb = 2;\na + b', languageId: 'wolfram', outputs: [] },
        { kind: 2, value: 'BOOM[[', languageId: 'wolfram', outputs: [] },
      ],
    };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(wb));
    return;
  }
  const file = path.join(root, url);
  if (file.startsWith(root) && fs.existsSync(file) && !fs.statSync(file).isDirectory()) {
    // .mjs MUST be a JavaScript MIME type: Chrome refuses to execute a module
    // served as application/octet-stream, which silently breaks katex.mjs.
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
    const timer = setTimeout(() => resolve(null), 90_000);
    onResult = (b) => { clearTimeout(timer); resolve(b); };
    chrome.on('error', () => { clearTimeout(timer); resolve(null); });
  });
  chrome.kill('SIGKILL');

  if (results == null) { console.error('the page never reported results.'); process.exit(1); }
  console.log(results);
  if (/FAIL/.test(results)) {
    const noisy = stderr.split('\n').filter((l) => /CONSOLE|Uncaught/.test(l)).slice(-5);
    if (noisy.length) console.error('\n--- browser console ---\n' + noisy.join('\n'));
  }
  failures = (results.match(/^FAIL/gm) || []).length;
} finally {
  server.close();
  fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nevaluation checks passed');
process.exit(failures ? 1 : 0);
