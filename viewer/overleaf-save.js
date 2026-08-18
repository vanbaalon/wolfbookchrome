// overleaf-save.js — write a .wb back to the Overleaf project.
//
// Uses Overleaf's OWN upload endpoint, captured from its drag-and-drop UI:
//
//   POST /project/<projectId>/upload?folder_id=<folderId>
//     x-csrf-token: <from the page>
//     multipart/form-data:
//       relativePath    "null"
//       targetFolderId  <folderId>
//       name            "<file>.wb"
//       type            "application/octet-stream"
//       qqfile          the bytes            (Fine Uploader's field name)
//
// Uploading the SAME name into the SAME folder REPLACES the file and creates a
// new version — confirmed by re-uploading an existing file and observing the
// identical request, with no delete and no separate update call.
//
// WHY NOT the OT websocket: that is how *text* documents sync. A .wb is
// classified binary by Overleaf and has no OT document at all — the capture
// showed no websocket frames — so this endpoint is the native path, not a
// workaround.
//
// The session cookie is never touched: the request is same-origin, so the
// browser attaches it. Only the CSRF token has to be found, and it is in the page.

/** Overleaf puts its CSRF token in a meta tag; the name has changed over time. */
export function findCsrfToken(doc = document) {
  const metas = ['ol-csrfToken', 'csrf-token', '_csrf'];
  for (const name of metas) {
    const v = doc.querySelector(`meta[name="${name}"]`)?.getAttribute('content');
    if (v) return v;
  }
  const input = doc.querySelector('input[name="_csrf"]')?.value;
  if (input) return input;
  return null;
}

/**
 * The folder to write into.
 *
 * Overleaf needs an entity id, which is not derivable from the project id, so
 * this tries the places it is exposed and reports what it saw when it fails —
 * a wrong guess here would write the file into the wrong folder.
 */
const OBJECT_ID = /^[0-9a-f]{24}$/;

/**
 * The folder to write into.
 *
 * Overleaf needs an entity id, and it is NOT derivable from the project id — in
 * one capture the root folder was …aab while the project was …aac, which merely
 * reflects the order Mongo minted them, not a rule. So this hunts through every
 * place Overleaf is known to expose it, in order of trustworthiness, and reports
 * everything it saw when it fails: writing into the wrong folder would be worse
 * than not writing at all.
 *
 * @returns {{folderId: string|null, source: string|null, candidates: object[]}}
 */
export function resolveFolderId(doc = document, projectId = null) {
  const candidates = [];
  const consider = (source, value, weight) => {
    if (!value || !OBJECT_ID.test(value)) return;
    if (projectId && value === projectId) return;      // the project is not a folder
    candidates.push({ source, value, weight });
  };

  // 1. Explicit meta tags, highest trust.
  for (const name of ['ol-rootFolderId', 'ol-rootFolder_id']) {
    consider(`meta[${name}]`, doc.querySelector(`meta[name="${name}"]`)?.getAttribute('content'), 100);
  }

  // 2. Any ol-* meta whose JSON carries a rootFolder / _id.
  for (const meta of doc.querySelectorAll('meta[name^="ol-"]')) {
    const content = meta.getAttribute('content') || '';
    if (!content.includes('_id')) continue;
    try {
      const parsed = JSON.parse(content);
      const roots = Array.isArray(parsed) ? parsed : [parsed];
      for (const r of roots) {
        consider(`meta[${meta.getAttribute('name')}]._id`, r?._id, 90);
        consider(`meta[${meta.getAttribute('name')}].rootFolder`, r?.rootFolder?.[0]?._id, 95);
        consider(`meta[${meta.getAttribute('name')}].rootDoc`, r?.rootFolder?._id, 90);
      }
    } catch (_) {
      // Not JSON — still scan it for an id labelled as a root folder.
      const m = /rootFolder[^0-9a-f]{0,20}([0-9a-f]{24})/.exec(content);
      consider(`meta[${meta.getAttribute('name')}] (regex)`, m && m[1], 70);
    }
  }

  // 3. The file tree, but ONLY attributes that mean "folder".
  //
  // `data-file-id` is emphatically NOT one of them: it identifies a FILE, and
  // passing one as folder_id makes Overleaf accept the upload and put the
  // notebook somewhere else entirely — observed in the wild, with the original
  // left untouched. A wrong id here is worse than no id, because it looks like
  // it worked. So no attribute is used unless its name says "folder".
  for (const sel of ['[data-folder-id]', '.file-tree [data-type="folder"][id]']) {
    for (const el of doc.querySelectorAll(sel)) {
      consider(sel, el.dataset?.folderId || (el.id || '').replace(/^entity-/, ''), 60);
    }
  }

  // 4. Inline scripts sometimes embed the project payload.
  for (const script of doc.querySelectorAll('script:not([src])')) {
    const text = script.textContent || '';
    if (text.length > 400000 || !text.includes('rootFolder')) continue;
    const m = /"rootFolder"\s*:\s*\[?\s*\{\s*"_id"\s*:\s*"([0-9a-f]{24})"/.exec(text);
    consider('inline script rootFolder', m && m[1], 80);
  }

  candidates.sort((a, b) => b.weight - a.weight);
  const best = candidates[0];
  return { folderId: best ? best.value : null, source: best ? best.source : null, candidates };
}

/**
 * Ask Overleaf directly which entities the project has.
 *
 * Used only as a fallback: it is an authenticated same-origin GET, and some
 * deployments expose folder ids here even when the page does not.
 */
export async function fetchFolderIdFromApi(projectId) {
  try {
    const res = await fetch(`/project/${encodeURIComponent(projectId)}/entities`,
      { credentials: 'same-origin', headers: { accept: 'application/json' } });
    if (!res.ok) return null;
    const body = await res.json();
    const raw = JSON.stringify(body);
    const m = /"(?:folder_id|folderId|_id)"\s*:\s*"([0-9a-f]{24})"/.exec(raw);
    return m ? m[1] : null;
  } catch (_) { return null; }
}

/**
 * Upload (and thereby replace) one file.
 *
 * @param {{projectId, folderId, fileName, bytes, csrfToken}} opts
 * @returns {Promise<object>} Overleaf's JSON response
 */
export async function uploadFile({ projectId, folderId, fileName, bytes, csrfToken }) {
  if (!projectId) throw new Error('no project id');
  if (!folderId) throw new Error('no folder id — cannot tell Overleaf where to write');
  if (!csrfToken) throw new Error('no CSRF token found on the page');

  const form = new FormData();
  form.append('relativePath', 'null');
  form.append('targetFolderId', folderId);
  form.append('name', fileName);
  form.append('type', 'application/octet-stream');
  // Field name and content-type mirror what Overleaf's own uploader sends.
  form.append('qqfile', new Blob([bytes], { type: 'application/octet-stream' }), fileName);

  const res = await fetch(
    `/project/${encodeURIComponent(projectId)}/upload?folder_id=${encodeURIComponent(folderId)}`,
    {
      method: 'POST',
      credentials: 'same-origin',      // the session cookie rides along
      headers: { 'x-csrf-token': csrfToken },   // content-type is set by FormData
      body: form,
    });

  if (!res.ok) throw new Error(`Overleaf refused the upload (HTTP ${res.status})`);
  let body = null;
  try { body = await res.json(); } catch (_) {}
  if (body && body.success === false) throw new Error(body.error || 'Overleaf reported failure');
  return body || {};
}

/**
 * Serialise the live notebook model for upload.
 *
 * The MODEL is the source of truth, not a patch over the original text, because
 * inserting and deleting cells cannot be expressed as a per-cell value patch.
 * Every field the viewer never touches — outputs, ids, metadata, top-level keys —
 * is still carried through untouched, since the model IS the parsed original
 * with only the user's changes applied to it.
 *
 * `JSON.stringify(_, null, 1)` matches the wolfbook serialiser's own formatting,
 * so an unchanged notebook round-trips without churning every line.
 *
 * @param {object} model     the parsed .wb, already mutated
 * @param {string} originalSource for the no-op check
 * @param {number} editedCells how many cells had their text changed
 * @param {boolean} structural whether cells were added or removed
 */
export function serialiseModel(model, originalSource, editedCells = 0, structural = false,
                               clearedOutputs = 0, savedOutputs = 0) {
  const text = JSON.stringify(model, null, 1) + '\n';
  const cellDelta = (() => {
    try { return model.cells.length - JSON.parse(originalSource).cells.length; }
    catch (_) { return 0; }
  })();
  const parts = [];
  if (editedCells) parts.push(`${editedCells} cell${editedCells === 1 ? '' : 's'}`);
  if (cellDelta > 0) parts.push(`+${cellDelta} new`);
  if (cellDelta < 0) parts.push(`${-cellDelta} removed`);
  if (savedOutputs) parts.push(`${savedOutputs} new output${savedOutputs === 1 ? '' : 's'}`);
  if (clearedOutputs) parts.push(`${clearedOutputs} stale output${clearedOutputs === 1 ? '' : 's'} cleared`);
  return { text, changed: parts.join(', ') || (structural ? 'changes' : 'nothing') };
}

/**
 * Apply edited cell code back into the notebook JSON.
 *
 * ONLY `value` on the cells that changed. Outputs, ids, metadata and every
 * untouched cell are preserved exactly, so a save produces a minimal diff and
 * never invents outputs — the stored outputs belong to the author's own run, and
 * results computed in this browser reference images that exist only in a temp
 * directory on the reader's machine.
 *
 * @param {string} originalSource the .wb text as fetched
 * @param {Map<number, string>} edits cell index → new code
 * @returns {{text: string, changed: number}}
 */
export function applyEdits(originalSource, edits) {
  const wb = JSON.parse(originalSource);
  let changed = 0;
  for (const [index, code] of edits) {
    const cell = wb.cells?.[index];
    if (!cell || cell.value === code) continue;
    cell.value = code;
    changed++;
  }
  // Match the serializer's formatting so unrelated lines do not churn.
  return { text: JSON.stringify(wb, null, 1) + '\n', changed };
}

/**
 * Turn a live evaluation into a stored .wb output.
 *
 * The kernel writes images to a temp directory on the local machine and refers
 * to them as `img/wl_….svg`. Those files cannot travel with the notebook into
 * Overleaf, so the pictures are INLINED as data: URIs and the notebook becomes
 * self-contained. That trades a larger file for one that renders anywhere —
 * including for a collaborator who has no Wolfram at all, which is the whole
 * point of the outputs being in the file.
 *
 * Deliberately dropped on the way in:
 *   data-wl-img            an absolute path on this machine; meaningless
 *                          elsewhere, and mildly identifying.
 *   data-session-epoch     the VS Code renderer deletes elements whose epoch is
 *                          not the current session, so a stale one would make
 *                          the output vanish when the notebook is opened there.
 *   data-wl-plot-src /     the 2D-tooltip and 3D-mesh sidecars. They point at
 *   data-wl-mesh-src       files we are not shipping; the static picture stays,
 *                          which is exactly the documented fallback.
 *
 * @param {{html: string, text: string}} result
 * @param {(rel: string) => string|null} resolveAsset  maps img/… to a fetchable URL
 * @returns {Promise<object|null>} a .wb output object
 */
export async function liveResultToOutput(result, resolveAsset) {
  const html = String(result?.html || '');
  const text = String(result?.text || '');
  if (!html.trim() && !text.trim()) return null;

  let finalHtml = html;
  if (html.trim()) {
    const doc = new DOMParser().parseFromString(html, 'text/html');

    for (const img of doc.querySelectorAll('img')) {
      const src = img.getAttribute('src') || '';
      img.removeAttribute('data-wl-img');
      img.removeAttribute('data-wl-plot-src');
      img.removeAttribute('data-wl-mesh-src');
      img.removeAttribute('data-wl-plot');
      img.removeAttribute('data-wl-mesh');
      if (/^(data:|https?:)/i.test(src)) continue;
      const url = resolveAsset ? resolveAsset(src) : null;
      if (!url) continue;
      try {
        const res = await fetch(url);
        if (!res.ok) continue;
        const blob = await res.blob();
        img.setAttribute('src', await blobToDataUrl(blob));
      } catch (_) { /* leave the relative src; the text form still carries it */ }
    }

    for (const el of doc.querySelectorAll('[data-session-epoch]')) {
      el.removeAttribute('data-session-epoch');
    }
    finalHtml = doc.body.innerHTML;
  }

  const items = [];
  if (finalHtml.trim()) items.push({ mime: 'x-application/wolfram-language-html', data: finalHtml });
  if (text.trim()) items.push({ mime: 'text/plain', data: text });
  if (!items.length) return null;
  return { items, id: cryptoRandomId() };
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result));
    fr.onerror = reject;
    fr.readAsDataURL(blob);
  });
}

function cryptoRandomId() {
  try { return crypto.randomUUID(); } catch (_) {}
  return 'wb-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}
