'use strict';

// Local synthetic login challenges only. This verifies browser compatibility;
// it does not attempt a real platform login or identify platform rejection rules.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { _electron } = require('playwright-core');

const root = path.resolve(__dirname, '..');
const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'qiye-login-compatibility-'));
const requestAgents = new Map();
const consumed = new Map();
let app;
let shell;
let primaryOrigin;
let frameOrigin;
let passed = 0;
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

const agentScript = `async function agentInfo() {
  const userAgent = navigator.userAgent;
  let base64Works = false;
  try { base64Works = atob(btoa(userAgent)) === userAgent; } catch {}
  return { userAgent, base64Works, brands: navigator.userAgentData?.brands ?? [],
    platform: navigator.userAgentData?.platform,
    high: await navigator.userAgentData?.getHighEntropyValues(['fullVersionList', 'uaFullVersion']) };
}`;

function pageHtml(url) {
  const addFrame = url.pathname === '/main' || url.pathname === '/checkpoint' || url.pathname === '/web-main';
  const frameContext = url.pathname === '/web-main' ? 'web-iframe' : 'iframe';
  return `<!doctype html><meta charset="utf-8"><title>Local login compatibility</title>
<script>
${agentScript}
window.initialNonce = sessionStorage.getItem('auditNonce');
if (new URL(location.href).searchParams.get('clearOnHide') === '1') {
  window.addEventListener('pagehide', () => sessionStorage.clear());
}
window.resumeDone = Promise.resolve(null);
if (location.pathname === '/resume' && window.initialNonce) {
  window.resumeDone = fetch('/consume', { method: 'POST', body: window.initialNonce }).then(response => response.json());
}
window.fixtureReady = true;
</script>${addFrame ? `<iframe src="${frameOrigin}/frame?context=${frameContext}"></iframe>` : ''}`;
}

const workerScript = `${agentScript}
self.addEventListener('install', event => {
  const context = new URL(self.location.href).searchParams.get('context') ?? 'service-worker';
  event.waitUntil(fetch('/agent?context=' + context).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('message', event => event.waitUntil(agentInfo().then(info => event.ports[0].postMessage(info))));`;

function check(label, assertion) {
  assertion();
  passed += 1;
  console.log(`✓ ${label}`);
}

function recordAgent(request, url) {
  const context = url.searchParams.get('context');
  if (context) requestAgents.set(context, {
    userAgent: request.headers['user-agent'],
    clientHints: request.headers['sec-ch-ua'] ?? '',
  });
}

async function contents(kind, id, action, value) {
  return app.evaluate(async ({ BrowserWindow }, { kind, id, action, value }) => {
    const wc = kind === 'native'
      ? globalThis.__qiyeLoginCompatibilityWindows.get(id).webContents
      : BrowserWindow.getAllWindows().flatMap(window => window.contentView.children)
        .map(view => view.webContents).find(wc => wc?.profileId === id);
    if (!wc || wc.isDestroyed()) throw new Error('Missing login fixture contents');
    if (action === 'load') return wc.loadURL(value);
    return wc.executeJavaScript(value);
  }, { kind, id, action, value });
}

async function waitForFixture(kind, id) {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    if (await contents(kind, id, 'eval', 'Boolean(window.fixtureReady)')) return;
    await delay(100);
  }
  throw new Error('Login fixture did not load');
}

async function newProfile(name, route) {
  const state = await shell.evaluate(input => window.browserAPI.createProfile(input), {
    name, notes: 'Local synthetic login test', startUrl: primaryOrigin + route,
  });
  const profile = state.profiles.find(profile => profile.name === name);
  assert.ok(profile);
  await waitForFixture('qiye', profile.id);
  return profile.id;
}

async function invoke(method, id) {
  return shell.evaluate(({ method, id }) => window.browserAPI[method](id), { method, id });
}

async function newNativeControl(name) {
  await app.evaluate(async ({ BrowserWindow, session }, { name, url }) => {
    globalThis.__qiyeLoginCompatibilityWindows ??= new Map();
    const ownSession = session.fromPartition(`login-control-${name}`);
    const window = new BrowserWindow({ show: false, webPreferences: {
      session: ownSession, sandbox: true, nodeIntegration: false, contextIsolation: true,
    } });
    window.webContents.setWindowOpenHandler(() => ({ action: 'allow', overrideBrowserWindowOptions: {
      show: false,
      webPreferences: { session: ownSession, sandbox: true, nodeIntegration: false, contextIsolation: true },
    } }));
    globalThis.__qiyeLoginCompatibilityWindows.set(name, window);
    await window.webContents.loadURL(url);
  }, { name, url: primaryOrigin + '/control' });
  return name;
}

async function popup(url, code = '({ initialNonce: window.initialNonce, openerIsNull: window.opener === null })') {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    const result = await app.evaluate(async ({ BrowserWindow }, { url, code }) => {
      const wc = BrowserWindow.getAllWindows().map(window => window.webContents)
        .find(wc => wc.getURL() === url && !wc.isLoadingMainFrame());
      if (!wc) return null;
      return wc.executeJavaScript(code);
    }, { url, code });
    if (result !== null) return result;
    await delay(100);
  }
  throw new Error('Login popup did not load');
}

function assertAgent(info, versions) {
  assert.equal(typeof info.userAgent, 'string');
  assert.match(info.userAgent, /^[\x20-\x7e]+$/);
  assert.ok(info.userAgent.includes(`Chrome/${versions.chrome}`));
  assert.doesNotMatch(info.userAgent, /\b(?:Electron|Qiye)\//);
  if (Object.hasOwn(info, 'base64Works')) assert.equal(info.base64Works, true);
  for (const brand of info.brands ?? []) {
    if (brand.brand === 'Chromium') assert.equal(brand.version, versions.chrome.split('.')[0]);
  }
  if (Object.hasOwn(info, 'brands')) {
    assert.ok(info.brands.some(brand => brand.brand === 'Chromium'));
    assert.equal(info.platform, versions.platform);
    assert.equal(info.high.uaFullVersion, versions.chrome);
    assert.equal(info.high.fullVersionList.find(brand => brand.brand === 'Chromium').version, versions.chrome);
  }
  const hint = /"Chromium";v="(\d+)"/.exec(info.clientHints ?? '');
  if (hint) assert.equal(hint[1], versions.chrome.split('.')[0]);
}

async function main() {
  const frameServer = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    recordAgent(request, url);
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(`<!doctype html><script>${agentScript}
sessionStorage.setItem('auditNonce', 'synthetic-iframe-marker');
window.frameReady = true;</script>`);
  });
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    recordAgent(request, url);
    if (url.pathname === '/consume') {
      let nonce = '';
      request.on('data', data => { nonce += data; });
      request.on('end', () => {
        const count = (consumed.get(nonce) ?? 0) + 1;
        consumed.set(nonce, count);
        response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        response.end(JSON.stringify({ count, reused: count > 1 }));
      });
      return;
    }
    if (url.pathname === '/agent-worker.js') {
      response.writeHead(200, { 'Content-Type': 'application/javascript', 'Cache-Control': 'no-store' });
      response.end(workerScript);
      return;
    }
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(pageHtml(url));
  });
  await Promise.all([
    new Promise(resolve => server.listen(0, '127.0.0.1', resolve)),
    new Promise(resolve => frameServer.listen(0, '127.0.0.1', resolve)),
  ]);
  primaryOrigin = `http://127.0.0.1:${server.address().port}`;
  frameOrigin = `http://127.0.0.1:${frameServer.address().port}`;
  try {
    app = await _electron.launch({
      chromiumSandbox: true,
      args: [...(process.platform === 'linux' ? ['--disable-setuid-sandbox'] : []), path.join(root, 'tests', 'electron-launch.cjs')],
      cwd: root,
      env: { ...process.env, QIYE_DATA_DIR: dataDirectory },
      timeout: 45_000,
    });
    for (let attempt = 0; attempt < 150; attempt += 1) {
      shell = app.windows().find(page => page.url().startsWith('file:') && page.url().endsWith('/renderer/index.html'));
      if (shell) break;
      await delay(100);
    }
    assert.ok(shell);
    await shell.waitForFunction(() => Boolean(window.browserAPI?.createProfile));
    const versions = await app.evaluate(({ app }) => ({
      chrome: process.versions.chrome, electron: process.versions.electron, app: app.getVersion(),
      platform: ({ win32: 'Windows', darwin: 'macOS', linux: 'Linux' })[process.platform],
    }));
    const profile = await newProfile('Login compatibility', '/main?context=main');
    const mainAgent = await contents('qiye', profile, 'eval', 'agentInfo()');
    check('main document sends ASCII User-Agent with real engine versions and btoa works', () => {
      assertAgent(mainAgent, versions);
      assertAgent(requestAgents.get('main'), versions);
    });
    const runtime = await app.evaluate(({ app, BrowserWindow }, id) => {
      const wc = BrowserWindow.getAllWindows().flatMap(window => window.contentView.children)
        .map(view => view.webContents).find(contents => contents?.profileId === id);
      return { noSandbox: app.commandLine.hasSwitch('no-sandbox'),
        injected: globalThis.__qiyeTestRuntime.injectedSwitches.filter(name => app.commandLine.hasSwitch(name)),
        renderer: globalThis.__qiyeTestRuntime.renderers.get(wc.id) };
    }, profile);
    check('login fixture uses an actually sandboxed renderer without Playwright storage or popup overrides', () => {
      assert.equal(runtime.noSandbox, false);
      assert.deepEqual(runtime.injected, []);
      assert.equal(runtime.renderer.sandboxed, true);
      assert.equal(runtime.renderer.contextIsolated, true);
      assert.equal(runtime.renderer.isMainFrame, true);
    });

    let frameAgent;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      frameAgent = await app.evaluate(async ({ BrowserWindow }, { id, origin }) => {
        const wc = BrowserWindow.getAllWindows().flatMap(window => window.contentView.children)
          .map(view => view.webContents).find(wc => wc?.profileId === id);
        const frame = wc.mainFrame.framesInSubtree.find(frame => frame.url.startsWith(origin));
        if (!frame) return null;
        return frame.executeJavaScript('window.frameReady ? agentInfo() : null');
      }, { id: profile, origin: frameOrigin });
      if (frameAgent) break;
      await delay(100);
    }
    check('cross-origin iframe HTTP and JavaScript agents preserve ASCII and native versions', () => {
      assert.ok(frameAgent);
      assertAgent(frameAgent, versions);
      assertAgent(requestAgents.get('iframe'), versions);
    });
    const workerAgent = await contents('qiye', profile, 'eval', `(async () => {
      await navigator.serviceWorker.register('/agent-worker.js');
      const registration = await navigator.serviceWorker.ready;
      return new Promise((resolve, reject) => {
        const channel = new MessageChannel();
        const timeout = setTimeout(() => reject(new Error('worker response timed out')), 10000);
        channel.port1.onmessage = event => { clearTimeout(timeout); resolve(event.data); };
        registration.active.postMessage('agent', [channel.port2]);
      });
    })()`);
    check('Service Worker HTTP and JavaScript agents preserve ASCII and native versions', () => {
      assertAgent(workerAgent, versions);
      assertAgent(requestAgents.get('service-worker'), versions);
    });

    const webProfile = await newProfile('Second login environment', '/web-main?context=web-main');
    const webMainAgent = await contents('qiye', webProfile, 'eval', 'agentInfo()');
    check('second environment page and HTTP requests keep native Chromium and platform without application products', () => {
      assertAgent(webMainAgent, versions);
      assertAgent(requestAgents.get('web-main'), versions);
    });
    let webFrameAgent;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      webFrameAgent = await app.evaluate(async ({ BrowserWindow }, { id, origin }) => {
        const wc = BrowserWindow.getAllWindows().flatMap(window => window.contentView.children)
          .map(view => view.webContents).find(wc => wc?.profileId === id);
        const frame = wc.mainFrame.framesInSubtree.find(frame => frame.url.startsWith(origin));
        return frame ? frame.executeJavaScript('window.frameReady ? agentInfo() : null') : null;
      }, { id: webProfile, origin: frameOrigin });
      if (webFrameAgent) break;
      await delay(100);
    }
    check('second environment cross-origin iframe preserves real Chromium Client Hints and matching HTTP identity', () => {
      assert.ok(webFrameAgent);
      assertAgent(webFrameAgent, versions);
      assertAgent(requestAgents.get('web-iframe'), versions);
    });
    const webWorkerAgent = await contents('qiye', webProfile, 'eval', `(async () => {
      await navigator.serviceWorker.register('/agent-worker.js?context=web-service-worker');
      const registration = await navigator.serviceWorker.ready;
      return new Promise((resolve, reject) => {
        const channel = new MessageChannel();
        const deadline = setTimeout(() => reject(new Error('web worker response timed out')), 10000);
        channel.port1.onmessage = event => { clearTimeout(deadline); resolve(event.data); };
        registration.active.postMessage('agent', [channel.port2]);
      });
    })()`);
    check('second environment Service Worker matches page and HTTP identity without mixing in the application UA', () => {
      assertAgent(webWorkerAgent, versions);
      assertAgent(requestAgents.get('web-service-worker'), versions);
    });
    const webPopupUrl = primaryOrigin + '/web-popup?context=web-popup';
    await contents('qiye', webProfile, 'eval', `window.open(${JSON.stringify(webPopupUrl)}, '_blank', 'noopener'); true`);
    const webPopupAgent = await popup(webPopupUrl, 'agentInfo()');
    check('second environment login popup inherits the originating session identity and real Client Hints', () => {
      assertAgent(webPopupAgent, versions);
      assertAgent(requestAgents.get('web-popup'), versions);
    });
    await contents('qiye', profile, 'eval', "document.cookie='modeAccount=app; Path=/'; localStorage.setItem('modeAccount','app'); true");
    await contents('qiye', webProfile, 'eval', "document.cookie='modeAccount=web; Path=/'; localStorage.setItem('modeAccount','web'); true");
    const appAccount = await contents('qiye', profile, 'eval', "({cookie:document.cookie, account:localStorage.getItem('modeAccount')})");
    const webAccount = await contents('qiye', webProfile, 'eval', "({cookie:document.cookie, account:localStorage.getItem('modeAccount')})");
    check('simultaneously open environments with the same browser identity retain separate account Cookies and localStorage', () => {
      assert.match(appAccount.cookie, /(?:^|; )modeAccount=app(?:;|$)/);
      assert.match(webAccount.cookie, /(?:^|; )modeAccount=web(?:;|$)/);
      assert.equal(appAccount.account, 'app');
      assert.equal(webAccount.account, 'web');
    });

    const native = await newNativeControl('nonce');
    for (const [kind, id, nonce] of [['qiye', profile, 'synthetic-qiye-nonce'], ['native', native, 'synthetic-native-nonce']]) {
      await contents(kind, id, 'eval', `sessionStorage.setItem('auditNonce', ${JSON.stringify(nonce)}); true`);
      await contents(kind, id, 'load', primaryOrigin + '/checkpoint?context=' + (kind === 'qiye' ? 'main' : 'control'));
      await contents(kind, id, 'eval', `fetch('/consume', { method: 'POST', body: ${JSON.stringify(nonce)} }).then(response => response.json())`);
      await contents(kind, id, 'eval', `window.open(${JSON.stringify(primaryOrigin + '/resume?context=' + (kind === 'qiye' ? 'popup' : 'control-popup'))}, '_blank', 'noopener'); true`);
    }
    const popupUrl = primaryOrigin + '/resume?context=popup';
    const qiyePopup = await popup(popupUrl, '(async () => ({ initialNonce: window.initialNonce, openerIsNull: window.opener === null, resume: await window.resumeDone }))()');
    const controlPopup = await popup(primaryOrigin + '/resume?context=control-popup');
    check('noopener login popup stays empty and never replays the main challenge', () => {
      assert.equal(qiyePopup.initialNonce, null);
      assert.equal(qiyePopup.openerIsNull, true);
      assert.equal(controlPopup.initialNonce, null);
      assert.equal(controlPopup.openerIsNull, true);
      assert.equal(consumed.get('synthetic-qiye-nonce'), 1);
      assert.equal(consumed.get('synthetic-native-nonce'), 1);
    });
    const popupAgent = await popup(popupUrl, 'agentInfo()');
    check('login popup HTTP and JavaScript agents preserve ASCII and native versions', () => {
      assertAgent(popupAgent, versions);
      assertAgent(requestAgents.get('popup'), versions);
    });

    await popup(popupUrl, "sessionStorage.setItem('auditNonce', 'synthetic-popup-only'); true");
    await app.evaluate(async ({ BrowserWindow }, { url, next }) => {
      const child = BrowserWindow.getAllWindows().find(window => window.webContents.getURL() === url);
      await child.webContents.loadURL(next);
      child.close();
    }, { url: popupUrl, next: primaryOrigin + '/popup-next' });
    const mainNonce = await contents('qiye', profile, 'eval', "sessionStorage.getItem('auditNonce')");
    check('same-origin popup navigation and closing do not replace the main tab state', () => assert.equal(mainNonce, 'synthetic-qiye-nonce'));
    await invoke('closeProfile', profile);
    await invoke('openProfile', profile);
    await waitForFixture('qiye', profile);
    const reopenedNonce = await contents('qiye', profile, 'eval', 'window.initialNonce');
    check('reopening restores the main tab snapshot before page scripts, without iframe or popup values', () => assert.equal(reopenedNonce, 'synthetic-qiye-nonce'));
    await contents('qiye', profile, 'eval', 'sessionStorage.clear(); true');
    await contents('qiye', profile, 'load', primaryOrigin + '/after-clear');
    const clearedNonce = await contents('qiye', profile, 'eval', 'window.initialNonce');
    check('later same-view navigation does not refill storage cleared by the website', () => assert.equal(clearedNonce, null));

    const cleanup = await newProfile('Pagehide cleanup', '/cleanup?clearOnHide=1');
    await contents('qiye', cleanup, 'eval', "sessionStorage.setItem('auditNonce', 'synthetic-cleanup-nonce'); true");
    await invoke('closeProfile', cleanup);
    await invoke('openProfile', cleanup);
    await waitForFixture('qiye', cleanup);
    const resumedBeforeCleanup = await contents('qiye', cleanup, 'eval', 'window.initialNonce');
    assert.equal(resumedBeforeCleanup, 'synthetic-cleanup-nonce');
    await contents('qiye', cleanup, 'load', primaryOrigin + '/after-cleanup');
    const cleanedAtDocumentStart = await contents('qiye', cleanup, 'eval', 'window.initialNonce');
    check('website pagehide cleanup remains cleared in the next live document', () => assert.equal(cleanedAtDocumentStart, null));
    const capabilities = await contents('qiye', cleanup, 'eval', '({ node: typeof require, manager: typeof browserAPI })');
    check('compatibility handling keeps remote Node.js and management access disabled', () => assert.deepEqual(capabilities, { node: 'undefined', manager: 'undefined' }));
    console.log(`\n${passed} local login compatibility checks passed. No real platform account was used.`);
  } finally {
    if (app) await app.close().catch(() => {});
    server.closeAllConnections();
    frameServer.closeAllConnections();
    await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => frameServer.close(resolve))]);
    fs.rmSync(dataDirectory, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
