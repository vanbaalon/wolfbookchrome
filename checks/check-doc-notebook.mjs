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

import { execFileSync, spawn } from 'node:child_process';
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

const WAVE_SOURCE = JSON.stringify({
  cells: [{ kind: 1, value: '# Wave notebook', languageId: 'markdown', outputs: [], metadata: {} }],
});

// Text-backed notebooks are now verified against the exact entry named by the
// active tab in Overleaf's project archive. This fixture deliberately keeps
// both notebooks in that archive so it can prove a stale CodeMirror buffer is
// never rendered under the other notebook's title.
const zipStage = fs.mkdtempSync(path.join(os.tmpdir(), 'wbdoczip-'));
fs.writeFileSync(path.join(zipStage, 'test.wb'), '');
fs.writeFileSync(path.join(zipStage, 'WaveFunctionDemo.wb'), WAVE_SOURCE);
execFileSync('zip', ['-q', 'project.zip', 'test.wb', 'WaveFunctionDemo.wb'], { cwd: zipStage });
const PROJECT_ZIP = fs.readFileSync(path.join(zipStage, 'project.zip'));
fs.rmSync(zipStage, { recursive: true, force: true });

const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>fake overleaf (doc mode)</title>
<link rel="stylesheet" href="/content.css"></head>
<body style="margin:0;display:flex;height:100vh;font:14px system-ui">
  <div class="file-tree" style="width:220px;border-right:1px solid #ccc">
    <ul>
      <li role="treeitem" aria-selected="false"><span class="entity-name">main.tex</span></li>
      <!-- Overleaf LEAVES the tree highlighted on a file whose tab was closed.
           Keeping it selected here is what makes the tab authoritative, rather
           than merely untested. -->
      <li role="treeitem" aria-selected="true"><span class="entity-name">test.wb</span></li>
    </ul>
  </div>
  <div style="flex:1;display:flex;flex-direction:column">
    <!-- OVERLEAF'S OWN TAB MARKUP, pasted from a live session. There is no
         role="tab" and no aria-selected anywhere in it, and the filename is
         prefixed with U+200E (LEFT-TO-RIGHT MARK). Both details defeated the
         generic tab probe, so with no download link to read the name from,
         nothing identified the open file and the panel never mounted. Keep
         this markup verbatim; it is the only record of what the site does. -->
    <div class="editor-file-tabs" style="display:flex;border-bottom:1px solid #ccc">
      <div class="editor-file-tab">
        <div class="editor-file-tab-content">
          <span class="editor-file-tab-icon"><span class="material-symbols file-tree-icon unfilled"
            aria-hidden="true" translate="no">description</span></span>
          <div class="editor-file-tab-path">\u200Emain.tex</div>
          <div class="editor-file-tab-action"><button class="editor-file-tab-close-action"
            aria-label="Close"><span class="material-symbols" aria-hidden="true"
            translate="no">close</span></button></div>
        </div>
      </div>
      <div class="editor-file-tab editor-file-tab-active">
        <div class="editor-file-tab-content">
          <span class="editor-file-tab-icon"><span class="material-symbols file-tree-icon unfilled"
            aria-hidden="true" translate="no">description</span></span>
          <div class="editor-file-tab-path">\u200Etest.wb</div>
          <div class="editor-file-tab-action"><button class="editor-file-tab-close-action"
            aria-label="Close"><span class="material-symbols" aria-hidden="true"
            translate="no">close</span></button></div>
        </div>
      </div>
      <div class="editor-file-tab">
        <div class="editor-file-tab-content">
          <span class="editor-file-tab-icon"><span class="material-symbols file-tree-icon unfilled"
            aria-hidden="true" translate="no">description</span></span>
          <div class="editor-file-tab-path">\u200EWaveFunctionDemo.wb</div>
          <div class="editor-file-tab-action"><button class="editor-file-tab-close-action"
            aria-label="Close"><span class="material-symbols" aria-hidden="true"
            translate="no">close</span></button></div>
        </div>
      </div>
    </div>
    <!-- NO .file-view and NO download link: this is the doc case. Overleaf
         shows its ordinary editor, and the file is empty. -->
    <!-- Overleaf's editor panel holds its generic LaTeX toolbar as well as the
         document. Wolfbook must cover that toolbar: its AI, undo/redo,
         Code/Visual and Reviewing controls do not apply to a .wb. -->
    <div id="panel-source-editor" style="flex:1;position:relative;display:flex;flex-direction:column">
      <div class="ol-cm-toolbar toolbar-editor" style="height:32px;background:#1e2a35;color:#fff;position:relative;z-index:50">
        Overleaf toolbar (Code / Visual / Editing)
      </div>
      <!-- React retains editors for inactive tabs. Keep a stale one FIRST in
           DOM order so querySelector('.cm-content') would read/write the wrong
           file; the bridge must select the visible editor instead. -->
      <div class="cm-editor" hidden><div class="cm-content"></div></div>
      <!-- The editor is a DIRECT child of the panel, so the chosen pane also
           contains the toolbar that Wolfbook must replace. -->
      <div class="cm-editor" style="flex:1;position:relative">
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
const cmContents = document.querySelectorAll('.cm-content');
cmContents[0].cmView = { view: { state: { doc: { length: 17, toString: () => 'STALE WRONG FILE' } } } };
cmContents[1].cmView = {
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
    // A live extension always has an id; content.js treats its absence as
    // an orphaned content script (the extension reloaded under the tab).
    id: 'wolfbook-check',
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
  // File tabs stay, but the generic text-editor toolbar is replaced.
  const tabsBox = document.querySelector('.editor-file-tabs').getBoundingClientRect();
  const olBar = document.querySelector('.ol-cm-toolbar').getBoundingClientRect();
  const hostBox = document.getElementById('wolfbook-overleaf-host').getBoundingClientRect();
  say('the text route preserves Overleaf file tabs', hostBox.top >= tabsBox.bottom - 1,
      'host top ' + Math.round(hostBox.top) + ' vs tabs bottom ' + Math.round(tabsBox.bottom));
  say('the text route replaces Overleaf editor tools', hostBox.top <= olBar.top + 1,
      'host top ' + Math.round(hostBox.top) + ' vs toolbar top ' + Math.round(olBar.top));

  const wbBar = shadow && shadow.querySelector('.wb-toolbar');
  const barBox = wbBar && wbBar.getBoundingClientRect();
  say('the notebook toolbar is visible', !!barBox && barBox.height > 10 && barBox.width > 100
      && barBox.top >= hostBox.top - 1,
      barBox ? Math.round(barBox.width) + 'x' + Math.round(barBox.height) + ' @ ' + Math.round(barBox.top)
             : 'no toolbar');
  say('and it carries the same controls as for an uploaded file',
      !!wbBar && !!wbBar.querySelector('.wb-title') && !!wbBar.querySelector('[data-act="refresh"]'));

  // Measuring is not enough: prove the high-z-index Wolfbook host, not the
  // role="toolbar" element, receives the top-band hit.
  const hostEl = document.getElementById('wolfbook-overleaf-host');
  const hitTop = document.elementFromPoint(olBar.left + 30, olBar.top + 4);
  say('Overleaf editor tools are actually covered',
      !!hitTop && (hitTop === hostEl || hostEl.contains(hitTop)),
      hitTop ? (hitTop.className || hitTop.tagName) : 'nothing there');

  const titleEl = shadow && shadow.querySelector('.wb-title');
  say('the file is identified from the Overleaf tab',
      !!titleEl && titleEl.textContent === 'test.wb',
      titleEl ? JSON.stringify(titleEl.textContent) : 'no title');
  const errBox = shadow && shadow.querySelector('.wb-error-box');
  say('an empty .wb is not reported as broken JSON', !errBox,
      errBox ? errBox.textContent.slice(0, 90) : '');

  const nb = shadow && shadow.querySelector('.wb-notebook');
  say('it renders as an empty notebook', !!nb && nb.querySelectorAll('.wb-cell').length === 0,
      nb ? nb.querySelectorAll('.wb-cell').length + ' cells' : 'no notebook');

  // Overleaf marks the new text tab active before CodeMirror changes its
  // document. Reproduce a deliberately slow handoff in both directions; title
  // and body must never come from different files.
  const docTabs = document.querySelectorAll('.editor-file-tab');
  const waveSource = JSON.stringify({
    cells: [{ kind: 1, value: '# Wave notebook', languageId: 'markdown', outputs: [], metadata: {} }],
  });
  docTabs.forEach((t, i) => t.classList.toggle('editor-file-tab-active', i === 2));
  setTimeout(() => { window.__cmDoc.text = waveSource; }, 700);
  await sleep(1800);
  let switchedHost = document.getElementById('wolfbook-overleaf-host');
  let switchedShadow = switchedHost && switchedHost.shadowRoot;
  say('text → text waits for the new editor document',
      switchedShadow?.querySelector('.wb-title')?.textContent === 'WaveFunctionDemo.wb'
      && /Wave notebook/.test(switchedShadow?.querySelector('.wb-notebook')?.textContent || ''),
      (switchedShadow?.querySelector('.wb-title')?.textContent || 'no title') + ' / '
      + (switchedShadow?.querySelector('.wb-notebook')?.textContent || '').slice(0, 30));

  docTabs.forEach((t, i) => t.classList.toggle('editor-file-tab-active', i === 1));
  setTimeout(() => { window.__cmDoc.text = ''; }, 700);
  await sleep(1800);
  switchedHost = document.getElementById('wolfbook-overleaf-host');
  switchedShadow = switchedHost && switchedHost.shadowRoot;
  say('returning text → text restores the right body',
      switchedShadow?.querySelector('.wb-title')?.textContent === 'test.wb'
      && switchedShadow?.querySelectorAll('.wb-cell').length === 0,
      (switchedShadow?.querySelector('.wb-title')?.textContent || 'no title') + ' / '
      + (switchedShadow?.querySelectorAll('.wb-cell').length ?? -1) + ' cells');

  // The failure seen live: the active tab changes but Overleaf leaves the old
  // CodeMirror bytes in place. Even if they NEVER hand off, title and body must
  // still be the same named file, using the project archive as the identity
  // authority.
  docTabs.forEach((t, i) => t.classList.toggle('editor-file-tab-active', i === 2));
  window.__cmDoc.text = ''; // permanently wrong for WaveFunctionDemo.wb
  await sleep(3400);
  switchedHost = document.getElementById('wolfbook-overleaf-host');
  switchedShadow = switchedHost && switchedHost.shadowRoot;
  say('a permanently stale editor cannot put one file under another title',
      switchedShadow?.querySelector('.wb-title')?.textContent === 'WaveFunctionDemo.wb'
      && /Wave notebook/.test(switchedShadow?.querySelector('.wb-notebook')?.textContent || ''),
      (switchedShadow?.querySelector('.wb-title')?.textContent || 'no title') + ' / '
      + (switchedShadow?.querySelector('.wb-notebook')?.textContent || '').slice(0, 30));
  say('the mismatch is disclosed',
      /editor buffer did not match this tab/i.test(switchedShadow?.querySelector('.wb-note')?.textContent || ''));

  docTabs.forEach((t, i) => t.classList.toggle('editor-file-tab-active', i === 1));
  window.__cmDoc.text = '';
  await sleep(1100);

  // ── the extension is reloaded under the tab ────────────────────────────
  // Chrome leaves this script running against a DEAD context: chrome.runtime.id
  // goes away and every chrome.* call throws, so the panel cannot import its
  // own viewer modules and comes up blank — indistinguishable on screen from
  // the notebook itself being broken. It must say which it is. Done here,
  // before anything is edited, so the re-mount costs no work.
  const tabs = document.querySelectorAll('.editor-file-tab');
  const selectTab = async (i) => {
    tabs.forEach((t, k) => t.classList.toggle('editor-file-tab-active', k === i));
    await sleep(800);
  };
  delete window.chrome.runtime.id;
  await selectTab(0);                       // main.tex — the panel tears down
  await selectTab(1);                       // test.wb — it must come back, stale
  await sleep(900);
  const staleHost = document.getElementById('wolfbook-overleaf-host');
  say('a stale tab says so instead of coming up blank',
      !!staleHost && /Wolfbook was reloaded/i.test(staleHost.textContent),
      staleHost ? JSON.stringify(staleHost.textContent.slice(0, 48)) : 'no panel at all');

  window.chrome.runtime.id = 'wolfbook-check';
  await selectTab(0);
  await selectTab(1);
  for (let i = 0; i < 60; i++) {
    const h = document.getElementById('wolfbook-overleaf-host');
    shadow = h && h.shadowRoot;
    if (shadow && shadow.querySelector('.wb-notebook')) break;
    await sleep(200);
  }
  say('and the panel comes back once the tab is fresh again', !!shadow);

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

  // ── the three things that made a new cell unusable ──────────────────
    const cell = shadow.querySelector('.wb-cell');

    // Inserting opens the editor, which HIDES the <pre> — so assert that
    // first, then close it to measure the read-only cell the user clicks.
    say('the new cell opened its editor',
        !!cell.__wbEditorHandle || !!shadow.querySelector('.wb-editor'),
        cell.__wbEditorHandle ? 'CodeMirror mounted' : 'no editor');
    if (cell.__wbEditorHandle) {
      cell.__wbEditorHandle.view.dom.dispatchEvent(
        new FocusEvent('focusout', { bubbles: true }));
      await sleep(300);
    }

    const pre = cell && cell.querySelector('.wb-input pre');
    const preBox = pre && pre.getBoundingClientRect();
    say('an empty cell is tall enough to click',
        !!preBox && preBox.height >= 12, preBox ? Math.round(preBox.height) + 'px' : 'no pre');

    // The click target must actually be THIS pre — the insertion strip folds
    // into the cell spacing and used to sit on top of the cell chrome.
    const hitPre = preBox && shadow.elementFromPoint(preBox.left + 20, preBox.top + preBox.height / 2);
    say('a click in the cell body reaches the cell, not the insert strip',
        !!hitPre && (hitPre === pre || pre.contains(hitPre)),
        hitPre ? (hitPre.className || hitPre.tagName) : 'nothing there');

    // The per-cell controls: hover the cell, then ask what is under them.
    cell.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    const controls = cell.querySelector('.wb-cell-controls');
    const btn = controls && controls.querySelector('button');
    const bb = btn && btn.getBoundingClientRect();
    const hitBtn = bb && shadow.elementFromPoint(bb.left + bb.width / 2, bb.top + bb.height / 2);
    say('the move/delete controls are clickable, not covered by the strip',
        !!hitBtn && (hitBtn === btn || btn.contains(hitBtn) || controls.contains(hitBtn)),
        hitBtn ? (hitBtn.className || hitBtn.tagName) : 'nothing there');

    // A cell inserted EMPTY and then typed into must be runnable. Whether a
    // cell could run was decided when it was drawn, so such a cell never got a
    // run handler and Shift-Enter in it did nothing for the rest of the
    // session. (No evaluator is connected in this fixture, so the handler's
    // presence is what is checked, not an evaluation.)
    const fresh = shadow.querySelector('.wb-cell-code');
    say('a cell inserted empty is not permanently unrunnable',
        !!fresh && (!!fresh.__wbRun || !shadow.querySelector('button.wb-run')),
        fresh && fresh.__wbRun ? 'has a run handler' : 'no evaluator in this fixture');

    const saveBtn = shadow.querySelector('[data-act="save"]');
    let ready = Date.now() + 4000;
    while (saveBtn && saveBtn.hidden && Date.now() < ready) await sleep(200);
    say('Save appears once the notebook has content', !!saveBtn && !saveBtn.hidden,
        saveBtn ? saveBtn.textContent : 'no save button');

    if (saveBtn && !saveBtn.hidden) {
      // Exercise both dirty-marker mechanisms. A verified doc save must clear
      // them without needing a destructive re-render.
      cell.classList.add('wb-cell-edited');
      const marker = document.createElement('span');
      marker.className = 'wb-edited-badge';
      cell.querySelector('.wb-input')?.appendChild(marker);
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
      say('a verified save clears edited markers',
          !shadow.querySelector('.wb-cell-edited, .wb-edited-badge'));

      // ── it must refuse to write into a document it did not read ──────────
      // The bridge writes into whichever document Overleaf currently holds, so
      // an editor showing something else must abort the save rather than
      // replace that file's contents — which is unrecoverable outside
      // Overleaf's own history.
      const someoneElse = '\\documentclass{article}\\begin{document}not the notebook\\end{document}';
      window.__cmDoc.text = someoneElse;
      const cellNow = shadow.querySelector('.wb-cell .wb-input pre');
      cellNow.click();
      await sleep(600);
      const handle = shadow.querySelector('.wb-cell').__wbEditorHandle;
      if (handle) {
        // The handle exposes the real CodeMirror view, so drive its document
        // model rather than synthesising keystrokes.
        handle.view.dispatch({
          changes: { from: 0, to: handle.view.state.doc.length, insert: 'Plot[Sin[x], {x, 0, 2 Pi}]' },
        });
        handle.view.dom.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
        await sleep(600);
      }
      const save2 = shadow.querySelector('[data-act="save"]');
      let waited = Date.now() + 4000;
      while (save2 && save2.hidden && Date.now() < waited) await sleep(150);
      if (save2 && !save2.hidden) save2.click();
      await sleep(1500);
      say('it refuses to overwrite a document it did not read',
          window.__cmDoc.text === someoneElse,
          window.__cmDoc.text === someoneElse ? 'the other file is untouched'
                                              : 'OVERWROTE ' + window.__cmDoc.text.slice(0, 40));
      const noteTxt = shadow.querySelector('.wb-note')?.textContent || '';
      say('and says why', /not showing the document|different|nothing was written/i.test(noteTxt),
          JSON.stringify(noteTxt.slice(0, 70)));
    }
  }

  // ── the notebook tab is closed ─────────────────────────────────────────
  // The tree still highlights test.wb. If that is allowed to answer "which file
  // is open", the panel stays up over a document that is no longer the
  // notebook — and a save then writes the notebook into THAT file.
  const wbTab = document.querySelectorAll('.editor-file-tab')[1];
  wbTab.remove();
  document.querySelectorAll('.editor-file-tab')[0].classList.add('editor-file-tab-active');
  await sleep(1200);
  const stillThere = document.getElementById('wolfbook-overleaf-host');
  say('closing the notebook tab closes the panel, even with the tree still on it',
      !stillThere, stillThere ? 'panel still showing ' + (shadow?.querySelector('.wb-title')?.textContent || '?')
                              : 'panel gone');

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
  if (url.endsWith('/download/zip')) {
    res.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Length': PROJECT_ZIP.length,
    });
    res.end(PROJECT_ZIP);
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
