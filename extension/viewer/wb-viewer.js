// wb-viewer.js — renders a .wb notebook into the DOM, using nothing but the
// browser and the stylesheets the wolfbook renderer itself uses.
//
// WHAT A .wb ACTUALLY CONTAINS (measured over the corpus, not assumed):
//   cells: [{ kind: 1=markup | 2=code, value, languageId, outputs: [...] }]
//   output items carry exactly three mimes:
//     x-application/wolfram-language-html  — the real payload: HTML the wolfbook
//         renderer already produced. Overwhelmingly PRE-RENDERED KaTeX (mord /
//         pstrut / vlist spans), plus inline <svg>, <img src="img/<nb>/…">,
//         wolfbook's custom elements (wrow/wfrac/wsub/…), <details>, and some
//         inert UI (format buttons, Manipulate sliders).
//     text/plain                            — fallback / InputForm
//     application/vnd.code.notebook.error   — {name, message, stack} JSON
//
// So Phase 1 is mostly *re-hosting HTML we already generated*, correctly and
// safely. No kernel, no evaluation, no math typesetting of our own.
//
// ISOLATION: everything mounts in a shadow root. Two reasons, both real:
//   - WL_CSS contains bare `pre {…}` and `:root {…}` selectors that would
//     otherwise restyle Overleaf's own interface;
//   - Overleaf's stylesheet would otherwise reach into KaTeX's markup, where
//     a single inherited line-height is enough to visibly break equations.

import { THEME_CSS, HIGHLIGHT_CSS, splitFontFaces, scopeRootToHost } from './theme-css.js';
import { renderMarkdown } from './md.js';
import katex from '../vendor/katex.mjs';
import { applyInlineHighlight } from '../vendor/renderer-highlight.js';
import { highlightWolframInto } from './wl-highlight.js';

const MIME_HTML = 'x-application/wolfram-language-html';
const MIME_TEXT = 'text/plain';
const MIME_ERROR = 'application/vnd.code.notebook.error';

const EXT_MIME = {
  svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', json: 'application/json',
};

// ─────────────────────────────────────────────────────────────────────────────
// assets

/**
 * Resolve a notebook-relative asset path (img/<nb>/wl_x.svg) to a blob: URL,
 * out of the project zip. Returns null when the project does not contain it —
 * the caller renders an honest placeholder rather than a broken image icon.
 *
 * @param {Map<string, Uint8Array>} zipEntries
 * @param {string} notebookDir  the notebook's own folder inside the project ('' at root)
 */
export function makeAssetResolver(zipEntries, notebookDir) {
  const cache = new Map();
  const revoke = [];
  const fn = (relPath) => {
    if (!relPath || /^(https?:|data:|blob:|#)/i.test(relPath)) return null;
    const joined = (notebookDir ? notebookDir + '/' : '') + relPath.replace(/^\.\//, '');
    const norm = [];
    for (const seg of joined.split('/')) {
      if (!seg || seg === '.') continue;
      if (seg === '..') norm.pop();
      else norm.push(seg);
    }
    const key = norm.join('/');
    if (cache.has(key)) return cache.get(key);
    const bytes = zipEntries.get(key);
    if (!bytes) { cache.set(key, null); return null; }
    const ext = key.slice(key.lastIndexOf('.') + 1).toLowerCase();
    const url = URL.createObjectURL(new Blob([bytes], { type: EXT_MIME[ext] || 'application/octet-stream' }));
    cache.set(key, url);
    revoke.push(url);
    return url;
  };
  fn.dispose = () => { for (const u of revoke) URL.revokeObjectURL(u); revoke.length = 0; cache.clear(); };
  return fn;
}

// ─────────────────────────────────────────────────────────────────────────────
// sanitising

const DROP_TAGS = ['script', 'iframe', 'object', 'embed', 'link', 'meta', 'base', 'form', 'style'];

/** base64 → string, UTF-8 safe (atob alone mangles non-ASCII). */
function b64ToText(b64) {
  const bin = atob(b64);
  const bytes = Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/**
 * Turn one stored output-HTML string into a safe DocumentFragment.
 *
 * The HTML is authored by whoever ran the notebook — in a shared Overleaf
 * project that is not necessarily the person reading it — so it is treated as
 * untrusted: no scripts, no event handlers, no javascript: URLs, no external
 * loads. Everything else is preserved, including wolfbook's custom elements,
 * because that markup IS the output.
 *
 * @returns {{ frag: DocumentFragment, outN: number|null, interactive: string[] }}
 */
export function sanitizeOutputHtml(html, resolveAsset) {
  const doc = new DOMParser().parseFromString(String(html), 'text/html');
  const body = doc.body;
  const interactive = [];

  for (const el of body.querySelectorAll(DROP_TAGS.join(','))) el.remove();

  // Attributes: drop handlers and javascript: URLs.
  for (const el of body.querySelectorAll('*')) {
    for (const attr of [...el.attributes]) {
      const name = attr.name.toLowerCase();
      if (name.startsWith('on')) { el.removeAttribute(attr.name); continue; }
      if ((name === 'href' || name === 'src' || name === 'xlink:href' || name === 'action')
          && /^\s*(javascript|vbscript|data:text\/html)/i.test(attr.value)) {
        el.removeAttribute(attr.name);
      }
    }
  }

  // Out[N] — the stored header already carries the real evaluation number, so
  // the viewer never invents its own numbering.
  const header = body.querySelector('.wl-output-header');
  const outN = header && header.dataset.outN ? Number(header.dataset.outN) : null;

  // Output-format switch buttons are a VS Code affordance with nothing behind
  // them here; remove rather than show dead controls.
  for (const b of body.querySelectorAll('button[data-fmt-key], button.wl-nb-default-fmt')) b.remove();

  // Manipulate sliders and any other control: keep them VISIBLE (their presence
  // is information — this output is interactive) but disabled and labelled.
  const controls = body.querySelectorAll('input, select, textarea, button');
  if (controls.length) {
    interactive.push('controls');
    for (const c of controls) {
      c.setAttribute('disabled', 'disabled');
      c.setAttribute('tabindex', '-1');
      c.setAttribute('title', 'Interactive controls need a running Wolfram kernel — open this notebook in Wolfbook.');
    }
    for (const strip of body.querySelectorAll('.wl-manip-controls')) {
      strip.classList.add('wb-inert');
      if (!strip.querySelector('.wb-inert-badge')) {
        const badge = doc.createElement('span');
        badge.className = 'wb-inert-badge';
        badge.textContent = 'static preview';
        strip.appendChild(badge);
      }
    }
  }

  // Images: rewrite to blob: URLs from the project zip, or say plainly that the
  // file is not in the project. data-wl-img is an absolute path on the author's
  // machine and is meaningless (and mildly identifying) here — drop it.
  for (const img of body.querySelectorAll('img')) {
    const src = img.getAttribute('src') || '';
    img.removeAttribute('data-wl-img');
    if (img.hasAttribute('data-wl-mesh-src') || img.hasAttribute('data-wl-plot-src')) {
      interactive.push(img.hasAttribute('data-wl-mesh-src') ? '3D' : 'plot');
    }
    if (/^(https?:|data:|blob:)/i.test(src)) continue;
    const url = resolveAsset ? resolveAsset(src) : null;
    if (url) { img.setAttribute('src', url); continue; }
    const note = doc.createElement('div');
    note.className = 'wb-missing-asset';
    note.textContent = `Image not in this Overleaf project: ${src} — upload the notebook's img/ folder to see it.`;
    img.replaceWith(note);
  }

  // Math: expose the LaTeX that produced each equation. In an Overleaf tab this
  // is the single most useful thing the viewer can offer — the source is
  // already sitting in the markup as base64.
  for (const host of body.querySelectorAll('[data-latex-b64]')) {
    let tex = '';
    try { tex = b64ToText(host.getAttribute('data-latex-b64')); } catch (_) { continue; }
    if (!tex) continue;
    host.classList.add('wb-math-host');
    const btn = doc.createElement('button');
    btn.className = 'wb-copy-tex';
    btn.setAttribute('data-tex', tex);
    btn.textContent = 'copy LaTeX';
    host.appendChild(btn);
  }

  const frag = doc.createDocumentFragment();
  while (body.firstChild) frag.appendChild(body.firstChild);
  return { frag, outN, interactive: [...new Set(interactive)] };
}

// ─────────────────────────────────────────────────────────────────────────────
// rendering

/**
 * Does this fragment actually show the reader anything?
 *
 * Not a nicety: a kernel-error output stores THREE items — the error, a
 * text/plain form, and an HTML item that is literally
 * `<span style="display:none"></span>`. Preferring HTML unconditionally
 * therefore rendered an invisible span and dropped the error message on the
 * floor. So we ask whether the HTML has visible content before choosing it.
 */
function fragmentHasContent(frag) {
  const VISUAL = new Set(['IMG', 'SVG', 'CANVAS', 'VIDEO', 'TABLE', 'INPUT', 'BUTTON', 'HR', 'DETAILS']);
  const walk = (node) => {
    for (const child of node.childNodes) {
      if (child.nodeType === 3) { if (child.nodeValue.trim()) return true; continue; }
      if (child.nodeType !== 1) continue;
      const style = (child.getAttribute('style') || '').replace(/\s/g, '');
      if (/display:none|visibility:hidden/i.test(style)) continue;
      if (VISUAL.has(child.tagName.toUpperCase())) return true;
      // A deferred-LaTeX placeholder is empty until it is typeset; counting it
      // as blank is what made LaTeX outputs vanish.
      if (child.hasAttribute && child.hasAttribute('data-latex-b64')) return true;
      if (walk(child)) return true;
    }
    return false;
  };
  return walk(frag);
}

/**
 * Typeset the `$…$` placeholders a markdown cell produced.
 *
 * Only markup cells need this. A code cell's output was already typeset by the
 * kernel-side renderer and arrives as finished KaTeX markup — running KaTeX
 * over it again would be both wasteful and wrong.
 *
 * KaTeX failures are contained per-equation: the placeholder already holds the
 * TeX source in a <code>, so a bad expression degrades to readable source
 * instead of taking the notebook down.
 */
function typesetMath(root) {
  for (const span of root.querySelectorAll('.wb-math')) {
    const tex = span.getAttribute('data-tex');
    if (!tex) continue;
    try {
      span.innerHTML = katex.renderToString(tex, {
        displayMode: span.classList.contains('wb-math-display'),
        throwOnError: false,
        strict: false,
        trust: false,
      });
      span.classList.add('wb-math-done');
    } catch (_) { /* keep the source fallback */ }
  }
}

/**
 * Fill in the DEFERRED LaTeX outputs the kernel ships as placeholders.
 *
 * A LaTeX-formatted result does not arrive as markup. It arrives as
 *
 *   <div class="vscode-wolfram-wllatex-prerendered" data-latex-b64="..."></div>
 *
 * an EMPTY element carrying its LaTeX in base64, which the VS Code renderer
 * typesets on arrival. Nothing here did, so every such output was an empty div:
 * invisible on screen, and dropped outright by fragmentHasContent — which is
 * why a Series, or any TeXForm result, looked like a cell that produced nothing.
 *
 * LINE BREAKING IS NOT DONE HERE. The LaTeX arrives already broken by BTL on
 * the server — \begin{aligned} with the continuations aligned on their leading
 * operator — because BTL breaks with knowledge of the expression (delimiter
 * depth, indent step, page width) and is what the notebook editor uses. KaTeX
 * can only split inline math at top-level relations and binary operators, which
 * knows nothing about structure: it will part a matrix row or an integrand from
 * its measure, and cannot indent a continuation at all. So this renders what it
 * is given, in display mode, and leaves the breaking to the tool that can see
 * the expression.
 */
function typesetDeferredLatex(root) {
  const nodes = root && root.querySelectorAll
    ? root.querySelectorAll('[data-latex-b64]:not([data-wb-typeset])')
    : [];
  for (const el of nodes) {
    let tex = '';
    try { tex = b64ToText(el.getAttribute('data-latex-b64') || ''); } catch (_) { continue; }
    if (!tex) continue;

    // Render into a child, NOT over innerHTML: sanitizeOutputHtml has already
    // put the "copy LaTeX" button inside this element, and replacing the
    // markup wholesale threw it away.
    const doc = el.ownerDocument;
    const holder = doc.createElement('span');
    holder.className = 'wb-tex-body';
    try {
      holder.innerHTML = katex.renderToString(tex, {
        // Display mode: BTL emits an `aligned` environment, whose alignment is
        // the whole point of breaking there rather than anywhere.
        displayMode: true,
        throwOnError: false,
        strict: false,
        trust: false,
      });
      el.setAttribute('data-wb-typeset', '1');
    } catch (_) {
      holder.textContent = tex;        // the source beats showing nothing at all
      el.setAttribute('data-wb-typeset', 'source');
    }
    el.insertBefore(holder, el.firstChild);
    el.classList.add('wb-tex-out');
  }
}

/**
 * Language ids as they appear in .wb cells and markdown fences, mapped to the
 * two the extension's highlighter understands.
 */
const HL_LANG = {
  wolfram: 'mathematica', mathematica: 'mathematica', wl: 'mathematica', wls: 'mathematica',
  latex: 'latex', tex: 'latex',
};

/**
 * Highlight a <pre> in place using the extension's own highlighter, so code
 * reads the same here as in the notebook editor. Unknown languages are left
 * alone (the highlighter returns without touching the element).
 */
function highlight(pre, languageId) {
  const lang = HL_LANG[String(languageId || '').toLowerCase()];
  if (!lang) return;
  try {
    // Wolfram gets the real tokenizer (builtins vs user symbols, patterns,
    // slots, operators); LaTeX keeps the extension's own rules.
    if (lang === 'mathematica') highlightWolframInto(pre);
    else applyInlineHighlight(pre, lang);
  } catch (_) { /* plain text is fine */ }
}

/**
 * Give a code cell a Run button and a place to show what the local kernel says.
 *
 * The result is deliberately kept SEPARATE from the notebook's stored outputs
 * and labelled with where it came from: the stored output is what the author
 * last committed to the project, while this is a fresh evaluation on the
 * reader's own machine. Conflating them would let a viewer believe the project
 * contains a result it does not.
 *
 * @param {object} evaluator { run(code) → Promise<{text, isError, form}> }
 */
function attachRunner(cellEl, cellState, evaluator, doc, storedOutputs = []) {
  /**
   * Hide the outputs that came with the file once they no longer describe the
   * code beside them.
   *
   * The stored output belongs to the author's last run. The moment this cell is
   * edited or re-run it describes DIFFERENT code, and showing it above a fresh
   * result is not "keeping both" — it is displaying a wrong answer with an
   * authoritative Out[n] label on it.
   */
  const supersede = (reason) => {
    if (cellState.outputsStale) return;
    cellState.outputsStale = reason;
    for (const box of storedOutputs) box.classList.add('wb-output-superseded');
    if (storedOutputs.length && !cellEl.querySelector('.wb-superseded-note')) {
      const note = doc.createElement('div');
      note.className = 'wb-superseded-note';
      note.textContent = reason === 'edited'
        ? 'saved output hidden — the code has changed since it was produced'
        : 'saved output replaced by this run';
      note.title = 'Click to show the output stored in the Overleaf file';
      note.addEventListener('click', () => {
        const hidden = storedOutputs.some((b) => b.classList.contains('wb-output-superseded'));
        for (const box of storedOutputs) box.classList.toggle('wb-output-superseded', !hidden);
        note.classList.toggle('wb-superseded-shown', hidden);
      });
      cellEl.appendChild(note);
    }
  };
  cellState.supersede = supersede;
  const btn = doc.createElement('button');
  btn.className = 'wb-run';
  btn.type = 'button';
  btn.title = 'Evaluate this cell on your local Wolfram kernel';
  btn.textContent = '▶';

  const live = doc.createElement('div');
  live.className = 'wb-live';
  live.hidden = true;

  let busy = false;
  const run = async () => {
    if (busy) return null;
    if (!String(cellState.code || '').trim()) return null;   // nothing to evaluate yet
    busy = true;
    btn.disabled = true;
    btn.classList.add('wb-run-busy');
    live.hidden = false;
    live.className = 'wb-live wb-live-running';
    live.textContent = '';
    const spin = doc.createElement('span');
    spin.className = 'wb-live-label';
    spin.textContent = 'evaluating on local kernel…';
    live.appendChild(spin);
    try {
      // cellState.code, not a captured string: an edited cell must run what
      // the reader now sees, not what the project last stored.
      const res = await evaluator.run(cellState.code);
      // This result now describes the cell; the stored one describes an older
      // run of possibly different code, so it is superseded rather than stacked
      // above. Keeping the result lets a save write it into the file, instead of
      // leaving the notebook with code whose output exists only in this tab.
      supersede('ran');
      cellState.liveResult = res;
      // Adopt the kernel's OWN evaluation number, the way the notebook does:
      // after re-running, In[3] becoming In[12] is how you can tell what has
      // actually been evaluated in this session.
      if (res.outN && cellState.label) cellState.label.textContent = `In[${res.outN}]:=`;
      renderLiveResult(live, res, doc, evaluator.resolveAsset || null);
      return res;
    } catch (e) {
      live.className = 'wb-live wb-live-error';
      live.textContent = String((e && e.message) || e);
      return { isError: true, text: String((e && e.message) || e) };
    } finally {
      busy = false;
      btn.disabled = false;
      btn.classList.remove('wb-run-busy');
    }
  };

  btn.addEventListener('click', run);
  cellEl.__wbRun = run;                 // used by "Run all" in content.js
  Object.defineProperty(cellEl, '__wbCode', { get: () => cellState.code, configurable: true });
  return { btn, live };
}

/** Render one evaluation result into its live area. */
function renderLiveResult(live, res, doc, resolveAsset) {
  live.textContent = '';
  live.className = 'wb-live' + (res.isError ? ' wb-live-error' : ' wb-live-ok');

  const label = doc.createElement('div');
  label.className = 'wb-live-label';
  const bits = [];
  if (res.outN) bits.push(`Out[${res.outN}]=`);
  bits.push(res.isError ? 'local kernel — error' : 'local kernel');
  if (res.via) bits.push(res.via);
  // Duration, as the notebook's own cell status shows it: the number people
  // actually watch when deciding whether something is stuck.
  if (res.ms != null) bits.push(res.ms >= 1000 ? `${(res.ms / 1000).toFixed(1)}s` : `${res.ms}ms`);
  label.textContent = bits.join(' · ');
  live.appendChild(label);

  // Output folding, for the results that are pages long.
  const fold = doc.createElement('button');
  fold.className = 'wb-live-fold';
  fold.type = 'button';
  fold.title = 'Collapse this output';
  fold.textContent = '▾';
  fold.addEventListener('click', () => {
    const folded = live.classList.toggle('wb-live-folded');
    fold.textContent = folded ? '▸' : '▾';
    fold.title = folded ? 'Expand this output' : 'Collapse this output';
  });
  live.appendChild(fold);

  // Print output first, in evaluation order, the way a notebook shows it.
  for (const line of res.print || []) {
    const p = doc.createElement('pre');
    p.className = 'wb-live-print';
    p.textContent = line;
    live.appendChild(p);
  }

  // Rich HTML from wolfbook-serve: the kernel's OWN rendering — real SVG plots
  // and typeset maths, not a text description of them. Sanitised on exactly the
  // same terms as a stored output, and its relative img/ paths are resolved
  // against the server that produced them.
  if (res.html && res.html.trim()) {
    const { frag } = sanitizeOutputHtml(res.html, resolveAsset);
    if (fragmentHasContent(frag)) {
      live.appendChild(frag);
      typesetMath(live);
      typesetDeferredLatex(live);
      // The server hands back LaTeX rather than pre-rendered markup, so an empty
      // prerendered div still needs typesetting here.
      for (const host of live.querySelectorAll('.vscode-wolfram-wllatex-prerendered[data-latex-b64]')) {
        // Only "already typeset" should skip. Testing textContent as well was
        // wrong: the sanitiser has just added a "copy LaTeX" button inside this
        // very div, so every equation looked already-rendered and none were —
        // which also made numeric results vanish, since they arrive as maths too.
        if (host.querySelector('.katex')) continue;
        try {
          const tex = b64ToText(host.getAttribute('data-latex-b64'));
          host.innerHTML = katex.renderToString(tex, {
            displayMode: true, throwOnError: false, strict: false, trust: false,
          });
        } catch (_) { /* leave it empty rather than break the cell */ }
      }
      for (const m of res.messages || []) {
        const w = doc.createElement('pre');
        w.className = 'wb-live-message';
        w.textContent = m;
        live.appendChild(w);
      }
      return;
    }
  }

  const text = String(res.text ?? '');

  // TeXForm results are LaTeX; typeset them, since KaTeX is already loaded.
  if (!res.isError && res.form === 'TeXForm' && text.trim()) {
    try {
      const span = doc.createElement('div');
      span.className = 'wb-live-math';
      span.innerHTML = katex.renderToString(text.trim(), {
        displayMode: true, throwOnError: true, strict: false, trust: false,
      });
      live.appendChild(span);
      return;
    } catch (_) { /* not valid TeX after all — fall through to plain text */ }
  }

  const pre = doc.createElement('pre');
  pre.className = 'wb-live-text';
  pre.textContent = text;
  live.appendChild(pre);

  for (const m of res.messages || []) {
    const w = doc.createElement('pre');
    w.className = 'wb-live-message';
    w.textContent = m;
    live.appendChild(w);
  }
}


/**
 * Make one code cell editable, on demand.
 *
 * Editors are created on CLICK and destroyed on blur. CodeMirror handles many
 * instances well, but a 138-cell notebook still should not build 138 of them up
 * front — and a read-only reader should not pay for the editor at all, which is
 * why the bundle is imported lazily.
 *
 * An edited cell is badged. The notebook in the Overleaf project is unchanged:
 * editing here only affects what gets evaluated, and nothing is written back.
 */
function attachEditing(cellEl, input, pre, cellState, editing, doc, onRun) {
  let active = null;

  /** Mount, but never let a broken editor take the cell's contents with it. */
  const mountGuarded = (el, opts) => {
    try {
      return editing._mount(el, opts);
    } catch (e) {
      console.error('[wolfbook] editor failed to mount; staying read-only', e);
      return null;
    }
  };
  pre.title = 'Click to edit — Shift-Enter evaluates, Escape closes';
  pre.classList.add('wb-editable');

  const closeEditor = () => {
    if (!active) return;
    cellState.code = active.getValue();
    active.destroy();
    active = null;
    delete cellEl.__wbEditorHandle;
    host.remove();
    pre.textContent = cellState.code;
    highlight(pre, cellState.languageId);
    pre.hidden = false;
    if (cellState.code !== cellState.original) markEdited();
  };

  const markEdited = () => {
    if (input.querySelector('.wb-edited-badge')) return;
    const badge = doc.createElement('span');
    badge.className = 'wb-edited-badge';
    badge.textContent = 'edited';
    badge.title = 'Changed here only — the file in the Overleaf project is untouched.';
    input.appendChild(badge);
  };

  const host = doc.createElement('div');
  host.className = 'wb-editor';

  // Exposed so the caller can put the cursor in a cell it just created: a new
  // cell you have to hunt for and click is not really "inserted here".
  cellEl.__wbEdit = () => pre.click();

  pre.addEventListener('click', async () => {
    if (active) return;
    const mount = await editing.mount();
    if (!mount) return;
    editing._mount = mount;                       // bundle unavailable; stay read-only

    // The <pre> is hidden only once the editor is REALLY up. Hiding first and
    // mounting second meant any failure inside CodeMirror left the cell looking
    // EMPTY — the code was still there, but nothing was showing it.
    input.insertBefore(host, pre.nextSibling);
    active = mountGuarded(host, {
      doc: cellState.code,
      // Badge as soon as the text diverges, not only when it is run or closed:
      // the cell already differs from the project's copy at that point, and that
      // is the fact worth showing.
      onChange: (v) => {
        cellState.code = v;
        if (v !== cellState.original) { markEdited(); cellState.supersede?.('edited'); }
      },
      onRun: (v) => { cellState.code = v; markEdited(); onRun?.(); },
      onDone: closeEditor,
    });
    if (!active) {                            // mount failed; stay readable
      host.remove();
      return;
    }
    pre.hidden = true;
    active.focus();
    // Exposed so tests can drive the real CodeMirror API instead of synthesising
    // keystrokes, which never exercises the document model faithfully.
    cellEl.__wbEditorHandle = active;
    // Blur closes, but only once focus has genuinely left the editor — clicking
    // inside it (gutter, scrollbar) moves focus around within the same view.
    active.view.dom.addEventListener('focusout', (ev) => {
      if (active && !active.view.dom.contains(ev.relatedTarget)) setTimeout(closeEditor, 0);
    });
  });
}


/** Editing for a MARKUP cell: swap rendered markdown for its source. */
function attachMarkdownEditing(cellEl, state, editing, doc, repaint) {
  let active = null;
  cellEl.classList.add('wb-editable-md');
  cellEl.title = 'Double-click to edit — Escape closes';

  const host = doc.createElement('div');
  host.className = 'wb-editor wb-editor-md';

  const close = () => {
    if (!active) return;
    state.code = active.getValue();
    active.destroy();
    active = null;
    host.remove();
    delete cellEl.__wbEditorHandle;
    repaint();
  };

  cellEl.__wbEdit = () => cellEl.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));

  cellEl.addEventListener('dblclick', async (ev) => {
    if (active) return;
    // Let links and the copy-LaTeX button keep working.
    if (ev.target.closest('a, button')) return;
    const mount = await editing.mount();
    if (!mount) return;
    cellEl.textContent = '';
    cellEl.appendChild(host);
    try {
      active = mount(host, {
        doc: state.code,
        onChange: (v) => { state.code = v; },
        onRun: close,
        onDone: close,
      });
    } catch (e) {
      console.error('[wolfbook] markdown editor failed to mount', e);
      repaint();
      return;
    }
    cellEl.__wbEditorHandle = active;
    active.focus();
    active.view.dom.addEventListener('focusout', (e2) => {
      if (active && !active.view.dom.contains(e2.relatedTarget)) setTimeout(close, 0);
    });
  });
}

/**
 * Per-cell structural controls: insert above/below, delete.
 *
 * These mutate the SAME parsed notebook the save serialises, so a structural
 * change is written back as faithfully as a text edit. Deletion is undoable
 * until saved, because losing a cell to a stray click would be unforgivable.
 */
function attachCellControls(cellEl, state, structure, doc, isCode) {
  const bar = doc.createElement('div');
  bar.className = 'wb-cell-controls';
  const mk = (label, title, fn, cls) => {
    const b = doc.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.title = title;
    if (cls) b.className = cls;
    b.addEventListener('click', (ev) => { ev.stopPropagation(); fn(); });
    bar.appendChild(b);
    return b;
  };
  // The set VS Code's own cell toolbar offers, in the same order, because that
  // is the muscle memory anyone opening this already has.
  mk('↑', 'Move this cell up', () => structure.move(state, -1));
  mk('↓', 'Move this cell down', () => structure.move(state, +1));
  mk('+↑', 'Insert a cell above', () => structure.insertBefore(state, isCode ? 2 : 1));
  mk('+↓', 'Insert a cell below', () => structure.insertAfter(state, isCode ? 2 : 1));
  mk(isCode ? '¶' : '{ }', isCode ? 'Turn into a markdown cell' : 'Turn into a code cell',
     () => structure.changeType(state, isCode ? 1 : 2));
  mk('⧉', 'Copy this cell to the clipboard', () => {
    navigator.clipboard?.writeText(state.code).catch(() => {});
  });
  if (isCode) {
    mk('∅', 'Clear this cell\u2019s output', () => structure.clearOutputs(state));
    // "Run above" is how you rebuild the state a cell depends on after opening
    // a notebook cold — the single most-used notebook command after Run.
    mk('⤒▶', 'Run every cell above this one', () => structure.runAbove?.(state));
    mk('▶⤓', 'Run this cell and everything below', () => structure.runBelow?.(state));
  }
  mk('⌦', 'Delete this cell', () => structure.remove(state), 'wb-danger');
  cellEl.appendChild(bar);
}


/**
 * The insertion strip VS Code puts BETWEEN cells: hover the gap and a
 * "+ Code / + Markdown" pill appears on a hairline.
 *
 * It answers a question the per-cell controls cannot — "add a cell *here*" —
 * without first deciding which neighbour to hang it off. The strip occupies its
 * space whether or not it is hovered, and the pill is absolutely positioned
 * inside it, so revealing the controls never nudges the notebook.
 *
 * @param {number} index  position in the cell array to insert AT
 */
function makeGap(doc, index, structure) {
  const gap = doc.createElement('div');
  gap.className = 'wb-gap';
  gap.dataset.index = String(index);

  const pill = doc.createElement('div');
  pill.className = 'wb-gap-pill';

  const add = (label, kind, title) => {
    const b = doc.createElement('button');
    b.type = 'button';
    b.className = 'wb-gap-btn';
    b.textContent = label;
    b.title = title;
    b.addEventListener('click', (ev) => {
      ev.stopPropagation();
      structure.insertAt(index, kind);
    });
    pill.appendChild(b);
  };
  add('+ Code', 2, 'Insert a code cell here');
  add('+ Markdown', 1, 'Insert a markdown cell here');

  gap.appendChild(pill);
  return gap;
}

function renderErrorOutput(doc, raw) {
  let name = 'Error', message = String(raw);
  try {
    const parsed = JSON.parse(raw);
    name = parsed.name || name;
    message = parsed.message || message;
  } catch (_) { /* not JSON — show it raw */ }
  const box = doc.createElement('div');
  box.className = 'wb-output-error';
  const n = doc.createElement('div');
  n.className = 'wb-err-name';
  n.textContent = name;
  const m = doc.createElement('pre');
  m.className = 'wb-err-msg';
  m.textContent = message;
  box.append(n, m);
  return box;
}

/**
 * Render a parsed .wb into `container` (any element; typically inside a shadow root).
 * @param {{cells?: Array}} wb
 * @param {HTMLElement} container
 * @param {{resolveAsset?: (rel:string)=>string|null}} [opts]
 * @returns {{cells:number, codeCells:number, outputs:number, missingAssets:number, interactive:string[]}}
 */
export function renderNotebook(wb, container, opts = {}) {
  const { resolveAsset = null, evaluator = null, editing = null, structure = null } = opts;
  const doc = container.ownerDocument;
  container.textContent = '';

  const cells = Array.isArray(wb?.cells) ? wb.cells : [];
  const stats = { cells: cells.length, codeCells: 0, outputs: 0, missingAssets: 0, interactive: [] };
  // Exposed so the caller can collect edits without walking the DOM.
  const cellStates = [];
  container.__wbCellStates = cellStates;
  let fallbackIn = 0;

  let gapIndex = 0;
  const addGap = () => {
    if (structure && structure.insertAt) container.appendChild(makeGap(doc, gapIndex, structure));
    gapIndex++;
  };

  for (const cell of cells) {
    addGap();
    const isMarkup = cell?.kind === 1;
    const el = doc.createElement('div');
    el.className = isMarkup ? 'wb-cell wb-cell-md' : 'wb-cell wb-cell-code';

    if (isMarkup) {
      const mdState = {
        code: String(cell?.value ?? ''), original: String(cell?.value ?? ''),
        languageId: 'markdown', index: cells.indexOf(cell), cell,
      };
      cellStates.push(mdState);
      el.__wbState = mdState;

      // Markdown cells may legitimately contain raw HTML — the .nb importer
      // represents a pasted picture as a markdown cell holding an <img>. So the
      // markdown output goes through the SAME sanitiser as stored outputs,
      // which also resolves image paths against the project.
      const paint = () => {
        el.textContent = '';
        const { frag } = sanitizeOutputHtml(renderMarkdown(mdState.code), resolveAsset);
        el.appendChild(frag);
        typesetMath(el);
        typesetDeferredLatex(el);
        // Fenced blocks that named a language (```wolfram / ~~~wolfram).
        for (const pre of el.querySelectorAll('pre.wb-md-code[data-lang]')) {
          highlight(pre, pre.getAttribute('data-lang'));
        }
        if (mdState.code !== mdState.original) el.classList.add('wb-cell-edited');
      };
      paint();

      // A markup cell shows RENDERED markdown, so it has no <pre> to click.
      // Editing swaps the rendered view for the source and repaints on close —
      // otherwise prose and headings could never be corrected here at all.
      if (editing) attachMarkdownEditing(el, mdState, editing, doc, paint);
      if (structure) attachCellControls(el, mdState, structure, doc, false);
      container.appendChild(el);
      continue;
    }

    stats.codeCells++;
    fallbackIn++;

    // Render outputs first: the stored Out[N] tells us the real In[N].
    const outputEls = [];
    let outN = null;
    for (const output of cell?.outputs || []) {
      const items = output?.items || [];
      const html = items.find((i) => i?.mime === MIME_HTML);
      const err = items.find((i) => i?.mime === MIME_ERROR);
      const text = items.find((i) => i?.mime === MIME_TEXT);

      const box = doc.createElement('div');
      box.className = 'wb-output';

      // Prepare the HTML item first so we can ask whether it is worth showing;
      // an error output ships a hidden placeholder span as its HTML.
      let htmlFrag = null;
      if (html) {
        const { frag, outN: n, interactive } = sanitizeOutputHtml(html.data, resolveAsset);
        if (fragmentHasContent(frag)) {
          htmlFrag = frag;
          if (n != null && outN == null) outN = n;
          for (const k of interactive) if (!stats.interactive.includes(k)) stats.interactive.push(k);
        }
      }

      if (err) {
        // An errored evaluation may still have produced visible output before
        // failing; show both, error last, the way the notebook does.
        if (htmlFrag) box.appendChild(htmlFrag);
        box.appendChild(renderErrorOutput(doc, err.data));
        el.classList.add('wb-cell-failed');   // visible at a glance when scanning
      } else if (htmlFrag) {
        box.appendChild(htmlFrag);
      } else if (text) {
        const pre = doc.createElement('pre');
        pre.className = 'wb-output-text';
        pre.textContent = text.data;
        box.appendChild(pre);
      }
      // Stored outputs carry the same deferred-LaTeX placeholders as live ones.
      typesetDeferredLatex(box);
      stats.missingAssets += box.querySelectorAll('.wb-missing-asset').length;
      if (box.childNodes.length) { outputEls.push(box); stats.outputs++; }
    }

    const input = doc.createElement('div');
    input.className = 'wb-input';
    const label = doc.createElement('span');
    label.className = 'wb-in-label';
    label.textContent = `In[${outN ?? fallbackIn}]:=`;
    const pre = doc.createElement('pre');
    const code = String(cell?.value ?? '');
    pre.textContent = code;
    highlight(pre, cell?.languageId || 'wolfram');
    input.append(label, pre);

    const cellState = {
      code, original: code,
      languageId: cell?.languageId || 'wolfram',
      index: cells.indexOf(cell),
      cell,
    };
    // Assigned AFTER the declaration, not at the label's creation site: `const`
    // is in its temporal dead zone until here, so touching cellState earlier
    // threw and took the whole render with it.
    cellState.label = label;
    cellStates.push(cellState);
    el.__wbState = cellState;      // lets "run above/below" locate this cell

    let runner = null;
    if (evaluator) {
      // NOT `evaluator && code.trim()`. Whether a cell can be run was decided
      // at RENDER time, so a cell inserted empty and then typed into never got
      // a run handler at all — and Shift-Enter in it did nothing, silently,
      // for the rest of the session. Emptiness is a question for the moment the
      // button is pressed, not for the moment the cell is drawn.
      runner = attachRunner(el, cellState, evaluator, doc, outputEls);
      // FIRST child: the run control belongs at the left edge, before In[n]:=,
      // where the notebook editor puts it.
      input.insertBefore(runner.btn, input.firstChild);
    }
    if (editing) attachEditing(el, input, pre, cellState, editing, doc, () => runner?.btn.click());
    if (structure) attachCellControls(el, cellState, structure, doc, true);

    el.appendChild(input);
    for (const o of outputEls) el.appendChild(o);
    if (runner) el.appendChild(runner.live);
    container.appendChild(el);
  }

  addGap();                       // the trailing strip, for appending
  stats.cellStates = cellStates;
  stats.edits = () => {
    const m = new Map();
    for (const c of cellStates) if (c.code !== c.original) m.set(c.index, c.code);
    return m;
  };
  return stats;
}

// ─────────────────────────────────────────────────────────────────────────────
// mounting

let fontsInjected = false;

/**
 * Create an isolated viewer surface inside `host`.
 *
 * KaTeX's @font-face rules are moved to the document head: Chrome does not
 * apply @font-face declared inside a shadow root, but fonts registered on the
 * document ARE usable by shadow content. Every other rule stays scoped.
 *
 * @param {HTMLElement} host
 * @param {{katexCss: string, wlCss: string}} css
 */
export function createViewerSurface(host, css) {
  const shadow = host.shadowRoot || host.attachShadow({ mode: 'open' });
  shadow.textContent = '';

  const { fontFaces, rest: katexRest } = splitFontFaces(css.katexCss || '');
  if (fontFaces && !fontsInjected) {
    const style = document.createElement('style');
    style.id = 'wolfbook-katex-fonts';
    style.textContent = fontFaces;
    document.head.appendChild(style);
    fontsInjected = true;
  }

  const style = document.createElement('style');
  // HIGHLIGHT_CSS goes LAST: it overrides WL_CSS's dark-theme .wl-hl-* colours,
  // and same-specificity rules are decided by order.
  style.textContent = [
    THEME_CSS,
    scopeRootToHost(katexRest),
    scopeRootToHost(css.wlCss || ''),
    HIGHLIGHT_CSS,
  ].join('\n');
  shadow.appendChild(style);

  // One delegated listener for every copy-LaTeX button, now and later.
  shadow.addEventListener('click', (ev) => {
    const btn = ev.target && ev.target.closest && ev.target.closest('.wb-copy-tex');
    if (!btn) return;
    ev.preventDefault();
    ev.stopPropagation();
    const tex = btn.getAttribute('data-tex') || '';
    navigator.clipboard.writeText(tex).then(
      () => {
        btn.textContent = 'copied ✓';
        btn.classList.add('done');
        setTimeout(() => { btn.textContent = 'copy LaTeX'; btn.classList.remove('done'); }, 1400);
      },
      () => { btn.textContent = 'copy failed'; },
    );
  });

  return shadow;
}
