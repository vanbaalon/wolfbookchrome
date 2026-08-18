#!/usr/bin/env node
// Browser check for the viewer — the one that actually proves it works.
//
//   node checks/check-browser.mjs [--screenshot]
//
// WHY: `node --check` parses an ES module happily and still misses duplicate
// lexical declarations, which once silently killed the entire 3D viewer in this
// repo. It also cannot see CSS at all — and this viewer's two riskiest claims
// are CSS claims: that KaTeX styles reach inside a shadow root, and that
// WL_CSS's bare `pre`/`:root` selectors do NOT leak out onto Overleaf. Both are
// measured here, in a real browser, over real HTTP, against the real fixture.
//
// Serves a temp dir on an ephemeral port and runs headless Chrome against it.
// The page POSTs its results back to the server rather than relying on
// --dump-dom: a module script using top-level await does not delay the DOM
// dump, so --dump-dom reliably captured "PENDING" instead of the results.

import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const wantShot = process.argv.includes('--screenshot');

const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
if (!fs.existsSync(CHROME)) {
  console.log(`SKIP — Chrome not found at ${CHROME} (set CHROME=...)`);
  process.exit(0);
}
if (!fs.existsSync(path.join(root, 'fixtures', 'sample.wb'))) {
  console.error('missing fixtures/sample.wb — run: node fixtures/make-fixture.mjs');
  process.exit(1);
}

const TYPES = {
  '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json',
  '.html': 'text/html', '.css': 'text/css', '.wb': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.zip': 'application/zip',
};

const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>wolfbook viewer check</title></head>
<body style="margin:0;font:14px system-ui">
  <!-- An outer element that WL_CSS would restyle if the shadow root leaked. -->
  <pre id="outer-pre">outer page content</pre>
  <div id="host" style="height:900px"></div>
  <pre id="result">PENDING</pre>
<script type="module">
const out = [];
const say = (label, cond, extra) => out.push((cond ? 'ok   ' : 'FAIL ') + label + (extra ? '  — ' + extra : ''));
window.__wbPwned = false;

try {
  const viewer = await import('/viewer/wb-viewer.js');
  const { KATEX_CSS } = await import('/vendor/katex-css.js');
  const { WL_CSS } = await import('/vendor/renderer-css.js');
  say('modules load in a real browser', true);

  const wb = await (await fetch('/fixtures/sample.wb')).json();
  say('fixture parses', Array.isArray(wb.cells) && wb.cells.length > 5, wb.cells.length + ' cells');

  // Serve fixture images the way the zip resolver would: map the one asset the
  // fixture references to a real URL, and leave the "absent" one unresolved.
  const assetMap = ${JSON.stringify('__ASSETS__')};
  const resolveAsset = (rel) => (assetMap[rel] ? assetMap[rel] : null);

  const host = document.getElementById('host');
  const shadow = viewer.createViewerSurface(host, { katexCss: KATEX_CSS, wlCss: WL_CSS });
  const nb = document.createElement('div');
  nb.className = 'wb-notebook';
  shadow.appendChild(nb);
  const stats = viewer.renderNotebook(wb, nb, { resolveAsset });
  say('renderNotebook returns stats', stats.cells > 0 && stats.outputs > 0,
      stats.cells + ' cells / ' + stats.outputs + ' outputs');

  // ── isolation ──────────────────────────────────────────────────────────
  // WL_CSS declares :root{--fraction-line-width:…}. If the shadow root leaked,
  // the document root would inherit it.
  const leaked = getComputedStyle(document.documentElement)
      .getPropertyValue('--fraction-line-width').trim();
  say('WL_CSS does not leak onto the host page', leaked === '', leaked ? 'leaked: ' + leaked : 'clean');

  // …and it MUST apply inside.
  const inner = getComputedStyle(shadow.querySelector('.wb-notebook'))
      .getPropertyValue('--fraction-line-width').trim();
  say('WL_CSS applies inside the shadow root', inner !== '', inner || 'MISSING');

  // ── KaTeX ──────────────────────────────────────────────────────────────
  const katex = shadow.querySelector('.katex');
  say('fixture contains rendered KaTeX', !!katex);
  if (katex) {
    const mord = katex.querySelector('.mord');
    const ff = mord ? getComputedStyle(mord).fontFamily : '';
    say('KaTeX font-family applied inside shadow root', /KaTeX/i.test(ff), ff.slice(0, 40));
    const r = katex.getBoundingClientRect();
    say('KaTeX math has real layout size', r.width > 10 && r.height > 5,
        Math.round(r.width) + 'x' + Math.round(r.height));
  }
  const fontStyle = document.getElementById('wolfbook-katex-fonts');
  say('@font-face moved to document head', !!fontStyle && fontStyle.textContent.includes('@font-face'));
  await document.fonts.ready;
  say('KaTeX_Main font is registered', document.fonts.check('16px KaTeX_Main'));

  // ── markdown cells ─────────────────────────────────────────────────────
  // The stored outputs arrive pre-typeset, but a markup cell's $…$ is raw
  // source and must be run through KaTeX. The first screenshot showed it
  // sitting there as literal LaTeX, which is what these two checks now pin.
  const mdCell = shadow.querySelector('.wb-cell-md');
  const inlineMath = shadow.querySelector('.wb-cell-md .wb-math:not(.wb-math-display)');
  say('markdown inline math typeset',
      !!(inlineMath && inlineMath.querySelector('.katex')),
      inlineMath ? inlineMath.className : 'no .wb-math found');
  const dispMath = shadow.querySelector('.wb-cell-md .wb-math-display');
  say('markdown display math typeset',
      !!(dispMath && dispMath.querySelector('.katex')));
  if (dispMath) {
    const r = dispMath.getBoundingClientRect();
    say('display math has real layout size', r.width > 20 && r.height > 10,
        Math.round(r.width) + 'x' + Math.round(r.height));
  }
  say('raw HTML in a markdown cell renders as an element',
      !!(mdCell && shadow.querySelector('.wb-cell-md sub')));

  // ── deferred LaTeX outputs ─────────────────────────────────────────────
  // A LaTeX-formatted result arrives as an EMPTY div carrying base64 LaTeX,
  // which whoever renders it must typeset. Nothing here did, so such outputs
  // were invisible AND dropped as empty — a Series looked like a cell that had
  // produced nothing.
  //
  // The payload is a real one from wolfbook-serve, ALREADY BROKEN BY BTL at
  // 21em: an aligned environment with each continuation on its leading
  // operator. The browser's job is to typeset those breaks, not to invent its
  // own — KaTeX splits only at top-level operators and would part a matrix row
  // from itself.
  const dl = await (await fetch('/fixtures/deferred-latex.json')).json();
  const narrow = document.createElement('div');
  narrow.style.width = '420px';                 // force the wrapping question
  narrow.className = 'wb-notebook';
  shadow.appendChild(narrow);
  const texStats = viewer.renderNotebook({ cells: [{
    kind: 2, value: 'Series[Sin[x], {x, 0, 60}]', languageId: 'wolfram',
    outputs: [{ items: [{ mime: 'x-application/wolfram-language-html', data: dl.html }] }],
  }] }, narrow, {});
  say('a deferred-LaTeX output is not dropped as empty', texStats.outputs === 1,
      texStats.outputs + ' output(s)');
  const texEl = narrow.querySelector('.wb-tex-out');
  say('it is typeset with KaTeX', !!(texEl && texEl.querySelector('.katex')),
      texEl ? (texEl.getAttribute('data-wb-typeset') || '?') : 'no .wb-tex-out');
  if (texEl) {
    const box = texEl.getBoundingClientRect();
    // BTL's breaks must survive as REAL rows. KaTeX renders an aligned
    // environment as vlist rows, so a 43-break result is many lines tall.
    say('BTL line breaks are rendered as separate lines', box.height > 200,
        Math.round(box.width) + 'x' + Math.round(box.height)
          + ' for ' + dl.breaks + ' breaks');
    say('the alignment environment survived', !!texEl.querySelector('.katex .vlist'),
        texEl.querySelector('.katex-display') ? 'display mode' : 'inline');
    // An atom too wide to break must scroll, not be clipped away.
    say('an unbreakable atom can still be reached',
        getComputedStyle(texEl).overflowX === 'auto',
        'overflow-x: ' + getComputedStyle(texEl).overflowX);
    say('the copy-LaTeX button survives typesetting', !!texEl.querySelector('.wb-copy-tex'));
    // The copied source must be BTL's broken LaTeX, so pasting into Overleaf
    // gives the same layout that is on screen.
    const tex = texEl.querySelector('.wb-copy-tex').getAttribute('data-tex') || '';
    say('copy LaTeX hands over the broken source', tex.indexOf('begin{aligned}') >= 0,
        tex.slice(0, 26).trim());
  }

  // ── syntax highlighting ────────────────────────────────────────────────
  const codePre = shadow.querySelector('.wb-input pre');
  const tokens = shadow.querySelectorAll('.wb-input [class^="wl-hl-"]');
  say('code cells are syntax highlighted', tokens.length > 0, tokens.length + ' token(s)');
  say('highlighting preserves the code text',
      !!(codePre && codePre.textContent.trim().length > 0));
  const sym = shadow.querySelector('.wb-input .wl-hl-sym');
  if (sym) {
    const colour = getComputedStyle(sym).color;
    // WL_CSS's dark-theme #4ec9b0 would be rgb(78, 201, 176); HIGHLIGHT_CSS must win.
    say('light-theme highlight colours override WL_CSS', colour !== 'rgb(78, 201, 176)', colour);
  }
  const cmt = shadow.querySelector('.wb-cell-md pre.wb-md-code [class^="wl-hl-"]');
  say('fenced markdown code is highlighted too', !!cmt);

  // ── sanitiser ──────────────────────────────────────────────────────────
  say('no script executed from output HTML', window.__wbPwned === false);
  say('no <script> survives in the DOM', shadow.querySelectorAll('script').length === 0);
  say('no <iframe> survives', shadow.querySelectorAll('iframe').length === 0);
  const jsLinks = [...shadow.querySelectorAll('a[href]')]
      .filter(a => /^\\s*javascript:/i.test(a.getAttribute('href') || ''));
  say('javascript: hrefs stripped', jsLinks.length === 0);
  const handlers = [...shadow.querySelectorAll('*')]
      .filter(el => [...el.attributes].some(a => a.name.toLowerCase().startsWith('on')));
  say('on* handlers stripped', handlers.length === 0, handlers.length + ' left');
  say('safe content preserved', !!shadow.querySelector('.ok-content'));

  // ── output fidelity ────────────────────────────────────────────────────
  say('inline <svg> preserved', shadow.querySelectorAll('svg').length > 0);
  const imgs = [...shadow.querySelectorAll('img')];
  say('resolved image kept its src', imgs.some(i => /^(https?:|blob:|\\/)/.test(i.getAttribute('src') || '')));
  say('missing asset shows a placeholder', !!shadow.querySelector('.wb-missing-asset'));
  const controls = [...shadow.querySelectorAll('input, button:not(.wb-copy-tex)')];
  say('interactive controls disabled', controls.every(c => c.hasAttribute('disabled')),
      controls.length + ' control(s)');
  say('format-switch buttons removed', shadow.querySelectorAll('button[data-fmt-key]').length === 0);
  const copy = shadow.querySelector('.wb-copy-tex');
  say('copy-LaTeX button present', !!copy);
  if (copy) {
    const tex = copy.getAttribute('data-tex') || '';
    say('copy-LaTeX carries decoded LaTeX', tex.length > 0 && !/^[A-Za-z0-9+/=]+$/.test(tex),
        JSON.stringify(tex.slice(0, 30)));
  }
  const inLabel = shadow.querySelector('.wb-in-label');
  say('In[N] label taken from stored Out[N]', /^In\\[\\d+\\]:=$/.test(inLabel ? inLabel.textContent : ''),
      inLabel && inLabel.textContent);
  say('error output rendered', !!shadow.querySelector('.wb-output-error'));

  // ── the host page is untouched ─────────────────────────────────────────
  const outerPre = getComputedStyle(document.getElementById('outer-pre'));
  say('host page <pre> not restyled', !/Consolas/i.test(outerPre.fontFamily), outerPre.fontFamily.slice(0, 30));
} catch (e) {
  say('UNCAUGHT: ' + (e && e.message), false);
  console.error(e);
}
document.getElementById('result').textContent = out.join('\\n');
// Hand the results back to the harness explicitly — see the note at the top.
try { await fetch('/__result', { method: 'POST', body: out.join('\\n') }); } catch (_) {}
</script></body></html>`;

// ── serve ────────────────────────────────────────────────────────────────────
let onResult = () => {};
const server = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  if (req.method === 'POST' && url === '/__result') {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => { res.writeHead(204); res.end(); onResult(body); });
    return;
  }
  if (url === '/preview') {
    // The viewer rendering the fixture full-bleed, with no test chrome — used
    // for the screenshot, and handy to open by hand while developing.
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<!doctype html><html><head><meta charset="utf-8"><title>wolfbook preview</title></head>
<body style="margin:0"><div id="host" style="height:2200px"></div>
<script type="module">
const viewer = await import('/viewer/wb-viewer.js');
const { KATEX_CSS } = await import('/vendor/katex-css.js');
const { WL_CSS } = await import('/vendor/renderer-css.js');
const wb = await (await fetch('/fixtures/sample.wb')).json();
const shadow = viewer.createViewerSurface(document.getElementById('host'),
    { katexCss: KATEX_CSS, wlCss: WL_CSS });
const root = document.createElement('div');
root.className = 'wb-root';
root.innerHTML = '<div class="wb-toolbar"><span class="wb-title">sample.wb</span>'
  + '<button class="active">Notebook</button><button>Source</button>'
  + '<span class="wb-spacer"></span><span class="wb-note"></span>'
  + '<button>Open in Wolfbook</button><span class="wb-dot online">●</span></div>'
  + '<div class="wb-body"><div class="wb-notebook"></div></div>';
shadow.appendChild(root);
const stats = viewer.renderNotebook(wb, root.querySelector('.wb-notebook'), {
  resolveAsset: (rel) => '/fixtures/' + rel,
  // Enough of a structure hook for the between-cell strips to render, so the
  // screenshot shows the real chrome rather than a stripped-down view.
  structure: { insertAt: () => {} },
});
// Reveal one strip and one cell toolbar for the screenshot, since both are
// hover-only and a headless capture never hovers.
for (const g of root.querySelectorAll('.wb-gap-pill')) g.style.opacity = '1';
for (const c of root.querySelectorAll('.wb-cell-controls')) c.style.opacity = '1';
root.querySelector('.wb-note').textContent =
  stats.cells + ' cells \\u00b7 ' + stats.outputs + ' outputs';
</script></body></html>`);
    return;
  }
  if (url === '/' || url === '/index.html') {
    // Point the fixture's one real asset at a URL the page can actually load.
    const wb = JSON.parse(fs.readFileSync(path.join(root, 'fixtures', 'sample.wb'), 'utf8'));
    const refs = new Set();
    for (const c of wb.cells || []) {
      for (const o of c.outputs || []) {
        for (const it of o.items || []) {
          if (typeof it.data === 'string') {
            for (const m of it.data.matchAll(/src="(img\/[^"]+)"/g)) refs.add(m[1]);
          }
        }
      }
    }
    const assets = {};
    for (const rel of refs) {
      // Only advertise assets that exist under fixtures/.
      if (fs.existsSync(path.join(root, 'fixtures', rel))) assets[rel] = '/fixtures/' + rel;
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(PAGE.replace('"__ASSETS__"', JSON.stringify(assets)));
    return;
  }
  const file = path.join(root, url);
  if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); res.end('not found'); return;
  }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});

await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/`;

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wbchrome-'));
const args = [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
  '--disable-dev-shm-usage', `--user-data-dir=${profile}`,
];

let failures = 0;
try {
  const chrome = spawn(CHROME, [...args, base], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  chrome.stderr.on('data', (d) => { stderr += d; });

  const results = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 60_000);
    onResult = (body) => { clearTimeout(timer); resolve(body); };
    chrome.on('error', () => { clearTimeout(timer); resolve(null); });
  });
  chrome.kill('SIGKILL');

  if (results == null) {
    console.error('the page never reported results within 60s.');
    if (stderr.trim()) console.error(stderr.split('\n').slice(-15).join('\n'));
    process.exit(1);
  }
  console.log(results);
  failures = (results.match(/^FAIL/gm) || []).length;

  if (wantShot) {
    // Shoot the clean preview page, not the assertion scaffold. Chrome will
    // not fire `load` here either (top-level await), so cap it with a virtual
    // time budget and kill it regardless.
    const shot = path.join(root, 'fixtures', 'viewer.png');
    fs.rmSync(shot, { force: true });
    await new Promise((resolve) => {
      const p = spawn(CHROME, [...args, '--window-size=1240,2200',
        '--virtual-time-budget=10000', '--hide-scrollbars',
        `--screenshot=${shot}`, base + 'preview'], { stdio: 'ignore' });
      const timer = setTimeout(() => { p.kill('SIGKILL'); resolve(); }, 45_000);
      p.on('error', () => { clearTimeout(timer); resolve(); });
      p.on('close', () => { clearTimeout(timer); resolve(); });
    });
    console.log(fs.existsSync(shot)
      ? `\nscreenshot → ${path.relative(process.cwd(), shot)} (${(fs.statSync(shot).size / 1024).toFixed(0)} KB)`
      : '\nscreenshot FAILED (no file written)');
  }
} finally {
  server.close();
  // Chrome may still be flushing its profile as it dies, so a plain rmSync
  // races and throws ENOTEMPTY. Retry briefly, and never fail the run over
  // a temp directory.
  fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall browser checks passed');
process.exit(failures ? 1 : 0);
