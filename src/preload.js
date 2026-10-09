'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('browserAPI', {
  getState: () => ipcRenderer.invoke('browser:state'),
  createProfile: input => ipcRenderer.invoke('browser:create', input),
  updateProfile: (id, input) => ipcRenderer.invoke('browser:update', id, input),
  moveProfile: (id, beforeId = null) => ipcRenderer.invoke('browser:move', id, beforeId),
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
  showToast: notification => ipcRenderer.invoke('browser:toast', notification),
  positionToast: bounds => ipcRenderer.invoke('browser:toast', { bounds }),
  updateUIPreferences: preferences => ipcRenderer.invoke('browser:ui-preferences', preferences),
  setNavigationOverlay: visible => ipcRenderer.invoke('browser:navigation-overlay', visible),
  startLoginDiagnostics: () => ipcRenderer.invoke('browser:diagnostics-start'),
  getLoginDiagnostics: () => ipcRenderer.invoke('browser:diagnostics-get'),
  stopLoginDiagnostics: () => ipcRenderer.invoke('browser:diagnostics-stop'),
  saveLoginDiagnostics: () => ipcRenderer.invoke('browser:diagnostics-save'),
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

contextBridge.exposeInMainWorld('publishingAPI', {
  command: (command,input) => ipcRenderer.invoke('publishing:command',command,input),
  paths: files => Array.from(files).map(file => webUtils.getPathForFile(file)).filter(Boolean),
  onChanged: callback => { const fn=()=>callback(); ipcRenderer.on('publishing:changed',fn); return ()=>ipcRenderer.removeListener('publishing:changed',fn); },
  onTakeover: callback => { const fn=(_event,id)=>callback(id); ipcRenderer.on('publishing:takeover',fn); return ()=>ipcRenderer.removeListener('publishing:takeover',fn); }
});
