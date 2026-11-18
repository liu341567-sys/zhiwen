'use strict';
const { randomUUID } = require('node:crypto');
const path = require('node:path');

// Pages belong to an existing environment. They never create profiles, Session
// partitions or OS windows, and never overwrite the root tab's storage checkpoint.
class PopupPages {
  constructor({ window, WebContentsView, sessionFor, configure, changed, canActivate }) {
    Object.assign(this, { window, WebContentsView, sessionFor, configure, changed, canActivate });
    this.entries = new Map();
    this.selected = new Map();
  }
  forEnvironment(id) { return [...this.entries.values()].filter(e => e.environmentId === id); }
  activePopup(id) { return this.entries.get(this.selected.get(id)); }
  active(id, root) { return this.activePopup(id) || root; }
  showMain(id) { this.selected.delete(id); }
  toggle(id) {
    const active = this.activePopup(id);
    if (active) this.close(active.id);
    else {
      const last = this.forEnvironment(id).at(-1);
      if (last) this.selected.set(id, last.id);
    }
  }
  open(environmentId, opener, details, options) {
    const session = this.sessionFor(environmentId);
    if (options.webContents && options.webContents.session !== session) throw new Error('新页面会话与原环境不一致');
    // An absent guest must be omitted, not passed as `webContents: undefined`:
    // Electron's native constructor treats a present property as an adoption
    // request and rejects anything other than a real WebContents.
    const view = new this.WebContentsView({ ...(options.webContents ? { webContents: options.webContents } : {}), webPreferences: {
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
    // Start deferred navigation after returning the newly created contents to
    // Chromium; an adopted guest already has its native navigation pending.
    setImmediate(() => {
      if (wc.isDestroyed() || !this.entries.has(id)) return;
      if (!options.webContents && details.url !== 'about:blank') {
        const post = details.postBody;
        const headers = post ? `content-type: ${post.contentType}${post.boundary ? '; boundary=' + post.boundary : ''}` : undefined;
        wc.loadURL(details.url, { httpReferrer: details.referrer, ...(post ? { postData: post.data, extraHeaders: headers } : {}) }).catch(() => {});
      }
      notify();
    });
    return wc;
  }
  remove(id) {
    const entry = this.entries.get(id); if (!entry) return;
    this.entries.delete(id);
    if (!this.window.isDestroyed()) this.window.contentView.removeChildView(entry.view);
    if (this.selected.get(entry.environmentId) === id) {
      const parent = this.entries.get(entry.openerId);
      const next = parent || this.forEnvironment(entry.environmentId).at(-1);
      if (next) this.selected.set(entry.environmentId, next.id);
      else this.showMain(entry.environmentId);
    }
    this.changed();
  }
  close(id) {
    const entry = this.entries.get(id);
    if (!entry) return;
    const wc = entry.view.webContents;
    this.remove(id);
    if (wc && !wc.isDestroyed()) wc.close({ waitForBeforeUnload: false });
  }
  closeEnvironment(id) {
    for (const entry of this.forEnvironment(id)) if (this.entries.has(entry.id)) this.close(entry.id);
    this.selected.delete(id);
  }
}
// Empty and named windows can be written to, reused, or closed by the caller.
// A POST also needs its original document's navigation and form metadata.
function needsPopup(details, opener) {
  if (details.url === 'about:blank' || details.postBody) return true;
  const name = details.frameName?.toLowerCase();
  if (name && !['_blank', '_self', '_parent', '_top'].includes(name)) return true;
  if (details.features?.split(',').some(feature => {
    const key = feature.split('=')[0].trim().toLowerCase();
    return key && key !== 'noopener' && key !== 'noreferrer';
  })) return true;

  const destination = new URL(details.url);
  const authOrPayment = /(?:^|[./_-])(?:oauth2?|oidc|sso|passport|login|log-in|sign-in|signin|authorize|authorization|consent|pay|payment|checkout|cashier)(?:$|[./_-])/i;
  if (authOrPayment.test(destination.hostname + destination.pathname) ||
      (destination.searchParams.has('client_id') && (destination.searchParams.has('redirect_uri') || destination.searchParams.has('response_type')))) return true;

  // Electron doesn't report the initiating frame. Where the referrer could
  // come from a subframe, let Chromium enforce that frame's popup restrictions.
  const main = opener.mainFrame;
  const frames = main.framesInSubtree.filter(frame => frame !== main);
  if (!frames.length) return false;
  const origin = url => { try { return new URL(url).origin; } catch { return null; } };
  const sourceOrigin = origin(details.referrer?.url);
  return !sourceOrigin || sourceOrigin !== origin(main.url) || frames.some(frame => {
    const frameOrigin = origin(frame.url);
    return !frameOrigin || frameOrigin === 'null' || frameOrigin === sourceOrigin;
  });
}

module.exports = { PopupPages, needsPopup };
