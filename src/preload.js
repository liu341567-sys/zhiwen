'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('browserAPI', {
  getState: () => ipcRenderer.invoke('browser:state'),
  createProfile: input => ipcRenderer.invoke('browser:create', input),
  updateProfile: (id, input) => ipcRenderer.invoke('browser:update', id, input),
  openProfile: id => ipcRenderer.invoke('browser:open', id),
  closeProfile: id => ipcRenderer.invoke('browser:close', id),
  deleteProfile: id => ipcRenderer.invoke('browser:delete', id),
  showOverview: () => ipcRenderer.invoke('browser:overview'),
  navigate: url => ipcRenderer.invoke('browser:navigate', url),
  goBack: () => ipcRenderer.invoke('browser:back'),
  goForward: () => ipcRenderer.invoke('browser:forward'),
  reload: () => ipcRenderer.invoke('browser:reload'),
  setContentBounds: bounds => ipcRenderer.invoke('browser:bounds', bounds),
  setOverlayVisible: visible => ipcRenderer.invoke('browser:overlay', visible),
  onShortcut: callback => {
    const listener = (_event, key) => callback(key);
    ipcRenderer.on('browser:shortcut', listener);
    return () => ipcRenderer.removeListener('browser:shortcut', listener);
  },
  onState: callback => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('browser:state-changed', listener);
    return () => ipcRenderer.removeListener('browser:state-changed', listener);
  }
});
