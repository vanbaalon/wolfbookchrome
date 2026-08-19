# wolfbook-serve

A local Wolfbook server that needs **wolfbook installed in VS Code, but not
running**. It drives a Wolfram kernel and the extension's own rendering pipeline
from plain Node, so browser clients (the Overleaf extension, for now) get real
notebook output with no VS Code window open.

Status: **M1 done** — verified end to end against a live kernel, and already
driving the Overleaf Chrome extension.

```bash
node server.mjs                     # prints its URL and a token
node checks/check-server.mjs        # end-to-end, needs a real kernel
node check-installed-extension.mjs  # the original feasibility spike
```

## Why it can be this small

The rich rendering lives in the **kernel**, not the extension. `resources/*.wl`
turns an expression into the HTML the notebook shows — SVG plots, 2D tooltip
JSON, 3D meshes, typeset maths — so this server only has to load those files and
call them. It also loads the extension's own **N-API** addons (`wstp`, `btl`),
which are ABI-stable and therefore work in ordinary Node despite being shipped
for VS Code's Electron.

Net effect: no native build, no vendored `.wl`, and nothing that can drift from
the extension it runs beside.

## Why not just use the MCP server

MCP is an AI transport: text parts, truncation, a tool-call envelope per
evaluation. Correct for agents, wrong for a notebook client. Measured here:

| | MCP | wolfbook-serve |
|---|---|---|
| `Range[400]` | truncated for the model | full 1892 chars |
| `Plot[…]` | text description | `<img src="img/wl_….svg">`, fetchable at `/img/…` |
| `Integrate[…]` | InputForm text | `data-latex-b64` → `-\frac{1}{6}\log(x^2-x+1)+…` |
| `Print[…]` | in the final payload | streamed live over SSE |

## API

```
GET  /health         liveness + server/Wolfbook/WSTP/BTL/Wolfram versions
                       (no token — for discovery and the extension popup)
GET  /v1/info        versions, paths, kernel source, uptime
POST /v1/eval        {code, cellId?, format?, scale?}
                       → {html, text, outN, messages[], print[], ms}
POST /v1/interrupt   abort the running evaluation
GET  /v1/events      SSE: eval-start, eval-done, print, message
GET  /img/<file>     images the kernel just wrote
```

## Security

Unlike the MCP server, **every request here evaluates arbitrary Wolfram code**,
so it must not be reachable by any page that happens to know the port:

- a random token is generated per run and required on every request
  (`X-Wolfbook-Token:` or `?token=`), compared in constant time;
- CORS is granted **only** to origins that presented the token;
- `/img/` refuses path traversal outside the image directory;
- `/health` is open but reveals only liveness and version.

Binding to `127.0.0.1` is not by itself a boundary against web pages.

## How it finds things

`host.mjs`, best source first:

1. **`~/.wolfbook/host.json`** — written by the extension on every successful
   kernel launch (`kernel/lifecycle.js`). Authoritative.
2. `~/.wolfbook-mcp-registry.json` — right while a VS Code window is live, but
   deleted on clean exit.
3. `wolfbook.systemKernel`, if pinned (the default `"Automatic"` means unset).
4. Probing — last resort, and it warns. **Choosing a kernel means ranking by
   version**: this machine has 14.1 and 15.0.1 installed side by side, and the
   real logic in `find-kernel.js` needs `vscode`, so it cannot be reused. Do not
   grow this fallback into a second implementation; fix `host.json` instead.

## Two traps that fail silently

Both cost real time to find; neither raises an error.

- **`$wolframResourceDir` must be supplied by the host**, via `Block[]` around
  the `Get`, exactly as `kernel/lifecycle.js` does — `$InputFileName` is
  unreliable over WSTP. Without it every sub-file `Get[]` fails, the render API
  is never defined, and `VsCodeRenderExpr[…]` returns **unevaluated** rather than
  erroring. Verify with `Length@DownValues[VsCodeRenderExpr] > 0`; `Head[…] ===
  Symbol` passes for an undefined symbol and proves nothing.
- **`VsCodeSetImgDir[dir, prefix]`** must be called or nothing reaches disk. The
  prefix takes **no trailing slash** — the kernel joins with `/` itself
  (`checkout.js` uses `'img/' + notebookName`), so `"img/"` yields `img//file`.

## Wired to the Overleaf extension

Done. `quests/Q18_anharmonic_spectrum/WolfbookChromeExtension` prefers this
server over MCP whenever it answers, and its
`checks/check-serve-integration.mjs` drives the whole chain — Overleaf page →
extension → this server → a real kernel → an SVG loaded in the browser at
480×285, an integral typeset with KaTeX, `Range[400]` untruncated at 4521 chars.

Two fixes that came out of that wiring:

- **CORS preflight cannot carry the token.** Gating the `OPTIONS` response on
  authentication made every browser `POST` fail before the real request was sent.
  Preflight now answers any Origin; the actual request still needs a valid token,
  so nothing is disclosed. (The extension's service worker bypasses CORS anyway;
  this matters for any page-based client.)
- The viewer skipped typesetting equations that already had "content", but the
  sanitiser had just inserted a *copy LaTeX* button into them — so every result
  that arrives as maths, including plain numbers, rendered blank.

## MCP coalition membership (M3, done)

`wolfbook-serve` joins the Wolfbook coalition as a member, so a notebook open in
an **Overleaf tab** is discoverable by AI agents alongside the notebooks open in
VS Code windows:

```
VSCode[VSCodeWolframExtension]   role=primary  notebooks=4  kernels=['K2','K4']
VSCode[2026 2d SoV]              role=worker   notebooks=2  kernels=['K1']
Wolfbook-Serve[<host>]           role=worker   notebooks=1  kernels=['S1']
```

**Why the server and not the extension:** coalition membership means being
reachable — the primary proxies each call as `POST /invoke` to a member's port.
A browser tab has no socket, so it cannot join. This process joins on its behalf.

**Reverse RPC.** Everywhere else the browser calls the server; for an agent to
read or edit the notebook the server must call the browser. The tab already
holds `GET /v1/events` open, so a request is a new event kind on it
(`event: rpc`), answered by `POST /v1/rpc/<id>`. Bounded by a timeout, so a
wedged tab surfaces as a tool error rather than a hung agent.

**Liveness is the SSE stream.** A tab that closes takes its notebooks with it —
a notebook an agent can see but not reach is worse than one it cannot see.

**Identity.** `/invoke` carries `{name, arguments}` and no client id, so one port
is one identity: a single client, with notebooks distinguished by the `notebook`
argument. Paths are prefixed `overleaf:` so an agent can tell at a glance that
this is not a file on disk.

### Tools offered

`wolfbook_kernelStatus` · `getNotebookContext` · `searchCells` · `getCellOutput` ·
`evaluateExpression` · `runCell` · `runCells` · `editCell` · `insertCells` ·
`deleteCell` · `moveCell`

Anything a VS Code window offers that this cannot do is simply **absent**, so an
agent finds the boundary by looking rather than by a call failing oddly.

**`wolfbook_saveNotebook` is deliberately not among them.** Everything an agent
changes lives in the browser's memory — the same position as an AI editing an
unsaved buffer in a local editor — so no permission tiers are needed. Writing to
someone's Overleaf project is the one irreversible, outward-facing step, and it
stays a human action through the panel's Save button. Every mutating tool says so
in its reply, and that sentence is added by the SERVER rather than by whatever
the tab returned, so the guarantee cannot depend on the least reliable part of
the chain.

### Security

`/invoke` cannot carry the token — the primary does not have one. Instead it
**refuses any request bearing an `Origin` header**: a browser always attaches one
to a cross-origin POST, so this admits the Node primary and excludes web pages.
Without it, any page could POST to `/invoke` and run code, its response unread
but its effect real.

```bash
node checks/check-coalition.mjs   # 25 checks: registration, /invoke, reverse RPC,
                                  # attach/detach, every agent tool, Origin refusal
```

## Next

- **M2** — several kernels, `kernel_id`/label vocabulary shared with the
  extension, interrupt hardening.
- **M3** — join the MCP coalition (`POST /register`, `/invoke`, `/health`,
  election) so it appears in `wolfbook_list_clients` beside VS Code windows, and
  serves MCP itself when it is the only member.
- **M4** — `enable`/`disable` writing a launchd agent / systemd user unit.
