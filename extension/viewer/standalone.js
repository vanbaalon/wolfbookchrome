import { parseNotebookJson } from './notebook-json.js';

// viewer/standalone.js — the Wolfbook viewer for a .wb that is NOT in Overleaf.
//
// WHY THIS PAGE EXISTS
//   The Overleaf panel needs a project around it: a file tree to read, a blob
//   endpoint to fetch from, a folder to save back into. A .wb that arrives by
//   email, sits in ~/Downloads, or is picked from Finder has none of that.
//
//   It also cannot be handled by a content script, because Chrome never renders
//   a .wb at all: an unknown type on file:// is DOWNLOADED, not displayed, so
//   there is no page for a script to run in. The only thing that can show the
//   notebook is an extension page of our own — this one — opened with the
//   notebook's location in ?src=.
//
//   `tools/register-chrome-viewer-macos.sh` builds the Finder "Open With" entry
//   that opens it. It registers as an ALTERNATE handler for the type, so Chrome
//   appears in the list without ever becoming what a double-click does.
//
// THREE WAYS IN — deliberately, because the first needs a permission the other
// two do not:
//   ?src=file:///…   fetching file:// requires "Allow access to file URLs"
//   Open…            a file picker: the user hands us the File object
//   drag and drop    likewise
//
// NOTHING LEAVES THE MACHINE. The notebook is read and rendered locally. The
// only network requests this page can make are to 127.0.0.1, and only when you
// evaluate a cell.

const params = new URLSearchParams(location.search);
const inExtension = !!(globalThis.chrome?.runtime?.getURL);

// Resolve sibling modules through the extension when we are one, and relative
// to this file otherwise — which is what lets the offline check load this page
// over plain HTTP, with no extension anywhere.
const EXT = (p) => (inExtension ? chrome.runtime.getURL(p) : new URL('../' + p, import.meta.url).href);

const $ = (sel) => document.querySelector(sel);
const bar = { name: $('.sv-name'), note: $('.sv-note'), kernel: $('.sv-kernel'), logo: $('.sv-logo') };
const hostEl = $('#sv-host');
const picker = $('input[type=file]');
const dlBtn = $('button[data-act=download]');

if (inExtension) bar.logo.src = EXT('vendor/wolfbook-icon.png');
else bar.logo.remove();

const state = {
  name: null,      // display + download file name
  source: null,    // the .wb text exactly as read
  model: null,     // the parsed notebook, mutated in place by edits
  baseUrl: null,   // for resolving img/… next to the notebook
  stats: null,
  shadow: null,
};

// ── module loading ──────────────────────────────────────────────────────────
let mods = null;
async function loadModules() {
  if (mods) return mods;
  const [viewer, katex, renderer] = await Promise.all([
    import(EXT('viewer/wb-viewer.js')),
    import(EXT('vendor/katex-css.js')),
    import(EXT('vendor/renderer-css.js')),
  ]);
  mods = { viewer, katexCss: katex.KATEX_CSS, wlCss: renderer.WL_CSS };
  return mods;
}

// 362 KB of CodeMirror that a reader who never edits should not pay for.
let editorMod = null;
async function loadEditor() {
  if (editorMod !== null) return editorMod;
  try {
    editorMod = (await import(EXT('vendor/codemirror.bundle.js'))).mountEditor;
  } catch (e) {
    console.warn('[wolfbook] editor bundle failed to load', e);
    editorMod = false;
  }
  return editorMod;
}

// ── messages ────────────────────────────────────────────────────────────────
function showMessage(build) {
  hostEl.textContent = '';
  const box = document.createElement('div');
  box.className = 'sv-msg';
  build(box);
  hostEl.appendChild(box);
}

function h(tag, text, cls) {
  const el = document.createElement(tag);
  if (text != null) el.textContent = text;
  if (cls) el.className = cls;
  return el;
}

function dropTarget() {
  return h('div', 'Drop a .wb file here, or press Open…', 'sv-drop');
}

function welcome(extra) {
  showMessage((box) => {
    box.appendChild(h('h1', 'Wolfbook viewer'));
    box.appendChild(h('p', 'Open a Wolfbook notebook (.wb, .evsnb, .vsnb) to read it — '
      + 'rendered maths, images and stored outputs, with no Wolfram needed.'));
    if (extra) box.appendChild(extra);
    box.appendChild(dropTarget());
  });
}

/**
 * The file:// case, which is the one that needs a permission.
 *
 * Chrome extensions cannot read local files unless the user ticks "Allow access
 * to file URLs", and a plain fetch failure here looks identical to a missing
 * file — so ask the API which it was and say so precisely. The picker and
 * drag-and-drop keep working either way, which is why they are offered right
 * here rather than left for the user to discover.
 */
function needsFileAccess() {
  showMessage((box) => {
    box.appendChild(h('h1', 'Chrome needs permission to read local files'));
    box.appendChild(h('p', 'This is a one-time switch on the extension itself — '
      + 'the notebook is still read only by your own browser, and nothing is uploaded.'));
    const ol = document.createElement('ol');
    for (const step of [
      'Open the extension’s details page (button below, or chrome://extensions).',
      'Turn on "Allow access to file URLs".',
      'Reload this tab.',
    ]) ol.appendChild(h('li', step));
    box.appendChild(ol);
    if (inExtension && chrome.tabs?.create) {
      const btn = h('button', 'Open extension details');
      btn.style.cssText = 'font:inherit;padding:5px 12px;border:1px solid #d0d7de;border-radius:6px;'
        + 'background:#fff;cursor:pointer';
      btn.addEventListener('click', () => {
        chrome.tabs.create({ url: `chrome://extensions/?id=${chrome.runtime.id}` });
      });
      box.appendChild(btn);
    }
    box.appendChild(h('p', 'Or open the file without granting anything:'));
    box.appendChild(dropTarget());
  });
}

function showError(msg) {
  showMessage((box) => {
    box.appendChild(h('h1', 'Could not open that notebook'));
    box.appendChild(h('div', msg, 'sv-err'));
    box.appendChild(dropTarget());
  });
}

// ── evaluation (optional) ───────────────────────────────────────────────────
//
// Reading needs no kernel at all, so the page never blocks on this: the
// evaluator is wired up if a local wolfbook-serve answers, and simply absent
// otherwise. Same background worker, same protocol as the Overleaf panel.
function sendMsg(msg) {
  if (!inExtension || !chrome.runtime?.sendMessage) return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(msg, (r) => { void chrome.runtime.lastError; resolve(r || null); });
    } catch (_) { resolve(null); }
  });
}

let servePort = null;
let serveToken = null;

async function probeServe() {
  const res = await sendMsg({ cmd: 'serve-status' });
  if (!res || !res.ok || !res.running) {
    bar.kernel.textContent = inExtension ? 'no kernel — view only' : '';
    bar.kernel.classList.remove('live');
    return null;
  }
  servePort = res.port;
  serveToken = res.hasToken ? true : null;
  bar.kernel.textContent = `wolfbook-serve :${res.port}`;
  bar.kernel.classList.add('live');
  return res;
}

function makeEvaluator() {
  return {
    // The kernel writes images into its own temp dir and refers to them as
    // img/…; rewrite those onto the server that wrote them.
    resolveAsset(rel) {
      if (!servePort || !rel || /^(https?:|data:|blob:|file:)/i.test(rel)) return null;
      const clean = String(rel).replace(/^\.?\//, '').replace(/^img\//, '');
      return `http://127.0.0.1:${servePort}/img/${clean}`;
    },
    async run(code) {
      if (!serveToken) {
        const typed = prompt('wolfbook-serve needs its token to evaluate '
          + '(printed when you started it):');
        if (!typed) throw new Error('No token — cell not evaluated.');
        await sendMsg({ cmd: 'serve-set-token', token: typed.trim() });
        serveToken = true;
      }
      const res = await sendMsg({ cmd: 'serve-eval', args: { code, format: 'Auto', scale: 1.0 } });
      if (!res) throw new Error('The extension could not reach its background worker.');
      if (!res.ok) throw new Error(res.error || 'Evaluation failed.');
      const r = res.result || {};
      return {
        html: r.html || '', text: r.text || '', print: r.print || [],
        messages: r.messages || [], outN: r.outN || null, ms: r.ms || null,
        isError: (r.messages || []).some((m) => /::(sntx|argx|argrx|argbu)/.test(m)),
        via: 'wolfbook-serve',
      };
    },
  };
}

// ── rendering ───────────────────────────────────────────────────────────────
async function render() {
  const { viewer, katexCss, wlCss } = await loadModules();

  // Resolve img/… against the notebook's own location — which only works when
  // we were given a URL. A file handed over by the picker has no directory we
  // are allowed to read, so its images stay missing and are counted as such.
  const resolveAsset = state.baseUrl
    ? (rel) => {
        if (!rel || /^(https?:|data:|blob:)/i.test(rel)) return null;
        try { return new URL(String(rel).replace(/^\.?\//, ''), state.baseUrl).href; }
        catch (_) { return null; }
      }
    : null;

  hostEl.textContent = '';
  const mount = document.createElement('div');
  hostEl.appendChild(mount);
  const shadow = state.shadow = viewer.createViewerSurface(mount, { katexCss, wlCss });
  const nb = document.createElement('div');
  nb.className = 'wb-notebook';
  shadow.appendChild(nb);

  const serve = await probeServe();
  const stats = state.stats = viewer.renderNotebook(state.model, nb, {
    resolveAsset,
    evaluator: serve ? makeEvaluator() : null,
    // Editing does not require a kernel: correcting prose or code and keeping
    // the result is useful with no Wolfram anywhere.
    editing: { mount: loadEditor },
  });

  const bits = [`${stats.cells} cells`, `${stats.outputs} outputs`];
  if (stats.missingAssets) bits.push(`${stats.missingAssets} image(s) not found`);
  if (stats.interactive.length) bits.push(`${stats.interactive.join('/')} interactive in Wolfbook`);
  bar.note.textContent = bits.join(' · ');
  dlBtn.disabled = false;
}

async function openText(text, name, baseUrl) {
  let parsed;
  try {
    parsed = parseNotebookJson(text);
  } catch (e) {
    showError(`${name} is not valid notebook JSON: ${e.message}`);
    return;
  }
  if (!Array.isArray(parsed?.cells)) {
    showError(`${name} has no "cells" array — this does not look like a Wolfbook notebook.`);
    return;
  }
  state.name = name;
  state.source = text;
  state.model = parsed;
  state.baseUrl = baseUrl || null;
  bar.name.textContent = name;
  document.title = `${name} — Wolfbook`;
  try {
    await render();
  } catch (e) {
    console.error('[wolfbook] render failed', e);
    showError(String(e?.message || e));
  }
}

async function openUrl(src) {
  let url;
  try { url = new URL(src, location.href); }
  catch (_) { showError(`Not a usable location: ${src}`); return; }

  const name = decodeURIComponent(url.pathname.split('/').pop() || 'notebook.wb');
  bar.name.textContent = name;

  if (url.protocol === 'file:' && inExtension && chrome.extension?.isAllowedFileSchemeAccess) {
    const allowed = await new Promise((r) => chrome.extension.isAllowedFileSchemeAccess(r));
    if (!allowed) { needsFileAccess(); return; }
  }

  try {
    const res = await fetch(url.href);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    await openText(await res.text(), name, url.href);
  } catch (e) {
    if (url.protocol === 'file:') { needsFileAccess(); return; }
    showError(`${url.href}\n\n${e?.message || e}`);
  }
}

// ── download ────────────────────────────────────────────────────────────────
//
// This page cannot write back to the file it was opened from — a browser page
// has no such authority, and silently rewriting a file the user double-clicked
// would be the wrong default even if it did. Edits are kept by downloading a
// copy, which lands in Downloads under the same name.
dlBtn.addEventListener('click', async () => {
  if (!state.model) return;
  let edited = 0;
  for (const st of (state.stats?.cellStates || [])) {
    if (!st.cell || st.code === st.original) continue;
    st.cell.value = st.code;
    edited++;
  }
  // Match the .wb serializer's formatting so an unchanged notebook round-trips
  // byte-for-byte and a diff shows only what was actually edited.
  const text = JSON.stringify(state.model, null, 1) + '\n';
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = state.name || 'notebook.wb';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  bar.note.textContent = edited
    ? `downloaded with ${edited} edited cell${edited === 1 ? '' : 's'}`
    : 'downloaded (no edits)';
});

// ── ways in ─────────────────────────────────────────────────────────────────
$('button[data-act=open]').addEventListener('click', () => picker.click());
picker.addEventListener('change', async () => {
  const file = picker.files?.[0];
  if (file) await openText(await file.text(), file.name, null);
});

for (const ev of ['dragenter', 'dragover']) {
  document.addEventListener(ev, (e) => { e.preventDefault(); document.body.classList.add('sv-dragging'); });
}
document.addEventListener('dragleave', (e) => {
  if (e.relatedTarget == null) document.body.classList.remove('sv-dragging');
});
document.addEventListener('drop', async (e) => {
  e.preventDefault();
  document.body.classList.remove('sv-dragging');
  const file = e.dataTransfer?.files?.[0];
  if (file) await openText(await file.text(), file.name, null);
});

const src = params.get('src') || params.get('file');
if (src) await openUrl(src);
else { welcome(null); await probeServe(); }

// Exposed for the offline check, which drives this page over plain HTTP.
globalThis.__wbStandalone = { state, openUrl, openText };
