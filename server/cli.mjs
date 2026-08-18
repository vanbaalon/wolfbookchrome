#!/usr/bin/env node
// cli.mjs — how a person starts, stops and inspects wolfbook-serve.
//
//   node cli.mjs start | stop | restart | status | token | logs | enable | disable
//
// `start` runs it DETACHED, so it outlives the terminal — this is a background
// service, not a foreground command. `enable` goes further and registers it to
// start at login (launchd on macOS, a systemd user unit on Linux), which is the
// on/off switch a user actually wants.
//
// Deliberately no daemon of our own: the OS already has a supervisor, and
// reusing it means `enable` survives reboots, crashes and upgrades without this
// project owning any of that.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { STATE_FILE, STATE_DIR, readState, writeState, loadOrCreateToken } from './server.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(here, 'server.mjs');
const LOG = path.join(STATE_DIR, 'serve.log');
const LABEL = 'com.wolfbook.serve';
const PLIST = path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
const UNIT = path.join(os.homedir(), '.config', 'systemd', 'user', 'wolfbook-serve.service');

const alive = (pid) => {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
};

async function health(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return null;
    const body = await res.json();
    return body?.service === 'wolfbook-serve' ? body : null;
  } catch (_) { return null; }
}

/** Find a running instance, whether we started it or launchd did. */
async function locate() {
  const st = readState();
  if (st.port) {
    const h = await health(st.port);
    if (h) return { port: st.port, pid: st.pid, health: h };
  }
  for (let port = 27300; port <= 27309; port++) {
    const h = await health(port);
    if (h) return { port, pid: st.pid, health: h };
  }
  return null;
}

async function cmdStatus() {
  const found = await locate();
  if (!found) { console.log('wolfbook-serve: not running'); return 1; }
  const st = readState();
  console.log('wolfbook-serve: running');
  console.log(`  url      http://127.0.0.1:${found.port}`);
  console.log(`  wolfram  ${found.health.wolframVersion || 'unknown'}`);
  console.log(`  pid      ${alive(st.pid) ? st.pid : '(not started by this CLI)'}`);
  console.log(`  token    ${st.token ? st.token.slice(0, 6) + '…  (run `token` to print)' : '(none)'}`);
  console.log(`  logs     ${LOG}`);
  return 0;
}

async function cmdStart() {
  const found = await locate();
  if (found) { console.log(`already running on http://127.0.0.1:${found.port}`); return 0; }

  fs.mkdirSync(STATE_DIR, { recursive: true });
  const out = fs.openSync(LOG, 'a');
  // Detached + unref'd, so closing the terminal does not take the kernel with it.
  const child = spawn(process.execPath, [SERVER, ...process.argv.slice(3)], {
    detached: true, stdio: ['ignore', out, out],
  });
  child.unref();

  // The kernel takes a few seconds; wait for it rather than claiming success.
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const f = await locate();
    if (f) {
      console.log(`wolfbook-serve started on http://127.0.0.1:${f.port}`);
      console.log(`  token  ${readState().token}`);
      console.log('  paste that into the Overleaf extension when it asks (once).');
      return 0;
    }
  }
  console.error(`failed to start within 20s — see ${LOG}`);
  return 1;
}

async function cmdStop() {
  const st = readState();
  const found = await locate();
  if (!found && !alive(st.pid)) { console.log('wolfbook-serve: not running'); return 0; }
  if (!alive(st.pid)) {
    console.log(`running on port ${found?.port} but not started by this CLI — stop it where it was started`);
    return 1;
  }
  process.kill(st.pid, 'SIGTERM');
  for (let i = 0; i < 20; i++) {
    if (!alive(st.pid)) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  if (alive(st.pid)) { try { process.kill(st.pid, 'SIGKILL'); } catch (_) {} }
  writeState({ pid: null });
  console.log('wolfbook-serve stopped');
  return 0;
}

function plistBody() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${process.execPath}</string>
    <string>${SERVER}</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict><key>SuccessfulExit</key><false/></dict>
  <key>StandardOutPath</key><string>${LOG}</string>
  <key>StandardErrorPath</key><string>${LOG}</string>
</dict>
</plist>
`;
}

function unitBody() {
  return `[Unit]
Description=wolfbook-serve — local Wolfbook notebook server

[Service]
ExecStart=${process.execPath} ${SERVER}
Restart=on-failure

[Install]
WantedBy=default.target
`;
}

async function cmdEnable() {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  loadOrCreateToken();                       // so the token exists before first launch
  if (process.platform === 'darwin') {
    fs.mkdirSync(path.dirname(PLIST), { recursive: true });
    fs.writeFileSync(PLIST, plistBody());
    const uid = process.getuid();
    try { execFileSync('launchctl', ['bootout', `gui/${uid}/${LABEL}`], { stdio: 'ignore' }); } catch (_) {}
    execFileSync('launchctl', ['bootstrap', `gui/${uid}`, PLIST]);
    console.log(`enabled at login (launchd: ${LABEL})`);
    console.log(`  plist  ${PLIST}`);
  } else if (process.platform === 'linux') {
    fs.mkdirSync(path.dirname(UNIT), { recursive: true });
    fs.writeFileSync(UNIT, unitBody());
    execFileSync('systemctl', ['--user', 'daemon-reload']);
    execFileSync('systemctl', ['--user', 'enable', '--now', 'wolfbook-serve.service']);
    console.log('enabled at login (systemd user unit)');
  } else {
    console.error('enable is implemented for macOS and Linux; on Windows use Task Scheduler with:');
    console.error(`  ${process.execPath} ${SERVER}`);
    return 1;
  }
  console.log(`  token  ${readState().token}`);
  return 0;
}

async function cmdDisable() {
  if (process.platform === 'darwin') {
    try { execFileSync('launchctl', ['bootout', `gui/${process.getuid()}/${LABEL}`], { stdio: 'ignore' }); } catch (_) {}
    fs.rmSync(PLIST, { force: true });
    console.log('disabled at login (launchd agent removed)');
  } else if (process.platform === 'linux') {
    try { execFileSync('systemctl', ['--user', 'disable', '--now', 'wolfbook-serve.service']); } catch (_) {}
    fs.rmSync(UNIT, { force: true });
    console.log('disabled at login (systemd unit removed)');
  } else {
    console.error('nothing to disable on this platform');
    return 1;
  }
  return 0;
}

const cmd = process.argv[2] || 'status';
const table = {
  start: cmdStart,
  stop: cmdStop,
  restart: async () => { await cmdStop(); return cmdStart(); },
  status: cmdStatus,
  token: async () => { console.log(loadOrCreateToken()); return 0; },
  logs: async () => {
    if (!fs.existsSync(LOG)) { console.log(`no log yet at ${LOG}`); return 0; }
    console.log(fs.readFileSync(LOG, 'utf8').split('\n').slice(-40).join('\n'));
    return 0;
  },
  enable: cmdEnable,
  disable: cmdDisable,
};

if (!table[cmd]) {
  console.error(`usage: node cli.mjs ${Object.keys(table).join(' | ')}`);
  process.exit(2);
}
process.exit(await table[cmd]());
