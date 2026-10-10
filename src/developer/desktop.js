'use strict';
const {
  BrowserWindow,
  ipcMain,
  dialog,
  clipboard,
  screen,
} = require('electron');
const path = require('node:path'),
  fs = require('node:fs');
const { randomUUID } = require('node:crypto');
function installDeveloperDesktop({
  service,
  manager,
  icon,
  reveal,
  publisher,
}) {
  let window = null;
  const pending = new Map();
  service.executeFrame = (frame, script) => {
    // Electron intentionally does not run Node/preload IPC in subframes with
    // nodeIntegrationInSubFrames disabled. Keep that security setting intact.
    // Child-frame DOM/event sampling therefore has no privileged bridge and is
    // marked as page-world data; it is never used to execute publishing actions.
    if (frame !== service.view().mainFrame)
      return frame.executeJavaScript(script);
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error('框架通信超时'));
      }, 2400);
      pending.set(id, { frame, resolve, reject, timer });
      try {
        frame.send('developer:frame-request', { id, script });
      } catch (error) {
        clearTimeout(timer);
        pending.delete(id);
        reject(error);
      }
    });
  };
  ipcMain.on('developer:frame-reply', (event, id, result, error) => {
    const request = pending.get(id);
    if (
      !request ||
      event.senderFrame?.frameTreeNodeId !== request.frame.frameTreeNodeId ||
      event.sender !== service.inspectView(service.active)
    )
      return;
    clearTimeout(request.timer);
    pending.delete(id);
    if (error) request.reject(new Error('框架暂不可访问'));
    else request.resolve(result);
  });
  const notify = () => {
    if (window && !window.isDestroyed())
      window.webContents.send('developer:changed');
  };
  service.changed = notify;
  const allowed = (event) => {
    if (
      !window ||
      window.isDestroyed() ||
      event.sender !== window.webContents ||
      event.senderFrame !== window.webContents.mainFrame
    )
      throw new Error('仅开发者工具窗口可以操作调试资料');
  };
  const open = async () => {
    service.suspended = false;
    if (window && !window.isDestroyed()) {
      window.show();
      window.focus();
      return;
    }
    const area = screen.getDisplayMatching(manager.getBounds()).workArea;
    window = new BrowserWindow({
      title: '栖页开发者工具中心',
      width: Math.min(1180, area.width),
      height: Math.min(800, area.height),
      minWidth: 760,
      minHeight: 520,
      icon,
      backgroundColor: '#f6f8fc',
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        sandbox: true,
        nodeIntegration: false,
        contextIsolation: true,
        webSecurity: true,
      },
    });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (e) => e.preventDefault());
    window.on('closed', () => {
      window = null;
      service.suspended = true;
      service
        .serial(async () => {
          if (service.report) {
            if (['recording', 'paused'].includes(service.report.status))
              await service.command('stop');
            else await service.release();
          }
        })
        .catch(() => {});
    });
    await window.loadFile(path.join(__dirname, 'index.html'));
  };
  ipcMain.handle('developer:open', async (event) => {
    if (
      event.sender !== manager.webContents ||
      event.senderFrame !== manager.webContents.mainFrame
    )
      throw new Error('无权打开开发者工具');
    await open();
    return true;
  });
  ipcMain.on('developer:page-event', (event, payload) => {
    if (
      !service.active ||
      event.sender !== service.inspectView(service.active) ||
      !event.senderFrame
    )
      return;
    const frames = event.sender.mainFrame.framesInSubtree;
    const index = frames.findIndex(
      (f) =>
        f.processId === event.senderFrame.processId &&
        f.routingId === event.senderFrame.routingId,
    );
    if (index < 0 || index >= 24) return;
    try {
      service.pageEvent(payload, index ? 'frame-' + index : 'main');
    } catch (error) {
      service.lastError = '录制记录未能保存：' + error.message;
      notify();
    }
  });
  ipcMain.handle('developer:command', async (event, command, input = {}) => {
    allowed(event);
    if (command === 'copy') {
      if (typeof input.text !== 'string' || input.text.length > 10000)
        throw new Error('复制内容格式无效');
      clipboard.writeText(input.text);
      return true;
    }
    if (command === 'task-state') {
      const p = publisher();
      return p
        ? p.store
            .tasks()
            .filter((t) => t.accountId === service.active)
            .map((t) => ({
              id: t.id,
              status: t.status,
              plannedAt: t.plannedAt,
              progress: t.checkpoint,
              reason: t.result?.reason || '',
              queue: t.status === 'pending' ? p.scheduler.waitInfo(t) : null,
            }))
        : [];
    }
    if (command === 'task-action') {
      const p = publisher();
      if (!p) throw new Error('发布引擎不可用');
      if (
        !['pause', 'start', 'cancel'].includes(input.action) ||
        !p.store
          .tasks()
          .some((t) => t.id === input.id && t.accountId === service.active)
      )
        throw new Error('任务操作无效');
      return p.action({ ids: [input.id], action: input.action });
    }
    if (command === 'export') {
      return service.serial(async () => {
        const data = await service.export(input.format),
          result = await dialog.showSaveDialog(window, {
            title: '导出本地 AI 调试资料',
            defaultPath: 'Qiye-Developer-Report.' + input.format,
            filters: [
              { name: input.format.toUpperCase(), extensions: [input.format] },
            ],
          });
        if (result.canceled || !result.filePath) return { cancelled: true };
        fs.writeFileSync(result.filePath, data, { mode: 0o600 });
        return { saved: true };
      });
    }
    return service.serial(() => service.command(command, input));
  });
  return { open, notify, close: () => window?.close() };
}
module.exports = { installDeveloperDesktop };
