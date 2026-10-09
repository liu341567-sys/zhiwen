'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// This local UI surface can receive messages and report its own height only.
// It has no environment-management or remote-page capability.
contextBridge.exposeInMainWorld('toastAPI', {
  onMessage: callback => ipcRenderer.on('browser:toast-changed', (_event, message) => callback(message)),
  resized: (sequence, height) => ipcRenderer.send('browser:toast-size', { sequence, height })
});
