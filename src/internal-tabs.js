'use strict';
const { randomUUID } = require('node:crypto');
const path = require('node:path');

// Pages belong to an existing environment. They never create profiles, Session
// partitions or OS windows, and never overwrite the root tab's storage checkpoint.
class InternalTabs {
  constructor({ window, WebContentsView, sessionFor, configure, changed, canActivate }) {
    Object.assign(this, { window, WebContentsView, sessionFor, configure, changed, canActivate });
    this.entries = new Map();
    this.selected = new Map();
    this.closing = new Set();
  }
  forEnvironment(id) { return [...this.entries.values()].filter(e => e.environmentId === id); }
  activeId(id) { return this.entries.has(this.selected.get(id)) ? this.selected.get(id) : id; }
  active(id, root) { return this.entries.get(this.activeId(id)) || root; }
  select(id, environmentId) {
    if (id !== environmentId && this.entries.get(id)?.environmentId !== environmentId) throw new Error('页面已关闭或不属于此环境');
    this.selected.set(environmentId, id);
  }
  open(environmentId, opener, details, options) {
    const session = this.sessionFor(environmentId);
    if (options.webContents && options.webContents.session !== session) throw new Error('新页面会话与原环境不一致');
    const view = new this.WebContentsView({ webContents: options.webContents, webPreferences: {
      ...options.webPreferences, session, partition: undefined,
      preload: path.join(__dirname, 'remote-preload.js'), nodeIntegration: false,
      nodeIntegrationInSubFrames: false, nodeIntegrationInWorker: false,
      contextIsolation: true, sandbox: true, webSecurity: true, webviewTag: false, navigateOnDragDrop: false
    } });
    const wc = view.webContents, id = `page:${randomUUID()}`;
    const entry = { id, environmentId, openerId: opener.pageTabId || environmentId, view, error: null };
    wc.pageTabId = id;
    this.entries.set(id, entry);
    view.setBackgroundColor('#ffffff');
    this.window.contentView.addChildView(view);
    view.setVisible(false);
    this.configure(wc, environmentId);
    const notify = () => this.changed();
    wc.on('did-start-loading', () => { entry.error = null; notify(); });
    for (const event of ['did-stop-loading', 'page-title-updated', 'did-navigate', 'did-navigate-in-page']) wc.on(event, notify);
    wc.on('did-fail-load', (_event, code, message, _url, main) => {
      if (main && code !== -3) { entry.error = `页面加载失败：${message}（${code}）`; notify(); }
    });
    wc.on('render-process-gone', (_event, info) => { entry.error = `页面进程已停止（${info.reason}），请重新加载。`; notify(); });
    wc.once('destroyed', () => this.remove(id));
    if (details.disposition !== 'background-tab' && this.canActivate(environmentId)) this.selected.set(environmentId, id);
    // Adopt Chromium's already-created guest: its opener, named window, POST,
    // referrer and native sessionStorage semantics must remain untouched.
    // Deferred guests (e.g. ctrl/middle-click) require one explicit navigation.
    if (!options.webContents && details.url !== 'about:blank') {
      const post = details.postBody;
      const headers = post ? `content-type: ${post.contentType}${post.boundary ? '; boundary=' + post.boundary : ''}` : undefined;
      wc.loadURL(details.url, { httpReferrer: details.referrer, ...(post ? { postData: post.data, extraHeaders: headers } : {}) }).catch(() => {});
    }
    notify();
    return wc;
  }
  remove(id) {
    const entry = this.entries.get(id); if (!entry) return;
    this.entries.delete(id);
    if (!this.window.isDestroyed()) this.window.contentView.removeChildView(entry.view);
    if (this.selected.get(entry.environmentId) === id) {
      const parent = this.entries.get(entry.openerId);
      this.selected.set(entry.environmentId, parent?.environmentId === entry.environmentId ? parent.id : entry.environmentId);
    }
    this.changed();
  }
  close(id) {
    const entry = this.entries.get(id); if (!entry) throw new Error('页面已关闭');
    if (this.closing.has(id)) return;
    this.closing.add(id);
    try {
      // Removing first keeps state coherent if destroyed fires synchronously.
      this.remove(id);
      if (!entry.view.webContents.isDestroyed()) entry.view.webContents.close({ waitForBeforeUnload: false });
    } finally { this.closing.delete(id); }
  }
  closeEnvironment(id) {
    for (const entry of this.forEnvironment(id)) if (this.entries.has(entry.id)) this.close(entry.id);
    this.selected.delete(id);
  }
}
module.exports = { InternalTabs };
