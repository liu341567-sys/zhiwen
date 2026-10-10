'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('developerAPI', {
  command: (command, input) =>
    ipcRenderer.invoke('developer:command', command, input),
  onChanged: (callback) => {
    const fn = () => callback();
    ipcRenderer.on('developer:changed', fn);
    return () => ipcRenderer.removeListener('developer:changed', fn);
  },
});
