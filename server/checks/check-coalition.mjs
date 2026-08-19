#!/usr/bin/env node
// Checks coalition membership and the agent-facing tool surface.
//
//   node checks/check-coalition.mjs
//
// Stands in for the MCP primary: listens on 27182, receives the registration,
// and drives wolfbook-serve exactly as the real primary does —
// `POST /invoke {name, arguments}` — with a fake Overleaf tab attached over SSE
// answering the reverse RPCs.
//
// Skips if a real primary already holds 27182 (a VS Code window), because
// stealing that port would disrupt a live session.

import http from 'node:http';
import { startServer } from '../server.mjs';
import { resolveHost } from '../host.mjs';

let failures = 0;
const say = (l, c, extra) => {
  console.log(`${c ? 'ok  ' : 'FAIL'} ${l}${extra ? `  — ${extra}` : ''}`);
  if (!c) failures++;
};

const pre = resolveHost();
if (!pre.kernelExecutable || !pre.extensionDir) {
  console.log('SKIP — no Wolfram kernel or installed wolfbook extension');
  process.exit(0);
}

// ── a stand-in primary on 27182 ────────────────────────────────────────────
let registration = null;
const primary = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/register') {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      try { registration = JSON.parse(body); } catch (_) {}
      res.writeHead(200); res.end();
    });
    return;
  }
  res.writeHead(404); res.end();
});

// An ephemeral port, not 27182: a working machine almost always has a real
// primary there, and stealing it would disrupt a live session.
await new Promise((resolve) => primary.listen(0, '127.0.0.1', resolve));
const primaryPort = primary.address().port;

let s;
try {
  s = await startServer({ port: 0, primaryPort });
  say('the server starts and joins the coalition', true, s.coalition.clientId);

  // Registration is periodic; the first one happens at listen time.
  for (let i = 0; i < 40 && !registration; i++) await new Promise((r) => setTimeout(r, 100));
  say('it registers with the primary', !!registration, registration && registration.clientId);
  if (registration) {
    say('the registration carries our port', registration.port === s.port, String(registration.port));
    say('it advertises a kernel', (registration.kernels || []).length === 1,
        JSON.stringify(registration.kernels?.[0]?.kernel_label));
    say('no notebooks are advertised before a tab attaches',
        (registration.notebooks || []).length === 0, JSON.stringify(registration.notebooks));
  }

  const invoke = async (name, args) => {
    const res = await fetch(`${s.url}/invoke`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, arguments: args || {} }),
    });
    return res.json();
  };
  // The reply is the PRIMARY's wire shape — {parts:[{kind,value}]} — not MCP
  // content blocks. This check previously read `r.content`, which is what let a
  // real regression through: the server answered in MCP shape, the primary read
  // `r.parts`, found none, and every tool call reached the agent as an empty
  // string. Read it exactly the way claude-mcp/server.js does.
  const textOf = (r) => (r.parts || []).filter((p) => p.kind === 'text')
    .map((p) => p.value).join('\n') || (r.error || '');

  // ── /invoke must not be reachable from a web page ────────────────────────
  const fromPage = await fetch(`${s.url}/invoke`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
    body: JSON.stringify({ name: 'wolfbook_kernelStatus', arguments: {} }),
  });
  say('a request carrying an Origin is refused', fromPage.status === 403, `HTTP ${fromPage.status}`);

  const status = await invoke('wolfbook_kernelStatus');
  say('the primary can invoke a tool', !status.isError, textOf(status).slice(0, 60));
  // Pin the wire shape itself, not just that some text came back.
  say('the reply speaks the primary\'s wire shape',
      Array.isArray(status.parts) && status.parts.every((p) => p.kind && 'value' in p)
      && status.content === undefined,
      Object.keys(status).join('+'));

  const unknown = await invoke('wolfbook_debugCell');
  say('an unimplemented tool says so honestly',
      unknown.isError && /does not implement/.test(textOf(unknown)),
      textOf(unknown).slice(0, 60));

  const noNb = await invoke('wolfbook_getNotebookContext');
  say('with no tab attached it explains why, not "undefined"',
      noNb.isError && /No Overleaf notebook is attached/.test(textOf(noNb)));

  // ── a fake Overleaf tab: SSE in, RPC answers out ─────────────────────────
  const seen = [];
  const requests = [];
  const ac = new AbortController();
  const sse = await fetch(`${s.url}/v1/events?token=${encodeURIComponent(s.token)}`, { signal: ac.signal });
  const model = {
    cells: [
      { kind: 1, value: '# Title', languageId: 'markdown', outputs: [] },
      { kind: 2, value: 'Range[3]', languageId: 'wolfram', outputs: [] },
    ],
  };
  (async () => {
    const reader = sse.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          if (!/^event: rpc/m.test(block)) continue;
          const req = JSON.parse(block.split('\n').find((l) => l.startsWith('data:')).slice(5).trim());
          seen.push(req.method);
          requests.push(req);
          let result;
          if (req.method === 'getContext') result = { path: 'x', cells: model.cells };
          else if (req.method === 'editCell') {
            model.cells[req.params.index].value = req.params.value;
            result = { summary: 'edited ' + req.params.index };
          } else if (req.method === 'insertCells') {
            model.cells.splice(req.params.index, 0, ...req.params.cells);
            result = { summary: 'inserted' };
          } else if (req.method === 'deleteCell') {
            model.cells.splice(req.params.index, 1);
            result = { summary: 'deleted' };
          } else result = { summary: req.method };
          fetch(`${s.url}/v1/rpc/${req.id}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Wolfbook-Token': s.token },
            body: JSON.stringify({ result }),
          }).catch(() => {});
        }
      }
    } catch (_) {}
  })();
  await new Promise((r) => setTimeout(r, 300));

  const attach = await (await fetch(`${s.url}/v1/notebooks/attach`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Wolfbook-Token': s.token },
    body: JSON.stringify({ projectId: 'p1', projectName: '2026 test wolfbook', fileName: 'Demo.wb' }),
  })).json();
  say('a tab can attach a notebook', !!attach.notebookId, attach.path);
  say('the path marks it as NOT a file on disk',
      String(attach.path).startsWith('overleaf:'), attach.path);

  registration = null;
  for (let i = 0; i < 40 && !registration; i++) await new Promise((r) => setTimeout(r, 100));
  say('attaching re-registers so agents see it promptly',
      !!registration && (registration.notebooks || []).includes(attach.path),
      JSON.stringify(registration && registration.notebooks));

  const routeStatus = await (await fetch(`${s.url}/v1/notebooks/status`, {
    headers: { 'X-Wolfbook-Token': s.token },
  })).json();
  say('status proves the complete reverse route reaches the tab',
      routeStatus.notebooks?.[0]?.reachable === true && seen.includes('ping'),
      JSON.stringify(routeStatus.notebooks));

  // ── the tools an agent would actually use ────────────────────────────────
  const ctx = await invoke('wolfbook_getNotebookContext', {});
  say('an agent can read the notebook', /Range\[3\]/.test(textOf(ctx)), textOf(ctx).split('\n')[0]);
  say('it reads the LIVE model through the tab', seen.includes('getContext'));

  const edited = await invoke('wolfbook_editCell', { cellIndex: 1, content: 'Range[9]' });
  say('an agent can edit a cell', !edited.isError, textOf(edited));
  say('the edit reached the tab model', model.cells[1].value === 'Range[9]', model.cells[1].value);
  // Assert the GUARANTEE, not a keyword: an agent must be told the change is
  // not published and that a person has to Save it.
  say('the reply says the change is not published',
      /browser only/i.test(textOf(edited)) && /Save/.test(textOf(edited)),
      textOf(edited).split('\n').pop());

  const canonicalEdit = await invoke('wolfbook_editCell', { cellNumber: 2, content: 'Range[10]' });
  say('canonical cellNumber is converted from 1-based to browser 0-based',
      !canonicalEdit.isError && requests.at(-1)?.params?.index === 1,
      JSON.stringify(requests.at(-1)?.params));
  const canonicalRun = await invoke('wolfbook_runCell', { cellNumber: 2 });
  say('canonical single-cell run reaches the intended browser cell',
      !canonicalRun.isError && requests.at(-1)?.method === 'runCell'
      && requests.at(-1)?.params?.index === 1);
  const canonicalRange = await invoke('wolfbook_runCell', { startCell: 1, endCell: 2 });
  say('canonical inclusive run range is converted correctly',
      !canonicalRange.isError && requests.at(-1)?.method === 'runCells'
      && requests.at(-1)?.params?.start === 0 && requests.at(-1)?.params?.end === 1,
      JSON.stringify(requests.at(-1)?.params));

  const ins = await invoke('wolfbook_insertCells', { index: 2, cells: [{ kind: 'code', value: '1+1' }] });
  say('an agent can insert a cell', !ins.isError && model.cells.length === 3, String(model.cells.length));

  const del = await invoke('wolfbook_deleteCell', { cellIndex: 2 });
  say('an agent can delete a cell', !del.isError && model.cells.length === 2, String(model.cells.length));

  // These mutate, so they run after the count-sensitive checks above.
  for (const [tool, args] of [['wolfbook_insertCells', { index: 0, cells: [{ kind: 'code', value: 'x' }] }],
                              ['wolfbook_moveCell', { fromIndex: 0, toIndex: 1 }]]) {
    const r = await invoke(tool, args);
    say(`${tool} says so too`, /browser only/i.test(textOf(r)));
  }

  const found = await invoke('wolfbook_searchCells', { query: 'Range' });
  say('an agent can search cells', /Range/.test(textOf(found)));

  const evaluated = await invoke('wolfbook_evaluateExpression', { expression: '6*7' });
  say('an agent can evaluate on the kernel', /42/.test(textOf(evaluated)), textOf(evaluated).slice(0, 20));

  say('saving is NOT exposed as a tool — it stays the person’s action',
      !s.toolSurface.names.includes('wolfbook_saveNotebook'),
      s.toolSurface.names.length + ' tools offered');

  // ── materialise: the notebook must survive WHOLE ─────────────────────────
  // wolfbook_newNotebook drops outputs, which is the entire reason this exists.
  const withOutputs = JSON.stringify({
    cells: [
      { kind: 2, value: 'Plot[Sin[x],{x,0,1}]', languageId: 'wolfram',
        outputs: [{ items: [{ mime: 'text/plain', data: '(* graphics *)' }], id: 'keep-me' }],
        metadata: { mine: true } },
    ],
  }, null, 1);
  const mat = await (await fetch(`${s.url}/v1/materialise`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Wolfbook-Token': s.token },
    body: JSON.stringify({ fileName: 'Demo.wb', projectName: 'proj x', text: withOutputs }),
  })).json();
  say('a notebook can be written to disk', !!mat.path, mat.path);
  if (mat.path) {
    const { readFileSync } = await import('node:fs');
    const back = JSON.parse(readFileSync(mat.path, 'utf8'));
    say('OUTPUTS survive the trip', back.cells[0].outputs?.[0]?.id === 'keep-me');
    say('metadata survives too', back.cells[0].metadata?.mine === true);
    say('it lands under the user wolfbook directory, not Downloads',
        mat.path.includes('/.wolfbook/overleaf/'), mat.path);
  }
  const bad = await fetch(`${s.url}/v1/materialise`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Wolfbook-Token': s.token },
    body: JSON.stringify({ fileName: '../../escape.wb', text: '{}' }),
  });
  const badBody = await bad.json();
  // The invariant is CONTAINMENT, not the absence of dots: "../../escape.wb"
  // becomes the literal filename ".._.._escape.wb", which is perfectly safe.
  const { resolve } = await import('node:path');
  const { homedir } = await import('node:os');
  const home = resolve(homedir(), '.wolfbook', 'overleaf');
  say('a path-traversing filename cannot escape the directory',
      !badBody.path || resolve(badBody.path).startsWith(home),
      badBody.path || badBody.error);

  // ── a tab that goes away must not leave a ghost ───────────────────────────
  ac.abort();
  await new Promise((r) => setTimeout(r, 500));
  const after = await (await fetch(`${s.url}/v1/notebooks`, {
    headers: { 'X-Wolfbook-Token': s.token },
  })).json();
  say('closing the tab removes its notebook', (after.notebooks || []).length === 0,
      JSON.stringify(after.notebooks));
} catch (e) {
  say('the check ran to completion', false, String(e?.message || e));
  console.error(e);
} finally {
  await s?.close?.();
  primary.close();
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\ncoalition checks passed');
process.exit(failures ? 1 : 0);
