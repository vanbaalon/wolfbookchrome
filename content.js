// content.js — Overleaf page integration (isolated world).
//
// Phase 1 scope: detect that the user selected a .wb, take over the editor
// pane, and render the notebook read-only. No kernel, no evaluation. The
// "Open in Wolfbook" button is present but only lights up when the local
// wolfbook MCP server answers — that is Phase 2's entry point.
//
// FRAGILITY IS CONCENTRATED ON PURPOSE: every dependence on Overleaf's own
// markup lives in probeSelectedFile() and probeEditorPane() below. When
// Overleaf reshuffles its DOM, those two functions are the entire fix. The zip
// endpoint, the .wb format and the MCP contract are all independent of it.

(() => {
  const HOST_ID = 'wolfbook-overleaf-host';
  const projectId = (location.pathname.match(/\/project\/([0-9a-f]{16,32})/) || [])[1];
  if (!projectId) return;

  let mods = null;              // lazily imported ES modules
  let provider = null;
  let currentFile = null;       // the .wb we are showing, or null
  let lastResolver = null;      // asset resolver, for blob: cleanup
  let lastMountError = null;    // surfaced by the diagnostics
  let suppressTeardownUntil = 0;
  let currentAttachedId = null;   // module-scope mirror, so teardown can detach

  const log = (...a) => console.debug('[wolfbook]', ...a);

  // ── page-bridge RPC (MAIN world) ───────────────────────────────────────────
  let seq = 0;
  function askBridge(action, timeoutMs = 1200, data = null) {
    return new Promise((resolve) => {
      const id = `wb${++seq}`;
      const timer = setTimeout(() => { window.removeEventListener('message', onMsg); resolve(null); }, timeoutMs);
      function onMsg(ev) {
        if (ev.source !== window || !ev.data || ev.data.type !== 'wb-bridge-response' || ev.data.id !== id) return;
        clearTimeout(timer);
        window.removeEventListener('message', onMsg);
        resolve(ev.data.payload);
      }
      window.addEventListener('message', onMsg);
      window.postMessage({ type: 'wb-bridge-request', id, action, data }, location.origin);
    });
  }

  // ── Overleaf DOM probes (THE fragile part — fix here) ─────────────────────
  //
  // Which file is on screen is decided by the ACTIVE EDITOR TAB, not by the
  // file-tree selection: the tree highlight and the open document can disagree
  // (click a file, then click another without opening it). So the tab bar is
  // probed first, and the tree only as a fallback for older layouts.
  //
  // Overleaf classifies .wb as a BINARY file — it shows "Sorry, no preview is
  // available" with a Download button instead of an editor. That is the normal
  // case for us, and it means there is no .cm-editor to find, so the pane probe
  // must not depend on one.

  // Bidi control characters are stripped, not just whitespace: Overleaf writes
  // the tab filename as "\u200Etest.wb" (a LEFT-TO-RIGHT MARK, so a name in a
  // right-to-left script still reads correctly). It is invisible, survives
  // trim(), and would travel into filename comparisons and zip lookups.
  const clean = (s) => (s || '')
    .replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/\s+/g, ' ').trim();

  /**
   * The binary-file view, which is what Overleaf shows for a .wb. Confirmed
   * against the live site:
   *
   *   <div class="file-view">
   *     <div class="file-view-buttons">
   *       <a href="/project/<id>/blob/<sha>" download="name.wb">Download</a>
   *     </div>
   *     <p class="no-preview">Sorry, no preview is available.</p>
   *   </div>
   *
   * This single element answers both questions at once and needs no guessing:
   * the `download` attribute is the exact filename, and the href is a
   * same-origin URL for the file's own bytes — so the notebook can be fetched
   * directly instead of pulling the entire project zip for it.
   */
  function probeFileView() {
    for (const view of document.querySelectorAll('.file-view, [class*="file-view"]')) {
      const link = view.querySelector('a[download]');
      if (!link) continue;
      const name = clean(link.getAttribute('download'));
      if (!name) continue;
      return { name, blobUrl: link.getAttribute('href') || null, view };
    }
    // The link alone, if Overleaf reshuffles its container.
    const loose = document.querySelector('a[download$=".wb"]');
    if (loose) {
      return {
        name: clean(loose.getAttribute('download')),
        blobUrl: loose.getAttribute('href') || null,
        view: null,
      };
    }
    return null;
  }

  /** The filename shown by the active tab, if the tab bar exists. */
  function probeActiveTab() {
    // Overleaf's OWN tab markup, captured from a live session:
    //
    //   <div class="editor-file-tab-content">
    //     <span class="editor-file-tab-icon">…</span>
    //     <div class="editor-file-tab-path">‎test.wb</div>
    //     <div class="editor-file-tab-action"><button aria-label="Close">…
    //
    // Note what is NOT there: no role="tab", no aria-selected. The generic
    // selectors below therefore matched nothing, and for a file with no
    // download link to name it — i.e. any .wb Overleaf holds as a doc — the
    // extension could not tell which file was open, so it never mounted.
    const paths = [...document.querySelectorAll(
      '.editor-file-tab-path, [class*="file-tab-path"]')];
    if (paths.length) {
      // Which tab is active is marked on an ANCESTOR, and that class name has
      // changed before, so match the word rather than a specific class.
      const isActive = (el) => {
        for (let n = el; n && n !== document.body; n = n.parentElement) {
          if (n.getAttribute('aria-selected') === 'true') return true;
          if (n.getAttribute('aria-current')) return true;
          const cls = typeof n.className === 'string' ? n.className : '';
          if (/\b(active|selected)\b/.test(cls)) return true;
        }
        return false;
      };
      const active = paths.find(isActive)
        // A single tab is unambiguous whether or not it is flagged active.
        || (paths.length === 1 ? paths[0] : null);
      if (active) {
        const m = clean(active.textContent).match(/[\w./+-]+\.[A-Za-z0-9]+/);
        if (m) return m[0];
      }
    }

    const TAB_SELECTORS = [
      '[role="tab"][aria-selected="true"]',
      '[role="tablist"] .active',
      '[class*="tab"][class*="active"]',
    ];
    for (const sel of TAB_SELECTORS) {
      for (const el of document.querySelectorAll(sel)) {
        // Tab text includes the close button's label; take the filename-looking part.
        const text = clean(el.getAttribute('aria-label') || el.textContent);
        const m = text.match(/[\w./+-]+\.[A-Za-z0-9]+/);
        if (m) return m[0];
      }
    }
    return null;
  }

  /** The file highlighted in the file tree. */
  function probeTreeSelection() {
    const TREE_SELECTORS = [
      '.file-tree [role="treeitem"][aria-selected="true"]',
      '[data-testid="file-tree"] [aria-selected="true"]',
      '.file-tree li[aria-selected="true"]',
      '.file-tree li.selected',
      '.file-tree .entity.selected',
      '.file-tree [class*="selected"]',
    ];
    for (const sel of TREE_SELECTORS) {
      for (const el of document.querySelectorAll(sel)) {
        const nameEl = el.querySelector('.entity-name, [class*="item-name"]') || el;
        const text = clean(nameEl.getAttribute('aria-label') || nameEl.textContent);
        const m = text.match(/[\w./+-]+\.[A-Za-z0-9]+/);
        if (m) return m[0];
      }
    }
    return null;
  }

  /**
   * Click a file back open in Overleaf's file tree.
   *
   * Uploading REPLACES the entity, so the id the tree was holding disappears and
   * Overleaf falls back to "no file is selected" — taking our panel with it,
   * since nothing is selected any more. Re-selecting restores Overleaf's own
   * state rather than trying to paper over it from outside.
   */
  function reselectFileInTree(name) {
    const tree = document.querySelector('.file-tree, [data-testid="file-tree"]') || document;
    const rows = [...tree.querySelectorAll('[role="treeitem"], li, button, a')];
    // Innermost match first: clicking an outer container may hit a folder.
    const hits = rows.filter((el) => clean(el.textContent).includes(name));
    hits.sort((a, b) => a.querySelectorAll('*').length - b.querySelectorAll('*').length);
    const target = hits[0];
    if (!target) return false;
    const clickable = target.closest('[role="treeitem"], li') || target;
    for (const el of [target, clickable]) {
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    }
    return true;
  }

  /** The file currently on screen, most reliable source first. */
  function probeSelectedFile() {
    const fv = probeFileView();
    return (fv && fv.name) || probeActiveTab() || probeTreeSelection();
  }

  /**
   * The region to take over. Preference order:
   *   1. Overleaf's "no preview available" pane — the exact thing we replace
   *      for a binary-classified file, and the most reliable signal there is.
   *   2. Known editor-panel containers.
   *   3. The editor itself (text-file case), mounted over its parent.
   */
  function probeEditorPane() {
    // 1. the binary-file view — the exact element we are replacing.
    //
    // Mount on its PARENT, not on .file-view itself: Overleaf DESTROYS that
    // element whenever the selection changes — including after our own upload,
    // which replaces the file entity — and a panel living inside it is destroyed
    // with it, closing the notebook mid-session.
    const fv = probeFileView();
    if (fv && fv.view) {
      const parent = fv.view.parentElement;
      if (parent && isPaneSized(parent) && parent !== document.body) return parent;
      const pane = growToPane(fv.view);
      if (pane) return pane;
    }

    // 2. any "no preview" message, if the structure above changed
    const NO_PREVIEW = /no preview is available|sorry, no preview/i;
    const candidates = document.querySelectorAll(
      '[class*="binary-file"], [class*="file-view"], .no-preview, [class*="no-preview"], main div');
    for (const el of candidates) {
      if (el.childElementCount > 6) continue;          // too big to be the message block
      if (!NO_PREVIEW.test(el.textContent || '')) continue;
      const pane = growToPane(el);
      if (pane) return pane;
    }

    // 3. the text editor, if this file did open in one — i.e. a .wb Overleaf
    //    holds as a DOC.
    //
    // THIS IS TRIED BEFORE the named panels below, and the order is the whole
    // point: #panel-source-editor contains Overleaf's OWN toolbar row (the
    // Code/Visual toggle and the review-mode menu) as well as the document. A
    // panel covering all of it puts our toolbar in the same place as theirs,
    // where it is simply not seen — which is exactly how a doc-backed notebook
    // came up with no toolbar while an uploaded one had one. The binary branch
    // above already mounts over the CONTENT region only (the .file-view's
    // parent), so matching that here is what makes the two look the same.
    const cm = document.querySelector('.cm-editor');
    if (cm && cm.parentElement && isPaneSized(cm.parentElement)) return cm.parentElement;
    if (cm && isPaneSized(cm)) return cm;

    // 2. known panels
    for (const sel of ['#panel-source-editor', '.ide-react-editor-content',
                       '[data-testid="editor-panel"]', '#editor']) {
      const el = document.querySelector(sel);
      if (el && isPaneSized(el)) return el;
    }

    return null;
  }

  function isPaneSized(el) {
    const r = el.getBoundingClientRect();
    return r.height > 150 && r.width > 250;
  }

  /** Walk up from a marker element to the enclosing pane-sized container. */
  function growToPane(el) {
    let node = el;
    for (let i = 0; i < 8 && node && node !== document.body; i++) {
      if (isPaneSized(node)) return node;
      node = node.parentElement;
    }
    return null;
  }

  /**
   * Print what the probes can and cannot see. Runs automatically when we fail
   * to mount, because that is exactly when someone needs it — and a content
   * script's console.info lands in the page's own DevTools console.
   */
  /**
   * A pruned outline of the regions that matter, so one report is enough to
   * write correct selectors from — rather than a round trip per guess. Only the
   * file tree, the tab bar and the editor region are walked, to a shallow
   * depth, with text clipped.
   */
  function domOutline() {
    const ROOTS = [
      ['file tree', '[class*="file-tree"], [data-testid*="file-tree"], nav'],
      ['tab bar', '[role="tablist"], [class*="tab-bar"], [class*="editor-tabs"]'],
      ['editor region', '#panel-source-editor, [class*="editor"], main'],
    ];
    const lines = [];
    const seen = new Set();

    const describe = (el) => {
      const cls = typeof el.className === 'string' ? el.className : '';
      const attrs = ['id', 'role', 'aria-selected', 'aria-label', 'data-testid']
        .map((a) => (el.hasAttribute(a) ? ` ${a}="${el.getAttribute(a).slice(0, 40)}"` : ''))
        .join('');
      const own = [...el.childNodes]
        .filter((n) => n.nodeType === 3).map((n) => n.nodeValue).join(' ').replace(/\s+/g, ' ').trim();
      return `<${el.tagName.toLowerCase()}${attrs}${cls ? ` class="${cls.slice(0, 80)}"` : ''}>`
        + (own ? ` "${own.slice(0, 60)}"` : '');
    };

    const walk = (el, depth, maxDepth) => {
      if (!el || depth > maxDepth || lines.length > 220) return;
      lines.push('  '.repeat(depth) + describe(el));
      for (const child of el.children) walk(child, depth + 1, maxDepth);
    };

    for (const [label, sel] of ROOTS) {
      lines.push(`\n── ${label} ──`);
      let found = 0;
      for (const el of document.querySelectorAll(sel)) {
        if (seen.has(el) || found >= 2) continue;
        // Skip nodes wholly contained in something already dumped.
        if ([...seen].some((s) => s.contains(el))) continue;
        seen.add(el); found++;
        walk(el, 0, 4);
      }
      if (!found) lines.push('  (nothing matched)');
    }
    return lines.join('\n');
  }

  /**
   * "yes" is not enough: a MOUNTED BUT EMPTY panel is its own failure, and it
   * looks identical to no panel at all in a screenshot.
   */
  function panelState() {
    const host = document.getElementById(HOST_ID);
    if (!host) return 'no';
    const shadow = host.shadowRoot;
    if (!shadow) return 'host present but no shadow root — module import failed';
    const bar = shadow.querySelector('.wb-toolbar');
    const cells = shadow.querySelectorAll('.wb-cell').length;
    const err = shadow.querySelector('.wb-error-box');
    const r = host.getBoundingClientRect();
    return `yes — toolbar=${bar ? 'present' : 'MISSING'} cells=${cells}`
      + `${err ? ` error="${err.textContent.slice(0, 80)}"` : ''}`
      + ` box=${Math.round(r.width)}x${Math.round(r.height)}@${Math.round(r.top)}`;
  }

  function diagnosisText(reason) {
    const pane = probeEditorPane();
    const tab = probeActiveTab();
    const tree = probeTreeSelection();
    return `[wolfbook] ${reason}\n`
      + `  url            : ${location.href}\n`
      + `  active tab     : ${tab || '(none found)'}\n`
      + `  tree selection : ${tree || '(none found)'}\n`
      + `  chosen file    : ${probeSelectedFile() || '(none)'}\n`
      + `  editor pane    : ${pane ? `<${pane.tagName.toLowerCase()} class="${pane.className || ''}">` : '(none found)'}\n`
      + `  panel mounted  : ${panelState()}\n`
      + `  extension      : ${contextAlive() ? 'live' : 'STALE — reload this tab (the extension was reloaded under it)'}\n`
      + `  state          : currentFile=${JSON.stringify(currentFile)} mountError=${JSON.stringify(lastMountError)}\n`
      + '  A "(none found)" line names the function to fix in content.js\n'
      + '  (probeActiveTab / probeTreeSelection / probeEditorPane).';
  }

  function diagnose(reason, { full = false } = {}) {
    const text = diagnosisText(reason) + (full ? `\n\n${domOutline()}` : '');
    console.info(text);
    // Also hand it to the MAIN world, so __wolfbookDiagnose() works in the
    // console's default "top" context instead of requiring the reader to switch
    // to the extension's isolated world.
    try { window.postMessage({ type: 'wb-diagnose-result', text }, location.origin); } catch (_) {}
    // Keep the latest report where it survives a page reload.
    try { chrome.storage?.local?.set({ lastDiagnosis: text }); } catch (_) {}
    return text;
  }

  /** Hand the full report to the user as a file they can send on. */
  function downloadDiagnosis() {
    const text = diagnosisText('full report') + `\n\n${domOutline()}`;
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'wolfbook-overleaf-diagnostics.txt';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    console.info('[wolfbook] diagnostics downloaded as wolfbook-overleaf-diagnostics.txt');
    return text;
  }

  // The MAIN-world bridge asks for these on demand.
  window.addEventListener('message', (ev) => {
    if (ev.source !== window || !ev.data || ev.data.type !== 'wb-diagnose-request') return;
    if (ev.data.mode === 'download') downloadDiagnosis();
    else diagnose('requested from the console', { full: ev.data.mode === 'full' });
  });

  /**
   * Repeat the short report while there is no panel, so the answer is on screen
   * without anyone having to ask for it. Stops as soon as a panel mounts, and
   * gives up after a bounded number of attempts rather than spamming the log.
   */
  function startPeriodicDiagnosis() {
    let n = 0;
    const MAX = 8;
    const timer = setInterval(() => {
      if (document.getElementById(HOST_ID)) { clearInterval(timer); return; }
      const name = probeSelectedFile();
      if (!name || !/\.wb$/i.test(name)) { if (++n >= MAX) clearInterval(timer); return; }
      n++;
      diagnose(`no panel yet for "${name}" (check ${n}/${MAX})`, { full: n === 1 });
      if (n >= MAX) {
        clearInterval(timer);
        console.info('[wolfbook] giving up on periodic checks. Run '
          + '__wolfbookDiagnose("download") to save a full report to a file.');
      }
    }, 4000);
  }

  // ── MCP (Phase 2 groundwork: detection only) ──────────────────────────────
  function mcp(msg) {
    return new Promise((resolve) => {
      try { chrome.runtime.sendMessage(msg, (r) => resolve(chrome.runtime.lastError ? null : r)); }
      catch (_) { resolve(null); }
    });
  }

  /** Pull the plain text out of an MCP tools/call result. */
  function mcpText(result) {
    const parts = (result && result.content) || [];
    return parts.filter((p) => p && p.type === 'text').map((p) => p.text).join('\n').trim();
  }

  /**
   * Evaluate a cell on the reader's own kernel, through the local wolfbook MCP
   * server. No VS Code window has to be focused and no notebook has to be open —
   * wolfbook_evaluateExpression talks to the kernel directly.
   *
   * `multiLine` matters: a notebook cell is usually several statements, and this
   * evaluates each as its own expression, the way shift-enter does in the
   * notebook. Without it the whole cell would be parsed as one expression and
   * most real cells would fail.
   */
  /**
   * Evaluate through wolfbook-serve — the local notebook server.
   *
   * Preferred over MCP because it returns the KERNEL'S OWN HTML: real SVG plots
   * fetched from the server, untruncated results, typeset maths. MCP is an AI
   * transport and gives a truncated text description of a picture.
   */
  function makeServeEvaluator(getPort, getToken, askForToken) {
    return {
      // Rewrite the kernel's relative img/ paths onto the server that wrote them.
      resolveAsset(rel) {
        const port = getPort();
        const token = getToken();
        if (!port || !rel || /^(https?:|data:|blob:)/i.test(rel)) return null;
        const clean = String(rel).replace(/^\.?\//, '').replace(/^img\//, '');
        return `http://127.0.0.1:${port}/img/${clean}?token=${encodeURIComponent(token || '')}`;
      },
      async run(code) {
        // The token is requested HERE — at the first evaluation that needs it —
        // rather than when the notebook opens. Reading a notebook needs no
        // credentials, so asking earlier would be demanding one for nothing.
        if (!getToken() && askForToken) {
          const granted = await askForToken('wolfbook-serve needs its token to evaluate:');
          if (!granted) throw new Error('No token — cell not evaluated.');
        }

        const call = () => mcp({ cmd: 'serve-eval', args: { code, format: 'Auto', scale: 1.0 } });
        let res = await call();
        if (!res) throw new Error('The extension could not reach its background worker.');

        // A stale or rotated token: ask once more, then retry the same cell.
        if (!res.ok && /token/i.test(res.error || '') && askForToken) {
          const granted = await askForToken('That token is no longer accepted:');
          if (!granted) throw new Error('No token — cell not evaluated.');
          res = await call();
        }
        if (!res.ok) throw new Error(res.error || 'Evaluation failed.');
        const r = res.result || {};
        const failed = (r.messages || []).some((m) => /::(sntx|argx|argrx|argbu)/.test(m));
        return {
          html: r.html || '',
          text: r.text || '',
          print: r.print || [],
          messages: r.messages || [],
          // The kernel's OWN evaluation number and timing, so the cell can show
          // In[n]/Out[n] that match the session rather than a count of its own.
          outN: r.outN || null,
          ms: r.ms || null,
          isError: failed,
          via: 'wolfbook-serve',
        };
      },
    };
  }

  function makeEvaluator(getForm, getTarget) {
    return {
      async run(code) {
        const form = getForm();
        const target = getTarget() || {};
        const args = {
          expression: code,
          multiLine: true,
          timeoutSeconds: 60,
          caption: 'Evaluate from Overleaf',
        };
        // Route explicitly on EVERY call rather than setting a session target.
        // The server requires a target whenever more than one window is
        // connected, and a session target lives on the MCP session — which an
        // MV3 service worker may drop and recreate at any time, silently losing
        // the choice. Per-call routing has no such state to lose.
        if (target.clientId) args.client_id = target.clientId;
        if (target.kernelId) args.kernel_id = target.kernelId;
        if (form === 'TeXForm') args.outputForm = 'TeXForm';

        const res = await mcp({ cmd: 'mcp-call', name: 'wolfbook_evaluateExpression', args });
        if (!res) throw new Error('The extension could not reach its background worker.');
        if (!res.ok) throw new Error(res.error || 'Evaluation failed.');
        return {
          text: mcpText(res.result) || '(no output)',
          isError: !!(res.result && res.result.isError),
          form,
          via: 'MCP',
        };
      },
    };
  }

  /**
   * Load the CodeMirror bundle, once, on the first click into a cell.
   *
   * 362 KB that a reader who never edits should not pay for — and the viewer
   * stays read-only rather than breaking if it fails to load.
   */
  let editorMod = null;
  async function loadEditor() {
    if (editorMod !== null) return editorMod;
    try {
      const m = await import(chrome.runtime.getURL('vendor/codemirror.bundle.js'));
      editorMod = m.mountEditor;
    } catch (e) {
      log('editor bundle failed to load', e);
      editorMod = false;
    }
    return editorMod;
  }

  // ── module loading ────────────────────────────────────────────────────────
  async function loadModules() {
    if (mods) return mods;
    const url = (p) => chrome.runtime.getURL(p);
    const [viewer, source, katex, renderer] = await Promise.all([
      import(url('viewer/wb-viewer.js')),
      import(url('viewer/source.js')),
      import(url('vendor/katex-css.js')),
      import(url('vendor/renderer-css.js')),
    ]);
    mods = { viewer, source, katexCss: katex.KATEX_CSS, wlCss: renderer.WL_CSS };
    return mods;
  }

  // ── panel ─────────────────────────────────────────────────────────────────
  function teardown() {
    if (currentAttachedId) {
      mcp({ cmd: 'serve-detach', notebookId: currentAttachedId });
      currentAttachedId = null;
    }
    const old = document.getElementById(HOST_ID);
    old?.__wbResizeObserver?.disconnect();
    old?.remove();
    if (lastResolver?.dispose) { lastResolver.dispose(); lastResolver = null; }
  }

  /**
   * Is this script still attached to a live extension?
   *
   * Reloading an unpacked extension ORPHANS the content scripts already running
   * in open tabs: the code keeps executing, but every chrome.* call throws
   * "Extension context invalidated". So the panel cannot import its own viewer
   * modules and comes up blank — which looks like the notebook failing, not
   * like a stale tab, and is the single most confusing thing that happens while
   * developing this. chrome.runtime.id is undefined exactly in that state.
   */
  const contextAlive = () => {
    try { return !!chrome.runtime?.id; } catch (_) { return false; }
  };

  /** Say plainly that the tab is stale, in the place the notebook would be. */
  function showStaleBanner(pane, fileName) {
    document.getElementById(HOST_ID)?.remove();
    const box = document.createElement('div');
    box.id = HOST_ID;
    box.style.cssText = 'position:absolute;inset:0;z-index:40;background:#fff;'
      + 'display:flex;align-items:center;justify-content:center;padding:24px;'
      + 'font:14px/1.5 system-ui,-apple-system,sans-serif;color:#1f2328;text-align:center';
    box.innerHTML = '<div><div style="font-weight:600;margin-bottom:6px">Wolfbook was reloaded</div>'
      + '<div style="color:#57606a">This tab is still running the previous version. '
      + 'Reload the page (⌘R) to open <b></b> again.</div></div>';
    box.querySelector('b').textContent = fileName;
    if (getComputedStyle(pane).position === 'static') pane.style.position = 'relative';
    pane.appendChild(box);
  }

  async function mount(fileName) {
    teardown();
    const pane = probeEditorPane();
    if (!pane) { diagnose(`found "${fileName}" but no editor pane to mount over`); return; }
    if (!contextAlive()) {
      console.info('[wolfbook] the extension was reloaded; this tab needs a refresh.');
      showStaleBanner(pane, fileName);
      return;
    }
    if (getComputedStyle(pane).position === 'static') pane.style.position = 'relative';

    const host = document.createElement('div');
    host.id = HOST_ID;
    pane.appendChild(host);

    /**
     * Never cover Overleaf's own toolbar.
     *
     * Which container we get depends on TIMING: on a fresh load the CodeMirror
     * editor may not exist yet, so the pane probe falls back to the whole
     * editor panel — which also holds Overleaf's toolbar row. Our panel then
     * starts at the top of that row and our toolbar is painted underneath
     * theirs: the notebook renders, but Save, Run all and the kernel picker are
     * simply unreachable, which reads as "the features are missing".
     *
     * So measure the chrome inside whatever pane we were given and start below
     * it. Re-measured on resize, because the Visual-mode toolbar is taller.
     */
    const clearOverleafChrome = () => {
      const bar = pane.querySelector(
        '.ol-cm-toolbar, .toolbar-editor, .toolbar-pdf, [class*="toolbar-editor"]');
      if (!bar || !pane.contains(bar) || bar.contains(host)) { host.style.top = '0px'; return; }
      const b = bar.getBoundingClientRect();
      const p = pane.getBoundingClientRect();
      // Only a bar at the TOP of the pane is chrome we must clear; one further
      // down is part of the document region and covering it is correct.
      const offset = b.height > 8 && b.top - p.top < 60 ? Math.round(b.bottom - p.top) : 0;
      host.style.top = `${Math.max(0, offset)}px`;
    };
    clearOverleafChrome();
    try {
      const ro = new ResizeObserver(clearOverleafChrome);
      ro.observe(pane);
      host.__wbResizeObserver = ro;
    } catch (_) { /* older browser: the one-off measurement stands */ }

    // Loading the viewer means dynamic import() of a web-accessible resource
    // from the isolated world. That is the standard MV3 pattern, but it is also
    // the one assumption the offline checks cannot verify (Chrome no longer
    // allows --load-extension, so nothing here runs as a real extension). If it
    // ever fails, say so in the pane instead of leaving a blank panel.
    let loaded;
    try {
      loaded = await loadModules();
    } catch (e) {
      host.textContent = '';
      const box = document.createElement('div');
      box.style.cssText = 'padding:16px;font:13px system-ui;color:#82071e;background:#fff5f5';
      box.textContent = `Wolfbook could not load its viewer modules: ${e && e.message}. `
        + 'Check the extension console; the .wb file itself is unaffected.';
      host.appendChild(box);
      log('module load failed', e);
      return;
    }
    const { viewer, source, katexCss, wlCss } = loaded;
    if (!provider) provider = source.createSourceProvider(projectId, { askBridge });

    const shadow = viewer.createViewerSurface(host, { katexCss, wlCss });
    const root = document.createElement('div');
    root.className = 'wb-root';
    root.innerHTML = `
      <div class="wb-toolbar">
        <img class="wb-logo" alt="Wolfbook" title="Wolfbook">
        <span class="wb-title"></span>
        <button data-mode="view" class="active">Notebook</button>
        <button data-mode="source">Source</button>
        <button data-act="refresh" title="Re-download from Overleaf">⟳</button>
        <button data-act="wrap" title="Wrap long code lines instead of scrolling">⏎ Wrap</button>
        <button data-act="undo" title="Undo the last cell operation (⌘Z)">↶</button>
        <span class="wb-spacer"></span>
        <span class="wb-note"></span>
        <span class="wb-run-group" hidden>
          <select class="wb-kernel" title="Which Wolfram kernel to evaluate on"></select>
          <button data-act="run-all" title="Evaluate every code cell in order on your local kernel">▶ Run all</button>
          <button data-act="stop" title="Stop after the current cell" hidden>■ Stop</button>
          <button data-act="interrupt" title="Abort the evaluation running now" hidden>⏹ Abort</button>
          <button data-act="clear-all" title="Clear every stored output">∅ Outputs</button>
          <button data-act="form" title="Show results as plain text or typeset maths">Text</button>
        </span>
        <button data-act="save" hidden title="Write the edited cells back to this Overleaf project">Save to Overleaf</button>
        <button data-act="open" title="Open this notebook in your local Wolfbook (VS Code)">Open in Wolfbook</button>
        <span class="wb-dot" title="Local Wolfbook not detected">●</span>
      </div>
      <div class="wb-body"><div class="wb-status">Loading…</div></div>`;
    root.querySelector('.wb-title').textContent = fileName;
    // Set from the extension URL rather than inlined in the markup, so the
    // sanitiser and CSP have nothing to argue with.
    root.querySelector('.wb-logo').src = chrome.runtime.getURL('vendor/wolfbook-icon.png');
    shadow.appendChild(root);

    const body = root.querySelector('.wb-body');
    const note = root.querySelector('.wb-note');
    const dot = root.querySelector('.wb-dot');
    const openBtn = root.querySelector('[data-act="open"]');
    let parsed = null;
    let mode = 'view';
    let lastStats = null;      // carries edits() for the Save button
    let loadedSource = '';     // the exact bytes we parsed, for a minimal diff
    let docBacked = false;     // Overleaf holds this .wb as a doc, not a binary file
    let loadedBlobUrl = null;  // content-addressed → doubles as a version token

    // Tier-2 probe: is a local wolfbook running? Everything that needs the
    // local machine stays disabled and out of the way until it answers.
    const runGroup = root.querySelector('.wb-run-group');
    const runAllBtn = root.querySelector('[data-act="run-all"]');
    const stopBtn = root.querySelector('[data-act="stop"]');
    const formBtn = root.querySelector('[data-act="form"]');
    let resultForm = 'InputForm';
    let evaluator = null;
    let stopRequested = false;

    // ── kernel picker ────────────────────────────────────────────────────
    // A machine can have several VS Code windows open, each with its own
    // kernels, and the MCP server refuses to guess between them — it returns
    // "No session target set" rather than risk running in the wrong window. So
    // the choice is surfaced here instead of being invented.
    const kernelSel = root.querySelector('.wb-kernel');
    let target = null;            // { clientId, kernelId, label }

    const rememberTarget = (t) => {
      target = t;
      try { chrome.storage?.local?.set({ wbKernelTarget: t }); } catch (_) {}
    };

    async function loadKernels(preferred) {
      const res = await mcp({ cmd: 'mcp-clients' });
      if (!res || !res.ok) return [];
      const options = [];
      kernelSel.textContent = '';
      for (const client of res.clients || []) {
        const group = document.createElement('optgroup');
        // "VSCode[2026 2d SoV]" → "2026 2d SoV"
        group.label = (String(client.clientId).match(/\[(.+)\]$/) || [, client.clientId])[1]
          + (client.role === 'primary' ? ' (primary)' : '');
        for (const k of client.kernels || []) {
          const opt = document.createElement('option');
          // The kernel id alone is the value; the client travels in a data
          // attribute. Packing both into one string and splitting on a
          // separator is exactly what a real client id breaks - they look like
          // "VSCode[2026 2d SoV]", spaces and brackets included.
          opt.value = k.kernel_id || (client.clientId + '#' + group.children.length);
          opt.dataset.clientId = client.clientId;
          const bits = [k.kernel_label || k.kernel_id || 'kernel'];
          if (k.is_default) bits.push('default');
          if (k.busy) bits.push('busy');
          else if (k.lifecycle) bits.push(k.lifecycle);
          opt.textContent = bits.join(' · ');
          group.appendChild(opt);
          options.push({ clientId: client.clientId, kernelId: k.kernel_id, isDefault: !!k.is_default,
                         primary: client.role === 'primary', value: opt.value, label: opt.textContent });
        }
        if (group.children.length) kernelSel.appendChild(group);
      }

      if (!options.length) {
        const opt = document.createElement('option');
        opt.textContent = 'no kernels available';
        kernelSel.appendChild(opt);
        kernelSel.disabled = true;
        return options;
      }
      kernelSel.disabled = false;

      // Keep the previous choice if it still exists, else fall back to the
      // primary window's default kernel — chosen, shown, and changeable, never
      // silently assumed.
      const keep = preferred && options.find((o) => o.value === preferred);
      const pick = keep
        || options.find((o) => o.primary && o.isDefault)
        || options.find((o) => o.isDefault)
        || options[0];
      kernelSel.value = pick.value;
      rememberTarget({ clientId: pick.clientId, kernelId: pick.kernelId, label: pick.label });
      return options;
    }

    kernelSel.addEventListener('change', () => {
      const opt = kernelSel.options[kernelSel.selectedIndex];
      if (!opt) return;
      const label = opt.textContent || '';
      rememberTarget({
        clientId: opt.dataset.clientId || null,
        kernelId: opt.value || null,
        label,
      });
      note.textContent = `evaluating on ${label}`;
    });
    // Kernels start, stop and get busy while the tab is open, so refresh the
    // list whenever the picker is about to be used.
    kernelSel.addEventListener('mousedown', () => { loadKernels(kernelSel.value); });

    // ── prefer wolfbook-serve when it is running ──────────────────────────
    // It needs no VS Code window at all and returns real pictures, so it wins
    // whenever it answers and we hold its token.
    let servePortNow = null;
    let serveTokenNow = null;

    /**
     * Ask for the server's token, INLINE and only when it is actually needed.
     *
     * Not window.prompt, and not on page load: a modal browser dialog appearing
     * the moment a notebook opens is startling and blocks the page, when at that
     * point the reader may only want to look. So this renders a small bar inside
     * our own panel, and is called lazily from the first evaluation that needs it.
     *
     * @returns {Promise<string|null>} the accepted token, or null if dismissed
     */
    function requestToken(reason) {
      return new Promise((resolve) => {
        const existing = root.querySelector('.wb-token-bar');
        if (existing) existing.remove();

        const bar = document.createElement('div');
        bar.className = 'wb-token-bar';
        bar.innerHTML = `
          <span class="wb-token-msg"></span>
          <input type="password" class="wb-token-input" placeholder="paste token"
                 autocomplete="off" spellcheck="false">
          <button data-act="token-ok">Connect</button>
          <button data-act="token-cancel" title="Evaluate over MCP instead">Not now</button>
          <span class="wb-token-hint">get it with <code>node cli.mjs token</code></span>`;
        bar.querySelector('.wb-token-msg').textContent = reason;
        body.parentNode.insertBefore(bar, body);

        const input = bar.querySelector('.wb-token-input');
        input.focus();
        const done = (value) => { bar.remove(); resolve(value); };

        bar.querySelector('[data-act="token-ok"]').addEventListener('click', async () => {
          const value = input.value.trim();
          if (!value) return;
          const after = await mcp({ cmd: 'serve-set-token', token: value });
          if (after && after.authorised) { serveTokenNow = value; done(value); return; }
          bar.querySelector('.wb-token-msg').textContent = 'That token was rejected. Try again:';
          input.select();
        });
        bar.querySelector('[data-act="token-cancel"]').addEventListener('click', () => done(null));
        input.addEventListener('keydown', (ev) => {
          if (ev.key === 'Enter') bar.querySelector('[data-act="token-ok"]').click();
          if (ev.key === 'Escape') done(null);
        });
      });
    }

    /** Same inline bar as the token, for the one id we cannot discover. */
    function requestFolderId() {
      return new Promise((resolve) => {
        root.querySelector('.wb-token-bar')?.remove();
        const bar = document.createElement('div');
        bar.className = 'wb-token-bar';
        bar.innerHTML = `
          <span class="wb-token-msg">Which Overleaf folder holds this file?</span>
          <input type="text" class="wb-token-input" placeholder="folder id (24 hex chars)"
                 autocomplete="off" spellcheck="false">
          <button data-act="token-ok">Save here</button>
          <button data-act="token-cancel">Cancel</button>
          <span class="wb-token-hint">DevTools &rsaquo; Network &rsaquo; upload a file &rsaquo; copy <code>folder_id</code></span>`;
        body.parentNode.insertBefore(bar, body);
        const input = bar.querySelector('.wb-token-input');
        input.focus();
        const done = (v) => { bar.remove(); resolve(v); };
        bar.querySelector('[data-act="token-ok"]').addEventListener('click', () => {
          const v = input.value.trim();
          if (!/^[0-9a-f]{24}$/.test(v)) {
            bar.querySelector('.wb-token-msg').textContent = 'That is not a 24-character id. Try again:';
            input.select();
            return;
          }
          done(v);
        });
        bar.querySelector('[data-act="token-cancel"]').addEventListener('click', () => done(null));
        input.addEventListener('keydown', (ev) => {
          if (ev.key === 'Enter') bar.querySelector('[data-act="token-ok"]').click();
          if (ev.key === 'Escape') done(null);
        });
      });
    }

    async function trySetupServe() {
      const st = await mcp({ cmd: 'serve-status' });
      if (!st || !st.ok || !st.connected) return false;
      servePortNow = st.port;

      // Connect regardless of whether we hold a token yet. The notebook renders
      // and the Run buttons appear; the token is asked for at the moment it is
      // first needed, which is when the reader clicks Run.
      serveTokenNow = st.authorised
        ? await new Promise((r) => {
            try { chrome.storage.local.get('wbServeToken', (v) => r(v?.wbServeToken || null)); }
            catch (_) { r(null); }
          })
        : null;

      evaluator = makeServeEvaluator(() => servePortNow, () => serveTokenNow, requestToken);
      attachToCoalition().catch((e) => log('coalition attach failed', e));
      runGroup.hidden = false;
      kernelSel.hidden = true;              // one server, one kernel for now
      formBtn.hidden = true;                // it always returns rich HTML
      dot.classList.add('online');
      dot.title = `wolfbook-serve on port ${servePortNow}`
        + (st.info?.wolframVersion ? ` · Wolfram ${String(st.info.wolframVersion).split(' ')[0]}` : '')
        + (serveTokenNow ? '' : ' · token needed to evaluate');
      render(false);
      return true;
    }

    openBtn.disabled = true;
    trySetupServe().then((usingServe) => {
      if (usingServe) return;
      return mcp({ cmd: 'mcp-status' }).then(async (s) => {
      const online = !!(s && s.ok && s.connected);
      dot.classList.toggle('online', online);
      dot.title = online ? `Local Wolfbook detected (port ${s.port})` : 'Local Wolfbook not detected';
      openBtn.disabled = !online;
      openBtn.title = online
        ? 'Open this notebook in your local Wolfbook (VS Code)'
        : 'Start VS Code with the Wolfbook extension to enable this';
      if (!online || evaluator) return;

      let saved = null;
      try {
        saved = await new Promise((r) => chrome.storage.local.get('wbKernelTarget',
          (v) => r(v && v.wbKernelTarget)));
      } catch (_) { /* no storage in some contexts; the default pick covers it */ }
      await loadKernels(saved && saved.kernelId);

        evaluator = makeEvaluator(() => resultForm, () => target);
        runGroup.hidden = false;
        render(false);            // re-render so cells gain their Run buttons
      });
    });

    formBtn.addEventListener('click', () => {
      resultForm = resultForm === 'InputForm' ? 'TeXForm' : 'InputForm';
      formBtn.textContent = resultForm === 'TeXForm' ? 'Math' : 'Text';
      formBtn.title = resultForm === 'TeXForm'
        ? 'Results are requested as TeXForm and typeset'
        : 'Results are shown as plain InputForm text';
    });

    stopBtn.addEventListener('click', () => { stopRequested = true; stopBtn.disabled = true; });

    runAllBtn.addEventListener('click', async () => {
      const cells = [...body.querySelectorAll('.wb-cell-code')].filter((c) => c.__wbRun);
      if (!cells.length) return;
      stopRequested = false;
      runAllBtn.disabled = true;
      stopBtn.hidden = false;
      stopBtn.disabled = false;
      let done = 0, failed = 0;
      for (const cell of cells) {
        if (stopRequested) break;
        runAllBtn.textContent = `▶ ${done + 1}/${cells.length}`;
        cell.scrollIntoView({ block: 'nearest' });
        // Sequential on purpose: cells share one kernel and usually depend on
        // the ones above them, so running them in parallel would be wrong.
        const res = await cell.__wbRun();
        done++;
        if (res && res.isError) failed++;
      }
      runAllBtn.disabled = false;
      runAllBtn.textContent = '▶ Run all';
      stopBtn.hidden = true;
      note.textContent = `ran ${done}/${cells.length} cell(s)`
        + (failed ? `, ${failed} with errors` : '')
        + (stopRequested ? ' — stopped' : '');
    });

    async function render(force = false) {
      body.textContent = '';
      const status = document.createElement('div');
      status.className = 'wb-status';
      status.textContent = force ? 'Re-downloading project…' : 'Loading notebook…';
      body.appendChild(status);
      note.textContent = '';

      try {
        // The Download link's href is re-read each time: Overleaf re-renders it,
        // and the sha changes when a collaborator saves.
        const fv = probeFileView();
        const blobUrl = fv && fv.name === fileName ? fv.blobUrl : null;
        // Overleaf holds a .wb one of two ways, and they save differently:
        //   uploaded  → a binary FILE, shown as "no preview" + a Download link
        //   created   → a DOC, opened in CodeMirror like any .tex
        // Everything made inside Overleaf — including "New file" — is a doc.
        docBacked = !blobUrl && !!document.querySelector('.cm-content');
        const got = await provider.getSource(fileName, { blobUrl, force, preferEditor: true, docBacked });
        loadedSource = got.source;
        loadedBlobUrl = blobUrl;

        if (mode === 'source') {
          const pre = document.createElement('pre');
          pre.className = 'wb-source';
          pre.textContent = got.source;
          body.textContent = '';
          body.appendChild(pre);
          note.textContent = `${(got.source.length / 1024).toFixed(0)} KB · from ${got.from}`;
          return;
        }

        // A blank file is a NEW notebook, not a broken one. Overleaf's "New
        // file" writes zero bytes, so the first thing a user ever sees of a
        // notebook they just created was a JSON parse error.
        if (!got.source.trim()) {
          parsed = { cells: [] };
        } else {
          try { parsed = JSON.parse(got.source); }
          catch (e) { throw new Error(`This file is not valid .wb JSON (${e.message}). Use Source to inspect it.`); }
        }

        // Only download the whole project when an image actually needs it.
        if (lastResolver?.dispose) lastResolver.dispose();
        lastResolver = null;
        let assetNote = '';
        if (source.referencesAssets(got.source)) {
          status.textContent = 'Downloading project images…';
          try {
            const assets = await provider.getAssets(fileName, { force });
            lastResolver = viewer.makeAssetResolver(assets.entries, assets.dir);
          } catch (e) {
            assetNote = 'images unavailable';
            log('asset fetch failed', e);
          }
        }

        body.textContent = '';
        const nb = document.createElement('div');
        nb.className = 'wb-notebook';
        body.appendChild(nb);
        const stats = lastStats = viewer.renderNotebook(parsed, nb, {
          resolveAsset: lastResolver,
          evaluator,               // null until a local wolfbook answers
          // Editing does NOT require an evaluator: correcting prose or code and
          // saving it back to Overleaf is useful with no kernel anywhere.
          editing: { mount: loadEditor },
          structure: lastStructure = makeStructure(),
        });

        const bits = [`${stats.cells} cells`, `${stats.outputs} outputs`];
        if (stats.missingAssets) bits.push(`${stats.missingAssets} image(s) not in project`);
        if (assetNote) bits.push(assetNote);
        if (stats.interactive.length) bits.push(`${stats.interactive.join('/')} interactive in Wolfbook`);
        note.textContent = bits.join(' · ');
      } catch (e) {
        body.textContent = '';
        const box = document.createElement('div');
        box.className = 'wb-error-box';
        box.textContent = e.message || String(e);
        body.appendChild(box);
        log('render failed', e);
      }
    }

    root.querySelectorAll('button[data-mode]').forEach((btn) => {
      btn.addEventListener('click', () => {
        mode = btn.dataset.mode;
        root.querySelectorAll('button[data-mode]').forEach((b) => b.classList.toggle('active', b === btn));
        render(false);
      });
    });
    root.querySelector('[data-act="refresh"]').addEventListener('click', () => {
      provider.invalidate();
      render(true);
    });

    // ── structural operations ────────────────────────────────────────────
    //
    // Every one of these goes through mutate(), which snapshots the notebook
    // first. Deleting a cell with a stray click is otherwise unrecoverable —
    // the in-memory model is the only copy of unsaved work — so undo is not a
    // nicety here.
    const undoStack = [];
    const MAX_UNDO = 50;
    let structureDirty = false;
    let lastStructure = null;

    const newCell = (kind) => ({
      kind,
      value: '',
      languageId: kind === 1 ? 'markdown' : 'wolfram',
      outputs: [],
      metadata: {},
    });

    function makeStructure() {
      const at = (state) => parsed.cells.indexOf(state.cell);
      return {
        // Index-based, for the between-cells strips: they know WHERE, with no
        // neighbouring cell to hang the insertion off.
        insertAt: (index, kind) => mutate('insert', () => {
          const i = Math.max(0, Math.min(Number(index), parsed.cells.length));
          parsed.cells.splice(i, 0, newCell(kind));
        }),
        insertAfter: (state, kind) => mutate('insert', () => {
          const i = at(state);
          parsed.cells.splice(i < 0 ? parsed.cells.length : i + 1, 0, newCell(kind));
        }),
        insertBefore: (state, kind) => mutate('insert', () => {
          parsed.cells.splice(Math.max(0, at(state)), 0, newCell(kind));
        }),
        remove: (state) => mutate('delete', () => {
          const i = at(state);
          if (i >= 0) parsed.cells.splice(i, 1);
        }),
        move: (state, delta) => mutate('move', () => {
          const i = at(state);
          const j = i + delta;
          if (i < 0 || j < 0 || j >= parsed.cells.length) return;
          const [cell] = parsed.cells.splice(i, 1);
          parsed.cells.splice(j, 0, cell);
        }),
        changeType: (state, kind) => mutate('change type', () => {
          const cell = state.cell;
          if (!cell) return;
          cell.kind = kind;
          cell.languageId = kind === 1 ? 'markdown' : 'wolfram';
          // Outputs belong to code; carrying them onto prose would be nonsense.
          if (kind === 1) cell.outputs = [];
        }),
        clearOutputs: (state) => mutate('clear output', () => {
          if (state.cell) state.cell.outputs = [];
        }),
        runAbove: (state) => {
          const cells = codeCells();
          const i = cells.findIndex((c) => c.__wbState === state);
          runRange(i <= 0 ? [] : cells.slice(0, i));
        },
        runBelow: (state) => {
          const cells = codeCells();
          const i = cells.findIndex((c) => c.__wbState === state);
          runRange(i < 0 ? [] : cells.slice(i));
        },
      };
    }

    function snapshot() {
      undoStack.push(JSON.stringify(parsed));
      if (undoStack.length > MAX_UNDO) undoStack.shift();
    }

    function undo() {
      const prev = undoStack.pop();
      if (!prev) { note.textContent = 'nothing to undo'; return; }
      parsed = JSON.parse(prev);
      structureDirty = true;
      rerenderFromModel();
      note.textContent = `undone (${undoStack.length} step${undoStack.length === 1 ? '' : 's'} left)`;
    }

    function mutate(label, fn) {
      // Carry text edits into the model first, or a structural change would
      // discard whatever is currently in the open editors.
      for (const st of (lastStats?.cellStates || [])) {
        if (st.cell && st.code !== st.original) st.cell.value = st.code;
      }
      snapshot();
      const before = parsed.cells.length;
      fn();
      structureDirty = true;
      rerenderFromModel();
      note.textContent = `${label} — ⌘Z to undo`;
      // Put the cursor in a cell that was just created. Without this the new
      // cell is an empty box you must find and click before you can type in it.
      if (label === 'insert' && parsed.cells.length > before) {
        const cells = nbRoot().querySelectorAll('.wb-cell');
        const added = [...cells].find((el) => el.__wbState && !el.__wbState.code);
        added?.__wbEdit?.();
      }
    }

    const nbRoot = () => body.querySelector('.wb-notebook') || body;

    /** Repaint the notebook from the in-memory model, keeping unsaved edits. */
    function rerenderFromModel() {
      const nb = body.querySelector('.wb-notebook');
      if (!nb || !parsed) return;
      lastStats = viewer.renderNotebook(parsed, nb, {
        resolveAsset: lastResolver,
        evaluator,
        editing: { mount: loadEditor },
        structure: lastStructure,
      });
      refreshSaveButton();
    }

    // ── Save to Overleaf ─────────────────────────────────────────────────
    const saveBtn = root.querySelector('[data-act="save"]');

    // While a transient message is on the button ("Saving…", "Saved ✓",
    // "Reload before saving"), the poller must not overwrite it — otherwise the
    // one moment the user needs to read it is the moment it disappears.
    let holdMessageUntil = 0;
    const holdMessage = (text, ms = 4000) => {
      saveBtn.textContent = text;
      holdMessageUntil = Date.now() + ms;
    };

    /** Show the Save button as soon as anything is actually different. */
    function refreshSaveButton() {
      if (saveBtn.disabled || Date.now() < holdMessageUntil) return;
      const edits = lastStats && lastStats.edits ? lastStats.edits() : new Map();
      const n = edits.size;
      // A cell that was merely RUN still needs saving — in both directions:
      // there may be a fresh result to write, or a stored output that no longer
      // matches its code and must not stay in the file.
      const outputWork = (lastStats?.cellStates || [])
        .filter((c) => c.outputsStale && (c.liveResult || (c.cell?.outputs || []).length)).length;
      saveBtn.hidden = n === 0 && !structureDirty && !outputWork;
      saveBtn.textContent = n === 0 && outputWork && !structureDirty
        ? (outputWork === 1 ? 'Save 1 result to Overleaf' : `Save ${outputWork} results to Overleaf`)
        : structureDirty && !n ? 'Save changes to Overleaf'
        : n === 1 ? 'Save 1 cell to Overleaf'
        : `Save ${n} cells to Overleaf`;
    }
    setInterval(refreshSaveButton, 800);

    saveBtn.addEventListener('click', async () => {
      const edits = lastStats.edits();
      const outputWorkNow = (lastStats?.cellStates || [])
        .some((c) => c.outputsStale && (c.liveResult || (c.cell?.outputs || []).length));
      if (!edits.size && !structureDirty && !outputWorkNow) return;

      const prev = saveBtn.textContent;
      saveBtn.disabled = true;
      try {
        // FRESHNESS. Overleaf's Download link is content-addressed
        // (/blob/<sha>), so the sha IS a version token: if it differs from the
        // one we loaded, someone changed the file meanwhile. Uploading replaces
        // the whole file — unlike a .tex, there is no OT merge — so a silent
        // save here would destroy their work.
        const fvNow = probeFileView();
        if (loadedBlobUrl && fvNow && fvNow.blobUrl && fvNow.blobUrl !== loadedBlobUrl) {
          note.textContent = 'file changed in Overleaf since you opened it — press ⟳ first';
          holdMessage('Reload before saving', 6000);
          saveBtn.disabled = false;
          return;
        }

        holdMessage('Saving…', 30000);
        suppressTeardownUntil = Date.now() + 30000;

        const { serialiseModel, uploadFile, findCsrfToken, resolveFolderId,
                fetchFolderIdFromApi, liveResultToOutput } =
          await import(chrome.runtime.getURL('viewer/overleaf-save.js'));

        // Flush open editors into the model, then serialise THE MODEL — which
        // carries inserted and deleted cells as well as text edits.
        //
        // Outputs that no longer match their code are replaced by the fresh
        // result where there is one, and DROPPED otherwise: keeping them would
        // write a result the code cannot produce, labelled Out[n] as though it
        // were current.
        let clearedOutputs = 0;
        let savedOutputs = 0;
        for (const st of (lastStats?.cellStates || [])) {
          if (!st.cell) continue;
          if (st.code !== st.original) st.cell.value = st.code;
          if (!st.outputsStale) continue;
          let replacement = null;
          if (st.liveResult) {
            holdMessage('Capturing outputs…', 30000);
            try {
              replacement = await liveResultToOutput(st.liveResult, evaluator?.resolveAsset || null);
            } catch (e) { log('could not capture a live output', e); }
          }
          if (replacement) { st.cell.outputs = [replacement]; savedOutputs++; }
          else if ((st.cell.outputs || []).length) { st.cell.outputs = []; clearedOutputs++; }
        }
        const { text, changed } = serialiseModel(
          parsed, loadedSource, edits.size, structureDirty, clearedOutputs, savedOutputs);

        // A DOC is saved through CodeMirror, not uploaded.
        //
        // Dispatching a transaction is what typing does, so Overleaf's own OT
        // extension syncs it: the file entity is never replaced, the tree keeps
        // its id, and none of the "no file is selected" recovery below applies.
        // Uploading over a doc would instead leave the project with a doc and a
        // file of the same name — the state Overleaf itself refuses to create.
        if (docBacked) {
          const res = await askBridge('set-editor-doc', 4000, { text });
          if (!res || !res.ok) {
            note.textContent = res?.error || 'could not write into the Overleaf editor';
            holdMessage('Save failed', 6000);
            saveBtn.disabled = false;
            return;
          }
          // The model IS what is on screen now, so mark it clean in place
          // rather than re-rendering and dropping live outputs and open editors.
          loadedSource = text;
          for (const st of (lastStats?.cellStates || [])) {
            st.original = st.code;
            st.outputsStale = false;
          }
          structureDirty = false;
          holdMessage(`Saved — ${changed}`, 5000);
          note.textContent = `saved into the Overleaf document (${(text.length / 1024).toFixed(1)} KB)`;
          refreshSaveButton();
          saveBtn.disabled = false;
          return;
        }

        // Folder id, best source first: the project tree Overleaf itself
        // received over its websocket is authoritative, and also lets a notebook
        // in a SUBFOLDER be written back to that subfolder.
        let folderId = null;
        let folderSource = null;
        let found = { candidates: [] };

        const tree = await askBridge('get-project-tree', 2500);
        if (tree && tree.rootFolderId) {
          const owning = (tree.folders || []).find((f) => (f.fileNames || []).includes(fileName));
          folderId = owning ? owning.id : tree.rootFolderId;
          folderSource = owning ? `project tree (${owning.path})` : 'project tree (root)';
        }
        if (!folderId) {
          found = resolveFolderId(document, projectId);
          folderId = found.folderId;
          folderSource = found.source;
        }
        if (!folderId) {
          folderId = await fetchFolderIdFromApi(projectId);
          if (folderId) folderSource = '/entities';
        }
        if (!folderId) {
          folderId = await new Promise((r) => {
            try { chrome.storage.local.get('wbFolderIds', (v) => r((v?.wbFolderIds || {})[projectId] || null)); }
            catch (_) { r(null); }
          });
          if (folderId) folderSource = 'remembered';
        }
        if (!folderId) {
          diagnose('could not find the Overleaf folder id for saving\n'
            + `  project tree    : ${tree ? JSON.stringify(tree).slice(0, 160) : '(bridge did not answer)'}\n`
            + `  candidates seen : ${JSON.stringify(found.candidates)}\n`
            + '  The tree is read from Overleaf\'s own websocket, which is only\n'
            + '  captured if the page was loaded AFTER the extension. Reload the\n'
            + '  Overleaf tab and try again before entering anything by hand.');
          note.textContent = 'reload the Overleaf tab and try again — the project tree was not captured';
          const typed = await requestFolderId();
          if (!typed) throw new Error('No folder id — nothing was written.');
          folderId = typed;
          folderSource = 'entered by hand';
          try {
            const all = await new Promise((r) => chrome.storage.local.get('wbFolderIds', (v) => r(v?.wbFolderIds || {})));
            all[projectId] = folderId;
            chrome.storage.local.set({ wbFolderIds: all });
          } catch (_) {}
        }
        log('saving into folder', folderId, 'via', folderSource);

        const csrf = findCsrfToken(document);
        if (!csrf) throw new Error('No CSRF token on this page — reload Overleaf and try again.');

        const uploaded = await uploadFile({
          projectId, folderId, fileName,
          bytes: new TextEncoder().encode(text),
          csrfToken: csrf,
        });
        log('upload accepted', uploaded, 'folder', folderId, 'via', folderSource);

        // VERIFY, do not trust the 200. Overleaf answers {success:true} even
        // when the upload landed in a DIFFERENT folder, leaving the file on
        // screen untouched.
        //
        // RE-SELECT FIRST: replacing the entity leaves Overleaf with nothing
        // selected, which removes the Download link altogether, so polling for
        // it before re-selecting would always time out.
        holdMessage('Verifying…', 30000);
        provider.invalidate();
        suppressTeardownUntil = Date.now() + 20000;
        reselectFileInTree(fileName);

        let verified = false;
        const wantHash = String(uploaded.hash || '');
        const deadline = Date.now() + 12000;
        while (Date.now() < deadline) {
          const fv = probeFileView();
          if (fv && fv.name === fileName
              && wantHash && (fv.blobUrl || '').includes(wantHash)) { verified = true; break; }
          if (!wantHash) {
            try {
              const after = await provider.getSource(fileName, { force: true });
              verified = after.source.trim() === text.trim();
            } catch (_) {}
            break;
          }
          await new Promise((r) => setTimeout(r, 350));
          // Re-select whenever the view is CURRENTLY absent, not just until it
          // has been seen once: Overleaf drops it when the replaced entity lands.
          if (!probeFileView()) reselectFileInTree(fileName);
        }
        if (verified) loadedBlobUrl = (probeFileView() || {}).blobUrl || loadedBlobUrl;

        if (!verified) {
          note.textContent = `Overleaf accepted the upload but ${fileName} is unchanged — `
            + `it was probably written into the wrong folder (${folderId}, from ${folderSource}).`;
          holdMessage('Saved to wrong place?', 10000);
          diagnose(`upload accepted but the file did not change\n`
            + `  folder used     : ${folderId} (source: ${folderSource})\n`
            + `  entity returned : ${JSON.stringify(uploaded)}\n`
            + '  Check the project tree for a duplicate, and re-run the save with the\n'
            + '  correct folder id (the panel will ask if none can be found).');
          try {
            const all = await new Promise((r) => chrome.storage.local.get('wbFolderIds', (v) => r(v?.wbFolderIds || {})));
            if (all[projectId] === folderId) { delete all[projectId]; chrome.storage.local.set({ wbFolderIds: all }); }
          } catch (_) {}
          suppressTeardownUntil = 0;
          saveBtn.disabled = false;
          return;
        }

        // NO RE-RENDER: what is on screen already IS what was written, so
        // re-reading would cost scroll position, focus, open editors and every
        // live result. Mark the model clean in place instead.
        structureDirty = false;
        loadedSource = text;
        for (const st of (lastStats?.cellStates || [])) { st.original = st.code; st.outputsStale = null; }
        for (const el of nbRoot().querySelectorAll('.wb-edited-badge')) el.remove();
        for (const el of nbRoot().querySelectorAll('.wb-cell-edited')) el.classList.remove('wb-cell-edited');
        note.textContent = `saved ${changed} to Overleaf`;
        holdMessage('Saved ✓', 3000);
        saveBtn.disabled = false;
        refreshSaveButton();
        suppressTeardownUntil = 0;
      } catch (e) {
        suppressTeardownUntil = 0;
        note.textContent = `save failed: ${e.message}`;
        holdMessage('Save failed', 6000);
        log('save failed', e);
        saveBtn.disabled = false;
      }
    });
    openBtn.addEventListener('click', async () => {
      if (!parsed) return;
      const prev = openBtn.textContent;
      openBtn.disabled = true;
      openBtn.textContent = 'Opening…';
      try {
        // Flush open editors, so what lands on disk is what is on screen.
        for (const st of (lastStats?.cellStates || [])) {
          if (st.cell && st.code !== st.original) st.cell.value = st.code;
        }
        const text = JSON.stringify(parsed, null, 1) + '\n';

        // Written by wolfbook-serve rather than built through
        // wolfbook_newNotebook: that tool constructs cells from {kind, content}
        // and drops outputs entirely, so every plot and result in the notebook
        // would be lost on the way. These are the exact bytes.
        let localPath = null;
        const mat = await mcp({
          cmd: 'serve-materialise',
          notebook: {
            fileName,
            text,
            projectId,
            projectName: document.title.replace(/\s*-\s*Overleaf.*$/i, '').trim() || projectId,
          },
        });
        if (mat && mat.ok && mat.result) localPath = mat.result.path;

        if (localPath) {
          // Ask VS Code to open the file we just wrote. `overwrite` is on
          // purpose: this path is ours, and re-opening the same notebook should
          // refresh it rather than fail or pile up copies.
          const res = await mcp({
            cmd: 'mcp-call',
            name: 'wolfbook_newNotebook',
            args: { path: localPath, overwrite: false, target: true },
          });
          const opened = res && res.ok;
          note.textContent = opened
            ? `opened in VS Code — ${localPath}`
            : `written to ${localPath} (open it in VS Code yourself)`;
          openBtn.textContent = opened ? 'Opened ✓' : 'Written to disk';
        } else {
          // No local server: fall back to the cells-only route, and say what
          // that costs rather than quietly producing a lesser notebook.
          const cells = (parsed.cells || []).map((c) => ({
            kind: c.kind === 1 ? 'markdown' : 'code',
            content: String(c.value ?? ''),
          }));
          const res = await mcp({
            cmd: 'mcp-call',
            name: 'wolfbook_newNotebook',
            args: { path: `overleaf-import/${fileName}`, cells },
          });
          if (!(res && res.ok)) throw new Error(res?.error || 'could not open it');
          note.textContent = 'opened in VS Code without outputs '
            + '(start wolfbook-serve to copy the notebook whole)';
          openBtn.textContent = 'Opened (code only)';
        }
      } catch (e) {
        note.textContent = `could not open: ${e.message}`;
        openBtn.textContent = 'Failed';
        log('open in wolfbook failed', e);
      } finally {
        setTimeout(() => { openBtn.textContent = prev; openBtn.disabled = false; }, 3500);
      }
    });

    // ── agent access (MCP coalition) ─────────────────────────────────────
    //
    // wolfbook-serve represents this notebook in the coalition, so an agent's
    // tool call arrives here as an RPC. Everything below acts on the SAME live
    // model the person is editing — reading a stale snapshot would be worse than
    // useless — and every change is left UNSAVED. Saving to Overleaf remains the
    // person's own action, through the Save button.
    let attachedId = null;

    const agentBadge = (indices) => {
      for (const i of indices) {
        const cell = nbRoot().querySelectorAll('.wb-cell')[i];
        if (cell) cell.classList.add('wb-cell-edited');
      }
    };

    async function handleAgentRpc(req) {
      const { method, params = {} } = req;

      if (method === 'getContext') {
        // Flush open editors first, so an agent sees what the person sees.
        for (const st of (lastStats?.cellStates || [])) {
          if (st.cell && st.code !== st.original) st.cell.value = st.code;
        }
        return {
          path: fileName,
          projectId,
          cells: (parsed?.cells || []).map((c) => ({
            kind: c.kind,
            languageId: c.languageId,
            value: c.value,
            outputs: (c.outputs || []).map((o) => ({
              items: (o.items || []).map((it) => ({
                mime: it.mime,
                // Output HTML can be enormous; an agent wants the text.
                data: it.mime === 'text/plain' ? it.data : `(${it.mime}, ${String(it.data || '').length} chars)`,
              })),
            })),
          })),
        };
      }

      if (method === 'editCell') {
        const cell = parsed?.cells?.[params.index];
        if (!cell) throw new Error(`no cell ${params.index}`);
        mutate('agent edit', () => { cell.value = String(params.value ?? ''); });
        agentBadge([params.index]);
        return { summary: `edited cell ${params.index} — unsaved` };
      }

      if (method === 'insertCells') {
        const at = params.index == null ? (parsed.cells.length) : Number(params.index);
        mutate('agent insert', () => {
          parsed.cells.splice(at, 0, ...(params.cells || []).map((c) => ({
            kind: c.kind === 1 ? 1 : 2,
            value: String(c.value ?? ''),
            languageId: c.kind === 1 ? 'markdown' : 'wolfram',
            outputs: [],
            metadata: {},
          })));
        });
        agentBadge((params.cells || []).map((_, k) => at + k));
        return { summary: `inserted ${(params.cells || []).length} cell(s) at ${at} — unsaved` };
      }

      if (method === 'deleteCell') {
        if (!parsed?.cells?.[params.index]) throw new Error(`no cell ${params.index}`);
        mutate('agent delete', () => { parsed.cells.splice(params.index, 1); });
        return { summary: `deleted cell ${params.index} — undoable here until saved` };
      }

      if (method === 'moveCell') {
        const { from, to } = params;
        if (!parsed?.cells?.[from]) throw new Error(`no cell ${from}`);
        mutate('agent move', () => {
          const [c] = parsed.cells.splice(from, 1);
          parsed.cells.splice(Math.max(0, Math.min(to, parsed.cells.length)), 0, c);
        });
        return { summary: `moved cell ${from} → ${to}` };
      }

      if (method === 'runCell' || method === 'runCells') {
        const cells = [...nbRoot().querySelectorAll('.wb-cell')];
        const targets = method === 'runCell'
          ? [cells[params.index]].filter(Boolean)
          : cells.slice(params.start || 0, params.end == null ? undefined : params.end + 1);
        const runnable = targets.filter((c) => c.__wbRun);
        if (!runnable.length) throw new Error('no runnable code cell in that range');
        const results = [];
        for (const cell of runnable) {
          cell.scrollIntoView({ block: 'nearest' });
          const res = await cell.__wbRun();
          results.push(res);
        }
        const last = results[results.length - 1] || {};
        return {
          summary: `ran ${runnable.length} cell(s)`,
          text: last.text || '',
          messages: last.messages || [],
        };
      }

      throw new Error(`unknown method ${method}`);
    }

    // The background worker forwards agent requests here.
    // Guarded: agent access is an optional capability, and a context without
    // chrome.runtime.onMessage (or an older browser) must still get a working
    // notebook rather than a panel that fails to mount.
    if (!window.__wbRpcListener && chrome.runtime?.onMessage?.addListener) {
      window.__wbRpcListener = true;
      chrome.runtime.onMessage.addListener((m, _s, reply) => {
        if (m?.cmd !== 'wb-rpc' && m?.cmd !== 'wb-reattach') return;
        if (m.cmd === 'wb-reattach') {
          // The server came back (restarted, or started after this tab). Say we
          // are here again — attach is keyed on (project, file), so this is a
          // no-op when nothing was lost.
          attachToCoalition().catch(() => {});
          reply({ handled: true });
          return true;
        }
        if (!attachedId || m.req?.notebookId !== attachedId) { reply({ handled: false }); return true; }
        handleAgentRpc(m.req)
          .then((result) => reply({ handled: true, result }))
          .catch((e) => reply({ handled: true, error: String(e?.message || e) }));
        return true;                 // async reply
      });
    }

    /**
     * Keep trying to join the coalition.
     *
     * Attaching once at mount was not enough in either direction: the server
     * may not have been running yet when the notebook opened, and it may be
     * restarted while the tab sits there. Both end with an agent being told the
     * notebook does not exist while the user is looking straight at it. Attach
     * is keyed on (project, file), so re-announcing costs nothing when nothing
     * was lost.
     */
    let keepAttachedTimer = null;
    function keepAttached() {
      if (keepAttachedTimer) return;
      keepAttachedTimer = setInterval(() => {
        if (!document.getElementById(HOST_ID)) {
          clearInterval(keepAttachedTimer);
          keepAttachedTimer = null;
          return;
        }
        if (attachedId) return;
        attachToCoalition().catch(() => {});
      }, 20_000);
    }

    /** Tell wolfbook-serve this notebook exists, so agents can find it. */
    async function attachToCoalition() {
      const res = await mcp({
        cmd: 'serve-attach',
        notebook: {
          projectId,
          projectName: document.title.replace(/\s*-\s*Overleaf.*$/i, '').trim() || projectId,
          fileName,
        },
      });
      if (res && res.ok && res.result) {
        attachedId = res.result.notebookId;
        currentAttachedId = attachedId;
        log('attached to the coalition as', res.result.path);
      }
    }

    // ── notebook-level actions ───────────────────────────────────────────
    //
    // on() rather than querySelector(...).addEventListener: a toolbar button
    // that is missing from the markup then costs its own feature, instead of
    // throwing during mount and taking the whole notebook down with it.
    const on = (act, handler) => {
      const el = root.querySelector(`[data-act="${act}"]`);
      if (!el) { log(`toolbar button "${act}" is missing from the markup`); return null; }
      el.addEventListener('click', handler);
      return el;
    };

    on('undo', undo);

    on('wrap', (ev) => {
      // Long Wolfram lines are common and horizontal scrolling per cell is
      // tiring; this is the notebook's word-wrap toggle.
      const nb = nbRoot();
      const on = nb.classList.toggle('wb-wrap');
      ev.target.classList.toggle('active', on);
    });

    on('clear-all', () => {
      mutate('cleared all outputs', () => {
        for (const cell of parsed.cells) if (cell.kind === 2) cell.outputs = [];
      });
    });

    const interruptBtn = on('interrupt', async () => {
      interruptBtn.disabled = true;
      const res = await mcp({ cmd: 'serve-interrupt' });
      note.textContent = res && res.ok ? 'abort sent to the kernel' : 'could not abort';
      interruptBtn.disabled = false;
    }) || { hidden: true, disabled: false };

    /** Run a contiguous stretch, the way "Run above"/"Run below" do. */
    async function runRange(cells) {
      if (!cells.length) return;
      stopRequested = false;
      stopBtn.hidden = false;
      interruptBtn.hidden = false;
      let done = 0;
      for (const cell of cells) {
        if (stopRequested) break;
        cell.scrollIntoView({ block: 'nearest' });
        await cell.__wbRun();
        done++;
      }
      stopBtn.hidden = true;
      interruptBtn.hidden = true;
      note.textContent = `ran ${done}/${cells.length} cell(s)`;
    }

    const codeCells = () => [...nbRoot().querySelectorAll('.wb-cell-code')].filter((c) => c.__wbRun);

    // ── keyboard, matching the notebook's own bindings ───────────────────
    //
    // Shift-Enter and ⌘-Enter are the two everyone reaches for; ⌘S saves, and
    // ⌘Z undoes a cell operation. Bindings are ignored while a CodeMirror
    // editor has focus (it owns Shift-Enter itself) except for the ones that
    // are notebook-wide.
    shadow.addEventListener('keydown', (ev) => {
      const inEditor = ev.target.closest && ev.target.closest('.cm-editor');
      const mod = ev.metaKey || ev.ctrlKey;

      if (mod && ev.key.toLowerCase() === 's') {
        ev.preventDefault();
        if (!saveBtn.hidden && !saveBtn.disabled) saveBtn.click();
        return;
      }
      if (mod && ev.key.toLowerCase() === 'z' && !inEditor) {
        ev.preventDefault(); undo(); return;
      }
      if (inEditor) return;

      const cell = ev.target.closest && ev.target.closest('.wb-cell');
      if (ev.key === 'Enter' && (ev.shiftKey || mod) && cell && cell.__wbRun) {
        ev.preventDefault(); cell.__wbRun(); return;
      }
      if (ev.key === 'Escape') { ev.target.blur?.(); return; }
    });

    await render(false);

    // Did the panel actually end up where a person can see it?
    //
    // A panel mounted over the wrong container looks like a MISSING FEATURE,
    // not a bug: the notebook renders, so nothing throws, and the toolbar is
    // simply somewhere off screen or behind Overleaf's own chrome. That went
    // unnoticed until someone compared two files side by side. Measure it once
    // and say so plainly.
    requestAnimationFrame(() => {
      const bar = root.querySelector('.wb-toolbar');
      if (!bar) return;
      const b = bar.getBoundingClientRect();
      const h = host.getBoundingClientRect();
      // Hit-test the toolbar as well as measuring it: sitting UNDERNEATH
      // Overleaf's own bar leaves a perfectly good rectangle on screen while
      // being completely unclickable, which is exactly how Save and Run all
      // went missing without anything appearing to be wrong.
      const onTop = document.elementFromPoint(
        Math.min(b.left + 30, window.innerWidth - 1), Math.min(b.top + b.height / 2, window.innerHeight - 1));
      const covered = !!onTop && onTop !== host && !host.contains(onTop);
      const hidden = b.height < 10 || b.width < 100
        || b.bottom <= 0 || b.top >= window.innerHeight
        || b.top < h.top - 2 || covered;
      if (hidden) {
        diagnose('the panel mounted, but its toolbar is not usable — the pane it '
          + 'was mounted over is probably the wrong one\n'
          + `  covered by : ${covered ? (onTop.tagName + '.' + String(onTop.className || '')) : '(nothing)'}\n`
          + `  toolbar : ${JSON.stringify(b.toJSON ? b.toJSON() : { top: b.top, height: b.height })}\n`
          + `  host    : ${JSON.stringify(h.toJSON ? h.toJSON() : { top: h.top, height: h.height })}\n`
          + `  pane    : ${pane.tagName}${pane.id ? '#' + pane.id : ''}`
          + `${pane.className ? '.' + String(pane.className).split(/\s+/).join('.') : ''}`);
      }
    });
  }

  // ── selection tracking ────────────────────────────────────────────────────
  function sync() {
    const name = probeSelectedFile();
    const isWb = !!name && /\.wb$/i.test(name);
    // The save window suppresses TEARDOWN only, never mounting. It used to skip
    // sync() wholesale, so for its 30 seconds the extension also ignored the
    // user opening a different notebook — a save made the panel briefly deaf.
    if (!isWb && currentFile && Date.now() < suppressTeardownUntil) return;
    if (isWb && name !== currentFile) {
      currentFile = name;
      lastMountError = null;
      // mount() is async: an exception inside it would otherwise become an
      // unhandled rejection with no visible symptom beyond a missing panel.
      mount(name).catch((e) => {
        lastMountError = String((e && e.message) || e);
        diagnose(`mounting "${name}" threw: ${lastMountError}`);
      });
    } else if (!isWb && currentFile) {
      // Overleaf briefly has NOTHING selected while a save is in flight: the
      // upload replaces the file entity, so the tree drops the old id before
      // the new one appears. That is what the window above protects.
      currentFile = null;
      teardown();
    }
  }

  let timer = null;
  const observer = new MutationObserver(() => {
    clearTimeout(timer);
    timer = setTimeout(sync, 150);
  });

  function start() {
    console.info(`[wolfbook] active on ${location.pathname}. If a .wb does not open, this `
      + 'console will report why every few seconds; __wolfbookDiagnose("download") '
      + 'saves a full report to a file.');
    observer.observe(document.body, {
      subtree: true, childList: true,
      attributes: true, attributeFilter: ['class', 'aria-selected'],
    });
    sync();

    // Once the SPA has settled, report unconditionally if there is still no
    // panel. The earlier version also required currentFile to be unset, so the
    // most interesting case — file detected, mount silently failed — printed
    // nothing at all.
    startPeriodicDiagnosis();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();
