'use strict';

// This sandboxed preload exposes no objects or IPC to the website. Restore at
// document start, before login scripts can observe an empty sessionStorage.
const { ipcRenderer } = require('electron');

if (['http:', 'https:'].includes(window.location.protocol)) {
  try {
    // Consume the main tab's one-time restore even when Chromium already has
    // storage. Never refill a later empty document after a website cleared it.
    const entries = ipcRenderer.sendSync('browser:document-restore');
    if (window.sessionStorage.length === 0) {
      if (Array.isArray(entries)) for (const [key, value] of entries) window.sessionStorage.setItem(key, value);
    }
  } catch { /* The website may disable storage; Chromium governs this access. */ }

  window.addEventListener('pagehide', () => {
    try { ipcRenderer.sendSync('browser:document-checkpoint', window.location.origin, Object.entries(window.sessionStorage)); }
    catch { /* No storage snapshot is available for this document. */ }
  });
}
