// Proves the premise of `wolfbook-serve` in one run: a plain Node process can
// drive the FULL wolfbook rendering pipeline using nothing but the assets of an
// INSTALLED (not running) VS Code extension.
//
//   node server/check-installed-extension.mjs
//
// Verified 2026-08-18 against wolfbook 2.9.0, Node 24 (ABI 137), darwin-arm64:
// kernel up in ~3 s, Plot rendered to HTML + .svg + 2D-tooltip .json, integral
// rendered to box expressions. So the server needs no native build, no vendored
// .wl and no VS Code process — only a path to the installed extension.
//
// Two things the host MUST supply, both of which fail SILENTLY if omitted:
//   1. $wolframResourceDir, via Block[] around the Get. Without it every
//      sub-file Get inside init.wl fails and the render API is left undefined —
//      calls then return unevaluated rather than erroring.
//   2. VsCodeSetImgDir[absDir, relPrefix], or nothing is written to disk.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const say = (label, ok, extra) =>
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${extra ? `  — ${extra}` : ''}`);

// ── 1. discover the installed extension, the way the server would ──────────
function findExtension() {
  const roots = [
    path.join(os.homedir(), '.vscode', 'extensions'),
    path.join(os.homedir(), '.vscode-insiders', 'extensions'),
    path.join(os.homedir(), '.vscode-server', 'extensions'),
  ];
  const found = [];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const name of fs.readdirSync(root)) {
      if (!/^wolfbook\.wolfbook-/i.test(name)) continue;
      const dir = path.join(root, name);
      const version = name.replace(/^wolfbook\.wolfbook-/i, '');
      if (fs.existsSync(path.join(dir, 'resources', 'init.wl'))) found.push({ dir, version });
    }
  }
  // Highest version wins.
  found.sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }));
  return found[0] || null;
}

const ext = findExtension();
say('found an installed wolfbook extension', !!ext, ext && `v${ext.version}`);
if (!ext) process.exit(1);

// ── 2. load the native addon it ships, from plain Node ─────────────────────
function findAddon(extDir) {
  const triple = `${process.platform}-${process.arch}`;
  const candidates = [
    path.join(extDir, 'wstp', 'prebuilt', `wstp-${triple}.node`),
    path.join(extDir, 'wstp', 'build', 'Release', 'wstp.node'),
  ];
  return candidates.find((p) => fs.existsSync(p)) || null;
}

const addonPath = findAddon(ext.dir);
say('found a matching prebuilt addon', !!addonPath, addonPath && path.basename(addonPath));
let wstp;
try {
  wstp = require(addonPath);
  say('addon loads in plain Node (N-API, ABI-stable)', true,
      `node ${process.version}, ABI ${process.versions.modules}`);
} catch (e) {
  say('addon loads in plain Node', false, e.message.split('\n')[0]);
  process.exit(1);
}

// ── 3. find a kernel ───────────────────────────────────────────────────────
const kernels = [
  ...fs.readdirSync('/Applications').filter((n) => /^Wolfram.*\.app$/.test(n))
    .map((n) => `/Applications/${n}/Contents/MacOS/WolframKernel`),
  '/usr/local/bin/WolframKernel',
].filter((p) => fs.existsSync(p));
say('found a WolframKernel binary', kernels.length > 0, kernels[0]);
if (!kernels.length) process.exit(1);

// ── 4. start it and load the extension's OWN rendering pipeline ────────────
const imgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wbserve-img-'));
let session;
const t0 = Date.now();
try {
  session = new wstp.WstpSession(kernels[0]);
  // sub() returns a WExpr {type, value}; it is also the call shape init.wl
  // documents ("helpers called by JS via session.sub()").
  const val = (w) => (w && (w.value !== undefined ? String(w.value) : JSON.stringify(w))) || '';
  const ping = await session.sub('1+1');
  say('kernel starts and answers', val(ping).trim() === '2',
      `${Date.now() - t0} ms, got ${JSON.stringify(val(ping))}`);

  // init.wl locates its sub-files via $wolframResourceDir, which the HOST must
  // supply — $InputFileName is unreliable when loaded over WSTP. Without the
  // Block, every Get[] inside init.wl fails with Get::stream and the render API
  // is left undefined, so calls return unevaluated and silently do nothing.
  const resDir = path.join(ext.dir, 'resources').replace(/\\/g, '/');
  const initPath = path.join(ext.dir, 'resources', 'init.wl').replace(/\\/g, '/');
  const init = await session.evaluate(
    `Block[{$wolframResourceDir="${resDir}"}, Get["${initPath}"]]`, { interactive: false });
  const initErrs = (init.messages || []).filter((m) => /Get::stream/.test(m));
  say('extension resources/init.wl loads all sub-files', initErrs.length === 0,
      initErrs.length ? `${initErrs.length} Get::stream error(s)` : 'no load errors');

  const dv = await session.sub('ToString@Length@DownValues[VsCodeRenderExpr]');

  // The public API is declared at the top of init.wl and so lives in Global`;
  // it must be called by BARE name. VsCodeSetImgDir is how the host tells the
  // renderer where to write images (absolute dir + the prefix used in <img src>).
  say('the render API is actually DEFINED (not just a bare symbol)',
      Number(val(dv)) > 0, `${val(dv)} DownValues`);

  const dir = imgDir.replace(/\\/g, '/');
  await session.sub(`VsCodeSetImgDir["${dir}", "img/"]`);

  // ── 5. THE POINT: render a plot and see if we get rich HTML + an image ──
  const r = await session.sub('VsCodeRenderExpr[Plot[Sin[x], {x, 0, 2 Pi}], "Auto", 1.0]');
  const html = val(r);
  say('rendering a Plot returns HTML', html.length > 40, `${html.length} chars`);
  say('the HTML references an image file', /<img|<svg/.test(html),
      (html.match(/<(img|svg)[^>]{0,90}/) || ['(none)'])[0]);

  const written = fs.existsSync(imgDir) ? fs.readdirSync(imgDir) : [];
  say('the kernel wrote image files a server could serve', written.length > 0,
      written.slice(0, 3).join(', ') || '(none)');

  // ── 6. and typeset maths, the other half of rich output ────────────────
  const m = await session.sub('VsCodeRenderExpr[Integrate[1/(1+x^3), x], "Auto", 1.0]');
  const mhtml = val(m);
  say('rendering an integral returns typeset markup', /katex|<w|mrow|latex/i.test(mhtml),
      mhtml.slice(0, 70).replace(/\s+/g, ' '));

  console.log(`\ntotal ${Date.now() - t0} ms`);
} catch (e) {
  say('spike completed', false, e.message.split('\n')[0]);
  console.error(e);
} finally {
  try { session?.stop?.(); } catch (_) {}
  console.log(`images in ${imgDir}`);
}
process.exit(0);
