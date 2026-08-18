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

// Kernel status, purely informational — everything above works without one.
const status = document.querySelector('.status');
const text = status.querySelector('.text');
chrome.runtime.sendMessage({ cmd: 'serve-status' }, (res) => {
  void chrome.runtime.lastError;
  if (res?.ok && res.running) {
    status.classList.add('live');
    text.textContent = `wolfbook-serve on :${res.port} — cells can run`;
  } else {
    text.textContent = 'no local kernel — notebooks open read-only';
  }
});
