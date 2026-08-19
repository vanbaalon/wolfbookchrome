// page-bridge.js — runs in the PAGE (MAIN) world.
//
// Two jobs, both about reaching things the isolated world cannot:
//
//   1. Read Overleaf's CodeMirror document, for the case where Overleaf treats
//      the .wb as an editable text file. (It usually does not — .wb is
//      classified as a binary file and shown as "no preview available" — so
//      this is a fast path, not the main one.) Uses the unofficial but
//      long-stable CM6 back-reference: the .cm-content node carries `cmView`,
//      whose `.view` is the EditorView.
//
//   2. Expose `__wolfbookDiagnose()` on the PAGE's window. A content script's
//      own globals live in the isolated world, so calling it from DevTools
//      requires switching the console's context dropdown — which is exactly the
//      step someone debugging a blank panel should not have to discover. This
//      forwards the request to the content script and prints its reply.

(() => {
  const REQ = 'wb-bridge-request';
  const RES = 'wb-bridge-response';

  // ── the project's folder structure ──────────────────────────────────────
  //
  // Saving needs a FOLDER id, and it is not derivable from the project id, not
  // in the URL, and not in any meta tag. Asking the user for it is not a real
  // answer — Overleaf's own client never asks, because it is told: the
  // `joinProject` payload on the websocket carries the whole tree, rootFolder
  // and every `_id` included.
  //
  // So we learn it exactly where the app learns it. That is why this script runs
  // at document_start: the hook has to be installed BEFORE Overleaf opens its
  // socket, or the one message that matters has already gone by.
  const project = { rootFolderId: null, folders: [], raw: null };

  /** Pull rootFolder/_id out of any parsed Overleaf payload. */
  function absorb(value) {
    if (!value || typeof value !== 'object') return;
    const roots = value.rootFolder || value.project?.rootFolder;
    const root = Array.isArray(roots) ? roots[0] : roots;
    if (root && typeof root._id === 'string') {
      project.rootFolderId = root._id;
      project.folders = [];
      // Record every folder, so a file that lives in a subfolder can be matched
      // by path rather than assumed to be at the root.
      // `null` marks the root, so its children are not also labelled "/" —
      // otherwise every folder reports the same path and the message telling the
      // user where their file went is wrong.
      const walk = (folder, prefix) => {
        if (!folder || typeof folder !== 'object') return;
        const path = prefix === null ? '/'
          : prefix === '/' ? `/${folder.name}`
          : `${prefix}/${folder.name}`;
        project.folders.push({
          id: folder._id,
          path,
          fileNames: [
            ...(folder.docs || []).map((d) => d.name),
            ...(folder.fileRefs || []).map((f) => f.name),
          ].filter(Boolean),
        });
        for (const sub of folder.folders || []) walk(sub, path);
      };
      walk(root, null);
    }
  }

  /** Walk a parsed payload looking for a rootFolder anywhere inside it. */
  function deepAbsorb(value, depth = 0) {
    if (!value || typeof value !== 'object' || depth > 8) return;
    absorb(value);
    if (project.rootFolderId) return;
    for (const child of Array.isArray(value) ? value : Object.values(value)) {
      deepAbsorb(child, depth + 1);
      if (project.rootFolderId) return;
    }
  }

  /**
   * Overleaf speaks socket.io, so a frame is JSON behind a protocol prefix —
   * `5:::{…}` in v0.9, `42[…]` in engine.io v3+. Slicing at the first `[` is
   * wrong: that bracket is usually the one in `"args":[`, and the tail then
   * fails to parse. Try each plausible start instead, and search the result
   * recursively rather than assuming a fixed shape.
   */
  function sniff(text) {
    if (typeof text !== 'string' || !text.includes('rootFolder')) return;
    const starts = [];
    const tri = text.indexOf(':::');
    if (tri >= 0) starts.push(tri + 3);
    const brack = text.indexOf('[');
    if (brack >= 0) starts.push(brack);
    const brace = text.indexOf('{');
    if (brace >= 0) starts.push(brace);
    starts.push(0);

    for (const at of starts) {
      let parsed;
      try { parsed = JSON.parse(text.slice(at)); } catch (_) { continue; }
      deepAbsorb(parsed);
      if (project.rootFolderId) { project.raw = 'websocket joinProject'; return; }
    }
  }

  const RealWebSocket = window.WebSocket;
  if (RealWebSocket && !RealWebSocket.__wbHooked) {
    const Hooked = function (...args) {
      const ws = new RealWebSocket(...args);
      ws.addEventListener('message', (ev) => { try { sniff(ev.data); } catch (_) {} });
      return ws;
    };
    Hooked.prototype = RealWebSocket.prototype;
    Object.assign(Hooked, RealWebSocket);
    Hooked.__wbHooked = true;
    try { window.WebSocket = Hooked; } catch (_) {}
  }

  /** Late fallback: the app may also hang the tree off a global. */
  function scanGlobals() {
    if (project.rootFolderId) return;
    for (const key of ['_ide', 'ide', '__overleaf', 'overleaf']) {
      const g = window[key];
      if (!g || typeof g !== 'object') continue;
      absorb(g);
      absorb(g.$scope);
      absorb(g.$scope?.project);
      if (project.rootFolderId) { project.raw = `window.${key}`; return; }
    }
  }

  /** The CodeMirror belonging to the visible tab, never a retained old tab. */
  function activeEditorView() {
    const candidates = [...document.querySelectorAll('.cm-content')]
      .filter((el) => el.cmView?.view);
    const visible = candidates.filter((el) => {
      for (let n = el; n && n !== document.body; n = n.parentElement) {
        if (n.hidden || n.getAttribute?.('aria-hidden') === 'true') return false;
        const s = getComputedStyle(n);
        if (s.display === 'none' || s.visibility === 'hidden') return false;
      }
      const r = (el.closest('.cm-editor') || el).getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
    // During a React handoff both nodes can exist briefly; the newly mounted
    // editor is last in DOM order. With several invisible retained editors,
    // refusing is safer than writing into the first one.
    const content = visible.at(-1) || (candidates.length === 1 ? candidates[0] : null);
    return content?.cmView?.view || null;
  }

  /**
   * Replace the whole CodeMirror document.
   *
   * This is how a .wb that Overleaf holds as a DOC (anything created inside
   * Overleaf rather than uploaded) is saved: dispatching a transaction is
   * exactly what typing does, so Overleaf's own OT extension picks the change
   * up and syncs it — no upload, no replaced file entity, and therefore none of
   * the re-selection dance the binary path needs.
   */
  function setEditorDoc(text, expect) {
    const view = activeEditorView();
    if (!view) return { ok: false, error: 'no CodeMirror editor is open' };

    // REFUSE UNLESS THE DOCUMENT IS THE ONE WE READ.
    //
    // This selector finds whichever document Overleaf currently has open — not
    // necessarily the notebook. Writing blind therefore risks replacing the
    // contents of a completely different file, which is unrecoverable except
    // through Overleaf's history. So the caller states what it expects to find,
    // and an exact match is the licence to overwrite: same bytes, same
    // document. It doubles as the freshness check, since a collaborator editing
    // the file meanwhile also fails the comparison.
    const current = view.state.doc.toString();
    if (typeof expect === 'string' && current !== expect) {
      return {
        ok: false,
        mismatch: true,
        error: 'the editor is not showing the document this notebook was read from '
          + `(it holds ${current.length} bytes, expected ${expect.length}). Nothing was written.`,
      };
    }
    try {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: String(text) } });
      return { ok: true, length: String(text).length };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  }

  function getEditorDoc() {
    const view = activeEditorView();
    if (!view) return null;
    try { return view.state.doc.toString(); } catch (_) { return null; }
  }

  window.addEventListener('message', (ev) => {
    if (ev.source !== window || !ev.data) return;

    if (ev.data.type === REQ) {
      const { id, action, data } = ev.data;
      let payload = null;
      if (action === 'get-editor-doc') payload = { doc: getEditorDoc() };
      else if (action === 'set-editor-doc') payload = setEditorDoc(data && data.text, data && data.expect);
      else if (action === 'get-project-tree') {
        scanGlobals();
        payload = {
          rootFolderId: project.rootFolderId,
          folders: project.folders,
          source: project.raw,
        };
      }
      window.postMessage({ type: RES, id, payload }, window.location.origin);
      return;
    }

    if (ev.data.type === 'wb-diagnose-result') {
      console.info(ev.data.text);
    }
  });

  /**
   * __wolfbookDiagnose()           short report in the console
   * __wolfbookDiagnose('full')     …plus a DOM outline of the relevant regions
   * __wolfbookDiagnose('download') save the full report as a .txt file
   */
  window.__wolfbookDiagnose = function (mode) {
    window.postMessage({ type: 'wb-diagnose-request', mode: mode || 'short' },
                       window.location.origin);
    return mode === 'download'
      ? 'saving wolfbook-overleaf-diagnostics.txt…'
      : 'asking the Wolfbook content script — its report follows below.';
  };
})();
