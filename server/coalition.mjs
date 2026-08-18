// coalition.mjs — join the Wolfbook MCP coalition as a first-class member.
//
// The coalition is defined by REACHABILITY: whoever holds port 27182 is the
// primary and proxies every tool call to members with
//
//     POST http://127.0.0.1:<memberPort>/invoke     {name, arguments}
//
// after they announce themselves with
//
//     POST http://127.0.0.1:27182/register
//       {clientId, port, pid, notebooks[], kernels[], kernelBindings[],
//        generation, registeredAt}
//
// A browser tab cannot do that — it has no socket. So this process joins on the
// tab's behalf and represents the notebooks open in it, which is why the
// Overleaf viewer can appear in `wolfbook_list_clients` at all.
//
// WE DECLINE PROMOTION. Members poll the primary and race to bind 27182 when it
// dies. We implement a subset of the tool surface, so becoming primary would
// leave agents with a server that cannot answer most calls — worse than no
// primary, which at least fails honestly. We simply keep re-registering until a
// real one returns.

import http from 'node:http';
import os from 'node:os';

const PRIMARY_PORT = 27182;
const REREGISTER_MS = 15000;

/** POST JSON to the primary. Never throws: it may simply not be running. */
function postJson(port, path, payload, timeout = 2000) {
  return new Promise((resolve) => {
    const body = JSON.stringify(payload);
    const req = http.request({
      hostname: '127.0.0.1', port, path, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout,
    }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end(body);
  });
}

export class Coalition {
  /**
   * @param {{port: number, getNotebooks: () => string[], getKernels: () => object[]}} opts
   */
  constructor(opts) {
    this.port = opts.port;
    this.getNotebooks = opts.getNotebooks || (() => []);
    this.getKernels = opts.getKernels || (() => []);
    this.clientId = opts.clientId || `Wolfbook-Serve[${os.hostname().replace(/\.local$/, '')}]`;
    // Injectable so the coalition can be exercised against a stand-in primary;
    // a real one is almost always already holding 27182 on a working machine.
    this.primaryPort = opts.primaryPort || PRIMARY_PORT;
    // Distinguishes this process lifetime from a stale registration left behind
    // by an earlier one that happened to use the same client id.
    this.generation = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    this.timer = null;
    this.registered = false;
  }

  payload() {
    return {
      clientId: this.clientId,
      port: this.port,
      pid: process.pid,
      notebooks: this.getNotebooks(),
      kernels: this.getKernels(),
      kernelBindings: [],
      generation: this.generation,
      registeredAt: Date.now(),
    };
  }

  async register() {
    const code = await postJson(this.primaryPort, '/register', this.payload());
    const ok = code != null;
    if (ok !== this.registered) {
      console.log(ok
        ? `coalition: registered with the primary as ${this.clientId}`
        : `coalition: no primary on ${this.primaryPort} (a VS Code window would be one) — will retry`);
    }
    this.registered = ok;
    return ok;
  }

  /**
   * Re-register periodically rather than only once.
   *
   * The primary keeps members in memory, so a primary that restarts — or an
   * election that moves it to another window — forgets us. Re-announcing is far
   * simpler than tracking who is in charge, and it doubles as the liveness
   * signal for our own notebook list, which changes as tabs come and go.
   */
  start() {
    this.register();
    this.timer = setInterval(() => this.register(), REREGISTER_MS);
    if (this.timer.unref) this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Announce immediately, e.g. when a notebook is attached or detached. */
  refresh() { return this.register(); }
}


/**
 * Translate an MCP tool result into the reply shape the PRIMARY reads.
 *
 * This is not the MCP wire format, and assuming it was cost a silent failure:
 * the primary reconstructs its content blocks from `r.parts` (or a bare
 * `r.text`), so a reply carrying MCP's `content: [{type, text}]` parsed fine,
 * produced zero parts, and reached the agent as an EMPTY string — a tool that
 * answered successfully with nothing at all. The reference is
 * `claude-mcp/worker.js` `_handleInvoke` in the VS Code extension; match it.
 *
 *   {parts: [{kind: 'text'|'image', value}], isError: false}
 *   {error: '…', isError: true}
 *
 * Images travel as data: URIs, which is how the primary tells them apart.
 */
export function toWorkerReply(result) {
  if (result?.isError) {
    const first = (result.content || []).map((p) => p?.text ?? p?.value ?? '').join('\n');
    return { error: first || 'tool failed', isError: true };
  }
  const parts = (result?.content || []).map((p) => {
    const value = String(p?.text ?? p?.value ?? '');
    return value.startsWith('data:image/') && value.includes(';base64,')
      ? { kind: 'image', value }
      : { kind: 'text', value };
  });
  return { parts, isError: false };
}

/**
 * Handle the endpoints a coalition member must serve.
 *
 * SECURITY: `/invoke` evaluates whatever the tool does, and the primary cannot
 * present our token — it does not have one. So instead we require the request to
 * look server-to-server: a browser ALWAYS attaches an `Origin` header to a
 * cross-origin POST, so refusing any request that carries one keeps web pages
 * out while letting the Node primary through. Without that, any page could POST
 * to this endpoint and run code, response unread but effect real.
 *
 * @returns {boolean} true when the request was handled here
 */
export function handleCoalitionRequest(req, res, url, ctx) {
  const send = (code, body) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  if (url.pathname === '/notebooks' && req.method === 'GET') {
    send(200, { clientId: ctx.coalition.clientId, notebooks: ctx.coalition.getNotebooks() });
    return true;
  }

  if (url.pathname === '/new-primary' && req.method === 'POST') {
    // A new primary was elected; announce ourselves to it.
    req.resume();
    req.on('end', () => { ctx.coalition.refresh(); send(200, { ok: true }); });
    return true;
  }

  if (url.pathname === '/kernel-session' && req.method === 'POST') {
    // Kernel leasing is a VS Code-side concept (one kernel per notebook editor).
    // We have a single shared kernel and no arbiter, so we answer honestly
    // rather than pretending to hold a lease.
    req.resume();
    req.on('end', () => send(200, { ok: false, reason: 'wolfbook-serve does not lease kernels' }));
    return true;
  }

  if (url.pathname === '/invoke' && req.method === 'POST') {
    if (req.headers.origin) {
      // See the note above: this is how a web page is told apart from the primary.
      send(403, { error: 'forbidden' });
      return true;
    }
    let body = '';
    req.on('data', (d) => {
      body += d;
      if (body.length > 16 * 1024 * 1024) { req.destroy(); }
    });
    req.on('end', async () => {
      let parsed;
      try { parsed = JSON.parse(body || '{}'); } catch (_) {
        send(400, { content: [{ type: 'text', text: 'invalid JSON' }], isError: true });
        return;
      }
      try {
        send(200, toWorkerReply(await ctx.invokeTool(parsed.name, parsed.arguments || {})));
      } catch (e) {
        send(200, { error: String(e?.message || e), isError: true });
      }
    });
    return true;
  }

  return false;
}
