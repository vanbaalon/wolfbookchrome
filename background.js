// background.js — MV3 service worker.
// MCP client for the wolfbook VS Code extension's HTTP/SSE server
// (claude-mcp/server.js: GET /sse → `event: endpoint` with /message?sessionId=…;
// JSON-RPC responses arrive back over the SSE stream).
//
// Caveat: MV3 may kill an idle service worker (~30 s). The session is created
// lazily per request batch and transparently reconnected, so a killed worker
// just means the next call pays the handshake again.

const PORT_MIN = 27182;
const PORT_MAX = 27202;

let session = null; // { port, endpoint, pending: Map<id, {resolve,reject}>, nextId, abort }

async function findServerPort() {
  for (let port = PORT_MIN; port <= PORT_MAX; port++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(800) });
      if (res.ok) return port;
    } catch (_) { /* not this port */ }
  }
  return null;
}

function sseLines(onEvent) {
  // Incremental SSE parser: feed chunks, emits {event, data} per blank-line-delimited block.
  let buf = '';
  return (chunk) => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      let event = 'message';
      const data = [];
      for (const line of block.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).trim());
      }
      if (data.length) onEvent({ event, data: data.join('\n') });
    }
  };
}

async function connect() {
  if (session) return session;
  const port = await findServerPort();
  if (!port) throw new Error('Wolfbook MCP server not found on 127.0.0.1:27182–27202. Is VS Code with the wolfbook extension running?');

  const abort = new AbortController();
  const s = { port, endpoint: null, pending: new Map(), nextId: 1, abort };

  const res = await fetch(`http://127.0.0.1:${port}/sse`, {
    headers: { Accept: 'text/event-stream' },
    signal: abort.signal,
  });
  if (!res.ok || !res.body) throw new Error(`SSE connect failed: HTTP ${res.status}`);

  let resolveEndpoint;
  const endpointReady = new Promise((r) => { resolveEndpoint = r; });

  const feed = sseLines(({ event, data }) => {
    if (event === 'endpoint') {
      s.endpoint = `http://127.0.0.1:${port}${data}`;
      resolveEndpoint();
      return;
    }
    // JSON-RPC responses ride the default "message" event.
    try {
      const msg = JSON.parse(data);
      if (msg.id != null && s.pending.has(msg.id)) {
        const p = s.pending.get(msg.id);
        s.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        else p.resolve(msg.result);
      }
    } catch (_) { /* non-JSON event, ignore */ }
  });

  // Pump the stream in the background; on stream end, drop the session.
  (async () => {
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        feed(dec.decode(value, { stream: true }));
      }
    } catch (_) { /* aborted or dropped */ }
    for (const p of s.pending.values()) p.reject(new Error('MCP SSE stream closed'));
    s.pending.clear();
    if (session === s) session = null;
  })();

  await endpointReady;

  // MCP handshake.
  await rpc(s, 'initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'wolfbook-overleaf', version: '0.1.0' },
  });
  await post(s, { jsonrpc: '2.0', method: 'notifications/initialized' });

  session = s;
  return s;
}

async function post(s, body) {
  const res = await fetch(s.endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok && res.status !== 202) throw new Error(`MCP POST failed: HTTP ${res.status}`);
}

function rpc(s, method, params, timeoutMs = 120000) {
  const id = s.nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      s.pending.delete(id);
      reject(new Error(`MCP ${method} timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);
    s.pending.set(id, {
      resolve: (v) => { clearTimeout(timer); resolve(v); },
      reject: (e) => { clearTimeout(timer); reject(e); },
    });
    post(s, { jsonrpc: '2.0', id, method, params }).catch((e) => {
      clearTimeout(timer);
      s.pending.delete(id);
      reject(e);
    });
  });
}

async function callTool(name, args) {
  let s = await connect();
  try {
    return await rpc(s, 'tools/call', { name, arguments: args || {} });
  } catch (e) {
    // One transparent retry through a fresh session (worker slept, stream dropped).
    if (session === s) session = null;
    s = await connect();
    return rpc(s, 'tools/call', { name, arguments: args || {} });
  }
}

/**
 * List the connected Wolfbook windows and their kernels.
 *
 * Uses the server's plain `GET /workers` endpoint rather than the
 * wolfbook_list_clients tool: it needs no MCP session or handshake, so the
 * kernel picker can be populated immediately and refreshed cheaply. It returns
 * the same structure the tool reports.
 */
async function listClients() {
  const port = session?.port ?? (await findServerPort());
  if (!port) return { port: null, clients: [] };
  const res = await fetch(`http://127.0.0.1:${port}/workers`, { signal: AbortSignal.timeout(3000) });
  if (!res.ok) throw new Error(`/workers returned HTTP ${res.status}`);
  const clients = await res.json();
  return { port, clients: Array.isArray(clients) ? clients : [] };
}


// ─────────────────────────────────────────────────────────────────────────────
// wolfbook-serve — the notebook server (see server/ in this repo).
//
// Preferred over MCP whenever it is running, because MCP is an AI transport:
// it truncates large results and returns text where we want a picture. This one
// returns the kernel's own HTML plus real image files.
//
// It requires a token, deliberately: every request evaluates arbitrary Wolfram
// code, so a page that merely guesses the port must not get through. The token
// is printed by the server at startup and pasted in by the user once; we keep it
// in chrome.storage.local.

const SERVE_PORT_MIN = 27300;
const SERVE_PORT_MAX = 27309;

let servePort = null;   // cached across calls; re-probed when a request fails
let serveHealth = null; // public /health payload from the last successful probe

async function getServeToken() {
  try {
    return await new Promise((r) => chrome.storage.local.get('wbServeToken', (v) => r(v?.wbServeToken || null)));
  } catch (_) { return null; }
}

async function findServePort(force = false) {
  if (servePort && !force) return servePort;
  for (let port = SERVE_PORT_MIN; port <= SERVE_PORT_MAX; port++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(700) });
      if (!res.ok) continue;
      const body = await res.json();
      // /health is unauthenticated so it can be used for discovery; check that
      // it is actually our server and not something else on the port.
      if (body?.service === 'wolfbook-serve') {
        servePort = port;
        serveHealth = body;
        return port;
      }
    } catch (_) { /* not this port */ }
  }
  servePort = null;
  serveHealth = null;
  return null;
}

async function serveStatus() {
  const port = await findServePort(true);
  if (!port) return { ok: true, connected: false, running: false, health: null };
  const token = await getServeToken();
  let authorised = false, info = null;
  if (token) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/v1/info`, {
        headers: { 'X-Wolfbook-Token': token }, signal: AbortSignal.timeout(2000),
      });
      authorised = res.ok;
      if (res.ok) info = await res.json();
    } catch (_) {}
  }
  return {
    ok: true, connected: true, running: true, port, authorised,
    hasToken: !!token, health: serveHealth, info,
  };
}

async function serveEval(args) {
  // Re-probe on every user evaluation. The daemon is routinely restarted
  // during upgrades, often on the same port, and a cached pre-restart answer
  // made an already-open notebook claim it was still offline indefinitely.
  let port = await findServePort(true);
  if (!port) throw new Error('wolfbook-serve is not running.');
  const token = await getServeToken();
  if (!token) throw new Error('No token for wolfbook-serve. Paste the token it printed at startup.');

  const request = (at) => fetch(`http://127.0.0.1:${at}/v1/eval`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Wolfbook-Token': token },
    body: JSON.stringify(args || {}),
  });
  let res;
  try {
    res = await request(port);
  } catch (_) {
    // Cover the narrow restart race between the health check and POST once.
    servePort = null;
    port = await findServePort(true);
    if (!port) throw new Error('wolfbook-serve is not running.');
    res = await request(port);
  }
  if (res.status === 401) throw new Error('wolfbook-serve rejected the token.');
  if (res.status === 409) throw new Error('The kernel is busy with another evaluation.');
  if (!res.ok) throw new Error(`wolfbook-serve returned HTTP ${res.status}`);
  return res.json();
}

// ─────────────────────────────────────────────────────────────────────────────
// Reverse RPC: the server calling US.
//
// An agent reaches the notebook through wolfbook-serve, which has to ask the tab
// that actually holds it. The tab therefore keeps the server's SSE stream open
// and answers requests on it — the same direction of travel as the MCP server's
// own transport, and the only one available to a page that cannot listen.
//
// It lives in the service worker, not the content script, because the connection
// must outlive any single Overleaf tab's render cycle.

let rpcStream = null;
// Notebook id -> the concrete Chrome tab which announced it. Enumerating tabs
// is only a fallback: on some Chrome profiles URL-filtered and even unfiltered
// tabs.query calls return no rows inside a restarted MV3 worker, despite the
// content script in that tab being alive.
const notebookTabIds = new Map();
const NOTEBOOK_TAB_BINDINGS_KEY = 'wbNotebookTabIds';

async function routeStorageGet() {
  const area = chrome.storage?.session || chrome.storage?.local;
  if (!area) return {};
  try {
    const row = await area.get(NOTEBOOK_TAB_BINDINGS_KEY);
    return row?.[NOTEBOOK_TAB_BINDINGS_KEY] || {};
  } catch (_) { return {}; }
}

async function rememberNotebookTab(notebookId, tabId) {
  if (!notebookId || !Number.isInteger(tabId)) return false;
  notebookTabIds.set(notebookId, tabId);
  const all = await routeStorageGet();
  all[notebookId] = tabId;
  const area = chrome.storage?.session || chrome.storage?.local;
  try { await area?.set({ [NOTEBOOK_TAB_BINDINGS_KEY]: all }); } catch (_) {}
  return true;
}

async function forgetNotebookTab(notebookId) {
  notebookTabIds.delete(notebookId);
  const all = await routeStorageGet();
  if (!(notebookId in all)) return;
  delete all[notebookId];
  const area = chrome.storage?.session || chrome.storage?.local;
  try { await area?.set({ [NOTEBOOK_TAB_BINDINGS_KEY]: all }); } catch (_) {}
}

async function resolveNotebookTab(notebookId) {
  const hot = notebookTabIds.get(notebookId);
  if (Number.isInteger(hot)) return hot;
  const stored = (await routeStorageGet())[notebookId];
  if (Number.isInteger(stored)) {
    notebookTabIds.set(notebookId, stored);
    return stored;
  }
  return null;
}

async function connectRpc(onRequest) {
  const port = await findServePort();
  const token = await getServeToken();
  if (!port || !token) return null;
  if (rpcStream && rpcStream.port === port) return rpcStream;

  const abort = new AbortController();
  const res = await fetch(`http://127.0.0.1:${port}/v1/events?token=${encodeURIComponent(token)}`,
    { signal: abort.signal });
  if (!res.ok || !res.body) return null;
  rpcStream = { port, abort };

  (async () => {
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          if (!/^event:\s*rpc/m.test(block)) continue;
          const line = block.split('\n').find((l) => l.startsWith('data:'));
          if (!line) continue;
          let req;
          try { req = JSON.parse(line.slice(5).trim()); } catch (_) { continue; }
          let payload;
          try { payload = { result: await onRequest(req) }; }
          catch (e) { payload = { error: String(e?.message || e) }; }
          fetch(`http://127.0.0.1:${port}/v1/rpc/${encodeURIComponent(req.id)}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Wolfbook-Token': token },
            body: JSON.stringify(payload),
          }).catch(() => {});
        }
      }
    } catch (_) { /* stream dropped */ }
    if (rpcStream && rpcStream.abort === abort) rpcStream = null;
    scheduleRpcReconnect();
  })();

  return rpcStream;
}

/**
 * Come back after the server goes away.
 *
 * The notebook's presence in the coalition is the SSE stream — so restarting
 * wolfbook-serve silently removed the open notebook from every agent's view,
 * and nothing restored it: the tab attaches once, at mount, and had no reason
 * to try again. An agent was then told the notebook did not exist while the
 * user was looking straight at it.
 *
 * So: retry with a backoff, and once the stream is back, ask every Overleaf tab
 * to re-announce itself. Attaching is idempotent — keyed on (project, file) —
 * so a tab that never lost anything simply keeps the id it had.
 */
let rpcRetryTimer = null;
let rpcRetryDelay = 5_000;
const RPC_RETRY_MAX = 60_000;

async function queryOverleafTabs() {
  // Keep this in lockstep with manifest.json. Overleaf may use either the bare
  // domain or a subdomain; the content script supports both, so reverse MCP
  // routing must not silently lose tabs on the bare-domain route.
  const matched = await chrome.tabs.query({ url: [
    '*://*.overleaf.com/project/*',
    '*://overleaf.com/project/*',
  ] }).catch(() => []);
  if (matched.length) return matched;

  // Some Chrome builds/profiles return no rows for a URL-filtered query even
  // though the content script is alive in that tab. Messaging every tab is a
  // safe fallback: tabs without Wolfbook have no listener and are skipped.
  return chrome.tabs.query({}).catch(() => []);
}

function scheduleRpcReconnect() {
  if (rpcRetryTimer) return;
  rpcRetryTimer = setTimeout(async () => {
    rpcRetryTimer = null;
    const tabs = await queryOverleafTabs();
    // No tab to serve: stop retrying rather than polling a dead port forever.
    if (!tabs.length) { rpcRetryDelay = 5_000; return; }
    const stream = await connectRpc(dispatchToTab).catch(() => null);
    if (!stream) {
      rpcRetryDelay = Math.min(rpcRetryDelay * 2, RPC_RETRY_MAX);
      scheduleRpcReconnect();
      return;
    }
    rpcRetryDelay = 5_000;
    for (const tab of tabs) {
      chrome.tabs.sendMessage(tab.id, { cmd: 'wb-reattach' }).catch(() => {});
    }
  }, rpcRetryDelay);
}

/** Forward an agent's request to whichever Overleaf tab holds that notebook. */
async function dispatchToTab(req) {
  const boundTabId = await resolveNotebookTab(req?.notebookId);
  let boundError = null;
  if (Number.isInteger(boundTabId)) {
    try {
      const reply = await chrome.tabs.sendMessage(boundTabId, { cmd: 'wb-rpc', req });
      if (reply && reply.handled) {
        if (reply.error) throw new Error(reply.error);
        return reply.result;
      }
    } catch (e) {
      // The tab may genuinely have closed. Remove only this stale binding and
      // retain the enumeration fallback for older attachments.
      await forgetNotebookTab(req.notebookId);
      boundError = String(e?.message || e);
    }
  }
  const tabs = await queryOverleafTabs();
  let lastError = boundError || 'no Overleaf tab is open';
  for (const tab of tabs) {
    try {
      const reply = await chrome.tabs.sendMessage(tab.id, { cmd: 'wb-rpc', req });
      if (reply && reply.handled) {
        if (reply.error) throw new Error(reply.error);
        return reply.result;
      }
      if (reply && reply.error) lastError = reply.error;
    } catch (e) { lastError = String(e?.message || e); }
  }
  throw new Error(lastError);
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      if (msg?.cmd === 'mcp-status') {
        const port = session?.port ?? (await findServerPort());
        sendResponse({ ok: true, connected: port != null, port });
      } else if (msg?.cmd === 'serve-status') {
        sendResponse(await serveStatus());
      } else if (msg?.cmd === 'serve-set-token') {
        await new Promise((r) => chrome.storage.local.set({ wbServeToken: msg.token || '' }, r));
        sendResponse(await serveStatus());
      } else if (msg?.cmd === 'serve-attach') {
        // A tab has opened a .wb; make sure the RPC stream is up, then attach.
        const stream = await connectRpc(dispatchToTab);
        if (!stream) {
          sendResponse({ ok: false, error: 'could not open the wolfbook-serve RPC stream' });
          return;
        }
        const port = await findServePort();
        const token = await getServeToken();
        if (!port || !token) { sendResponse({ ok: false, error: 'wolfbook-serve unavailable' }); return; }
        const requestAttach = () => fetch(`http://127.0.0.1:${port}/v1/notebooks/attach`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Wolfbook-Token': token },
          body: JSON.stringify(msg.notebook || {}),
        });
        let res = await requestAttach();
        let payload = await res.json().catch(() => ({}));
        // A server restart on the same port can leave the worker holding an
        // obsolete rpcStream object for the few milliseconds before its reader
        // reports EOF. Recover in this call instead of waiting for another
        // heartbeat and returning an unexplained empty registry.
        if (!res.ok && /open \/v1\/events first/i.test(payload?.error || '')) {
          try { rpcStream?.abort?.abort(); } catch (_) {}
          rpcStream = null;
          const reopened = await connectRpc(dispatchToTab);
          if (reopened) {
            res = await requestAttach();
            payload = await res.json().catch(() => ({}));
          }
        }
        const routeBound = res.ok && payload?.notebookId
          ? await rememberNotebookTab(payload.notebookId, sender?.tab?.id)
          : false;
        if (res.ok) payload.routeBound = routeBound;
        sendResponse({
          ok: res.ok,
          result: res.ok ? payload : null,
          error: res.ok ? null : (payload?.error || `attach returned HTTP ${res.status}`),
        });
      } else if (msg?.cmd === 'serve-detach') {
        const port = await findServePort();
        const token = await getServeToken();
        if (port && token) {
          await fetch(`http://127.0.0.1:${port}/v1/notebooks/detach`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Wolfbook-Token': token },
            body: JSON.stringify({ notebookId: msg.notebookId }),
          }).catch(() => {});
        }
        await forgetNotebookTab(String(msg.notebookId || ''));
        sendResponse({ ok: true });
      } else if (msg?.cmd === 'serve-materialise') {
        const port = await findServePort();
        const token = await getServeToken();
        if (!port || !token) throw new Error('wolfbook-serve is not running');
        const r = await fetch(`http://127.0.0.1:${port}/v1/materialise`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Wolfbook-Token': token },
          body: JSON.stringify(msg.notebook || {}),
        });
        if (!r.ok) throw new Error(`could not write the file (HTTP ${r.status})`);
        sendResponse({ ok: true, result: await r.json() });
      } else if (msg?.cmd === 'serve-interrupt') {
        const port = await findServePort();
        const token = await getServeToken();
        if (!port || !token) throw new Error('wolfbook-serve unavailable');
        const res = await fetch(`http://127.0.0.1:${port}/v1/interrupt`, {
          method: 'POST', headers: { 'X-Wolfbook-Token': token },
        });
        sendResponse({ ok: res.ok });
      } else if (msg?.cmd === 'serve-eval') {
        sendResponse({ ok: true, result: await serveEval(msg.args) });
      } else if (msg?.cmd === 'mcp-clients') {
        sendResponse({ ok: true, ...(await listClients()) });
      } else if (msg?.cmd === 'mcp-call') {
        const result = await callTool(msg.name, msg.args);
        sendResponse({ ok: true, result });
      } else {
        sendResponse({ ok: false, error: `unknown cmd ${msg?.cmd}` });
      }
    } catch (e) {
      sendResponse({ ok: false, error: String(e?.message || e) });
    }
  })();
  return true; // async sendResponse
});
