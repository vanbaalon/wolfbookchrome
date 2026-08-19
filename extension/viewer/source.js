// source.js — obtaining the bytes of the selected .wb (and its images) from
// Overleaf. Isolated behind one function so the acquisition strategy can change
// without touching the viewer or the UI.
//
// STRATEGY — two sources, because they answer different questions.
//
//   THE NOTEBOOK: GET /project/<id>/blob/<sha>, the href of the Download link
//   Overleaf itself renders in its binary-file view. Same-origin, cookie-authed,
//   exact (no matching a basename against project paths), and small.
//
//   THE IMAGES: GET /project/<id>/download/zip, unzipped with the browser-native
//   DecompressionStream. Outputs reference img/<nb>/… as separate project files,
//   and the zip is the one read path that returns them. It is fetched LAZILY —
//   only when the notebook actually references an image — so a text-only
//   notebook never pays for a whole-project download.
//
// Considered and deliberately not used for Phase 1:
//   * git.overleaf.com — the right transport for WRITING back later (see the
//     plan doc), but for reading it needs a premium-plan token, a token UI, and
//     a full smart-HTTP + packfile client in the browser, to deliver the same
//     bytes these two endpoints already give us for free.
//   * CodeMirror document — no images, and it only exists when Overleaf treats
//     .wb as an editable text file (it usually does not). Kept as a fast path.
//   * websocket / OT interception — most fragile of all; not attempted.

import { readZip } from './zip.js';

const ZIP_TTL_MS = 60_000;

/** @param {string} projectId */
export function createSourceProvider(projectId, { askBridge } = {}) {
  let zipCache = null; // { at, entries }
  // A doc save reaches Overleaf through CodeMirror before a subsequent project
  // archive request is guaranteed to observe it. Remember only sources which
  // were first tied to an unambiguous archive entry, and update that same
  // identity after a verified save.
  const namedSourceCache = new Map(); // visible tab name -> { path, source }

  async function fetchZip(force) {
    if (!force && zipCache && Date.now() - zipCache.at < ZIP_TTL_MS) return zipCache.entries;
    const res = await fetch(`/project/${projectId}/download/zip`, { credentials: 'same-origin' });
    if (!res.ok) {
      throw new Error(res.status === 403 || res.status === 401
        ? 'Overleaf refused the project download (not signed in, or no access to this project).'
        : `Could not download the project zip (HTTP ${res.status}).`);
    }
    const entries = await readZip(await res.arrayBuffer());
    zipCache = { at: Date.now(), entries };
    return entries;
  }

  /**
   * Overleaf's file tree shows a basename; the zip holds full paths. Prefer an
   * exact match, then a unique suffix match, then bail with a clear message
   * rather than guessing between same-named files in different folders.
   */
  function locate(entries, fileName) {
    if (entries.has(fileName)) return fileName;
    const matches = [...entries.keys()].filter((p) => p.endsWith('/' + fileName));
    if (matches.length === 1) return matches[0];
    if (matches.length === 0) {
      throw new Error(`"${fileName}" is not in the downloaded project. If you just added it, hit ⟳ to refetch.`);
    }
    throw new Error(`Several project files are named "${fileName}" (${matches.join(', ')}). `
      + 'Wolfbook will not guess which one belongs to this tab.');
  }

  async function getNamedSource(fileName, force) {
    if (!force && namedSourceCache.has(fileName)) return namedSourceCache.get(fileName);
    const entries = await fetchZip(force);
    const p = locate(entries, fileName);
    const named = { path: p, source: new TextDecoder().decode(entries.get(p)) };
    namedSourceCache.set(fileName, named);
    return named;
  }

  return {
    /**
     * Fetch just the notebook's text.
     *
     * @param {string} fileName basename as shown by Overleaf
     * @param {{blobUrl?: string|null, force?: boolean, preferEditor?: boolean,
     *          docBacked?: boolean, verifyFileName?: boolean}} [opts]
    * @returns {Promise<{source:string, from:string}>}
     */
    async getSource(fileName, opts = {}) {
      // A binary-file view gives us the strongest identity available: the
      // Download link names the file and points at its content-addressed bytes.
      // Overleaf may retain a perfectly valid CodeMirror document for a text
      // tab underneath that view; consulting it first is exactly how test.wb
      // appeared under a WaveFunctionDemo.wb title.
      if (opts.blobUrl) {
        const res = await fetch(opts.blobUrl, { credentials: 'same-origin' });
        if (res.ok) return { source: await res.text(), from: `blob (${fileName})`, path: fileName };
        console.warn('[wolfbook] blob fetch failed', res.status, '— falling back to the project zip');
        const named = await getNamedSource(fileName, !!opts.force);
        return { source: named.source, from: `zip (${named.path})`, path: named.path };
      }

      // Capture the visible editor as a candidate, never as proof of identity.
      // `docBacked` means Overleaf holds this .wb as an editable document, but
      // its SPA can change the active tab title before replacing CodeMirror's
      // buffer. The archive comparison below binds those bytes to the filename.
      let editorDoc;
      if ((opts.preferEditor || opts.docBacked) && askBridge) {
        const bridge = await askBridge('get-editor-doc');
        editorDoc = bridge && bridge.doc;
      }

      // A visible CodeMirror instance proves only that *an* Overleaf document
      // is mounted. React may retain/swap editors after it has already changed
      // the active tab title, so accepting that buffer can put test.wb under a
      // WaveFunctionDemo.wb heading. For a doc-backed notebook, bind the bytes
      // to the active tab's filename through the project's own archive first.
      if (opts.docBacked && opts.verifyFileName) {
        const named = await getNamedSource(fileName, !!opts.force);
        const editorMatches = typeof editorDoc === 'string' && editorDoc === named.source;
        return {
          source: editorMatches ? editorDoc : named.source,
          from: editorMatches ? `editor (verified as ${named.path})` : `project archive (${named.path})`,
          path: named.path,
          verifiedName: true,
          editorMismatch: typeof editorDoc === 'string' && !editorMatches,
        };
      }

      if (typeof editorDoc === 'string'
          && (!opts.docBacked ? editorDoc.trimStart().startsWith('{') : true)) {
        return { source: editorDoc, from: 'editor' };
      }

      const named = await getNamedSource(fileName, !!opts.force);
      return { source: named.source, from: `zip (${named.path})`, path: named.path };
    },

    /**
     * Fetch the project archive so notebook-relative images can be resolved.
     * Only worth calling when the notebook actually references one.
     *
     * @returns {Promise<{entries: Map<string, Uint8Array>, dir: string}>}
     */
    async getAssets(fileName, opts = {}) {
      const entries = await fetchZip(!!opts.force);
      let dir = '';
      try {
        const p = locate(entries, fileName);
        dir = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '';
      } catch (_) {
        // The notebook itself may be absent (fetched via blob); images are
        // still resolvable relative to the project root.
      }
      return { entries, dir };
    },

    /** Keep the verified filename binding coherent after a successful doc save. */
    remember(fileName, source) {
      const known = namedSourceCache.get(fileName);
      if (known) namedSourceCache.set(fileName, { path: known.path, source });
    },

    invalidate() {
      zipCache = null;
      namedSourceCache.clear();
    },
  };
}

/**
 * Does this notebook reference any project image? Outputs point at
 * img/<notebook>/… ; markdown cells may use ![](img/…). Checked against the raw
 * source so the whole-project download can be skipped when the answer is no.
 */
export function referencesAssets(source) {
  return /(?:src=|url\(|\]\()\\?["']?img\//.test(source);
}
