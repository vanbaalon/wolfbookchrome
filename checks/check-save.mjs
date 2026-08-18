#!/usr/bin/env node
// Checks writing a .wb back to Overleaf.
//
//   node checks/check-save.mjs
//
// The server here impersonates Overleaf's upload endpoint and asserts the
// request matches the one CAPTURED from Overleaf's own drag-and-drop uploader —
// field names, the qqfile part, the CSRF header — because this endpoint is
// reverse-engineered from that capture and a silent drift would corrupt saves.
//
// It also pins the two properties that protect a shared project: a save must
// change ONLY the edited cell's `value`, and must refuse when the file changed
// in Overleaf since it was opened (there is no OT merge for a binary file).

import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const PROJECT_ID = '0123456789abcdef01234567';
const FOLDER_ID = '0123456789abcdef01234566';
const CSRF = 'test-csrf-token-value';

const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
if (!fs.existsSync(CHROME)) { console.log('SKIP — Chrome not found'); process.exit(0); }

const NOTEBOOK = {
  cells: [
    { kind: 1, value: '# Save test', languageId: 'markdown', outputs: [], metadata: {} },
    { kind: 2, value: 'Range[3]', languageId: 'wolfram', metadata: { keepMe: true },
      outputs: [{ items: [{ mime: 'text/plain', data: '{1, 2, 3}' }], id: 'keep-this-output' }] },
    { kind: 2, value: 'untouched = 1', languageId: 'wolfram', metadata: {},
      outputs: [{ items: [{ mime: 'text/plain', data: '1' }], id: 'untouched-output' }] },
  ],
};

let uploads = [];
let blobSha = 'aaa111';
// Simulates Overleaf accepting an upload into the WRONG folder: it answers 200
// with an entity id, but the file the reader is looking at never changes.
let blackhole = false;
let lastHash = null;

const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>save</title>
<meta name="ol-csrfToken" content="${CSRF}">
<meta name="ol-rootFolder" content='[{"_id":"${FOLDER_ID}","name":"rootFolder"}]'>
<link rel="stylesheet" href="/content.css"></head>
<body style="margin:0;font:14px system-ui">
  <div role="tablist"><div role="tab" aria-selected="true">sample.wb</div></div>
  <div class="file-tree">
    <ul>
      <li role="treeitem"><span class="entity-name">main.tex</span></li>
      <li role="treeitem" id="wbrow"><span class="entity-name">sample.wb</span></li>
    </ul>
  </div>
  <div id="panel-source-editor" style="height:100vh;position:relative">
    <div class="file-view" style="height:100%">
      <div class="file-view-buttons">
        <a id="dl" href="/project/${PROJECT_ID}/blob/${blobSha}" download="sample.wb">Download</a>
      </div>
      <p class="no-preview">Sorry, no preview is available.</p>
    </div>
  </div>
  <pre id="result" style="display:none">PENDING</pre>
<script>
window.chrome = {
  storage: { local: { _v: {}, set(o, cb) { Object.assign(this._v, o); if (cb) cb(); },
                      get(k, cb) { cb({ [k]: this._v[k] }); } } },
  runtime: {
    // A live extension always has an id; content.js treats its absence as an
    // orphaned content script (the extension reloaded under the tab).
    id: 'wolfbook-check',
    lastError: null,
    getURL: (p) => '/' + String(p).replace(/^\\//, ''),
    // A connected evaluator, so editing is offered; evaluation itself is not
    // what this check is about.
    sendMessage: (msg, cb) => {
      if (msg.cmd === 'serve-status') return cb({ ok: true, connected: true, port: 1, authorised: true, info: {} });
      if (msg.cmd === 'serve-eval') return cb({ ok: true, result: { text: '{1, 2, 3}', html: '', print: [], messages: [] } });
      return cb({ ok: true, connected: false });
    },
  },
};
</script>
<script>
// Mimic Overleaf: an upload REPLACES the file entity, so the open file-view is
// discarded and the app shows "no file is selected" until something re-selects
// it. This is the behaviour that closed the notebook mid-session.
window.__dropSelection = () => {
  const fv = document.querySelector('.file-view');
  if (fv) {
    const empty = document.createElement('div');
    empty.className = 'no-selection';
    empty.textContent = 'Currently, no file is selected. Please select a file from the file tree.';
    fv.replaceWith(empty);
  }
};
document.addEventListener('click', (ev) => {
  // Clicking the row re-opens the file, as Overleaf would.
  if (!ev.target.closest('#wbrow')) return;
  const empty = document.querySelector('.no-selection');
  if (!empty) return;
  const fv = document.createElement('div');
  fv.className = 'file-view';
  fv.style.height = '100%';
  fv.innerHTML = '<div class="file-view-buttons">'
    + '<a id="dl" href="/project/${PROJECT_ID}/blob/' + (window.__newHash || 'aaa111') + '" download="sample.wb">Download</a>'
    + '</div><p class="no-preview">Sorry, no preview is available.</p>';
  empty.replaceWith(fv);
});
</script>
<script src="/content.js"></script>
<script>
const out = [];
const say = (l, c, extra) => out.push((c ? 'ok   ' : 'FAIL ') + l + (extra ? '  — ' + extra : ''));
const wait = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
 try {
  const dl = Date.now() + 30000;
  let shadow = null, cells = [];
  while (Date.now() < dl) {
    const host = document.getElementById('wolfbook-overleaf-host');
    shadow = host && host.shadowRoot;
    cells = shadow ? [...shadow.querySelectorAll('.wb-cell-code')] : [];
    if (cells.length) break;
    await wait(250);
  }
  say('the notebook rendered', cells.length === 2, cells.length + ' code cells');

  const saveBtn = shadow.querySelector('[data-act="save"]');
  say('no Save button before any edit', !!saveBtn && saveBtn.hidden);

  // Edit the FIRST code cell only.
  const target = cells.find(c => /Range\\[3\\]/.test(c.__wbCode || ''));
  target.querySelector('.wb-input pre').click();
  const dl2 = Date.now() + 15000;
  while (Date.now() < dl2 && !target.__wbEditorHandle) await wait(200);
  say('the editor opened', !!target.__wbEditorHandle);
  target.__wbEditorHandle.view.dispatch({
    changes: { from: 0, to: target.__wbEditorHandle.view.state.doc.length, insert: 'Range[99]' },
  });
  await wait(1200);
  say('the Save button appears once a cell is edited', !saveBtn.hidden, saveBtn.textContent);
  say('it says how many cells will be written', /1 cell/.test(saveBtn.textContent), saveBtn.textContent);

  saveBtn.click();
  // Overleaf's UI swaps the Download link to the new blob once the replace
  // lands; simulate that so verification has something true to observe.
  (async () => {
    for (let i = 0; i < 40; i++) {
      await wait(250);
      const h = (await (await fetch('/__lasthash')).json()).hash;
      if (h) {
        window.__newHash = h;
        document.getElementById('dl').setAttribute('href', '/project/${PROJECT_ID}/blob/' + h);
        window.__dropSelection();          // …and Overleaf deselects the file
        break;
      }
    }
  })();
  const dl3 = Date.now() + 20000;
  while (Date.now() < dl3 && !/Saved|failed/.test(saveBtn.textContent)) await wait(250);
  say('the save reported success', /Saved/.test(saveBtn.textContent), saveBtn.textContent);

  say('the panel survives Overleaf dropping the selection',
      !!document.getElementById('wolfbook-overleaf-host'));
  // Give the post-save re-select and re-render time to run.
  await wait(3000);
  say('the notebook is still open after saving',
      !!document.querySelector('#wolfbook-overleaf-host')
      && shadow.querySelectorAll('.wb-cell-code').length > 0,
      shadow.querySelectorAll('.wb-cell-code').length + ' code cells');
  say('Overleaf shows the file again, not "no file is selected"',
      !document.querySelector('.no-selection') && !!document.querySelector('.file-view'));

  const seen = await (await fetch('/__uploads')).json();
  say('exactly one upload was sent', seen.length === 1, seen.length + ' upload(s)');
  if (seen.length) {
    const u = seen[0];
    say('it POSTs to Overleaf\\'s upload endpoint',
        u.method === 'POST' && /\\/upload\\?folder_id=/.test(u.url), u.method + ' ' + u.url);
    say('it carries the CSRF header', u.csrf === '${CSRF}', String(u.csrf));
    say('the form fields match Overleaf\\'s own uploader',
        JSON.stringify(u.fields.sort()) === JSON.stringify(['name','relativePath','targetFolderId','type']),
        u.fields.join(','));
    say('the file part is named qqfile', u.fileField === 'qqfile', String(u.fileField));
    say('it is sent under the right filename', u.filename === 'sample.wb', String(u.filename));

    const saved = JSON.parse(u.content);
    say('the edited cell was written', saved.cells[1].value === 'Range[99]', saved.cells[1].value);
    say('untouched cells are unchanged', saved.cells[2].value === 'untouched = 1');
    // An EDITED cell's stored output described the old code, so it is dropped
    // rather than written back as though it still applied. (When the cell has
    // been re-run here, the fresh result takes its place instead — covered by
    // check-serve-integration.mjs, which needs a real kernel.)
    say('a stale output on an edited cell is dropped, not kept',
        (saved.cells[1].outputs || []).length === 0,
        JSON.stringify(saved.cells[1].outputs).slice(0, 40));
    say('an UNTOUCHED cell keeps its stored output',
        saved.cells[2].outputs?.[0]?.id === 'untouched-output',
        JSON.stringify(saved.cells[2].outputs).slice(0, 40));
    say('cell metadata is preserved', saved.cells[1].metadata?.keepMe === true);
    say('the markdown cell is untouched', saved.cells[0].value === '# Save test');
  }

  // ── freshness: someone else changed the file meanwhile ────────────────
  // A successful save re-renders the panel, so the earlier cell node is detached
  // and editing it would change nothing. Re-acquire from the live DOM — and WAIT
  // for it: the re-render awaits the page-bridge timeout before it fetches.
  let target2 = null;
  const dlRe = Date.now() + 20000;
  while (Date.now() < dlRe) {
    target2 = [...shadow.querySelectorAll('.wb-cell-code')]
        .find(c => (c.__wbCode || '').includes('Range'));
    if (target2) break;
    await wait(300);
  }
  const errBox = shadow.querySelector('.wb-error-box');
  // NOW someone else edits the file in Overleaf, while we have it open.
  await fetch('/__bump');
  const dlNow = document.getElementById('dl');
  say('the Download link is back after re-selection', !!dlNow);
  if (dlNow) dlNow.setAttribute('href', '/project/${PROJECT_ID}/blob/bbb222');

  say('the cell nodes SURVIVE the save (no re-render)', !!target2 && target2 === target,
      'cells=' + shadow.querySelectorAll('.wb-cell-code').length
      + ' err=' + (errBox ? errBox.textContent.slice(0, 90) : 'none')
      + ' note=' + (shadow.querySelector('.wb-note')?.textContent || ''));
  if (!target2) throw new Error('no code cells after the post-save re-render');
  target2.querySelector('.wb-input pre').click();
  const dl4 = Date.now() + 15000;
  while (Date.now() < dl4 && !target2.__wbEditorHandle) await wait(200);
  target2.__wbEditorHandle.view.dispatch({
    changes: { from: 0, to: target2.__wbEditorHandle.view.state.doc.length, insert: 'Range[1234]' },
  });
  await wait(1200);
  saveBtn.disabled = false;
  saveBtn.click();
  await wait(1500);
  const after = await (await fetch('/__uploads')).json();
  say('a save is REFUSED when the file changed in Overleaf', after.length === 1,
      after.length + ' upload(s) total');
  say('and it says why', /Reload before saving/.test(saveBtn.textContent), saveBtn.textContent);

  // ── structural edits: insert and delete ─────────────────────────────
  {
    const before = shadow.querySelectorAll('.wb-cell').length;
    const first = shadow.querySelector('.wb-cell-code');
    say('cells expose insert/delete controls', !!first.querySelector('.wb-cell-controls'));

    // ── the between-cells insertion strips ─────────────────────────────
    const gaps = shadow.querySelectorAll('.wb-gap');
    say('there is an insertion strip between cells, and at each end',
        gaps.length === before + 1, gaps.length + ' strips for ' + before + ' cells');
    const firstGap = gaps[0];
    say('each strip offers + Code and + Markdown',
        [...firstGap.querySelectorAll('.wb-gap-btn')].map(b => b.textContent).join(',') === '+ Code,+ Markdown',
        [...firstGap.querySelectorAll('.wb-gap-btn')].map(b => b.textContent).join(','));
    say('the strips do not count as cells',
        shadow.querySelectorAll('.wb-cell').length === before);

    // Insert at the very top, which no per-cell control can express.
    firstGap.querySelector('.wb-gap-btn').click();
    await wait(700);
    say('a strip inserts at its own position',
        shadow.querySelectorAll('.wb-cell').length === before + 1
        && shadow.querySelectorAll('.wb-cell')[0].classList.contains('wb-cell-code'),
        shadow.querySelectorAll('.wb-cell').length + ' cells');
    shadow.querySelector('[data-act="undo"]').click();
    await wait(700);
    say('and that insertion is undoable',
        shadow.querySelectorAll('.wb-cell').length === before);

    // Pick controls by what they DO, not by position: the toolbar order changed
    // and a positional click silently exercised "move up" instead of "insert".
    const ctl = (cell, titleFragment) =>
      [...cell.querySelectorAll('.wb-cell-controls button')]
        .find(b => (b.title || '').includes(titleFragment));
    ctl(first, 'Insert a cell below').click();
    await wait(700);
    say('inserting a cell adds one to the view',
        shadow.querySelectorAll('.wb-cell').length === before + 1,
        shadow.querySelectorAll('.wb-cell').length + ' cells (was ' + before + '), note="'
        + (shadow.querySelector('.wb-note')?.textContent || '') + '", btn='
        + !!ctl(first, 'Insert a cell below'));
    say('the Save button offers to write structural changes',
        !saveBtn.hidden, saveBtn.textContent);

    const cellsNow = [...shadow.querySelectorAll('.wb-cell')];
    const last = cellsNow[cellsNow.length - 1];
    ctl(last, 'Delete this cell').click();
    await wait(700);
    say('deleting a cell removes it from the view',
        shadow.querySelectorAll('.wb-cell').length === before,
        shadow.querySelectorAll('.wb-cell').length + ' cells');

    // ── undo: deletion must not be a one-way door ──────────────────────
    const undoBtn = shadow.querySelector('[data-act="undo"]');
    say('an undo control is offered', !!undoBtn);
    undoBtn.click();
    await wait(700);
    say('undo restores a deleted cell',
        shadow.querySelectorAll('.wb-cell').length === before + 1,
        shadow.querySelectorAll('.wb-cell').length + ' cells');
    undoBtn.click();                       // back to the original count
    await wait(700);

    // ── move ───────────────────────────────────────────────────────────
    const cellsBeforeMove = [...shadow.querySelectorAll('.wb-cell')].map(c => c.__wbCode || '');
    const second = shadow.querySelectorAll('.wb-cell')[1];
    ctl(second, 'Move this cell up')?.click();
    await wait(700);
    const cellsAfterMove = [...shadow.querySelectorAll('.wb-cell')].map(c => c.__wbCode || '');
    say('moving a cell up reorders the notebook',
        JSON.stringify(cellsAfterMove) !== JSON.stringify(cellsBeforeMove),
        cellsAfterMove.length + ' cells');

    // ── change type ────────────────────────────────────────────────────
    const codeCell = shadow.querySelector('.wb-cell-code');
    ctl(codeCell, 'Turn into a markdown cell')?.click();
    await wait(700);
    say('a code cell can be turned into markdown',
        shadow.querySelectorAll('.wb-cell-code').length < 2,
        shadow.querySelectorAll('.wb-cell-code').length + ' code cells left');

    // Put everything back, so later checks see the notebook they expect.
    for (let i = 0; i < 3; i++) { undoBtn.click(); await wait(400); }
  }

  // ── markdown cells are editable ─────────────────────────────────────
  {
    const md = [...shadow.querySelectorAll('.wb-cell-md')]
        .find(c => /Save test|Renamed heading/.test(c.textContent))
      || shadow.querySelector('.wb-cell-md');
    say('markdown cells are marked editable', !!md && md.classList.contains('wb-editable-md'));
    md.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    const dlm = Date.now() + 15000;
    while (Date.now() < dlm && !md.__wbEditorHandle) await wait(200);
    say('double-clicking a markdown cell opens an editor', !!md.__wbEditorHandle);
    if (md.__wbEditorHandle) {
      const h = md.__wbEditorHandle;
      say('it shows the markdown SOURCE, not the rendered html',
          h.getValue().includes('# Save test'), JSON.stringify(h.getValue().slice(0, 24)));
      h.view.dispatch({ changes: { from: 0, to: h.view.state.doc.length, insert: '# Renamed heading' } });
      await wait(300);
      h.view.contentDOM.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
      await wait(900);
      say('closing re-renders the markdown',
          /Renamed heading/.test(md.textContent) && !md.querySelector('.cm-editor'),
          md.textContent.replace(/\s+/g, ' ').slice(0, 40));
    }
  }

 // ── the failure seen in the wild: accepted, but written somewhere else ──
  // Overleaf answers {success:true, entity_id, hash} even when the upload lands
  // in a different folder, leaving the file on screen untouched. Reporting
  // "Saved" then would be a lie that costs the user their edits.
  try {
    // Clear the stale-file state left by the previous case first.
    shadow.querySelector('[data-act="refresh"]').click();
    await wait(3000);
    await fetch('/__blackhole');
    const t3 = [...shadow.querySelectorAll('.wb-cell-code')]
        .find(c => (c.__wbCode || '').includes('Range'));
    if (t3) {
      t3.querySelector('.wb-input pre').click();
      const d5 = Date.now() + 15000;
      while (Date.now() < d5 && !t3.__wbEditorHandle) await wait(200);
      t3.__wbEditorHandle.view.dispatch({
        changes: { from: 0, to: t3.__wbEditorHandle.view.state.doc.length, insert: 'Range[777]' },
      });
      await wait(1200);
      saveBtn.disabled = false;
      saveBtn.click();
      const d6 = Date.now() + 30000;
      while (Date.now() < d6 && !/wrong place|Saved|failed/.test(saveBtn.textContent)) await wait(300);
      say('an upload that does not take effect is NOT reported as saved',
          !/Saved \u2713/.test(saveBtn.textContent), saveBtn.textContent);
      say('and the user is told where it probably went',
          /wrong folder/.test(shadow.querySelector('.wb-note')?.textContent || ''),
          (shadow.querySelector('.wb-note')?.textContent || '').slice(0, 90));
    } else say('a cell was available for the ineffective-upload case', false);
  } catch (e) { say('the ineffective-upload case ran', false, String(e && e.message)); }
 } catch (err) {
  // Always report: a thrown check is a failed check, not a hung harness.
  say('the check ran to completion', false, String(err && err.message || err));
 }
 document.getElementById('result').textContent = out.join('\\n');
 try { await fetch('/__result', { method: 'POST', body: out.join('\\n') }); } catch (e) {}
})();
</script></body></html>`;

let onResult = () => {};
const server = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  const json = (o) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };

  if (req.method === 'POST' && url === '/__result') {
    let b = ''; req.on('data', (d) => { b += d; });
    req.on('end', () => { res.writeHead(204); res.end(); onResult(b); });
    return;
  }
  if (url === '/__uploads') return json(uploads);
  if (url === '/__lasthash') return json({ hash: lastHash });
  if (url === '/__bump') { blobSha = 'bbb222'; return json({ ok: true }); }
  if (url === '/__blackhole') { blackhole = true; return json({ ok: true }); }

  // Overleaf's upload endpoint.
  if (req.method === 'POST' && url === `/project/${PROJECT_ID}/upload`) {
    const chunks = [];
    req.on('data', (d) => chunks.push(d));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      // (?<!file) matters: `filename="x"` ends in `name="x"`, so a naive match
      // reports the uploaded file as if it were a form field.
      const fields = [...body.matchAll(/(?<!file)name="([^"]+)"(?!;)/g)].map((m) => m[1]);
      const fileM = /name="([^"]+)"; filename="([^"]+)"/.exec(body);
      const contentM = /filename="[^"]+"\r\nContent-Type:[^\r]*\r\n\r\n([\s\S]*?)\r\n------/.exec(body);
      if (blackhole) { json({ success: true, entity_id: 'elsewhere', entity_type: 'file' }); return; }
      uploads.push({
        method: req.method,
        url: req.url,
        csrf: req.headers['x-csrf-token'],
        fields: fields.filter((f) => f !== (fileM && fileM[1])),
        fileField: fileM && fileM[1],
        filename: fileM && fileM[2],
        content: contentM ? contentM[1] : '',
      });
      // Overleaf returns the content hash; the Download link then becomes
      // /blob/<that hash>. Both are reproduced so verification can be tested.
      const hash = crypto.createHash('sha1').update(contentM ? contentM[1] : '').digest('hex');
      lastHash = hash;
      json({ success: true, entity_id: 'new-entity', entity_type: 'file', hash });
    });
    return;
  }

  if (url === `/project/${PROJECT_ID}`) {
    res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(PAGE); return;
  }
  if (url.startsWith(`/project/${PROJECT_ID}/blob/`)) {
    // Serve back whatever was last uploaded, the way Overleaf would after a
    // successful replace — otherwise post-save verification correctly fails.
    if (uploads.length) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(uploads[uploads.length - 1].content); return; }
    return json(NOTEBOOK);
  }

  const file = path.join(root, url);
  if (file.startsWith(root) && fs.existsSync(file) && !fs.statSync(file).isDirectory()) {
    const T = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
    res.writeHead(200, { 'Content-Type': T[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res); return;
  }
  res.writeHead(404); res.end('not found');
});

await new Promise((r) => server.listen(0, '127.0.0.1', r));
const pageUrl = `http://127.0.0.1:${server.address().port}/project/${PROJECT_ID}`;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wbchrome-'));
let failures = 0;
try {
  const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    '--enable-logging=stderr', '--v=0',
    '--disable-dev-shm-usage', `--user-data-dir=${profile}`, pageUrl], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  chrome.stderr.on('data', (d) => { stderr += d; });
  const results = await new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), 90_000);
    onResult = (b) => { clearTimeout(t); resolve(b); };
    chrome.on('error', () => { clearTimeout(t); resolve(null); });
  });
  chrome.kill('SIGKILL');
  if (results == null) {
    console.error('the page never reported results.');
    const lines = stderr.split('\n').filter((l) => /error|Error|exception|Uncaught/.test(l));
    console.error(lines.slice(-8).join('\n') || stderr.slice(-600));
    process.exit(1);
  }
  console.log(results);
  failures = (results.match(/^FAIL/gm) || []).length;
} finally {
  server.close();
  fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
console.log(failures ? `\n${failures} FAILURE(S)` : '\nsave checks passed');
process.exit(failures ? 1 : 0);
