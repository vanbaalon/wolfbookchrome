// capture-overleaf-writes.js
//
// Paste this into the DevTools console on an Overleaf project page (context:
// "top"), then perform ONE write action. It records how Overleaf itself does it,
// so a "Save to Overleaf" button can replicate exactly that rather than a guess.
//
// WHAT TO DO AFTER PASTING
//   1. Drag a small .wb onto the file tree, replacing one that already exists
//      (or right-click the file → Upload/Replace, if your Overleaf offers it).
//   2. Run  __wbWrites.dump()  and send the output.
//
// It hooks fetch, XMLHttpRequest and WebSocket sends, and prints only
// state-changing traffic — no document content is echoed, just shapes: method,
// URL, header names, form-field names and sizes. Read-only GETs are skipped.
//
// Nothing is sent anywhere; it lives in the page until you reload.

(() => {
  const writes = [];
  const MAX = 200;

  const interesting = (method, url) =>
    method && !/^(GET|HEAD|OPTIONS)$/i.test(method) && !/__result|analytics|telemetry/i.test(url);

  const describeBody = (body) => {
    if (body == null) return null;
    if (typeof body === 'string') {
      return { kind: 'string', bytes: body.length, preview: body.slice(0, 120) };
    }
    if (body instanceof FormData) {
      // Field NAMES and sizes only — the file's contents are yours.
      return {
        kind: 'FormData',
        fields: [...body.entries()].map(([k, v]) => (v instanceof File
          ? { name: k, file: v.name, type: v.type, bytes: v.size }
          : { name: k, value: String(v).slice(0, 80) })),
      };
    }
    if (body instanceof Blob) return { kind: 'Blob', type: body.type, bytes: body.size };
    if (body instanceof ArrayBuffer) return { kind: 'ArrayBuffer', bytes: body.byteLength };
    try { return { kind: 'json', preview: JSON.stringify(body).slice(0, 160) }; } catch (_) {}
    return { kind: typeof body };
  };

  const record = (entry) => {
    if (writes.length < MAX) writes.push({ t: new Date().toISOString(), ...entry });
    console.log('[wb-capture]', entry.via, entry.method || '', entry.url || '', entry.body || '');
  };

  // ── fetch ────────────────────────────────────────────────────────────────
  const realFetch = window.fetch;
  window.fetch = function (input, init = {}) {
    try {
      const url = typeof input === 'string' ? input : input?.url;
      const method = (init.method || (typeof input === 'object' && input?.method) || 'GET').toUpperCase();
      if (interesting(method, url)) {
        record({
          via: 'fetch', method, url,
          headers: Object.keys(Object.fromEntries(new Headers(init.headers || {}).entries())),
          body: describeBody(init.body),
        });
      }
    } catch (_) {}
    return realFetch.apply(this, arguments);
  };

  // ── XMLHttpRequest (Overleaf's uploader has historically used this) ───────
  const realOpen = XMLHttpRequest.prototype.open;
  const realSend = XMLHttpRequest.prototype.send;
  const realSetHeader = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__wb = { method: String(method || '').toUpperCase(), url: String(url || ''), headers: [] };
    return realOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    if (this.__wb) {
      this.__wb.headers.push(/csrf|token/i.test(name) ? `${name}: <${String(value).length} chars>` : name);
    }
    return realSetHeader.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function (body) {
    try {
      if (this.__wb && interesting(this.__wb.method, this.__wb.url)) {
        record({ via: 'xhr', ...this.__wb, body: describeBody(body) });
        this.addEventListener('load', () => {
          record({ via: 'xhr-response', method: this.__wb.method, url: this.__wb.url,
                   status: this.status, body: { kind: 'text', preview: String(this.responseText || '').slice(0, 200) } });
        }, { once: true });
      }
    } catch (_) {}
    return realSend.apply(this, arguments);
  };

  // ── websocket (this is where TEXT edits go — shown so we can rule it out) ─
  const realWsSend = WebSocket.prototype.send;
  WebSocket.prototype.send = function (data) {
    try {
      const s = typeof data === 'string' ? data : '<binary>';
      // Only frames that look like document mutations; skip heartbeats.
      if (/applyOtUpdate|op|insert|delete|newDoc/i.test(s) && s.length < 4000) {
        record({ via: 'websocket', url: this.url, body: { kind: 'frame', preview: s.slice(0, 300) } });
      }
    } catch (_) {}
    return realWsSend.apply(this, arguments);
  };

  // ── things a save would need, harvested from the page itself ─────────────
  const meta = (name) => document.querySelector(`meta[name="${name}"]`)?.getAttribute('content') || null;
  const csrfCandidates = {
    'meta[name=ol-csrfToken]': meta('ol-csrfToken') ? `<${meta('ol-csrfToken').length} chars>` : null,
    'meta[name=csrf-token]': meta('csrf-token') ? `<${meta('csrf-token').length} chars>` : null,
    'window.csrfToken': typeof window.csrfToken === 'string' ? `<${window.csrfToken.length} chars>` : null,
  };

  window.__wbWrites = {
    all: writes,
    csrfCandidates,
    projectId: (location.pathname.match(/\/project\/([0-9a-f]{16,32})/) || [])[1] || null,
    dump() {
      const report = {
        projectId: this.projectId,
        csrfCandidates,
        writes,
      };
      const text = JSON.stringify(report, null, 2);
      console.log(text);
      try { copy(text); console.log('[wb-capture] copied to clipboard'); } catch (_) {}
      return report;
    },
    reset() { writes.length = 0; },
  };

  console.log('[wb-capture] armed. Now REPLACE a .wb file in the file tree, then run __wbWrites.dump()');
  console.log('[wb-capture] csrf candidates on this page:', csrfCandidates);
})();
