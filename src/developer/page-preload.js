'use strict';

// Registered for existing profile frames, including cross-origin frames.
// This channel is private to the isolated preload world. No contextBridge is
// exposed, and the page receives neither IPC nor Node.js capabilities.
const { ipcRenderer, webFrame } = require('electron');
globalThis.__qiyeDeveloperNotify = (event) =>
  ipcRenderer.send('developer:page-event', event);
ipcRenderer.on('developer:frame-request', async (_event, request) => {
  if (
    !request ||
    typeof request.id !== 'string' ||
    typeof request.script !== 'string'
  )
    return;
  try {
    const result = await webFrame.executeJavaScriptInIsolatedWorld(999, [
      { code: request.script },
    ]);
    if (result === undefined || JSON.stringify(result).length > 2 * 1024 * 1024)
      throw new Error('网页采样失败或超过范围');
    ipcRenderer.send('developer:frame-reply', request.id, result);
  } catch {
    ipcRenderer.send(
      'developer:frame-reply',
      request.id,
      null,
      '框架不可访问或正在跳转',
    );
  }
});
