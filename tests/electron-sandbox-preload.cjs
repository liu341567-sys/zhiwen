'use strict';

// Test-only private reporting: no objects or helpers are exposed to websites.
const { ipcRenderer } = require('electron');
ipcRenderer.sendSync('qiye-test:renderer-runtime', {
  sandboxed: process.sandboxed,
  contextIsolated: process.contextIsolated,
  isMainFrame: process.isMainFrame,
});
