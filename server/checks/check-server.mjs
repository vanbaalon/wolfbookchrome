#!/usr/bin/env node
// End-to-end check for wolfbook-serve against a REAL Wolfram kernel.
//
//   node server/checks/check-server.mjs
//
// Starts the server, evaluates over HTTP, and verifies the things that make this
// worth building at all: untruncated rich output, an image actually fetchable
// over HTTP, maths as LaTeX, and that the token is enforced.
//
// Skips cleanly when no kernel or no installed extension is present.

import { startServer } from '../server.mjs';
import { resolveHost } from '../host.mjs';

let failures = 0;
const say = (label, ok, extra) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${extra ? `  — ${extra}` : ''}`);
  if (!ok) failures++;
};

const pre = resolveHost();
if (!pre.kernelExecutable || !pre.extensionDir) {
  console.log(`SKIP — ${!pre.kernelExecutable ? 'no Wolfram kernel' : 'no installed wolfbook extension'}`);
  process.exit(0);
}
console.log(`host: kernel from ${pre.source}, ext ${pre.extensionDir.split('/').pop()}`);

let s;
try {
  const t0 = Date.now();
  s = await startServer({ port: 0 });
  say('server starts with a live kernel', true,
      `${Date.now() - t0} ms, wolfram ${s.kernel.wolframVersion?.split(' ')[0] || '?'}`);

  const call = (p, init = {}) => fetch(`${s.url}${p}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', 'X-Wolfbook-Token': s.token, ...(init.headers || {}) },
  });
  const evalCell = async (code) => (await call('/v1/eval', {
    method: 'POST', body: JSON.stringify({ code }),
  })).json();

  // ── auth ────────────────────────────────────────────────────────────────
  const noTok = await fetch(`${s.url}/v1/info`);
  say('requests without a token are refused', noTok.status === 401, `HTTP ${noTok.status}`);
  const badTok = await fetch(`${s.url}/v1/info`, { headers: { 'X-Wolfbook-Token': 'x'.repeat(32) } });
  say('a wrong token is refused', badTok.status === 401, `HTTP ${badTok.status}`);
  const health = await (await fetch(`${s.url}/health`)).json();
  say('/health is reachable without a token', health.status === 'ok');
  say('/health does not leak the token', !JSON.stringify(health).includes(s.token));
  const info = await (await call('/v1/info')).json();
  say('/v1/info works with the token', !!info.kernelExecutable, info.kernelSource);

  // ── evaluation ──────────────────────────────────────────────────────────
  const sum = await evalCell('2 + 2');
  say('evaluates arithmetic', /4/.test(sum.text) || /4/.test(sum.html),
      JSON.stringify((sum.text || sum.html || '').slice(0, 40)));
  say('reports the Out[n] number', Number(sum.outN) > 0, `Out[${sum.outN}]`);

  const state = await evalCell('wbTestVar = 41; wbTestVar + 1');
  say('state persists between cells', /42/.test(state.text) || /42/.test(state.html),
      JSON.stringify((state.text || '').slice(0, 30)));

  const printed = await evalCell('Print["hello from kernel"]; 7');
  say('Print output is captured', (printed.print || []).some((l) => /hello from kernel/.test(l)),
      JSON.stringify(printed.print?.[0] || ''));

  const msg = await evalCell('1/0');
  say('kernel messages are reported', (msg.messages || []).some((m) => /infy|Infinite/i.test(m)),
      JSON.stringify(msg.messages?.[0] || '').slice(0, 60));

  // ── the reasons for building this ───────────────────────────────────────
  const big = await evalCell('Range[400]');
  say('large output is NOT truncated', /\b399\b/.test(big.text) || /\b399\b/.test(big.html),
      `${(big.text || '').length} chars of text`);

  const plot = await evalCell('Plot[Sin[x], {x, 0, 2 Pi}]');
  // `\ssrc=` on purpose: a greedy/loose match also hits data-wl-plot-src, which
  // points at the tooltip JSON rather than the picture.
  const src = (/<img\b[^>]*?\ssrc="([^"]+)"/.exec(plot.html) || [])[1];
  say('a Plot renders to HTML with an image', !!src, src || plot.html.slice(0, 70));
  say('the image path is well formed', !!src && !src.includes('//'), src);
  say('an SVG (not a fallback raster) was produced', !!src && /\.svg$/i.test(src), src);
  if (src) {
    const rel = src.replace(/^img\//, '');
    const imgRes = await call(`/img/${rel}`);
    const bytes = imgRes.ok ? (await imgRes.arrayBuffer()).byteLength : 0;
    say('the image is fetchable over HTTP', imgRes.ok && bytes > 200,
        `HTTP ${imgRes.status}, ${bytes} bytes, ${imgRes.headers.get('content-type')}`);
  }
  say('path traversal on /img/ is refused',
      (await call('/img/../../../../etc/passwd')).status === 404);

  const maths = await evalCell('Integrate[1/(1 + x^3), x]');
  const b64 = (/data-latex-b64="([^"]*)"/.exec(maths.html) || [])[1];
  const latex = b64 ? Buffer.from(b64, 'base64').toString('utf8') : '';
  say('maths comes back as LaTeX, not box expressions',
      !!latex && !maths.html.includes('wllatex-boxes'), JSON.stringify(latex.slice(0, 50)));

  // ── streaming ───────────────────────────────────────────────────────────
  const ac = new AbortController();
  const events = [];
  const streamed = fetch(`${s.url}/v1/events?token=${encodeURIComponent(s.token)}`, { signal: ac.signal })
    .then(async (r) => {
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = dec.decode(value, { stream: true });
        for (const m of chunk.matchAll(/^event: (\w[\w-]*)/gm)) events.push(m[1]);
      }
    }).catch(() => {});
  await new Promise((r) => setTimeout(r, 300));
  await evalCell('Print["streamed"]; 1');
  await new Promise((r) => setTimeout(r, 400));
  ac.abort();
  await streamed;
  say('SSE delivers evaluation events', events.includes('eval-start') && events.includes('eval-done'),
      events.join(',') || '(none)');
  say('SSE delivers Print output live', events.includes('print'), events.join(','));
} catch (e) {
  say('check completed', false, String(e?.message || e));
  console.error(e);
} finally {
  await s?.close?.();
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nwolfbook-serve checks passed');
process.exit(failures ? 1 : 0);
