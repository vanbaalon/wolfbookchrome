// host.mjs — find the wolfbook installation and the kernel it resolved.
//
// Resolution order, best first. Each step says where its answer came from, so a
// wrong kernel is diagnosable rather than mysterious.
//
//   1. ~/.wolfbook/host.json          written by the extension on every
//                                     successful kernel launch (kernel/lifecycle.js).
//                                     Authoritative: it is the answer from the
//                                     code that actually made the choice.
//   2. ~/.wolfbook-mcp-registry.json  accurate while a VS Code window is live,
//                                     but removeEntry() deletes it on clean exit.
//   3. wolfbook.systemKernel          only when the user pinned it explicitly;
//                                     the default "Automatic" means "not stated".
//   4. probing                        LAST RESORT, and it says so. Choosing a
//                                     kernel means ranking installs by VERSION —
//                                     a machine can have 14.1 and 15.0.1 side by
//                                     side — and this is a simplified copy of
//                                     logic that lives properly in find-kernel.js.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const HOME = os.homedir();
const HOST_RECORD = path.join(HOME, '.wolfbook', 'host.json');
const MCP_REGISTRY = path.join(HOME, '.wolfbook-mcp-registry.json');

const readJson = (p) => {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return null; }
};

/** Extension directories VS Code might have installed wolfbook into. */
function extensionRoots() {
  return [
    path.join(HOME, '.vscode', 'extensions'),
    path.join(HOME, '.vscode-insiders', 'extensions'),
    path.join(HOME, '.vscode-server', 'extensions'),
    path.join(HOME, '.vscode-oss', 'extensions'),
  ];
}

/** Newest installed wolfbook extension, by directory version suffix. */
export function findExtensionDir() {
  const found = [];
  for (const root of extensionRoots()) {
    let names = [];
    try { names = fs.readdirSync(root); } catch (_) { continue; }
    for (const name of names) {
      const m = /^wolfbook\.wolfbook-(.+)$/i.exec(name);
      if (!m) continue;
      const dir = path.join(root, name);
      if (fs.existsSync(path.join(dir, 'resources', 'init.wl'))) found.push({ dir, version: m[1] });
    }
  }
  found.sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }));
  return found[0]?.dir || null;
}

/** macOS app-bundle version, for ranking installs. */
function bundleVersion(appPath) {
  try {
    return execFileSync('defaults', ['read', path.join(appPath, 'Contents', 'Info.plist'),
      'CFBundleShortVersionString'], { encoding: 'utf8', timeout: 3000 }).trim();
  } catch (_) { return '0'; }
}

const cmpVersion = (a, b) => {
  const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pb[i] || 0) - (pa[i] || 0);
    if (d) return d;
  }
  return 0;
};

/** Last-resort search. Deliberately narrow; find-kernel.js is the real thing. */
function probeKernel() {
  const candidates = [];
  if (process.platform === 'darwin') {
    let apps = [];
    try { apps = fs.readdirSync('/Applications').filter((n) => /^Wolfram.*\.app$/i.test(n)); } catch (_) {}
    for (const app of apps) {
      const full = path.join('/Applications', app);
      const exe = path.join(full, 'Contents', 'MacOS', 'WolframKernel');
      if (fs.existsSync(exe)) candidates.push({ exe, version: bundleVersion(full) });
    }
  } else {
    for (const base of ['/usr/local/Wolfram', '/opt/Wolfram']) {
      for (const product of ['Wolfram', 'WolframEngine', 'Mathematica']) {
        const dir = path.join(base, product);
        let versions = [];
        try { versions = fs.readdirSync(dir).filter((v) => /^\d/.test(v)); } catch (_) { continue; }
        for (const v of versions) {
          const exe = path.join(dir, v, 'Executables', 'WolframKernel');
          if (fs.existsSync(exe)) candidates.push({ exe, version: v });
        }
      }
    }
    for (const exe of ['/usr/local/bin/WolframKernel', '/usr/bin/WolframKernel']) {
      if (fs.existsSync(exe)) candidates.push({ exe, version: '0' });
    }
  }
  candidates.sort((a, b) => cmpVersion(a.version, b.version));
  return candidates[0] || null;
}

/** VS Code user settings, if the kernel was pinned there. */
function pinnedKernel() {
  const files = [
    path.join(HOME, 'Library', 'Application Support', 'Code', 'User', 'settings.json'),
    path.join(HOME, '.config', 'Code', 'User', 'settings.json'),
    path.join(process.env.APPDATA || '', 'Code', 'User', 'settings.json'),
  ];
  for (const f of files) {
    let raw;
    try { raw = fs.readFileSync(f, 'utf8'); } catch (_) { continue; }
    // settings.json permits comments and trailing commas.
    const stripped = raw.replace(/^\s*\/\/.*$/gm, '').replace(/,(\s*[}\]])/g, '$1');
    let cfg;
    try { cfg = JSON.parse(stripped); } catch (_) { continue; }
    const v = cfg['wolfbook.systemKernel'];
    if (v && v !== 'Automatic' && fs.existsSync(v)) return v;
  }
  return null;
}

/**
 * @returns {{extensionDir, resourcesDir, kernelExecutable, wolframVersion, source, warnings[]}}
 */
export function resolveHost({ extensionDir: overrideExt, kernel: overrideKernel } = {}) {
  const warnings = [];
  let extensionDir = overrideExt || null;
  let kernelExecutable = overrideKernel || null;
  let wolframVersion = null;
  let source = overrideKernel ? 'override' : null;

  // 1. the extension's own record
  const rec = readJson(HOST_RECORD);
  if (rec && rec.kernelExecutable) {
    if (!kernelExecutable && fs.existsSync(rec.kernelExecutable)) {
      kernelExecutable = rec.kernelExecutable;
      wolframVersion = rec.wolframVersion || null;
      source = 'host.json';
    } else if (!fs.existsSync(rec.kernelExecutable)) {
      warnings.push(`~/.wolfbook/host.json points at a kernel that no longer exists (${rec.kernelExecutable})`);
    }
    if (!extensionDir && rec.extensionDir && fs.existsSync(rec.extensionDir)) extensionDir = rec.extensionDir;
  }

  // 2. a live VS Code window
  if (!kernelExecutable) {
    const reg = readJson(MCP_REGISTRY);
    const exe = Array.isArray(reg)
      ? reg.flatMap((e) => e.kernels || []).map((k) => k.executable).find((p) => p && fs.existsSync(p))
      : null;
    if (exe) { kernelExecutable = exe; source = 'mcp-registry'; }
  }

  // 3. an explicit user setting
  if (!kernelExecutable) {
    const pinned = pinnedKernel();
    if (pinned) { kernelExecutable = pinned; source = 'wolfbook.systemKernel'; }
  }

  // 4. guessing
  if (!kernelExecutable) {
    const probed = probeKernel();
    if (probed) {
      kernelExecutable = probed.exe;
      wolframVersion = probed.version;
      source = 'probe';
      warnings.push('No recorded kernel found, so one was GUESSED by probing. '
        + 'Run a notebook in VS Code once to record the right one in ~/.wolfbook/host.json.');
    }
  }

  if (!extensionDir) {
    extensionDir = findExtensionDir();
    if (extensionDir && rec) warnings.push('host.json had no usable extensionDir; fell back to scanning ~/.vscode/extensions.');
  }

  return {
    extensionDir,
    resourcesDir: extensionDir ? path.join(extensionDir, 'resources') : null,
    kernelExecutable,
    wolframVersion,
    source,
    warnings,
  };
}

/** The N-API addons the installed extension ships, for this platform. */
export function findAddons(extensionDir) {
  const triple = `${process.platform}-${process.arch}`;
  const pick = (...candidates) => candidates.find((p) => p && fs.existsSync(p)) || null;
  return {
    wstp: pick(
      path.join(extensionDir, 'wstp', 'prebuilt', `wstp-${triple}.node`),
      path.join(extensionDir, 'wstp', 'build', 'Release', 'wstp.node'),
    ),
    // Optional: without it, maths comes back as box expressions rather than LaTeX.
    btl: pick(
      path.join(extensionDir, 'wllatex-addon', 'prebuilt', `wolfbook_btl-${triple}.node`),
      path.join(extensionDir, 'wllatex-addon', 'wolfbook_btl.node'),
    ),
  };
}
