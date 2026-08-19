// viewer/popup.js — the toolbar dropdown.
//
// Its one job that nothing else can do: give a .wb file that is NOT in Overleaf
// a way in. Before this, clicking the toolbar icon offered only Chrome's own
// menu ("Remove from Chrome", "Unpin"), which told a user nothing about what
// the extension is for or how to open a notebook with it.
//
// The file picker deliberately does NOT live here. A Chrome popup closes the
// moment it loses focus — which is exactly what opening a file dialog does — so
// the chosen File would be discarded before it could be read. The popup opens
// the viewer page instead, and the picker lives there, in a window that stays.

const openTab = (url) => {
  chrome.tabs.create({ url });
  window.close();
};

document.querySelector('[data-act=open]').addEventListener('click', () => {
  openTab(chrome.runtime.getURL('viewer/standalone.html'));
});

document.querySelector('[data-act=overleaf]').addEventListener('click', () => {
  chrome.tabs.query({ url: ['*://*.overleaf.com/project/*'] }, (tabs) => {
    if (tabs && tabs.length) {
      chrome.tabs.update(tabs[0].id, { active: true });
      chrome.windows?.update(tabs[0].windowId, { focused: true });
      window.close();
    } else {
      openTab('https://www.overleaf.com/project');
    }
  });
});

const setVersion = (name, value, built) => {
  const el = document.querySelector(`[data-version="${name}"]`);
  if (!el) return;
  el.textContent = value && value !== 'unknown' ? `v${value}` : '—';
  if (built && built !== 'unknown') {
    const small = document.createElement('small');
    small.textContent = `built ${built}`;
    el.appendChild(small);
  }
};

setVersion('chrome', chrome.runtime.getManifest().version);

// Local-server status and the versions of the exact native binaries it loaded.
const status = document.querySelector('.status');
const text = status.querySelector('.text');
chrome.runtime.sendMessage({ cmd: 'serve-status' }, (res) => {
  void chrome.runtime.lastError;
  const running = !!(res?.ok && (res.connected || res.running));
  if (running) {
    status.classList.add('live');
    if (!res.authorised) status.classList.add('warning');
    text.innerHTML = `<strong>Local server running</strong> on 127.0.0.1:${Number(res.port)}`
      + (res.authorised ? ' — cells can run' : ' — token needed on first run');
  } else {
    status.classList.add('offline');
    text.innerHTML = '<strong>Local server not running</strong> — notebooks open read-only';
    document.querySelector('.help').classList.add('visible');
  }

  const health = res?.health || {};
  const info = res?.info || {};
  const versions = info.versions || health.versions || {};
  setVersion('server', info.serverVersion || health.serverVersion);
  setVersion('wolfbook', versions.wolfbook, versions.wolfbookBuildDate);
  setVersion('wstp', versions.wstp, versions.wstpBuildDate);
  setVersion('btl', versions.btl, versions.btlBuildDate);
});

document.querySelector('[data-act=copy-start]').addEventListener('click', async (ev) => {
  try {
    await navigator.clipboard.writeText('node server/cli.mjs start');
    ev.currentTarget.textContent = 'Copied ✓';
  } catch (_) {
    ev.currentTarget.textContent = 'Select the command above';
  }
});
