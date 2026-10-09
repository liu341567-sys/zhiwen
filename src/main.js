'use strict';

const { app, BrowserWindow, WebContentsView, session, ipcMain, dialog, safeStorage, screen } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { ProfileStore, normalizeUrl, partitionFor } = require('./profile-store');
const { CookieVault } = require('./cookie-vault');
const { userAgentForMode } = require('./browser-identity');
const { LoginDiagnostics, PAGE_OBSERVATION_SCRIPT } = require('./login-diagnostics');
const platformPresets = require('./platform-presets.json');

app.setName('栖页');
if (process.platform === 'win32') app.setAppUserModelId('com.qiye.browser');
const iconDirectory = app.isPackaged ? path.join(process.resourcesPath, 'brand-icons') : path.join(__dirname, 'assets');
const applicationIcon = path.join(iconDirectory, process.platform === 'win32' ? 'qiye.ico' : 'qiye.png');
// Use one browser identity for documents and Service Workers before creating
// any network context. Keep the real OS/Chromium version and native metadata.
const applicationProduct = `${app.getName().replace(/ /g, '')}/${app.getVersion()}`;
const applicationUserAgent = app.userAgentFallback.replace(applicationProduct, `Qiye/${app.getVersion()}`);
app.userAgentFallback = userAgentForMode(applicationUserAgent, 'web');
if (process.env.QIYE_DATA_DIR) app.setPath('userData', path.resolve(process.env.QIYE_DATA_DIR));

const views = new Map();
const sessions = new Map();
const popups = new Map();
const restores = new Map();
const blockedVaults = new Set();
const documentStates = new Map();
const pendingDocumentRestores = new Map();
let store;
let vault;
let mainWindow;
let bounds = { x: 276, y: 128, width: 900, height: 640 };
let overlayVisible = false;
let quitting = false;
let canQuit = false;
let mutationQueue = Promise.resolve();
let toastView;
let toastReady = false;
let toastMessage = null;
let toastSequence = 0;
let toastHeight = 58;
let toastBounds = { x: 264, y: 116, width: 900 };
let toastFadeTimer;
let toastHideTimer;
const diagnostics = new LoginDiagnostics();
let diagnosticGeneration = 0;
let samplingDiagnostics = false;

function stopDiagnostics(reason) {
  diagnosticGeneration += 1;
  diagnostics.stop(reason);
}

async function sampleDiagnosticsPage() {
  const id = diagnostics.targetId;
  const wc = views.get(id)?.view.webContents;
  if (samplingDiagnostics || !diagnostics.getReport()?.running || !wc || wc.isDestroyed()) return;
  let host;
  const sampleUrl = wc.getURL();
  try {
    const url = new URL(sampleUrl);
    host = url.protocol === 'https:' && (url.hostname === 'zhihu.com' || url.hostname.endsWith('.zhihu.com'));
  } catch { return; }
  if (!host) return;
  samplingDiagnostics = true;
  const generation = diagnosticGeneration;
  let deadline;
  try {
    const observed = await Promise.race([
      wc.executeJavaScriptInIsolatedWorld(1001, [{ code: `(() => {
        const observed = ${PAGE_OBSERVATION_SCRIPT};
        if (!observed) return null;
        observed.configuredUaMatchesPage = navigator.userAgent === ${JSON.stringify(wc.getUserAgent())};
        return observed;
      })()` }]),
      new Promise((_resolve, reject) => { deadline = setTimeout(() => reject(new Error('Diagnostic sample timed out')), 750); })
    ]);
    if (generation !== diagnosticGeneration || diagnostics.targetId !== id ||
        wc.isDestroyed() || wc.getURL() !== sampleUrl || !observed || typeof observed !== 'object') return;
    const major = Number(process.versions.chrome.split('.')[0]);
    diagnostics.observePage(id, {
      zhihu10001Shown: observed.zhihu10001Shown === true,
      configuredUaMatchesPage: observed.configuredUaMatchesPage === true,
      clientHintsMatchChromium: observed.clientHintChromiumMajor === major
    });
  } catch { /* Navigation or a stalled document must not block diagnostics. */ }
  finally { clearTimeout(deadline); samplingDiagnostics = false; }
}

function snapshot() {
  const state = store.getState();
  return {
    profiles: state.profiles,
    platformPresets,
    activeId: state.activeId,
    openTabs: state.openIds.map(id => {
      const entry = views.get(id);
      const wc = entry?.view.webContents;
      const usable = wc && !wc.isDestroyed();
      return {
        id,
        title: usable ? wc.getTitle() : '',
        url: usable ? wc.getURL() || store.get(id).lastUrl : store.get(id).lastUrl,
        loading: usable ? wc.isLoading() : false,
        canGoBack: usable ? wc.navigationHistory.canGoBack() : false,
        canGoForward: usable ? wc.navigationHistory.canGoForward() : false,
        error: entry?.error ?? null
      };
    }),
    dataPath: app.getPath('userData'),
    persistenceWarning: vault.available ? '' : '本机安全存储不可用：会话型 Cookie 和临时网页存储无法跨程序退出恢复。关闭标签页再打开仍保留；持久 Cookie 和网站存储也会保留。Windows 版使用系统加密保存会话。'
  };
}

function emitState() {
  if (quitting || !mainWindow || mainWindow.isDestroyed() || !store) return;
  mainWindow.webContents.send('browser:state-changed', snapshot());
}

function updateViews() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const [width, height] = mainWindow.getContentSize();
  const safeBounds = {
    x: Math.min(bounds.x, width),
    y: Math.min(bounds.y, height),
    width: Math.max(0, Math.min(bounds.width, width - bounds.x)),
    height: Math.max(0, Math.min(bounds.height, height - bounds.y))
  };
  const activeId = store.getState().activeId;
  for (const [id, entry] of views) {
    entry.view.setBounds(safeBounds);
    entry.view.setVisible(id === activeId && !overlayVisible && !entry.error && safeBounds.width > 0 && safeBounds.height > 0);
  }
  updateToastView();
}

function updateToastView() {
  if (!toastView || !mainWindow || mainWindow.isDestroyed()) return;
  const [width, height] = mainWindow.getContentSize();
  const left = Math.min(toastBounds.x, width);
  const available = Math.max(0, width - left);
  const toastWidth = Math.min(416, Math.max(0, available - 16));
  const y = toastBounds.y + 8;
  toastView.setBounds({ x: Math.round(left + (available - toastWidth) / 2), y, width: Math.round(toastWidth), height: toastHeight });
  // A native website view sits above DOM overlays. This separate local,
  // sandboxed UI view floats above it without resizing or hiding the account.
  if (mainWindow.contentView.children.at(-1) !== toastView) mainWindow.contentView.addChildView(toastView);
  toastView.setVisible(Boolean(toastReady && toastMessage && toastWidth >= 120 && y + toastHeight <= height));
}

function sendToast() {
  if (toastReady && toastMessage && !toastView.webContents.isDestroyed()) toastView.webContents.send('browser:toast-changed', toastMessage);
  updateToastView();
}

function createToastView() {
  toastView = new WebContentsView({ webPreferences: {
    preload: path.join(__dirname, 'toast-preload.js'), nodeIntegration: false,
    contextIsolation: true, sandbox: true, webSecurity: true, navigateOnDragDrop: false
  } });
  toastView.setBackgroundColor('#00000000');
  toastView.setVisible(false);
  mainWindow.contentView.addChildView(toastView);
  toastView.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  toastView.webContents.on('will-navigate', event => event.preventDefault());
  toastView.webContents.loadFile(path.join(__dirname, 'renderer', 'toast.html')).then(() => {
    toastReady = true;
    sendToast();
  }).catch(() => { toastReady = false; });
  mainWindow.once('closed', () => {
    clearTimeout(toastFadeTimer);
    clearTimeout(toastHideTimer);
    if (!toastView.webContents.isDestroyed()) toastView.webContents.close();
    toastView = null;
    toastReady = false;
    toastMessage = null;
  });
}

function allowedNavigation(url) {
  try { return ['http:', 'https:'].includes(new URL(url).protocol); }
  catch { return false; }
}

function configurePage(wc, id) {
  // Remote pages receive only the private storage preload, with no Node.js,
  // shell API, or local-file access.
  wc.profileId = id;
  wc.on('will-navigate', (event, url) => { if (!allowedNavigation(url)) event.preventDefault(); });
  wc.on('will-redirect', (event, url) => { if (!allowedNavigation(url)) event.preventDefault(); });
  wc.on('will-frame-navigate', event => {
    // about:blank/srcdoc are normal iframe documents; no local-file navigation.
    const allowedFrameDocument = !event.isMainFrame && /^(about:blank|about:srcdoc|blob:|data:)/.test(event.url);
    if (!allowedNavigation(event.url) && !allowedFrameDocument) event.preventDefault();
  });
  wc.setWindowOpenHandler(({ url }) => {
    const popupArea = (mainWindow && !mainWindow.isDestroyed()
      ? screen.getDisplayMatching(mainWindow.getBounds()) : screen.getPrimaryDisplay()).workAreaSize;
    return {
      action: allowedNavigation(url) || url === 'about:blank' ? 'allow' : 'deny',
      overrideBrowserWindowOptions: {
        parent: mainWindow,
        icon: applicationIcon,
        autoHideMenuBar: true,
        width: Math.min(1060, popupArea.width),
        height: Math.min(780, popupArea.height),
        title: `${store.get(id).name} · 栖页`,
        webPreferences: {
          session: sessions.get(id),
          preload: path.join(__dirname, 'remote-preload.js'),
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
          webSecurity: true,
          navigateOnDragDrop: false
        }
      }
    };
  });
  wc.on('did-create-window', child => {
    if (!popups.has(id)) popups.set(id, new Set());
    popups.get(id).add(child);
    configurePage(child.webContents, id);
    child.on('page-title-updated', event => {
      event.preventDefault();
      if (!child.isDestroyed()) child.setTitle(`${store.get(id).name} · ${child.webContents.getTitle() || '新窗口'}`);
    });
    child.on('closed', () => popups.get(id)?.delete(child));
  });
}

function getSession(id) {
  if (sessions.has(id)) return sessions.get(id);
  const ownSession = session.fromPartition(partitionFor(id), { cache: true });
  sessions.set(id, ownSession);
  const diagnosticFilter = { urls: ['https://zhihu.com/*', 'https://*.zhihu.com/*'] };
  ownSession.webRequest.onCompleted(diagnosticFilter, details => diagnostics.recordCompleted(id, details));
  ownSession.webRequest.onErrorOccurred(diagnosticFilter, details => diagnostics.recordError(id, details));
  documentStates.set(id, {});
  const restoration = vault.restore(id, ownSession).then(documents => {
    documentStates.set(id, documents);
  }).catch(error => {
    blockedVaults.add(id);
    return error;
  });
  restores.set(id, restoration);
  // Chromium default certificates, sandbox and web security remain enabled.
  const allowedPermissions = new Set(['fullscreen', 'clipboard-sanitized-write']);
  const grantedPermissions = new Set();
  ownSession.setPermissionCheckHandler((_wc, permission, requestingOrigin) => {
    let origin;
    try { origin = new URL(requestingOrigin).origin; } catch { return false; }
    return allowedPermissions.has(permission) || grantedPermissions.has(`${origin}:${permission}`);
  });
  ownSession.setPermissionRequestHandler(async (wc, permission, callback, details) => {
    if (allowedPermissions.has(permission)) return callback(true);
    if (!['media', 'notifications', 'clipboard-read'].includes(permission) || !wc || wc.isDestroyed()) return callback(false);
    let origin;
    try { origin = new URL(details.requestingUrl || wc.getURL()).origin; }
    catch { return callback(false); }
    const labels = { media: '摄像头或麦克风', notifications: '桌面通知', 'clipboard-read': '读取剪贴板' };
    try {
      const result = await dialog.showMessageBox(BrowserWindow.fromWebContents(wc) || mainWindow, {
        type: 'question',
        title: '网站权限',
        message: `${store.get(id).name} 请求使用${labels[permission]}`,
        detail: `网站：${origin}\n授权仅用于此环境，请仅允许你信任的网站。`,
        buttons: ['拒绝', '允许'],
        defaultId: 0,
        cancelId: 0,
        noLink: true
      });
      const granted = result.response === 1 && !wc.isDestroyed();
      if (granted) grantedPermissions.add(`${origin}:${permission}`);
      callback(granted);
    } catch { callback(false); }
  });
  ownSession.on('will-download', async (_event, item, wc) => {
    item.pause();
    try {
      const result = await dialog.showSaveDialog(BrowserWindow.fromWebContents(wc) || mainWindow, {
        title: `${store.get(id).name} · 保存下载`,
        defaultPath: path.join(app.getPath('downloads'), path.basename(item.getFilename()))
      });
      if (result.canceled || !result.filePath) return item.cancel();
      item.setSavePath(result.filePath);
      item.resume();
    } catch { item.cancel(); }
  });
  return ownSession;
}

async function flushSession(id) {
  const ownSession = sessions.get(id);
  if (!ownSession) return;
  await restores.get(id);
  ownSession.flushStorageData();
  await ownSession.cookies.flushStore();
  if (!blockedVaults.has(id)) vault.save(id, await ownSession.cookies.get({}), documentStates.get(id) ?? {});
}

async function captureDocumentState(id) {
  const mainContents = views.get(id)?.view.webContents;
  // Login popups have their own native sessionStorage namespace; they must not
  // replace the saved main tab's state, even when they use the same origin.
  if (mainContents && !mainContents.isDestroyed()) {
    const wc = mainContents;
    for (const frame of wc.mainFrame.framesInSubtree) {
      if (!allowedNavigation(frame.url)) continue;
      const origin = new URL(frame.url).origin;
      let deadline;
      try {
        const entries = await Promise.race([
          frame.executeJavaScript('Object.entries(window.sessionStorage)'),
          new Promise((_resolve, reject) => { deadline = setTimeout(() => reject(new Error('Document checkpoint timed out')), 1500); })
        ]);
        if (!Array.isArray(entries) || !entries.every(entry => Array.isArray(entry) && entry.length === 2 && entry.every(item => typeof item === 'string'))) continue;
        const documents = documentStates.get(id) ?? {};
        if (entries.length) documents[origin] = entries;
        else delete documents[origin];
        documentStates.set(id, documents);
      } catch { /* Keep its last checkpoint if the frame disappeared or stalled. */ }
      finally { clearTimeout(deadline); }
    }
  }
}

async function createView(id) {
  if (views.has(id)) return views.get(id);
  const profile = store.get(id);
  const view = new WebContentsView({
    webPreferences: {
      session: getSession(id),
      preload: path.join(__dirname, 'remote-preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      navigateOnDragDrop: false
    }
  });
  const entry = { view, error: null };
  views.set(id, entry);
  view.setBackgroundColor('#ffffff');
  mainWindow.contentView.addChildView(view);
  view.setVisible(false);
  const wc = view.webContents;
  configurePage(wc, id);
  const notify = () => { updateViews(); emitState(); };
  wc.on('did-start-loading', () => { entry.error = null; notify(); });
  wc.on('did-stop-loading', notify);
  wc.on('page-title-updated', notify);
  wc.on('did-navigate', (_event, url) => {
    if (allowedNavigation(url)) store.touchUrl(id, url);
    notify();
  });
  wc.on('did-navigate-in-page', (_event, url, isMainFrame) => {
    if (isMainFrame && allowedNavigation(url)) store.touchUrl(id, url);
    notify();
  });
  wc.on('did-fail-load', (_event, code, description, _url, isMainFrame) => {
    if (!isMainFrame || code === -3) return; // A replaced navigation is not a failed page.
    entry.error = `页面加载失败：${description}（${code}）`;
    notify();
  });
  wc.on('render-process-gone', (_event, details) => {
    entry.error = `页面进程已停止（${details.reason}），请重新加载。`;
    notify();
  });
  // Forward browser shortcuts to the shell, including when a website has focus.
  wc.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || !(input.control || input.meta)) return;
    if (['t', 'l', 'w'].includes(input.key.toLowerCase())) {
      event.preventDefault();
      mainWindow.webContents.focus();
      mainWindow.webContents.send('browser:shortcut', input.key.toLowerCase());
    }
  });
  const restoration = await restores.get(id);
  if (restoration instanceof Error) {
    entry.error = restoration.message;
    notify();
    return entry;
  }
  // Restore each origin only once for this newly opened main tab. Subsequent
  // documents use Chromium's live storage, including any website removals.
  pendingDocumentRestores.set(id, { ...(documentStates.get(id) ?? {}) });
  wc.loadURL(profile.lastUrl).catch(error => {
    if (!views.has(id) || wc.isDestroyed() || error.code === 'ERR_ABORTED') return;
    entry.error = `页面加载失败：${error.message}`;
    notify();
  });
  return entry;
}

async function closeView(id) {
  if (diagnostics.targetId === id) stopDiagnostics('profile-closed');
  await captureDocumentState(id);
  const children = popups.get(id);
  if (children) for (const child of [...children]) { if (!child.isDestroyed()) child.destroy(); }
  popups.delete(id);
  const entry = views.get(id);
  if (entry) {
    views.delete(id);
    mainWindow.contentView.removeChildView(entry.view);
    if (!entry.view.webContents.isDestroyed()) entry.view.webContents.close({ waitForBeforeUnload: false });
  }
  await flushSession(id);
  pendingDocumentRestores.delete(id);
}

function activePage() {
  const activeId = store.getState().activeId;
  const entry = views.get(activeId);
  if (!entry || entry.view.webContents.isDestroyed()) throw new Error('请先打开一个环境');
  if (blockedVaults.has(activeId)) throw new Error('此环境的会话数据暂时无法解密，请使用原系统用户重新启动应用');
  return entry;
}

function registerIPC() {
  ipcMain.handle('browser:toast', (event, next) => {
    if (quitting || !mainWindow || event.sender !== mainWindow.webContents ||
        event.senderFrame !== mainWindow.webContents.mainFrame) throw new Error('此页面无权显示提示');
    if (!next || typeof next !== 'object') throw new Error('无效的提示');
    if (next.bounds) {
      if (!['x', 'y', 'width'].every(key => Number.isFinite(next.bounds[key]) && next.bounds[key] >= 0 && next.bounds[key] < 50000)) throw new Error('无效的提示位置');
      toastBounds = Object.fromEntries(['x', 'y', 'width'].map(key => [key, Math.round(next.bounds[key])]));
    }
    if (Object.hasOwn(next, 'message')) {
      if (typeof next.message !== 'string' || !next.message.trim() || next.message.length > 1000 || !['success', 'error', 'info'].includes(next.type)) throw new Error('无效的提示内容');
      clearTimeout(toastFadeTimer);
      clearTimeout(toastHideTimer);
      toastMessage = { message: next.message, type: next.type, sequence: ++toastSequence, leaving: false };
      sendToast();
      const sequence = toastSequence;
      toastFadeTimer = setTimeout(() => {
        if (toastMessage?.sequence !== sequence) return;
        toastMessage.leaving = true;
        sendToast();
      }, 2500);
      toastHideTimer = setTimeout(() => {
        if (toastMessage?.sequence !== sequence) return;
        toastMessage = null;
        updateToastView();
      }, 2700);
    } else updateToastView();
    return true;
  });
  ipcMain.on('browser:toast-size', (event, size) => {
    if (!toastView || event.sender !== toastView.webContents || event.senderFrame !== toastView.webContents.mainFrame ||
        !toastMessage || size?.sequence !== toastMessage.sequence || !Number.isFinite(size.height) || size.height < 30 || size.height > 144) return;
    toastHeight = Math.ceil(size.height);
    updateToastView();
  });
  // A website can restore only its own origin in its own Session. These IPC
  // channels are private to the sandboxed preload, never exposed through DOM.
  const documentContext = event => {
    const ownSession = event.sender.session;
    const id = [...sessions.keys()].find(key => sessions.get(key) === ownSession);
    if (!id || event.sender !== views.get(id)?.view.webContents ||
        !store.getState().profiles.some(profile => profile.id === id) || blockedVaults.has(id) || !allowedNavigation(event.senderFrame.url)) return null;
    return { id, origin: new URL(event.senderFrame.url).origin };
  };
  ipcMain.on('browser:document-restore', event => {
    try {
      const context = documentContext(event);
      const pending = context ? pendingDocumentRestores.get(context.id) : null;
      const entries = pending?.[context?.origin] ?? [];
      if (pending) delete pending[context.origin];
      event.returnValue = entries;
    } catch { event.returnValue = []; }
  });
  ipcMain.on('browser:document-checkpoint', (event, origin, entries) => {
    try {
      const context = documentContext(event);
      if (!context || context.origin !== origin || !Array.isArray(entries) || !entries.every(entry => Array.isArray(entry) && entry.length === 2 && entry.every(item => typeof item === 'string'))) return;
      const documents = documentStates.get(context.id) ?? {};
      if (entries.length) documents[context.origin] = entries;
      else delete documents[context.origin];
      documentStates.set(context.id, documents);
    } catch { /* A closing frame cannot checkpoint after it is detached. */ }
    finally { event.returnValue = true; }
  });
  const serialized = new Set(['create', 'update', 'move', 'open', 'close', 'delete', 'overview', 'navigate', 'back', 'forward', 'reload',
    'diagnostics-start', 'diagnostics-stop', 'diagnostics-save']);
  const handle = (name, action) => ipcMain.handle(`browser:${name}`, async (event, ...args) => {
    if (quitting || !mainWindow || event.sender !== mainWindow.webContents ||
        event.senderFrame !== mainWindow.webContents.mainFrame) throw new Error('此页面无权管理环境');
    const execute = () => {
      if (quitting) throw new Error('浏览器正在关闭');
      return action(...args);
    };
    let result;
    if (serialized.has(name)) {
      const pending = mutationQueue.then(execute);
      mutationQueue = pending.catch(() => {});
      result = await pending;
    } else {
      result = await execute();
    }
    updateViews();
    emitState();
    return result === undefined ? snapshot() : result;
  });
  handle('state', () => snapshot());
  handle('create', async input => {
    const profile = store.create(input);
    store.open(profile.id);
    await createView(profile.id);
  });
  handle('update', (id, input) => { store.update(id, input); });
  handle('move', (id, beforeId) => { store.move(id, beforeId); });
  handle('open', async id => { store.open(id); await createView(id); });
  handle('close', async id => {
    store.get(id);
    await closeView(id);
    store.close(id);
  });
  handle('delete', async id => {
    store.get(id);
    await closeView(id);
    const ownSession = getSession(id);
    await ownSession.clearStorageData();
    await ownSession.clearCache();
    await ownSession.clearAuthCache();
    await ownSession.closeAllConnections();
    await flushSession(id);
    vault.remove(id);
    blockedVaults.delete(id);
    documentStates.delete(id);
    store.remove(id);
  });
  handle('overview', () => store.activate(null));
  handle('navigate', url => {
    const target = normalizeUrl(url);
    const entry = activePage();
    entry.error = null;
    entry.view.webContents.loadURL(target).catch(() => {}); // did-fail-load reports failures.
  });
  handle('back', () => {
    const wc = activePage().view.webContents;
    if (wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
  });
  handle('forward', () => {
    const wc = activePage().view.webContents;
    if (wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
  });
  handle('reload', () => {
    const entry = activePage();
    entry.error = null;
    entry.view.webContents.reload();
  });
  handle('bounds', next => {
    if (!next || !['x', 'y', 'width', 'height'].every(key => Number.isFinite(next[key]) && next[key] >= 0 && next[key] < 50000)) {
      throw new Error('无效的页面尺寸');
    }
    bounds = Object.fromEntries(['x', 'y', 'width', 'height'].map(key => [key, Math.round(next[key])]));
    return true;
  });
  handle('overlay', visible => {
    if (typeof visible !== 'boolean') throw new Error('无效的窗口状态');
    overlayVisible = visible;
    return true;
  });
  handle('diagnostics-start', async () => {
    const entry = activePage();
    const id = store.getState().activeId;
    const ua = entry.view.webContents.getUserAgent();
    diagnosticGeneration += 1;
    diagnostics.start(id, {
      appVersion: app.getVersion(), electronVersion: process.versions.electron,
      chromiumVersion: process.versions.chrome, platform: process.platform, browserMode: 'web',
      identity: {
        ascii: /^[\x20-\x7e]+$/.test(ua), hasApplicationProduct: /\sQiye\//.test(ua),
        hasElectronProduct: /\sElectron\//.test(ua), chromeVersionMatches: ua.includes(`Chrome/${process.versions.chrome}`)
      }
    });
    await sampleDiagnosticsPage();
    return diagnostics.getReport();
  });
  handle('diagnostics-get', async () => { await sampleDiagnosticsPage(); return diagnostics.getReport(); });
  handle('diagnostics-stop', async () => {
    await sampleDiagnosticsPage();
    stopDiagnostics('user');
    return diagnostics.getReport();
  });
  handle('diagnostics-save', async () => {
    await sampleDiagnosticsPage();
    stopDiagnostics('user');
    const report = diagnostics.getReport();
    if (!report) throw new Error('请先开始一次登录诊断');
    const result = await dialog.showSaveDialog(mainWindow, {
      title: '保存登录诊断报告', defaultPath: path.join(app.getPath('downloads'), 'Qiye-Login-Diagnostics.json'),
      filters: [{ name: 'JSON 诊断报告', extensions: ['json'] }]
    });
    if (result.canceled || !result.filePath) return { saved: false };
    await fs.promises.writeFile(result.filePath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    return { saved: true };
  });
}

async function createWindow() {
  // Work-area sizes are device-independent pixels, so a scaled display must
  // not receive a window or minimum size larger than its available desktop.
  const workArea = screen.getPrimaryDisplay().workAreaSize;
  mainWindow = new BrowserWindow({
    width: Math.min(1440, workArea.width),
    height: Math.min(940, workArea.height),
    minWidth: Math.min(900, workArea.width),
    minHeight: Math.min(600, workArea.height),
    title: '栖页 · 账号工作空间',
    icon: applicationIcon,
    backgroundColor: '#f4f5f7',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      navigateOnDragDrop: false
    }
  });
  mainWindow.setMenu(null);
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', event => event.preventDefault());
  mainWindow.on('resize', updateViews);
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('close', event => {
    if (!canQuit) { event.preventDefault(); app.quit(); }
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  createToastView();
  const state = store.getState();
  for (const id of state.openIds) await createView(id);
  updateViews();
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });
  app.whenReady().then(async () => {
    try {
      store = new ProfileStore(app.getPath('userData'));
      vault = new CookieVault(app.getPath('userData'), safeStorage);
      registerIPC();
      const startup = mutationQueue.then(() => createWindow());
      mutationQueue = startup.catch(() => {});
      await startup;
    } catch (error) {
      dialog.showErrorBox('无法读取账号环境', `${error.message}\n数据位置：${app.getPath('userData')}\n请先备份原目录，再检查 profiles.json；原有数据未被覆盖。`);
      canQuit = true;
      app.quit();
    }
  });
  app.on('before-quit', event => {
    if (canQuit) return;
    event.preventDefault();
    if (quitting) return;
    quitting = true;
    stopDiagnostics('app-exit');
    (async () => {
      await mutationQueue;
      await Promise.all([...sessions.keys()].map(id => captureDocumentState(id)));
      const results = await Promise.allSettled([...sessions.keys()].map(id => flushSession(id)));
      const failed = results.filter(item => item.status === 'rejected');
      if (failed.length) dialog.showErrorBox('保存登录数据失败', '部分环境未能完成磁盘写入，请检查磁盘空间与目录权限。');
      canQuit = true;
      app.quit();
    })();
  });
  app.on('window-all-closed', () => app.quit());
}
