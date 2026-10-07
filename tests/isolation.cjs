'use strict';

// Real Chromium sessions, a loopback fixture and temporary data; no real account login.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { _electron: electron } = require('playwright-core');

const fixture = `<!doctype html><meta charset="utf-8"><title>账号隔离测试</title>
<body><h1>本地账号隔离测试</h1><script>
window.initialSessionAccount = sessionStorage.getItem('account');
async function database(action, write = false) {
  return new Promise((resolve, reject) => {
    const opening = indexedDB.open('account-db', 1);
    opening.onupgradeneeded = () => opening.result.createObjectStore('values');
    opening.onerror = () => reject(opening.error);
    opening.onsuccess = () => {
      const db = opening.result;
      const tx = db.transaction('values', write ? 'readwrite' : 'readonly');
      const request = action(tx.objectStore('values'));
      let result;
      request.onsuccess = () => { result = request.result; };
      tx.oncomplete = () => { db.close(); resolve(result); };
      tx.onerror = () => { db.close(); reject(tx.error); };
      tx.onabort = () => { db.close(); reject(tx.error || new Error('database aborted')); };
    };
  });
}
window.writeAccount = async value => {
  document.cookie = 'account=' + encodeURIComponent(value) + '; Max-Age=31536000; Path=/; SameSite=Lax';
  document.cookie = 'sessionAccount=' + encodeURIComponent(value) + '; Path=/; SameSite=Lax';
  localStorage.setItem('account', value);
  sessionStorage.setItem('account', value);
  await database(store => store.put(value, 'account'), true);
  const cache = await caches.open('account-cache');
  await cache.put('/cached-account', new Response(value));
  await navigator.serviceWorker.register('/worker.js');
  await navigator.serviceWorker.ready;
};
window.readAccount = async () => {
  const cookie = document.cookie.split('; ').find(item => item.startsWith('account='));
  const sessionCookie = document.cookie.split('; ').find(item => item.startsWith('sessionAccount='));
  const databases = await indexedDB.databases();
  const cached = await caches.match('/cached-account');
  const workers = await navigator.serviceWorker.getRegistrations();
  return {
    cookie: cookie ? decodeURIComponent(cookie.slice('account='.length)) : null,
    sessionCookie: sessionCookie ? decodeURIComponent(sessionCookie.slice('sessionAccount='.length)) : null,
    localStorage: localStorage.getItem('account'),
    sessionStorage: sessionStorage.getItem('account'),
    indexedDB: databases.some(db => db.name === 'account-db') ? (await database(store => store.get('account'))) ?? null : null,
    cache: cached ? await cached.text() : null,
    workers: workers.length,
  };
};
window.logoutAccount = async () => {
  document.cookie = 'account=; Max-Age=0; Path=/';
  document.cookie = 'sessionAccount=; Max-Age=0; Path=/';
  localStorage.removeItem('account');
  sessionStorage.removeItem('account');
  await database(store => store.delete('account'), true);
  await caches.delete('account-cache');
};
window.readHttpCache = async () => (await fetch('/http-cache')).text();
window.fixtureReady = true;
</script></body>`;

const worker = "self.addEventListener('install', () => self.skipWaiting()); self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));";
const root = path.resolve(__dirname, '..');
const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'qiye-isolation-'));
const emptyAccount = { cookie: null, sessionCookie: null, localStorage: null, sessionStorage: null, indexedDB: null, cache: null, workers: 0 };
let app;
let shell;
let passed = 0;

function check(label, assertion) {
  assertion();
  passed += 1;
  console.log(`✓ ${label}`);
}

function account(value, sessionValue = value, transientValue = value) {
  return { cookie: value, sessionCookie: sessionValue, localStorage: value, sessionStorage: transientValue, indexedDB: value, cache: value, workers: 1 };
}

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function launch() {
  app = await electron.launch({
    // Linux cloud machines use Chromium's user-namespace sandbox; the setuid
    // helper would require an administrator-owned installation. Sandbox stays on.
    args: [...(process.platform === 'linux' ? ['--disable-setuid-sandbox'] : []), path.join(root, 'src', 'main.js')],
    cwd: root,
    env: { ...process.env, QIYE_DATA_DIR: dataDirectory },
    timeout: 45_000,
  });
  // Restored WebContentsViews may load before the shell; select its local page.
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    shell = app.windows().find(page => page.url().startsWith('file:') && page.url().endsWith('/renderer/index.html'));
    if (shell) break;
    await delay(100);
  }
  if (!shell) throw new Error('Account management shell did not load');
  await shell.waitForFunction(() => Boolean(window.browserAPI?.getState), null, { timeout: 20_000 });
}

async function state() {
  return shell.evaluate(() => window.browserAPI.getState());
}

async function invoke(method, ...args) {
  return shell.evaluate(({ method, args }) => window.browserAPI[method](...args), { method, args });
}

async function newProfile(name, origin) {
  const previous = new Set((await state()).profiles.map(profile => profile.id));
  const next = await invoke('createProfile', { name, notes: '本地测试账号', startUrl: `${origin}/` });
  const created = next.profiles.find(profile => !previous.has(profile.id));
  assert.ok(created, 'createProfile must return the created saved environment');
  await waitForView(created.id, origin);
  return created;
}

async function evaluateView(id, code) {
  return app.evaluate(async ({ BrowserWindow, session }, { id, code }) => {
    const partition = session.fromPartition(`persist:account-${id}`);
    const contents = BrowserWindow.getAllWindows().flatMap(window => window.contentView.children)
      .map(view => view.webContents).filter(Boolean)
      .find(contents => contents.profileId === id || contents.session === partition);
    if (!contents || contents.isDestroyed()) throw new Error(`No live view for ${id}`);
    return contents.executeJavaScript(code);
  }, { id, code });
}

async function waitForView(id, origin) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const loaded = await app.evaluate(({ BrowserWindow, session }, { id, origin }) => {
      const partition = session.fromPartition(`persist:account-${id}`);
      const contents = BrowserWindow.getAllWindows().flatMap(window => window.contentView.children)
        .map(view => view.webContents).filter(Boolean)
        .find(contents => contents.profileId === id || contents.session === partition);
      return Boolean(contents && !contents.isDestroyed() && contents.getURL().startsWith(origin) && !contents.isLoadingMainFrame());
    }, { id, origin });
    if (loaded && await evaluateView(id, 'Boolean(window.fixtureReady)')) return;
    await delay(100);
  }
  throw new Error(`Fixture did not load for environment ${id}`);
}

async function closeApplication() {
  if (!app) return;
  await app.evaluate(async ({ session, BrowserWindow }) => {
    const partitions = new Set(BrowserWindow.getAllWindows().flatMap(window => window.contentView.children)
      .map(view => view.webContents?.session).filter(Boolean));
    for (const partition of partitions) {
      partition.flushStorageData();
      await partition.cookies.flushStore();
    }
  });
  await app.close();
  app = null;
  shell = null;
}

async function readDeletedPartition(id, origin) {
  return app.evaluate(async ({ WebContentsView, session }, { id, origin }) => {
    const probe = new WebContentsView({ webPreferences: {
      session: session.fromPartition(`persist:account-${id}`),
      sandbox: true,
      nodeIntegration: false,
      contextIsolation: true,
    } });
    try {
      await probe.webContents.loadURL(`${origin}/`);
      return await probe.webContents.executeJavaScript('Promise.all([window.readAccount(), window.readHttpCache()])');
    } finally {
      probe.webContents.close();
    }
  }, { id, origin });
}

async function main() {
  let cacheSequence = 0;
  const server = http.createServer((request, response) => {
    if (request.url === '/http-cache') {
      response.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'public, max-age=86400' });
      response.end(`http-cache-${++cacheSequence}`);
      return;
    }
    if (request.url === '/worker.js') {
      response.writeHead(200, { 'Content-Type': 'application/javascript', 'Cache-Control': 'no-store' });
      response.end(worker);
      return;
    }
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(fixture);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    await launch();
    const nativeCookieEncryption = await app.evaluate(({ safeStorage }) =>
      safeStorage.isEncryptionAvailable() && (process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text'));
    const first = await newProfile('账号 A', origin);
    check('new environment starts without account state', () => assert.ok(first.id));
    const initial = await evaluateView(first.id, 'window.readAccount()');
    check('first environment has no Cookie, localStorage, sessionStorage, IndexedDB, Cache API or service worker', () => assert.deepEqual(initial, emptyAccount));
    const pageCapabilities = await evaluateView(first.id, '({ node: typeof require, manager: typeof browserAPI })');
    check('websites cannot access Node.js or the account management bridge', () => assert.deepEqual(pageCapabilities, { node: 'undefined', manager: 'undefined' }));
    const aHttpCache = await evaluateView(first.id, 'window.readHttpCache()');
    const aCachedAgain = await evaluateView(first.id, 'window.readHttpCache()');
    check('Chromium HTTP cache is active within an environment', () => assert.equal(aCachedAgain, aHttpCache));
    await evaluateView(first.id, 'window.writeAccount("A")');
    const aAccount = await evaluateView(first.id, 'window.readAccount()');
    check('account A data is stored in its own environment', () => assert.deepEqual(aAccount, account('A')));

    const second = await newProfile('账号 B', origin);
    const bInitial = await evaluateView(second.id, 'window.readAccount()');
    check('new environment B cannot read any account A browser data', () => assert.deepEqual(bInitial, emptyAccount));
    const bHttpCache = await evaluateView(second.id, 'window.readHttpCache()');
    check('new environment B does not reuse A HTTP cache', () => assert.notEqual(bHttpCache, aHttpCache));
    await evaluateView(second.id, 'window.writeAccount("B")');
    const bAccount = await evaluateView(second.id, 'window.readAccount()');
    const aUnchanged = await evaluateView(first.id, 'window.readAccount()');
    check('two simultaneously open environments hold separate account and sessionStorage state', () => {
      assert.deepEqual(bAccount, account('B'));
      assert.deepEqual(aUnchanged, account('A'));
    });

    const liveViews = await app.evaluate(({ BrowserWindow }, ids) => {
      const contents = BrowserWindow.getAllWindows().flatMap(window => window.contentView.children)
        .map(view => view.webContents).filter(Boolean);
      return ids.every(id => contents.some(view => view.profileId === id && !view.isDestroyed()));
    }, [first.id, second.id]);
    check('switching tabs keeps both Chromium environments alive', () => assert.equal(liveViews, true));

    await evaluateView(first.id, 'window.logoutAccount()');
    const aLoggedOut = await evaluateView(first.id, 'window.readAccount()');
    const bAfterLogout = await evaluateView(second.id, 'window.readAccount()');
    check('logging out A does not log out B or remove B storage', () => {
      assert.deepEqual(aLoggedOut, { ...emptyAccount, workers: 1 });
      assert.deepEqual(bAfterLogout, account('B'));
    });

    await invoke('closeProfile', first.id);
    await invoke('openProfile', first.id);
    await waitForView(first.id, origin);
    const aLogoutReopened = await evaluateView(first.id, 'window.readAccount()');
    const aLogoutAtDocumentStart = await evaluateView(first.id, 'window.initialSessionAccount');
    check('reopening a logged-out environment does not resurrect old login or sessionStorage', () => {
      assert.deepEqual(aLogoutReopened, { ...emptyAccount, workers: 1 });
      assert.equal(aLogoutAtDocumentStart, null);
    });

    await evaluateView(first.id, 'window.writeAccount("A-restored")');
    await invoke('closeProfile', first.id);
    const afterClose = await state();
    check('closing a tab retains its saved account environment', () => assert.ok(afterClose.profiles.some(profile => profile.id === first.id)));
    await invoke('openProfile', first.id);
    await waitForView(first.id, origin);
    const aReopened = await evaluateView(first.id, 'window.readAccount()');
    const aReopenedAtDocumentStart = await evaluateView(first.id, 'window.initialSessionAccount');
    check('reopening restores account data and sessionStorage before website scripts run', () => {
      assert.deepEqual(aReopened, account('A-restored'));
      assert.equal(aReopenedAtDocumentStart, 'A-restored');
    });

    await invoke('updateProfile', first.id, { name: '运营账号 A', notes: '重命名不更换会话' });
    const renamed = (await state()).profiles.find(profile => profile.id === first.id);
    const aAfterRename = await evaluateView(first.id, 'window.readAccount()');
    check('renaming an environment preserves identity and login data', () => {
      assert.equal(renamed.name, '运营账号 A');
      assert.equal(renamed.id, first.id);
      assert.deepEqual(aAfterRename, account('A-restored'));
    });

    await evaluateView(first.id, `window.open(${JSON.stringify(`${origin}/popup`)}, '_blank'); true`);
    const popupDeadline = Date.now() + 10_000;
    while (Date.now() < popupDeadline) {
      const ready = await app.evaluate(({ BrowserWindow }, origin) =>
        BrowserWindow.getAllWindows().some(window => window.webContents.getURL().startsWith(`${origin}/popup`) && !window.webContents.isLoadingMainFrame()), origin);
      if (ready) break;
      await delay(100);
    }
    const popupIdentity = await app.evaluate(({ BrowserWindow, session }, { id, origin }) => {
      const partition = session.fromPartition(`persist:account-${id}`);
      const popup = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().startsWith(`${origin}/popup`));
      return { found: Boolean(popup), samePartition: Boolean(popup && popup.webContents.session === partition) };
    }, { id: first.id, origin });
    check('login popups inherit the originating environment session', () => assert.deepEqual(popupIdentity, { found: true, samePartition: true }));

    // Both IPC messages are sent in one turn, without waiting for close's disk
    // flush. The final open must represent exactly one usable Chromium view.
    await shell.evaluate(async id => Promise.all([
      window.browserAPI.closeProfile(id),
      window.browserAPI.openProfile(id),
    ]), second.id);
    await waitForView(second.id, origin);
    const afterConcurrentCycle = await state();
    const bAfterConcurrentCycle = await evaluateView(second.id, 'window.readAccount()');
    const concurrentViewCount = await app.evaluate(({ BrowserWindow }, id) =>
      BrowserWindow.getAllWindows().flatMap(window => window.contentView.children)
        .map(view => view.webContents).filter(contents => contents && !contents.isDestroyed() && contents.profileId === id).length, second.id);
    check('concurrent close and reopen produce one live saved tab with retained account data', () => {
      assert.equal(afterConcurrentCycle.openTabs.filter(tab => tab.id === second.id).length, 1);
      assert.equal(concurrentViewCount, 1);
      assert.deepEqual(bAfterConcurrentCycle, account('B'));
    });

    await closeApplication();
    await launch();
    await waitForView(first.id, origin);
    await waitForView(second.id, origin);
    const aRestarted = await evaluateView(first.id, 'window.readAccount()');
    const bRestarted = await evaluateView(second.id, 'window.readAccount()');
    const aRestartedAtDocumentStart = await evaluateView(first.id, 'window.initialSessionAccount');
    const bRestartedAtDocumentStart = await evaluateView(second.id, 'window.initialSessionAccount');
    const restoredState = await state();
    check('full browser restart restores the saved environments and account data', () => {
      assert.deepEqual(aRestarted, account('A-restored', nativeCookieEncryption ? 'A-restored' : null, nativeCookieEncryption ? 'A-restored' : null));
      assert.deepEqual(bRestarted, account('B', nativeCookieEncryption ? 'B' : null, nativeCookieEncryption ? 'B' : null));
      assert.equal(restoredState.profiles.find(profile => profile.id === first.id).name, '运营账号 A');
    });
    if (nativeCookieEncryption) {
      check('session-only cookies and sessionStorage restore through native encryption before website scripts', () => {
        assert.equal(aRestarted.sessionCookie, 'A-restored');
        assert.equal(bRestarted.sessionCookie, 'B');
        assert.equal(aRestartedAtDocumentStart, 'A-restored');
        assert.equal(bRestartedAtDocumentStart, 'B');
      });
    } else {
      console.log('↷ Session-only cookie and sessionStorage restart checks skipped: native secure storage is unavailable on this host. Persistent cookies and every other storage type remain verified.');
      check('hosts without native secure cookie storage show a persistence warning', () =>
        assert.ok(typeof restoredState.persistenceWarning === 'string' && restoredState.persistenceWarning.length > 0));
    }
    const restartedACache = await evaluateView(first.id, 'window.readHttpCache()');
    const restartedBCache = await evaluateView(second.id, 'window.readHttpCache()');
    check('HTTP disk caches persist separately across full browser restart', () => {
      assert.equal(restartedACache, aHttpCache);
      assert.equal(restartedBCache, bHttpCache);
    });

    const third = await newProfile('账号 C', origin);
    const cInitial = await evaluateView(third.id, 'window.readAccount()');
    const cInitialAtDocumentStart = await evaluateView(third.id, 'window.initialSessionAccount');
    check('new environment C remains fresh after restarting populated environments', () => {
      assert.deepEqual(cInitial, emptyAccount);
      assert.equal(cInitialAtDocumentStart, null);
    });

    await invoke('deleteProfile', first.id);
    const afterDelete = await state();
    const [deletedData, deletedHttpCache] = await readDeletedPartition(first.id, origin);
    const bAfterDelete = await evaluateView(second.id, 'window.readAccount()');
    check('deleting A clears its saved metadata and persistent browser data only', () => {
      assert.equal(afterDelete.profiles.some(profile => profile.id === first.id), false);
      assert.deepEqual(deletedData, emptyAccount);
      assert.notEqual(deletedHttpCache, aHttpCache);
      assert.deepEqual(bAfterDelete, account('B', nativeCookieEncryption ? 'B' : null, nativeCookieEncryption ? 'B' : null));
    });
    await closeApplication();
    await launch();
    const finalState = await state();
    await waitForView(second.id, origin);
    const finalB = await evaluateView(second.id, 'window.readAccount()');
    check('deleted environment does not return on restart; other account still persists', () => {
      assert.equal(finalState.profiles.some(profile => profile.id === first.id), false);
      assert.deepEqual(finalB, account('B', nativeCookieEncryption ? 'B' : null, nativeCookieEncryption ? 'B' : null));
    });
    console.log(`\n${passed} real-browser isolation checks passed.`);
  } finally {
    if (app) await app.close().catch(() => {});
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(dataDirectory, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
