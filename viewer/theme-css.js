// theme-css.js — the CSS the viewer adds on top of the extension's own
// stylesheets (vendor/katex-css.js → KATEX_CSS, vendor/renderer-css.js → WL_CSS).
//
// Two jobs:
//   1. Supply the --vscode-* custom properties that stored output HTML and
//      WL_CSS reference. In VS Code the workbench defines these; in a browser
//      they resolve to nothing, so `color: var(--vscode-foreground)` silently
//      yields inherited/transparent text. Measured across the corpus, outputs
//      reference exactly three: --vscode-foreground, --vscode-descriptionForeground
//      and --vscode-editor-font-family (WL_CSS adds a few more, all with
//      fallbacks, but we define them anyway so the look is deliberate).
//   2. Style the notebook chrome (cells, In/Out labels, toolbar) for a light
//      page, since Overleaf's editor area is light.

export const THEME_CSS = `
:host {
  /* ── VS Code workbench variables, light-theme values ── */
  --vscode-foreground: #1f2328;
  --vscode-descriptionForeground: #656d76;
  --vscode-editor-font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  --vscode-editor-font-size: 13px;
  --vscode-font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  --vscode-editorError-foreground: #cf222e;
  --vscode-button-background: #2c6e49;
  --vscode-focusBorder: #0969da;

  /* ── viewer's own palette ── */
  --wb-border: #d8dee4;
  --wb-bg: #ffffff;
  --wb-code-bg: #f6f8fa;
  --wb-muted: #656d76;
  --wb-accent: #2c6e49;

  all: initial;
  display: block;
  height: 100%;
  font-family: var(--vscode-font-family);
  font-size: 14px;
  line-height: 1.5;
  color: var(--vscode-foreground);
  background: var(--wb-bg);
}

*, *::before, *::after { box-sizing: border-box; }

.wb-root { display: flex; flex-direction: column; height: 100%; }

/* ── toolbar ─────────────────────────────────────────────────────────────── */
.wb-toolbar {
  flex: 0 0 auto;
  display: flex; align-items: center; gap: 6px;
  padding: 6px 12px;
  border-bottom: 1px solid var(--wb-border);
  background: #f7f8fa;
  font-size: 12px;
}
.wb-toolbar .wb-logo {
  width: 17px; height: 17px; flex: 0 0 auto;
  /* No border-radius: the icon has its own alpha, so rounding would clip it
     rather than tidy a background it does not have. */
  /* It marks whose panel this is; it is not a control, so it takes no clicks. */
  pointer-events: none;
}
.wb-toolbar .wb-title { font-weight: 600; margin-right: 6px; }
.wb-toolbar .wb-spacer { flex: 1; }
.wb-toolbar button {
  font: inherit; font-size: 12px;
  border: 1px solid var(--wb-border); background: #fff; color: inherit;
  border-radius: 5px; padding: 3px 10px; cursor: pointer;
}
.wb-toolbar button:hover { background: #eef1f4; }
.wb-toolbar button.active { background: var(--wb-accent); border-color: var(--wb-accent); color: #fff; }
.wb-toolbar .wb-note { color: var(--wb-muted); font-size: 11px; }
.wb-toolbar select.wb-kernel {
  font: inherit; font-size: 11.5px;
  border: 1px solid var(--wb-border);
  background: #fff; color: inherit;
  border-radius: 5px; padding: 3px 5px; max-width: 220px;
}
.wb-toolbar select.wb-kernel:disabled { color: var(--wb-muted); }
.wb-run-group { display: inline-flex; align-items: center; gap: 6px; }
.wb-dot { font-size: 13px; color: #c4c9ce; }
.wb-dot.online { color: #2da44e; }

/* ── body ────────────────────────────────────────────────────────────────── */
.wb-body { flex: 1 1 auto; overflow: auto; padding: 18px 22px 60px; }
.wb-notebook { max-width: none; width: 100%; }
.wb-status { color: var(--wb-muted); padding: 20px 4px; font-size: 13px; }
.wb-error-box {
  color: #82071e; background: #fff5f5; border: 1px solid #ffc9c9;
  border-radius: 6px; padding: 12px 14px; margin-bottom: 12px;
}
.wb-error-box code { font-family: var(--vscode-editor-font-family); font-size: 12px; }
.wb-source {
  font-family: var(--vscode-editor-font-family); font-size: 12px;
  white-space: pre-wrap; word-break: break-word; margin: 0;
}

/* ── cells ───────────────────────────────────────────────────────────────── */
.wb-cell { margin: 0 0 16px; max-width: 100%; }
.wb-cell-md :is(h1,h2,h3,h4) { margin: .8em 0 .4em; line-height: 1.25; }
.wb-cell-md h1 { font-size: 1.6em; }
.wb-cell-md h2 { font-size: 1.3em; }
.wb-cell-md h3 { font-size: 1.1em; }
.wb-cell-md p { margin: .5em 0; }
.wb-cell-md :is(ul,ol) { margin: .5em 0; padding-left: 1.6em; }
.wb-cell-md blockquote {
  margin: .6em 0; padding: .1em 1em; color: var(--wb-muted);
  border-left: 3px solid var(--wb-border);
}
.wb-cell-md code {
  font-family: var(--vscode-editor-font-family); font-size: .9em;
  background: var(--wb-code-bg); border-radius: 4px; padding: .1em .35em;
}
.wb-cell-md pre.wb-md-code {
  background: var(--wb-code-bg); border: 1px solid var(--wb-border);
  border-radius: 6px; padding: 10px 12px; overflow-x: auto; font-size: 12.5px;
}
.wb-cell-md pre.wb-md-code code { background: none; padding: 0; }
.wb-cell-md img { max-width: 100%; }
.wb-cell-md a { color: #0969da; }

/* input */
.wb-input {
  display: flex; gap: 10px; align-items: flex-start; max-width: 100%;
  background: var(--wb-code-bg);
  border: 1px solid var(--wb-border);
  border-left: 3px solid #b8c4cc;
  border-radius: 6px; padding: 8px 11px;
}
.wb-in-label {
  flex: 0 0 auto; color: var(--wb-muted);
  font-family: var(--vscode-editor-font-family); font-size: 11px;
  padding-top: 2px; user-select: none; white-space: nowrap;
}
.wb-input pre {
  margin: 0; flex: 1 1 auto; overflow-x: auto;
  /* min-width:0 is what actually permits shrinking: a flex item defaults to
     min-width:auto, so a long line pushes the cell wider than the panel instead
     of scrolling inside it. */
  min-width: 0;
  font-family: var(--vscode-editor-font-family); font-size: 13px;
  line-height: 1.45; white-space: pre; tab-size: 4;
}
.wb-notebook.wb-wrap .wb-input pre { white-space: pre-wrap; overflow-wrap: anywhere; }

/* output */
.wb-output { margin: 6px 0 0 14px; max-width: 100%; overflow-x: auto; }
.wb-output img, .wb-output svg { max-width: 100%; height: auto; }
.wb-output-text {
  margin: 0; font-family: var(--vscode-editor-font-family); font-size: 12.5px;
  white-space: pre-wrap; word-break: break-word; color: #24292f;
}
.wb-output-error {
  border-left: 3px solid #cf222e; background: #fff8f8;
  padding: 7px 11px; border-radius: 0 5px 5px 0;
}
.wb-output-error .wb-err-name {
  font-weight: 600; color: #cf222e; font-size: 12px;
  font-family: var(--vscode-editor-font-family);
}
.wb-output-error .wb-err-msg {
  margin: 2px 0 0; font-family: var(--vscode-editor-font-family);
  font-size: 12.5px; white-space: pre-wrap;
}

/* assets that are not in the Overleaf project */
.wb-missing-asset {
  display: inline-block; color: #9a6700; background: #fff8c5;
  border: 1px dashed #d4a72c; border-radius: 5px;
  padding: 6px 10px; font-size: 12px;
}

/* inert interactive controls (need a live kernel) */
.wb-inert { position: relative; opacity: .55; }
.wb-inert-badge {
  display: inline-block; margin-left: 6px; padding: 1px 6px;
  font-size: 10px; border-radius: 8px;
  background: #eef1f4; color: var(--wb-muted); border: 1px solid var(--wb-border);
  user-select: none; vertical-align: middle;
}

/* copy-LaTeX affordance on math outputs — the point of being in Overleaf */
.wb-math-host { position: relative; }
.wb-copy-tex {
  position: absolute; top: 2px; right: 2px;
  font: 500 10px/1 var(--vscode-font-family);
  padding: 3px 7px; border-radius: 4px; cursor: pointer;
  border: 1px solid var(--wb-border); background: #fff; color: var(--wb-muted);
  opacity: 0; transition: opacity .12s ease;
}
.wb-math-host:hover .wb-copy-tex { opacity: 1; }
.wb-copy-tex:hover { background: var(--wb-code-bg); color: var(--vscode-foreground); }
.wb-copy-tex.done { color: #2da44e; border-color: #2da44e; opacity: 1; }

/* Editing — CodeMirror mounts inside the input row, replacing the <pre>. */
.wb-editable { cursor: text; }
.wb-editor { flex: 1 1 auto; min-width: 0; }
.wb-editor .cm-editor { max-height: 60vh; }
.wb-edited-badge {
  flex: 0 0 auto; align-self: flex-start;
  margin-left: 6px; padding: 1px 7px;
  font-size: 10px; border-radius: 8px;
  background: #fff8c5; color: #9a6700; border: 1px solid #d4a72c;
  user-select: none;
}

/* The insertion strip between cells.
   The strip always occupies its height and the pill is absolutely positioned
   inside it, so revealing the controls on hover never shifts the notebook —
   cells moving under the pointer is exactly what makes such affordances
   frustrating. */
.wb-gap {
  position: relative;
  height: 16px;
  margin: -6px 0;              /* fold into the cell spacing when idle */
  z-index: 4;                  /* above cell chrome, which overhangs upward */
}
.wb-gap-pill {
  position: absolute;
  top: 50%; left: 50%;
  transform: translate(-50%, -50%);
  display: flex; gap: 4px;
  padding: 2px;
  border: 1px solid var(--wb-border);
  border-radius: 999px;
  background: #fff;
  box-shadow: 0 1px 3px rgba(0,0,0,.08);
  opacity: 0;
  transition: opacity .1s ease;
  pointer-events: none;        /* invisible controls must not swallow clicks */
}
.wb-gap:hover .wb-gap-pill,
.wb-gap:focus-within .wb-gap-pill { opacity: 1; pointer-events: auto; }
/* The hairline VS Code draws across the gap on hover. */
.wb-gap:hover::before {
  content: '';
  position: absolute; left: 0; right: 0; top: 50%;
  border-top: 1px dashed var(--wb-border);
}
.wb-gap-btn {
  font: 500 10.5px/1 var(--vscode-font-family);
  border: none; background: none; color: var(--wb-muted);
  border-radius: 999px; padding: 4px 10px; cursor: pointer; white-space: nowrap;
}
.wb-gap-btn:hover { background: var(--wb-code-bg); color: var(--vscode-foreground); }

/* Per-cell structural controls, revealed on hover so they never compete with
   the notebook's own content. */
.wb-cell { position: relative; }
.wb-cell-controls {
  position: absolute; top: -10px; right: 6px;
  display: flex; gap: 4px;
  opacity: 0; transition: opacity .12s ease;
  background: #fff; padding: 2px; border-radius: 6px;
  border: 1px solid var(--wb-border);
  /* The bar overhangs the top of its cell, so it lands underneath the PREVIOUS
     cell's box — later siblings paint over earlier ones. Raising it (and the
     hovered cell with it) is what keeps it clickable. */
  z-index: 3;
}
.wb-cell:hover { z-index: 2; }
.wb-cell:hover .wb-cell-controls, .wb-cell-controls:focus-within { opacity: 1; }
.wb-cell-controls button {
  font: 500 10px/1 var(--vscode-font-family);
  border: none; background: none; color: var(--wb-muted);
  border-radius: 4px; padding: 3px 6px; cursor: pointer;
}
.wb-cell-controls button:hover { background: var(--wb-code-bg); color: var(--vscode-foreground); }
.wb-cell-controls button:last-child:hover { background: #fff5f5; color: #cf222e; }

/* Markup cells are editable too — double-click, since a single click must stay
   available for links inside the prose. */
.wb-editable-md { cursor: default; }
.wb-editor-md { margin: 4px 0; }
.wb-cell-edited::before {
  content: 'edited';
  position: absolute; top: -9px; left: 6px;
  font-size: 9px; padding: 1px 6px; border-radius: 8px;
  background: #fff8c5; color: #9a6700; border: 1px solid #d4a72c;
}

/* A stored output that no longer matches its code: hidden, but recoverable —
   it is still what the Overleaf file contains, so it is never destroyed here. */
.wb-output-superseded { display: none; }
.wb-superseded-note {
  margin: 4px 0 0 14px;
  font-size: 10px;
  color: var(--wb-muted);
  cursor: pointer;
  user-select: none;
  border-left: 3px solid var(--wb-border);
  padding: 2px 8px;
}
.wb-superseded-note:hover { color: var(--vscode-foreground); background: var(--wb-code-bg); }
.wb-superseded-note::before { content: '▸ '; }
.wb-superseded-note.wb-superseded-shown::before { content: '▾ '; }

/* Output folding and cell status */
.wb-live { position: relative; }
.wb-live-fold {
  position: absolute; top: 4px; right: 6px;
  font: 10px/1 var(--vscode-font-family);
  border: none; background: none; color: var(--wb-muted);
  cursor: pointer; padding: 2px 5px; border-radius: 4px;
}
.wb-live-fold:hover { background: rgba(0,0,0,.05); }
.wb-live-folded > *:not(.wb-live-label):not(.wb-live-fold) { display: none; }
.wb-live-folded .wb-live-label::after { content: ' — collapsed'; opacity: .7; }
.wb-live-print {
  margin: 2px 0 0; font-family: var(--vscode-editor-font-family);
  font-size: 12px; white-space: pre-wrap; color: #57606a;
}
.wb-live-message {
  margin: 2px 0 0; font-family: var(--vscode-editor-font-family);
  font-size: 12px; white-space: pre-wrap; color: #9a6700;
}
.wb-cell-failed .wb-input { border-left-color: #cf222e; }

.wb-cell-controls button.wb-danger:hover { background: #fff5f5; color: #cf222e; }

/* Token bar — shown inside the panel, only when an evaluation needs it. */
.wb-token-bar {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  padding: 7px 12px;
  border-bottom: 1px solid var(--wb-border);
  background: #fffbe6;
  font-size: 12px;
}
.wb-token-msg { font-weight: 500; }
.wb-token-input {
  font: inherit; font-size: 12px;
  border: 1px solid var(--wb-border); border-radius: 5px;
  padding: 4px 8px; min-width: 230px;
}
.wb-token-bar button {
  font: inherit; font-size: 12px;
  border: 1px solid var(--wb-border); background: #fff; color: inherit;
  border-radius: 5px; padding: 4px 10px; cursor: pointer;
}
.wb-token-bar button[data-act="token-ok"] {
  background: var(--wb-accent); border-color: var(--wb-accent); color: #fff;
}
.wb-token-hint { color: var(--wb-muted); }
.wb-token-hint code {
  font-family: var(--vscode-editor-font-family);
  background: var(--wb-code-bg); padding: 1px 5px; border-radius: 4px;
}

/* ── live evaluation on the reader's own kernel ──────────────────────────── */

.wb-input { position: relative; }
button.wb-run {
  flex: 0 0 auto;
  align-self: flex-start;
  font: 11px/1 var(--vscode-font-family);
  border: 1px solid var(--wb-border);
  background: #fff;
  color: var(--wb-accent);
  border-radius: 5px;
  padding: 4px 8px;
  cursor: pointer;
  opacity: 0;
  transition: opacity .12s ease;
}
.wb-cell-code:hover button.wb-run, button.wb-run:focus, button.wb-run.wb-run-busy { opacity: 1; }
button.wb-run:hover { background: var(--wb-accent); border-color: var(--wb-accent); color: #fff; }
button.wb-run:disabled { cursor: default; }
button.wb-run.wb-run-busy { color: var(--wb-muted); }

/* A fresh result is visually distinct from the notebook's stored output: the
   stored one is what the project contains, this one is what the reader's kernel
   just said. The label states which is which. */
.wb-live {
  margin: 6px 0 0 14px;
  border-left: 3px solid var(--wb-accent);
  background: #f2f8f4;
  border-radius: 0 5px 5px 0;
  padding: 6px 11px;
}
.wb-live-running { border-left-color: #9aa0a6; background: #f6f7f8; }
.wb-live-error { border-left-color: #cf222e; background: #fff8f8; }
.wb-live-label {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: .04em;
  color: var(--wb-muted);
  user-select: none;
}
.wb-live-error .wb-live-label { color: #cf222e; }
.wb-live-running .wb-live-label::after {
  content: ''; display: inline-block; width: 6px;
  animation: wb-dots 1.2s steps(4, end) infinite;
}
@keyframes wb-dots { 0% { content: ''; } 25% { content: '.'; } 50% { content: '..'; } 75% { content: '...'; } }
.wb-live-text {
  margin: 3px 0 0;
  font-family: var(--vscode-editor-font-family);
  font-size: 12.5px;
  white-space: pre-wrap;
  word-break: break-word;
}
.wb-live-math { margin: 2px 0; overflow-x: auto; }

/* markdown math fallback when KaTeX JS is unavailable */
.wb-math code { background: #f2f0e8; }
.wb-math-display { display: block; text-align: center; margin: 8px 0; }
`;

/**
 * Chrome ignores `@font-face` declared inside a shadow root — the rules must be
 * registered in the document. Everything else must live INSIDE the shadow root
 * or it will not style the shadow content (and WL_CSS carries bare `pre` and
 * `:root` selectors that would otherwise leak out and restyle Overleaf itself).
 *
 * So: split the font faces off, put those in the page head, keep the rest scoped.
 * @font-face bodies contain no nested braces, so a flat match is sufficient.
 */
export function splitFontFaces(css) {
  const fontFaces = [];
  const rest = css.replace(/@font-face\s*\{[^}]*\}/g, (m) => { fontFaces.push(m); return ''; });
  return { fontFaces: fontFaces.join('\n'), rest };
}

/**
 * Syntax-highlight colours, and a few things that must beat WL_CSS.
 *
 * MUST BE CONCATENATED AFTER WL_CSS. WL_CSS defines .wl-hl-* in VS Code Dark+
 * colours — pale orange strings, pale green comments — which are chosen for a
 * dark editor and are close to unreadable on the white page Overleaf gives us.
 * Same class names, same specificity, so order alone decides the winner.
 */
export const HIGHLIGHT_CSS = `
/* GitHub-light-ish palette, for contrast on white.
   The distinction that matters is .wl-hl-sym (a Wolfram builtin) vs .wl-hl-usr
   (a symbol this notebook defined): it is what makes the code readable at a
   glance, and what the old capitalisation heuristic could not express. */
.wl-hl-str  { color: #0a3069; }
.wl-hl-cmt  { color: #6e7781; font-style: italic; }
.wl-hl-num  { color: #0550ae; }
.wl-hl-sym  { color: #8250df; }                 /* builtin, e.g. Table */
.wl-hl-usr  { color: #1f2328; }                 /* the notebook's own symbols */
.wl-hl-ctx  { color: #6639ba; opacity: .8; }    /* context prefix, e.g. BSolver2D backtick */
.wl-hl-pat  { color: #116329; font-style: italic; }  /* x_, _Head, x__ */
.wl-hl-slot { color: #116329; font-weight: 600; }    /* #, #1, ## */
.wl-hl-op   { color: #cf222e; }                 /* -> := /. @@ … */
.wl-hl-esc  { color: #0550ae; font-weight: 600; }    /* \\[Alpha] */
.wl-hl-cmd  { color: #0550ae; }
.wl-hl-math { color: #cf222e; }
.wl-hl-brk  { color: #57606a; }

/* WL_CSS styles this for a dark VS Code panel; ours sits on a light page. */
pre.vscode-wolfram-text-output, pre.vscode-wolfram-tex-source {
  background: var(--wb-code-bg);
  color: var(--vscode-foreground);
  border: 1px solid var(--wb-border);
  padding: 8px 11px;
}
.wl-line-gutter { display: none; }

/* Markdown tables */
table.wb-md-table {
  border-collapse: collapse;
  margin: 10px 0;
  font-size: 13.5px;
  display: block;
  overflow-x: auto;
  max-width: 100%;
}
table.wb-md-table :is(th, td) {
  border: 1px solid var(--wb-border);
  padding: 5px 10px;
  text-align: left;
}
table.wb-md-table th { background: var(--wb-code-bg); font-weight: 600; }
table.wb-md-table tbody tr:nth-child(even) { background: #fafbfc; }
`;

/**
 * Rewrite `:root` to `:host` for stylesheets injected into a shadow root.
 *
 * `:root` matches the DOCUMENT element and never matches inside a shadow tree,
 * so a `:root { --var: … }` block injected there defines nothing. WL_CSS opens
 * with exactly such a block (--fraction-line-width / --script-font-size /
 * --line-height), which the wfrac / wsup / wsub rules then consume — so without
 * this rewrite, fractions and scripts in wolfbook's own box markup silently
 * lose their metrics. Caught by checks/check-browser.mjs, which asserts the
 * variable is readable inside the shadow root and absent outside it.
 */
export function scopeRootToHost(css) {
  return String(css).replace(/(^|[\s,{}])(:root\b)/g, (_, pre) => `${pre}:host`);
}
