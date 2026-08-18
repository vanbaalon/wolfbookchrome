// make-fixture.mjs — assembles fixtures/sample.wb from REAL notebook outputs
// found in this workspace, rather than hand-authored markup.
//
// The whole point of the viewer is fidelity to what the wolfbook renderer
// actually emits; a fixture I invented would test my assumptions instead of
// the format. So this harvests one real example of each output shape:
//   pre-rendered KaTeX · inline SVG · <img> graphic · error · Manipulate
//   controls · <details> · plain text
// and writes a zip alongside it, mimicking an Overleaf project download.
//
//   node fixtures/make-fixture.mjs
//
// Re-run after regenerating notebooks; the output is committed so the checks
// run on any machine.

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Where to harvest from — and, more importantly, when NOT to.
 *
 * This walks a directory tree looking for .wb files. Run from a clone that is
 * not inside the wolfbook workspace, the old path arithmetic resolved to `/`
 * and it walked the whole filesystem: slow, and it would rifle through a
 * stranger's documents looking for notebooks. So harvest only when the
 * resolved root really is the workspace, identified by a marker directory, and
 * fall back to the synthetic samples otherwise.
 */
function findWorkspace() {
  let dir = here;
  for (let i = 0; i < 6; i++) {
    dir = path.dirname(dir);
    if (fs.existsSync(path.join(dir, 'Extension Development', 'resources', 'init.wl'))) return dir;
  }
  return null;
}
const WORKSPACE = findWorkspace();
const MIME_HTML = 'x-application/wolfram-language-html';
const MIME_ERR = 'application/vnd.code.notebook.error';

function* walk(dir, depth = 0) {
  if (depth > 4) return;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name.startsWith('.') || e.name === 'node_modules') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p, depth + 1);
    else if (e.name.endsWith('.wb')) yield p;
  }
}

// What we are hunting for, and how to recognise it in a stored output.
const WANTED = {
  katex: (h) => h.includes('data-latex-b64') && h.includes('katex'),
  svg: (h) => h.includes('<svg') && !h.includes('<img'),
  image: (h) => /<img[^>]+src="img\//.test(h),
  manipulate: (h) => h.includes('wl-manip-slider'),
  details: (h) => h.includes('<details'),
};

const found = {};
let errorItem = null;
const assets = new Map(); // zip path → source path on disk

for (const file of (WORKSPACE ? walk(WORKSPACE) : [])) {
  if (Object.keys(found).length === Object.keys(WANTED).length && errorItem) break;
  let nb;
  try { nb = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { continue; }
  if (!Array.isArray(nb.cells)) continue;

  for (const cell of nb.cells) {
    if (cell.kind !== 2) continue;
    for (const out of cell.outputs || []) {
      const html = (out.items || []).find((i) => i.mime === MIME_HTML);
      const err = (out.items || []).find((i) => i.mime === MIME_ERR);
      const text = (out.items || []).find((i) => i.mime === 'text/plain');
      if (err && !errorItem) errorItem = { code: cell.value, items: out.items };
      if (!html) continue;

      for (const [key, test] of Object.entries(WANTED)) {
        if (found[key] || !test(html.data)) continue;

        // For image outputs, collect the referenced files so the fixture zip
        // can actually contain them.
        if (key === 'image') {
          const srcs = [...html.data.matchAll(/src="(img\/[^"]+)"/g)].map((m) => m[1]);
          const nbDir = path.dirname(file);
          const ok = srcs.every((s) => fs.existsSync(path.join(nbDir, s)));
          if (!ok || !srcs.length) continue;
          for (const s of srcs) assets.set(s, path.join(nbDir, s));
        }

        found[key] = {
          code: cell.value,
          items: [html, text].filter(Boolean),
          from: path.relative(WORKSPACE, file),
        };
      }
    }
  }
}

// SYNTHETIC FALLBACKS.
//
// Harvesting real outputs is what makes this fixture worth having: it exercises
// the markup the renderer genuinely emits. But the notebooks it harvests from
// are the author's own research, so they are NOT committed, and a fresh clone
// has nothing to harvest. Rather than leave a contributor with a broken suite,
// each category falls back to a small hand-written sample of the same shape.
// Run this inside the wolfbook workspace to get the real thing.
const SYNTHETIC = {
  katex: {
    code: 'N[Pi, 20]',
    html: '<div class="wl-output-block"><div class="wl-output-header" data-out-n="1">'
        + '<span>Out[1]= </span></div><div class="wl-output-content">'
        + '<div class="vscode-wolfram-wllatex-prerendered" data-page-width-em="43" '
        + 'data-latex-b64="My4xNDE1OTI2NTM1ODk3OTMyMzg0Ng==">'
        + '<span class="katex"><span class="katex-html" aria-hidden="true"><span class="base">'
        + '<span class="mord">3.1415926535897932384</span></span></span></span></div></div></div>',
  },
  svg: {
    code: 'Graphics[Disk[]]',
    html: '<div class="wl-output-block"><div class="wl-output-content">'
        + '<svg width="60" height="60" viewBox="0 0 60 60"><circle cx="30" cy="30" r="26" '
        + 'fill="#5b9bd5"/></svg></div></div>',
  },
  image: null,           // needs a real file; skipped when nothing was harvested
  manipulate: {
    code: 'Manipulate[x^n, {n, 1, 5, 1}]',
    html: '<div class="wl-output-block"><div class="wl-output-content"><div class="wl-manip">'
        + '<div class="wl-manip-controls"><span class="wl-manip-label">n</span>'
        + '<input type="range" class="wl-manip-slider" min="1" max="5" step="1" value="1"/>'
        + '</div><div class="wl-manip-result">x</div></div></div></div>',
  },
  details: {
    code: 'Information[Sin]',
    html: '<div class="wl-output-block"><div class="wl-output-content">'
        + '<details><summary>Sin</summary><div>the sine function</div></details></div></div>',
  },
};

const missing = Object.keys(WANTED).filter((k) => !found[k]);
for (const key of missing) {
  const stub = SYNTHETIC[key];
  if (!stub) continue;
  found[key] = {
    code: stub.code,
    items: [{ mime: MIME_HTML, data: stub.html },
            { mime: 'text/plain', data: '(* synthetic fixture *)' }],
    from: 'synthetic (nothing to harvest here)',
  };
}
if (missing.length) {
  const still = Object.keys(WANTED).filter((k) => !found[k]);
  console.warn('note: synthesised', missing.filter((k) => found[k]).join(', ') || '(none)',
               still.length ? `| still missing: ${still.join(', ')}` : '');
}

// An error output, synthesised when none was harvested.
if (!errorItem) {
  errorItem = {
    code: '1/0',
    items: [{ mime: MIME_ERR, data: JSON.stringify(
      { name: 'WolframKernelMessage', message: 'Power::infy: Infinite expression 1/0 encountered.', stack: '' }) }],
  };
}

const cells = [
  {
    kind: 1,
    value: '# Wolfbook viewer fixture\n\n'
      + 'Assembled by `make-fixture.mjs` from **real** notebook outputs in this workspace, '
      + 'so the checks exercise the markup the renderer genuinely emits.\n\n'
      + 'Inline math $E = mc^2$ and display math:\n\n$$\\int_0^\\infty e^{-x^2}\\,dx = \\frac{\\sqrt{\\pi}}{2}$$\n\n'
      + '- a list item with `inline code`\n  - a nested one\n- another one\n\n'
      + '```wolfram\nIntegrate[Sin[x]^2, {x, 0, Pi}]\n```\n\n'
      + 'A tilde fence, as used by notebooks in this workspace:\n\n'
      + '~~~wolfram\nbr[q[A][i][down], u^(beta - 1), q[CC][j][up], muDown, closeUp, alpha]\n~~~\n\n'
      + '| state | twist | h |\n|---|---:|---|\n| A | 7/10 | 13/10 |\n| B | 7/10 | 9/10 |\n\n'
      + 'Raw HTML: x<sub>1</sub>, and ~~struck out~~ text.',
    languageId: 'markdown',
    outputs: [],
    metadata: {},
  },
];

for (const [key, hit] of Object.entries(found)) {
  cells.push({
    kind: 1,
    value: `## ${key} output\n\n<sub>harvested from \`${hit.from}\`</sub>`,
    languageId: 'markdown',
    outputs: [],
    metadata: {},
  });
  cells.push({
    kind: 2,
    value: hit.code || '(* harvested output *)',
    languageId: 'wolfram',
    outputs: [{ items: hit.items, id: `fx-${key}` }],
    metadata: {},
  });
}

if (errorItem) {
  cells.push({ kind: 1, value: '## error output', languageId: 'markdown', outputs: [], metadata: {} });
  cells.push({
    kind: 2, value: errorItem.code || 'Sort[betheSpec]', languageId: 'wolfram',
    outputs: [{ items: errorItem.items, id: 'fx-error' }], metadata: {},
  });
}

// A deliberately missing image, to exercise the "not in this project" path.
cells.push({ kind: 1, value: '## missing asset', languageId: 'markdown', outputs: [], metadata: {} });
cells.push({
  kind: 2,
  value: 'Plot[Tan[x], {x, 0, 3}]',
  languageId: 'wolfram',
  outputs: [{
    items: [{
      mime: MIME_HTML,
      data: '<div class="wl-output-block"><div class="wl-output-header" data-out-n="99">'
          + '<span>Out[99]= </span></div><div class="wl-output-content">'
          + '<img class="vscode-wolfram-svg-output" width="360" height="220" '
          + 'src="img/sample/definitely_absent.svg"/></div></div>',
    }, { mime: 'text/plain', data: '(* output: graphics *)' }],
    id: 'fx-missing',
  }],
  metadata: {},
});

// A hostile output: the viewer must neutralise all of this.
cells.push({ kind: 1, value: '## sanitiser probe', languageId: 'markdown', outputs: [], metadata: {} });
cells.push({
  kind: 2,
  value: '(* untrusted output from a collaborator *)',
  languageId: 'wolfram',
  outputs: [{
    items: [{
      mime: MIME_HTML,
      data: '<div class="wl-output-block"><div class="wl-output-content">'
          + '<script>window.__wbPwned = true;</script>'
          + '<img src="x" onerror="window.__wbPwned = true">'
          + '<a href="javascript:window.__wbPwned=true">link</a>'
          + '<iframe src="https://example.com"></iframe>'
          + '<svg><script>window.__wbPwned = true;</script></svg>'
          + '<span class="ok-content">safe content survives</span>'
          + '</div></div>',
    }],
    id: 'fx-hostile',
  }],
  metadata: {},
});

const outDir = here;
const wbPath = path.join(outDir, 'sample.wb');
fs.writeFileSync(wbPath, JSON.stringify({ cells }, null, 1));

// Also lay the referenced assets down beside the fixture, not only inside the
// zip: check-browser.mjs serves fixtures/ directly and needs a real file to
// resolve, so that "image resolved" and "image missing" are distinct outcomes.
for (const [rel, src] of assets) {
  const dest = path.join(outDir, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

// Build a project zip like Overleaf's download: the notebook at the root, a
// .tex beside it, and the img/ assets it references.
const stage = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'wbfx-'));
fs.copyFileSync(wbPath, path.join(stage, 'sample.wb'));
fs.writeFileSync(path.join(stage, 'main.tex'), '\\documentclass{article}\n\\begin{document}\nHello\n\\end{document}\n');
for (const [rel, src] of assets) {
  const dest = path.join(stage, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}
const zipPath = path.join(outDir, 'sample-project.zip');
fs.rmSync(zipPath, { force: true });
execSync(`zip -qr "${zipPath}" .`, { cwd: stage });
fs.rmSync(stage, { recursive: true, force: true });

console.log(WORKSPACE
  ? `harvested from ${WORKSPACE}`
  : 'no wolfbook workspace found — using synthetic samples only');
console.log(`sample.wb          ${cells.length} cells (${Object.keys(found).join(', ')}${errorItem ? ', error' : ''})`);
console.log(`sample-project.zip ${assets.size} asset(s), ${(fs.statSync(zipPath).size / 1024).toFixed(0)} KB`);
