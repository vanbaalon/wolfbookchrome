// kernel.mjs — drive a Wolfram kernel and the extension's own rendering
// pipeline from plain Node.
//
// This is the whole trick behind wolfbook-serve: the rich rendering lives in the
// KERNEL (resources/*.wl), not in the VS Code extension, so loading those files
// gives full-fidelity output — SVG plots, 2D tooltip data, 3D meshes, typeset
// maths — with no VS Code process anywhere.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { findAddons } from './host.mjs';

const require = createRequire(import.meta.url);

/** Escape a filesystem path for embedding in a Wolfram string literal. */
const wlPath = (p) => String(p).replace(/\\/g, '/').replace(/"/g, '\\"');

// The extension's own default for this conversion
// (notebook.rendering.lineBreaking.baseFontSizePx).
const BASE_FONT_PX = 16;

export class WolfbookKernel {
  /**
   * @param {{extensionDir, resourcesDir, kernelExecutable}} host
   * @param {{imageDir?: string, onPrint?: Function, onMessage?: Function}} [opts]
   */
  constructor(host, opts = {}) {
    this.host = host;
    this.imageDir = opts.imageDir || fs.mkdtempSync(path.join(os.tmpdir(), 'wolfbook-serve-img-'));
    this.onPrint = opts.onPrint || (() => {});
    this.onMessage = opts.onMessage || (() => {});
    this.session = null;
    this.btl = null;
    this.ready = false;
    this.busy = false;
    this.startedAt = null;
    this.wolframVersion = null;
    this.componentVersions = {
      wolfbook: 'unknown', wolfbookBuildDate: 'unknown',
      wstp: 'unknown', wstpBuildDate: 'unknown',
      btl: 'unknown', btlBuildDate: 'unknown',
    };
  }

  async start() {
    const { wstp: wstpPath, btl: btlPath } = findAddons(this.host.extensionDir);
    if (!wstpPath) {
      throw new Error(`No WSTP addon for ${process.platform}-${process.arch} in ${this.host.extensionDir}`);
    }
    // Both addons are N-API, so the copies the extension ships for VS Code's
    // Electron load unchanged in ordinary Node.
    const wstp = require(wstpPath);
    if (btlPath) {
      try { this.btl = require(btlPath); } catch (_) { this.btl = null; }
    }

    // Mirror WBVersion[]: package metadata identifies Wolfbook itself, while
    // native addon exports identify the binaries ACTUALLY selected above.
    // Reading prebuilds/VERSION would only describe what ought to be loaded.
    try {
      const pkgPath = path.join(this.host.extensionDir, 'package.json');
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      this.componentVersions.wolfbook = pkg.version || 'unknown';
      this.componentVersions.wolfbookBuildDate =
        new Date(fs.statSync(pkgPath).mtimeMs).toISOString().slice(0, 10);
    } catch (_) {}
    if (typeof wstp.version === 'string') this.componentVersions.wstp = wstp.version;
    if (typeof wstp.buildDate === 'string') this.componentVersions.wstpBuildDate = wstp.buildDate;
    if (this.btl && typeof this.btl.version === 'string') this.componentVersions.btl = this.btl.version;
    if (this.btl && typeof this.btl.buildDate === 'string') this.componentVersions.btlBuildDate = this.btl.buildDate;

    this.session = new wstp.WstpSession(this.host.kernelExecutable);
    this.startedAt = Date.now();

    // ── trap 1 ────────────────────────────────────────────────────────────
    // init.wl locates its sub-files through $wolframResourceDir, which the HOST
    // must supply — $InputFileName is unreliable over WSTP. Omit it and every
    // Get[] inside fails with Get::stream, leaving the render API undefined; the
    // calls then return UNEVALUATED instead of erroring, so everything looks
    // fine and nothing renders.
    const resDir = wlPath(this.host.resourcesDir);
    const initPath = wlPath(path.join(this.host.resourcesDir, 'init.wl'));
    const init = await this.session.evaluate(
      `Block[{$wolframResourceDir="${resDir}"}, Get["${initPath}"]]`, { interactive: false });

    const loadErrors = (init.messages || []).filter((m) => /Get::stream/.test(m));
    if (loadErrors.length) {
      throw new Error(`init.wl could not load its sub-files (${loadErrors.length} Get::stream errors). `
        + `Check resourcesDir: ${this.host.resourcesDir}`);
    }

    // Verify by DEFINITION, not by Head[]: an undefined symbol is also a Symbol,
    // which is exactly how this failure hides.
    const dv = await this.session.sub('ToString@Length@DownValues[VsCodeRenderExpr]');
    if (!(Number(dv?.value) > 0)) {
      throw new Error('resources/init.wl loaded but VsCodeRenderExpr has no definitions.');
    }

    // ── trap 2 ────────────────────────────────────────────────────────────
    // Without this nothing is written to disk, and the relative prefix is what
    // lets the server map an <img src> back onto a file it can serve.
    fs.mkdirSync(this.imageDir, { recursive: true });
    // The prefix carries NO trailing slash: the kernel joins it with "/" itself
    // (checkout.js uses `'img/' + notebookName`), so "img/" yields "img//file".
    await this.session.sub(`VsCodeSetImgDir["${wlPath(this.imageDir)}", "img"]`);

    try {
      const v = await this.session.sub('$Version');
      this.wolframVersion = String(v?.value || '').trim() || null;
    } catch (_) {}

    this.ready = true;
    return this;
  }

  /**
   * Evaluate one notebook cell and render it the way the notebook would.
   *
   * @param {string} code
   * @param {{format?: string, scale?: number, timeoutMs?: number,
   *          pageWidthEm?: number}} [opts] pageWidthEm is the READER's column
   *          width, which only the client knows; without it nothing is broken.
   * @returns {Promise<{html, text, outN, messages, print, ms}>}
   */
  async evalCell(code, opts = {}) {
    if (!this.ready) throw new Error('kernel not started');
    if (this.busy) throw new Error('kernel is busy');
    this.busy = true;
    const t0 = Date.now();
    const print = [];
    const messages = [];
    try {
      // Evaluate the cell as the user's own input so Out[n], $Line and history
      // behave as they do in the notebook; then render that Out[n].
      const res = await this.session.evaluate(code, {
        interactive: true,
        onPrint: (l) => { print.push(l); this.onPrint(l); },
        onMessage: (m) => { messages.push(m); this.onMessage(m); },
      });

      const outN = Number((await this.session.sub('ToString[$Line - 1]'))?.value) || null;

      let html = '';
      if (outN) {
        const format = String(opts.format || 'Auto').replace(/"/g, '');
        const scale = Number(opts.scale) || 1.0;
        const r = await this.session.sub(`VsCodeRender[${outN}, "${format}", ${scale}]`);
        html = String(r?.value ?? '');
      }

      return {
        html: this.boxesToLatex(html, Number(opts.pageWidthEm) || 0),
        text: this._resultText(res),
        outN,
        messages,
        print,
        ms: Date.now() - t0,
      };
    } finally {
      this.busy = false;
    }
  }

  _resultText(res) {
    const w = res && (res.result !== undefined ? res.result : res);
    if (!w) return '';
    if (w.value !== undefined) return String(w.value);
    return '';
  }

  /**
   * Convert the kernel's `wllatex-boxes` divs into `wllatex-prerendered` ones
   * carrying `data-latex-b64`.
   *
   * The kernel emits box expressions; turning them into LaTeX is the BTL addon's
   * job, which is why the extension does this host-side too. We stop at LaTeX
   * and let the browser typeset it — the Overleaf viewer already ships KaTeX and
   * already understands `data-latex-b64` (it is what the "copy LaTeX" button
   * reads), so sending LaTeX rather than pre-rendered markup keeps this server
   * free of a KaTeX dependency.
   *
   * LINE BREAKING IS BTL'S JOB TOO, and must not be left to the browser.
   * KaTeX can only break inline math at top-level relations and binary
   * operators, which mangles anything structured: it will happily split a
   * matrix row or an integrand from its measure, and it cannot indent a
   * continuation at all. BTL breaks the LaTeX with knowledge of the expression
   * — delimiter depth, indent step, page width — and that is what the notebook
   * editor shows, so doing it anywhere else means two different renderings of
   * the same result. The breaks travel inside the LaTeX itself, so the browser
   * still just typesets what it is given.
   *
   * @param {string} html
   * @param {number} [pageWidthEm] the reader's column width; 0 = do not break
   */
  boxesToLatex(html, pageWidthEm = 0) {
    if (!html || !html.includes('wllatex-boxes')) return html;
    if (!this.btl) {
      return html.replace(/<div class="vscode-wolfram-wllatex-boxes"[^>]*>\s*<\/div>/g,
        '<pre class="vscode-wolfram-text-output">Maths could not be typeset: '
        + 'the BTL addon is unavailable for this platform.</pre>');
    }
    return html.replace(
      /<div class="vscode-wolfram-wllatex-boxes"([^>]*)>\s*<\/div>/g,
      (whole, attrs) => {
        const m = /data-boxes-b64="([^"]*)"/.exec(attrs);
        if (!m) return whole;
        let latex;
        try {
          const boxes = Buffer.from(m[1], 'base64').toString('utf8');
          const out = this.btl.boxToLatex(boxes);
          latex = out && out.latex;
          if (!latex) return whole;
        } catch (_) { return whole; }
        latex = this.lineBreak(latex, pageWidthEm);
        const b64 = Buffer.from(latex, 'utf8').toString('base64');
        const keep = attrs.replace(/\s*data-boxes-b64="[^"]*"/, '');
        // Left EMPTY on purpose: the client typesets from data-latex-b64.
        return `<div class="vscode-wolfram-wllatex-prerendered"${keep} data-latex-b64="${b64}"></div>`;
      });
  }

  /**
   * Break one LaTeX string to the reader's column width, using BTL.
   *
   * Options mirror the extension's defaults (controller.js `_getLineBreakOptions`)
   * so a result breaks the same way in Overleaf as in the notebook editor.
   * Failure is never fatal: an unbroken line still renders, it just runs wide.
   *
   * @param {string} latex
   * @param {number} pageWidthEm  column width in em; 0 or less means leave it alone
   */
  lineBreak(latex, pageWidthEm) {
    if (!latex || !(pageWidthEm > 0)) return latex;
    if (!this.btl || typeof this.btl.lineBreakLatex !== 'function') return latex;
    try {
      const r = this.btl.lineBreakLatex(latex, {
        pageWidth: Math.floor(pageWidthEm),
        pageWidthPx: Math.floor(pageWidthEm * BASE_FONT_PX),
        baseFontSizePx: BASE_FONT_PX,
        indentStep: 2,
        compact: false,
        maxDelimDepth: 2,
        maxIterations: 5,
      });
      if (typeof r === 'string') return r || latex;
      if (r && typeof r === 'object') return r.result || latex;
      return latex;
    } catch (_) {
      return latex;
    }
  }

  /** Map an /img/ URL path back onto a file, refusing anything outside imageDir. */
  resolveImage(relPath) {
    const clean = path.normalize(relPath).replace(/^(\.\.[/\\])+/, '');
    const full = path.join(this.imageDir, clean);
    if (!full.startsWith(path.resolve(this.imageDir))) return null;
    return fs.existsSync(full) ? full : null;
  }

  async interrupt() {
    try { await this.session?.abort?.(); return true; } catch (_) { return false; }
  }

  stop() {
    try { this.session?.stop?.(); } catch (_) {}
    this.ready = false;
  }
}
