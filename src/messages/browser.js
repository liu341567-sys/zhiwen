'use strict';
const path = require('node:path');
const douyin = require('./douyin');

// A bounded, short-lived background list page in the *original* Session.
// It never replaces a visible tab, enters a conversation, focuses a page,
// attaches a debugger, persists navigation, or changes the environment config.
class MessageBrowser {
  constructor({ WebContentsView, window, getSession, restore, inspect, profiles, blocked }) {
    Object.assign(this, { WebContentsView, window, getSession, restore, inspect, profiles, blocked });
    this.pages = new Map();
  }
  close(id) {
    const entry = this.pages.get(id); if (!entry) return;
    this.pages.delete(id); clearTimeout(entry.timer);
    entry.signal?.removeEventListener('abort', entry.abort);
    if (!entry.view.webContents.isDestroyed()) { entry.view.webContents.stop(); this.window.contentView.removeChildView(entry.view); entry.view.webContents.close(); }
  }
  async acquire(id, signal, adapter = douyin) {
    if (signal.aborted) throw Object.assign(new Error(), { code: 'aborted' });
    const original = this.inspect(id);
    if (original && !original.isDestroyed() && adapter.allowed(original.getURL()) && !original.isLoading()) return original;
    const ownSession = this.getSession(id); await this.restore(id);
    if (signal.aborted) throw Object.assign(new Error(), { code: 'aborted' });
    if (this.blocked(id)) throw Object.assign(new Error(), { code: 'session_error' });
    if (!this.profiles().some(p => p.id === id)) throw Object.assign(new Error(), { code: 'closed' });
    const view = new this.WebContentsView({ webPreferences: { session: ownSession, nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, navigateOnDragDrop: false,
      backgroundThrottling: false, preload: path.join(__dirname, 'readonly-preload.js') } });
    const wc = view.webContents; wc.messageProfileId = id;
    const entry = { view, signal }; this.pages.set(id, entry);
    this.window.contentView.addChildView(view); view.setBounds({ x: 0, y: 0, width: 1000, height: 740 }); view.setVisible(false);
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    const guard = (event, target) => {
      if (!adapter.allowed(target)) { event.preventDefault(); entry.blocked = /login|passport/.test(target) ? 'login_required' : 'wrong_page'; }
    };
    wc.on('will-navigate', guard); wc.on('will-redirect', guard);
    try {
      await Promise.race([
        wc.loadURL(adapter.launchUrl),
        new Promise((_, reject) => {
          entry.timer = setTimeout(() => reject(Object.assign(new Error(), { code: 'timeout' })), 15000);
          entry.abort = () => reject(Object.assign(new Error(), { code: 'aborted' })); signal.addEventListener('abort', entry.abort, { once: true }); if (signal.aborted) entry.abort();
        })
      ]);
      if (entry.blocked) throw Object.assign(new Error(), { code: entry.blocked });
      return wc;
    } catch (error) { const code = entry.blocked || error.code; this.close(id); throw Object.assign(new Error('官方私信列表未能就绪'), { code: ['aborted', 'timeout', 'login_required', 'wrong_page'].includes(code) ? code : 'load_error' }); }
    finally { clearTimeout(entry.timer); signal.removeEventListener('abort', entry.abort); }
  }
  release(id) { this.close(id); }
  shutdown() { for (const id of [...this.pages.keys()]) this.close(id); }
}
module.exports = { MessageBrowser };
