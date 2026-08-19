// server.mjs — the local Wolfbook notebook server.
//
//   node server.mjs [--port 27300] [--no-auth] [--allow-origin <o>]
//
// A deliberately small HTTP face over a Wolfram kernel plus the extension's own
// renderer, for clients that want a NOTEBOOK rather than an AI tool call:
// untruncated output, real images, and streaming Print.
//
// SECURITY — this differs from the MCP server on purpose.
//
// The MCP server answers any local caller with `Access-Control-Allow-Origin: *`.
// That is already generous; here it would be reckless, because every request to
// this server EVALUATES ARBITRARY WOLFRAM CODE — file access, network, the lot.
// Any page in the browser could reach 127.0.0.1. So:
//
//   * a random token is generated per run and required on every request;
//   * CORS is granted only to origins that presented that token;
//   * the token is printed once at startup, for the client to be configured with.
//
// Localhost binding alone is NOT a security boundary against web pages.

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import path from 'node:path';
import { resolveHost } from './host.mjs';
import { WolfbookKernel } from './kernel.mjs';
import { Coalition, handleCoalitionRequest } from './coalition.mjs';
import { NotebookRegistry } from './notebooks.mjs';
import { makeToolSurface } from './tools.mjs';
import { WOLFBOOK_SERVE_VERSION } from './version.mjs';

const DEFAULT_PORT = 27300;
export const STATE_DIR = path.join(os.homedir(), '.wolfbook');
export const STATE_FILE = path.join(STATE_DIR, 'serve.json');

/**
 * The token is PERSISTED, not regenerated per run.
 *
 * A fresh token on every restart would mean re-pasting it into the browser
 * every time the server bounces, which is the kind of friction that makes
 * people reach for --no-auth. Stored 0600 in the user's own home directory —
 * the same trust boundary as an SSH key or a shell history file.
 */
export function loadOrCreateToken() {
  try {
    const st = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (typeof st.token === 'string' && st.token.length >= 24) return st.token;
  } catch (_) {}
  const token = crypto.randomBytes(24).toString('base64url');
  writeState({ token });
  return token;
}

export function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch (_) { return {}; }
}

export function writeState(patch) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const next = { ...readState(), ...patch };
  const tmp = `${STATE_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, STATE_FILE);
  try { fs.chmodSync(STATE_FILE, 0o600); } catch (_) {}
  return next;
}

const MIME = {
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.json': 'application/json',
};

export async function startServer(opts = {}) {
  // `?? DEFAULT_PORT`, not `|| DEFAULT_PORT`: port 0 means "any free port" and
  // is falsy, so `||` silently rewrote it to 27300 — which then collided with an
  // already-running instance instead of picking a free one.
  const port = (opts.port === undefined || opts.port === null || opts.port === '')
    ? DEFAULT_PORT : Number(opts.port);
  const requireAuth = opts.auth !== false;
  const token = opts.token || loadOrCreateToken();
  const allowOrigins = new Set(opts.allowOrigins || []);

  const host = resolveHost(opts);
  if (!host.kernelExecutable) throw new Error('No Wolfram kernel found. Pass --kernel <path>.');
  if (!host.extensionDir) throw new Error('No installed wolfbook extension found. Pass --extension-dir <path>.');
  for (const w of host.warnings) console.warn(`warning: ${w}`);

  const subscribers = new Set();          // SSE clients
  const emit = (event, data) => {
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of subscribers) { try { res.write(frame); } catch (_) {} }
  };

  const kernel = new WolfbookKernel(host, {
    onPrint: (line) => emit('print', { line }),
    onMessage: (message) => emit('message', { message }),
  });
  await kernel.start();

  // ── coalition membership ────────────────────────────────────────────────
  // Announcing our notebooks is what makes an Overleaf tab show up in
  // `wolfbook_list_clients` beside the VS Code windows.
  const registry = new NotebookRegistry({ onChange: () => coalition?.refresh() });
  const coalition = new Coalition({
    port: 0,                       // set once the listener has a real port
    primaryPort: opts.primaryPort,
    getNotebooks: () => registry.paths(),
    getKernels: () => ([{
      kernel_id: `serve-${process.pid}`,
      kernel_slot: 'default',
      kernel_label: 'S1',
      is_default: true,
      remote: false,
      lifecycle: kernel.ready ? (kernel.busy ? 'busy' : 'idle') : 'starting',
      busy: kernel.busy,
      notebook: null,
      executable: host.kernelExecutable,
      wolfram_version: kernel.wolframVersion,
    }]),
  });
  const toolSurface = makeToolSurface({ registry, kernel, coalition });

  const authorised = (req) => {
    if (!requireAuth) return true;
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    const given = req.headers['x-wolfbook-token'] || url.searchParams.get('token');
    // Constant-time compare, so the token cannot be discovered by timing.
    if (!given || given.length !== token.length) return false;
    return crypto.timingSafeEqual(Buffer.from(given), Buffer.from(token));
  };

  const send = (res, code, body, headers = {}) => {
    const payload = typeof body === 'string' ? body : JSON.stringify(body, null, 2);
    res.writeHead(code, { 'Content-Type': 'application/json', ...headers });
    res.end(payload);
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    const origin = req.headers.origin;
    const ok = authorised(req);

    // CORS headers are set for any Origin, INCLUDING on the preflight.
    //
    // A CORS preflight is sent by the browser without custom headers, so it can
    // never carry the token — gating it on `ok` made every browser POST fail
    // before the real request was ever sent. This does not weaken anything: the
    // preflight discloses nothing, and the actual request still needs a valid
    // token, so a page that lacks one gets a 401 and no data.
    //
    // (The Chrome extension itself is unaffected either way: fetches from its
    // service worker use host_permissions and bypass CORS entirely.)
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Wolfbook-Token');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Max-Age', '600');
    }
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    // Coalition endpoints answer to the MCP primary, which has no token — see
    // the Origin check in coalition.mjs for how a web page is kept out.
    if (handleCoalitionRequest(req, res, url, {
      coalition,
      invokeTool: (name, args) => toolSurface.invoke(name, args),
    })) return;

    // /health is unauthenticated so a client can discover the port, but it
    // deliberately reveals nothing beyond liveness and version.
    if (url.pathname === '/health') {
      return send(res, 200, {
        status: 'ok', service: 'wolfbook-serve', port,
        serverVersion: WOLFBOOK_SERVE_VERSION,
        versions: kernel.componentVersions,
        wolframVersion: kernel.wolframVersion, authRequired: requireAuth,
      });
    }

    if (!ok) return send(res, 401, { error: 'unauthorised', hint: 'pass ?token= or X-Wolfbook-Token' });

    try {
      if (url.pathname === '/v1/info') {
        return send(res, 200, {
          serverVersion: WOLFBOOK_SERVE_VERSION,
          versions: kernel.componentVersions,
          extensionDir: host.extensionDir,
          kernelExecutable: host.kernelExecutable,
          kernelSource: host.source,
          wolframVersion: kernel.wolframVersion,
          imageDir: kernel.imageDir,
          warnings: host.warnings,
          uptimeMs: Date.now() - kernel.startedAt,
        });
      }

      if (url.pathname === '/v1/events') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        res.write(': connected\n\n');
        subscribers.add(res);
        req.on('close', () => {
          subscribers.delete(res);
          // A tab that goes away takes its notebooks with it: the SSE stream IS
          // the liveness signal, so no heartbeat is needed and no stale notebook
          // is left advertised to agents.
          registry.detachSubscriber(res);
        });
        return;
      }

      if (url.pathname === '/v1/eval' && req.method === 'POST') {
        const body = await readBody(req);
        const code = body?.code;
        if (typeof code !== 'string' || !code.trim()) {
          return send(res, 400, { error: 'no code' });
        }
        if (kernel.busy) return send(res, 409, { error: 'kernel busy' });

        emit('eval-start', { cellId: body.cellId ?? null });
        // pageWidthEm: the reader's column width in em. The server cannot know
        // it — the notebook is in someone else's browser — so BTL leaves the
        // LaTeX unbroken unless the client says how wide it may be.
        const out = await kernel.evalCell(code, {
          format: body.format, scale: body.scale, pageWidthEm: body.pageWidthEm,
        });
        emit('eval-done', { cellId: body.cellId ?? null, outN: out.outN, ms: out.ms });
        return send(res, 200, { ...out, cellId: body.cellId ?? null });
      }

      // ── notebooks attached by an Overleaf tab ──────────────────────────
      if (url.pathname === '/v1/notebooks/attach' && req.method === 'POST') {
        const body = await readBody(req);
        // The subscriber is this tab's SSE stream — the newest one it opened.
        const subscriber = [...subscribers].pop();
        if (!subscriber) return send(res, 400, { error: 'open /v1/events first' });
        const nb = registry.attach({
          projectId: String(body.projectId || ''),
          projectName: String(body.projectName || body.projectId || ''),
          fileName: String(body.fileName || ''),
        }, subscriber);
        return send(res, 200, { notebookId: nb.id, path: nb.path });
      }

      if (url.pathname === '/v1/notebooks/detach' && req.method === 'POST') {
        const body = await readBody(req);
        registry.detach(String(body.notebookId || ''));
        return send(res, 200, { ok: true });
      }

      if (url.pathname === '/v1/notebooks' && req.method === 'GET') {
        return send(res, 200, { notebooks: registry.paths() });
      }

      // Used by the extension popup. Unlike /v1/notebooks, this sends a ping
      // over the complete server → service worker → content-script route, so a
      // green result means an MCP tool can really reach that open editor.
      if (url.pathname === '/v1/notebooks/status' && req.method === 'GET') {
        return send(res, 200, { notebooks: await registry.status(1800) });
      }

      // The tab answering a reverse RPC.
      if (url.pathname.startsWith('/v1/rpc/') && req.method === 'POST') {
        const id = url.pathname.slice('/v1/rpc/'.length);
        const body = await readBody(req);
        const known = registry.settle(id, body);
        return send(res, known ? 200 : 404, { ok: known });
      }

      // ── materialise a notebook on disk ─────────────────────────────────
      //
      // "Open in Wolfbook" cannot go through wolfbook_newNotebook: that tool
      // builds cells from {kind, content} and hard-codes `outputs: []`, so every
      // plot and result would be dropped on the way. Writing the exact bytes we
      // already hold keeps the notebook whole — and this process has filesystem
      // access precisely so the browser does not need it.
      if (url.pathname === '/v1/materialise' && req.method === 'POST') {
        const body = await readBody(req);
        const name = String(body.fileName || 'notebook.wb').replace(/[/\\]/g, '_');
        if (!/\.wb$/i.test(name)) return send(res, 400, { error: 'not a .wb filename' });
        if (typeof body.text !== 'string' || !body.text.trim()) {
          return send(res, 400, { error: 'no notebook content' });
        }
        // Under the user's own wolfbook directory, foldered by project, so
        // repeated opens overwrite one file instead of littering Downloads.
        const project = String(body.projectName || body.projectId || 'overleaf')
          .replace(/[/\\]/g, '_').slice(0, 80);
        const dir = path.join(STATE_DIR, 'overleaf', project);
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, name);
        fs.writeFileSync(file, body.text);
        return send(res, 200, { path: file, dir });
      }

      if (url.pathname === '/v1/interrupt' && req.method === 'POST') {
        return send(res, 200, { aborted: await kernel.interrupt() });
      }

      // Images the kernel just wrote — the thing MCP could not deliver.
      if (url.pathname.startsWith('/img/')) {
        const file = kernel.resolveImage(decodeURIComponent(url.pathname.slice('/img/'.length)));
        if (!file) { res.writeHead(404); res.end('not found'); return; }
        res.writeHead(200, {
          'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
          'Cache-Control': 'no-cache',
        });
        fs.createReadStream(file).pipe(res);
        return;
      }

      send(res, 404, { error: 'not found' });
    } catch (e) {
      send(res, 500, { error: String(e?.message || e) });
    }
  });

  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  const boundPort = server.address().port;
  coalition.port = boundPort;
  if (opts.coalition !== false) coalition.start();

  // Record where we are, so the CLI can report status and stop us.
  //
  // NOT for an ephemeral port. A test server binds port 0, and recording that
  // overwrote the running server's entry with a port nobody can reach and a pid
  // that dies seconds later — so `wolfbook-serve status` reported the test, and
  // the real server became undiscoverable. An ephemeral port is by definition
  // not something another process can find, so writing it down is pure harm.
  const recordState = Number(port) !== 0;
  if (recordState) {
    writeState({ token, port: boundPort, pid: process.pid, startedAt: new Date().toISOString() });
  }

  const close = async () => {
    coalition.stop();
    if (recordState && readState().pid === process.pid) writeState({ pid: null });
    for (const s of subscribers) { try { s.end(); } catch (_) {} }
    subscribers.clear();
    kernel.stop();
    await new Promise((r) => server.close(r));
  };

  return { server, kernel, host, registry, coalition, toolSurface,
           port: boundPort, token, close, url: `http://127.0.0.1:${boundPort}` };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (d) => {
      raw += d;
      if (raw.length > 8 * 1024 * 1024) { reject(new Error('body too large')); req.destroy(); }
    });
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

// ── CLI ─────────────────────────────────────────────────────────────────────
if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  const flag = (name, fallback) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? (argv[i + 1] ?? true) : fallback;
  };
  const s = await startServer({
    port: flag('port'),
    auth: !argv.includes('--no-auth'),
    kernel: flag('kernel'),
    extensionDir: flag('extension-dir'),
    allowOrigins: [flag('allow-origin')].filter((v) => typeof v === 'string'),
  });
  console.log(`wolfbook-serve on ${s.url}`);
  console.log(`  kernel   ${s.host.kernelExecutable}  (${s.host.source})`);
  console.log(`  wolfram  ${s.kernel.wolframVersion || 'unknown'}`);
  console.log(`  images   ${s.kernel.imageDir}`);
  console.log(`  token    ${s.token}`);
  console.log(`  client   ${s.coalition.clientId}  (MCP coalition)`);
  const bye = async () => { await s.close(); process.exit(0); };
  process.on('SIGINT', bye);
  process.on('SIGTERM', bye);
}
