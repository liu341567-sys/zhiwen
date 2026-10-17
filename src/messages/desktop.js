'use strict';
const { app, dialog, ipcMain, Notification, shell } = require('electron');
const fs = require('node:fs');
const { MessageService } = require('./service');
const { MessageBrowser } = require('./browser');

async function installMessages({ window, directory, profiles, WebContentsView, getSession, restore, blocked, inspect, scheduler, debugging, reveal, toast, icon }) {
  const browser = new MessageBrowser({ window, profiles, WebContentsView, getSession, restore, blocked, inspect });
  const summary = () => { if (window.isDestroyed()) return; window.show(); window.focus(); window.webContents.send('messages:summary'); };
  const service = await MessageService.create({ directory, profiles,
    getView: (...args) => browser.acquire(...args), releaseView: id => browser.release(id),
    isBusy: id => scheduler()?.leased(id) || debugging(id), reserveAccount: id => scheduler()?.reserveReadOnly(id) || (() => {}),
    changed: () => { if (!window.isDestroyed()) window.webContents.send('messages:changed'); }, reveal,
    notify: (changes, config) => {
      const first = changes[0];
      const body = changes.length === 1 ? `抖音｜${first.name}：未读计数增加 ${first.increase}，当前${first.lowerBound ? '至少' : ''} ${first.unread}。增量为估算。`
        : `${changes.length} 个账号的未读计数增加，打开私信汇总查看各账号变化（估算）。`;
      toast(body, 'info', summary);
      let native = false;
      if (config.systemNotifications && Notification.isSupported()) {
        try { const notification = new Notification({ title: '栖页 · 私信未读变化', body, icon, silent: !config.sound }); notification.on('click', summary); notification.show(); native = true; }
        catch { /* In-app reminder stays available when Windows denies notifications. */ }
      }
      if (config.sound && !native) shell.beep();
    }
  });
  ipcMain.handle('messages:command', async (event, command, input) => {
    if (window.isDestroyed() || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error('此页面无权访问私信监测');
    switch (command) {
      case 'state': return service.state();
      case 'settings': return service.update(input);
      case 'start': return service.start();
      case 'pause': return service.pause();
      case 'scan': return service.scan({ ids: input?.ids, force: true });
      case 'open': if (typeof input !== 'string') throw new Error('账号无效'); return service.open(input);
      case 'diagnostics': return { schemaVersion: 1, applicationVersion: app.getVersion(), platform: process.platform, exportedAt: Date.now(),
        capability: 'count-estimate', entryVerifiedByUser: true, authenticatedDomVerified: false, diagnostics: service.diagnostics(String(input)) };
      case 'backup': {
        const result = await dialog.showSaveDialog(window, { title: '备份私信监测数据', defaultPath: `Qiye-Messages-${Date.now()}.sqlite`, filters: [{ name: 'SQLite', extensions: ['sqlite'] }] });
        if (result.canceled || !result.filePath) return { cancelled: true };
        if (fs.existsSync(result.filePath)) throw new Error('请使用新的备份文件名，以免覆盖已有备份');
        service.store.backup(result.filePath); return { saved: true };
      }
      case 'export': {
        const report = { schemaVersion: 1, applicationVersion: app.getVersion(), exportedAt: Date.now(), capability: 'count-estimate',
          diagnostics: service.diagnostics(String(input)) };
        const result = await dialog.showSaveDialog(window, { title: '导出私信巡检诊断', defaultPath: 'Qiye-Message-Diagnostic.json', filters: [{ name: 'JSON', extensions: ['json'] }] });
        if (result.canceled || !result.filePath) return { cancelled: true };
        await fs.promises.writeFile(result.filePath, JSON.stringify(report, null, 2), { mode: 0o600 }); return { saved: true };
      }
      default: throw new Error('不支持的私信监测操作');
    }
  });
  service.initialize();
  const shutdown = service.shutdown.bind(service);
  service.shutdown = async () => { try { await shutdown(); } finally { browser.shutdown(); } };
  return service;
}
module.exports = { installMessages };
