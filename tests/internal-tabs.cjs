'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const { spawnSync }=require('node:child_process');
const { _electron } = require('playwright-core');
const root = path.resolve(__dirname, '..');
let checks = 0, lastStep = "startup";
const delay = ms => new Promise(r => setTimeout(r, ms));
const check = (label, fn) => { lastStep=label; fn(); checks++; console.log('✓ ' + label); };
async function until(fn, label) { lastStep=label; const end = Date.now() + 18000; while (Date.now() < end) { if (await fn()) return; await delay(60); } throw Error('Timed out: ' + label); }
async function run(scale) {
  let app, shell, origin; const before = checks, directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qiye-tabs-')), requests = [];
  const watchdog=setTimeout(()=>{const detail=JSON.stringify({uiFailure:{message:'Internal tab scenario exceeded 150s',scale,lastStep,checks}});console.error(detail);console.log('::error title=Internal tab watchdog::'+detail);const child=app?.process();if(child){if(process.platform==='win32')spawnSync('taskkill',['/pid',String(child.pid),'/t','/f']);else child.kill();}process.exit(1);},150000);
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, origin); let body = ''; for await (const chunk of req) body += chunk;
    requests.push({ path: u.pathname, method: req.method, body, referrer: req.headers.referer, origin: req.headers.origin });
    if (u.pathname === '/download') { res.writeHead(200, { 'Content-Disposition': 'attachment; filename="test.txt"' }); res.end('test'); return; }
    if (u.pathname === '/coop') res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(`<!doctype html><title>${u.pathname}</title><style>a, #script-open { display: block; width: max-content; min-height: 30px; }</style><input id="draft"><a id="ordinary" href="/same">普通跳转</a><a id="blank" href="/blank" target="_blank">新标签</a><button id="script-open" onclick="window.open('/regular','_blank')">脚本跳转</button><a id="background" href="/background" target="_blank">后台标签</a><a id="no-referrer" href="/noref" target="_blank" rel="noreferrer">无引荐来源</a><form target="_blank" method="post" action="/posted"><input name="challenge" value="test-nonce"><button id="post">提交表单</button></form><script>window.token=crypto.randomUUID();window.messages=[];addEventListener('message',e=>messages.push({data:e.data,origin:e.origin}));window.ready=true;</script>`);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r)); origin = `http://127.0.0.1:${server.address().port}`;
  const crossServer=http.createServer(server.listeners('request')[0]);await new Promise(r=>crossServer.listen(0,'127.0.0.1',r));const foreign=`http://127.0.0.1:${crossServer.address().port}`;
  const command = (name, ...args) => shell.evaluate(({ name, args }) => browserAPI[name](...args), { name, args });
  const evalPage = (id, code) => app.evaluate(async ({ BrowserWindow }, { id, code }) => {
    const wc = BrowserWindow.getAllWindows()[0].contentView.children.map(v => v.webContents).find(wc => wc && !wc.isDestroyed() && (wc.pageTabId || wc.profileId) === id);
    if (!wc) throw Error('Missing page ' + id); return wc.executeJavaScript(code);
  }, { id, code });
  async function clickPage(id, selector, modifiers = []) {
    const code = `(() => {
      const control = document.querySelector(${JSON.stringify(selector)});
      control.scrollIntoView({ block: 'center' });
      const rect = control.getBoundingClientRect();
      const x = Math.round(rect.x + rect.width / 2), y = Math.round(rect.y + rect.height / 2);
      if (!control.contains(document.elementFromPoint(x, y))) throw new Error('Link is not hit-testable: ' + control.id);
      return { x, y };
    })()`;
    const point = await evalPage(id, code);
    await app.evaluate(({ BrowserWindow }, { id, point, modifiers }) => {
      const wc = BrowserWindow.getAllWindows()[0].contentView.children.map(view => view.webContents)
        .find(contents => contents?.profileId === id && !contents.pageTabId);
      wc.focus();
      setImmediate(() => {
        wc.sendInputEvent({ type: 'mouseMove', ...point, modifiers });
        for (const type of ['mouseDown', 'mouseUp']) {
          wc.sendInputEvent({ type, ...point, button: 'left', clickCount: 1, modifiers });
        }
      });
    }, { id, point, modifiers });
  }
  const state = () => command('getState');
  async function pageAt(id, route, popup = false) {
    let tab;
    const expected = route.startsWith('http') ? route : origin + route;
    await until(async () => {
      tab = (await state()).openTabs.find(item => item.id === id);
      return tab?.url === expected && !tab.loading && tab.popupActive === popup;
    }, route);
    await until(() => evalPage(tab.pageId, 'window.ready === true'), 'document ready: ' + route);
    return tab;
  }
  async function tabIds(expected) {
    assert.deepEqual((await state()).openTabs.map(tab => tab.id), expected);
    await until(async () => (await shell.locator('#tab-list .tab:not(.overview-tab)').count()) === expected.length,
      'environment tab count: ' + expected.length);
  }
  async function closeApp() { if (!app) return; const process = app.process(); await app.evaluate(({ app }) => app.quit()); await until(() => process.exitCode !== null, 'normal exit'); await app.close().catch(() => {}); app = null; }
  try {
    async function launch() {
      app = await _electron.launch({ chromiumSandbox: true, args: [...(process.platform === 'linux' ? ['--disable-setuid-sandbox'] : []), `--force-device-scale-factor=${scale}`, path.join(root, 'tests/electron-launch.cjs')], cwd: root, env: { ...process.env, QIYE_DATA_DIR: directory } });
      await until(() => { shell = app.windows().find(p => p.url().endsWith('/renderer/index.html')); return shell; }, 'manager');
      await shell.waitForFunction(() => !document.body.classList.contains('navigation-loading'));
    }
    await launch();
    const a = (await command('createProfile', { name: '账号 A', startUrl: origin + '/root' })).activeId;
    await pageAt(a, '/root');
    await evalPage(a, "document.cookie='account=A;Path=/';localStorage.setItem('account','A');sessionStorage.setItem('nonce','A');true");

    for (const [selector, route] of [
      ['#ordinary', '/same'], ['#blank', '/blank'], ['#script-open', '/regular'], ['#no-referrer', '/noref']
    ]) {
      await clickPage(a, selector);
      const current = await pageAt(a, route);
      await tabIds([a]);
      check(route + ' uses the existing page and login session', () => {
        assert.equal(current.pageId, a);
        assert.equal(current.canGoBack, true);
      });
      assert.equal(await evalPage(a, "localStorage.getItem('account')"), 'A');
      assert.equal(await evalPage(a, "sessionStorage.getItem('nonce')"), 'A');
      await command('goBack');
      await pageAt(a, '/root');
    }
    check('noreferrer keeps its referrer privacy', () => assert.equal(requests.find(r => r.path === '/noref').referrer, undefined));

    await clickPage(a, '#background', ['control']);
    await pageAt(a, '/background');
    await tabIds([a]);
    check('Ctrl-click navigates in place with exactly one request', () => {
      assert.equal(requests.filter(r => r.path === '/background').length, 1);
    });
    await command('goBack');
    await pageAt(a, '/root');
    await command('goForward');
    await pageAt(a, '/background');
    await command('goBack');
    await pageAt(a, '/root');
    checks++;

    await evalPage(a, "document.getElementById('draft').value='unsaved A';window.auth=window.open('/auth','authorization');true");
    const auth = await pageAt(a, '/auth', true);
    await tabIds([a]);
    await shell.locator('#temporary-page-button').waitFor({ state: 'visible' });
    const identity = await evalPage(auth.pageId, "({cookie:document.cookie,nonce:sessionStorage.getItem('nonce'),opener:opener!==null,api:typeof browserAPI,node:typeof require})");
    check('authorization retains the native opener, original session, and sandbox', () => {
      assert.match(identity.cookie, /account=A/);
      assert.deepEqual({ ...identity, cookie: undefined }, { cookie: undefined, nonce: 'A', opener: true, api: 'undefined', node: 'undefined' });
    });
    await evalPage(a, "window.open('/auth-next','authorization');true");
    const named = await pageAt(a, '/auth-next', true);
    check('named authorization requests reuse the original popup', () => assert.equal(named.pageId, auth.pageId));
    await evalPage(auth.pageId, `opener.postMessage('authorized',${JSON.stringify(origin)});window.close();true`);
    await pageAt(a, '/root');
    const authResult = await evalPage(a, "({authorized:messages.some(m=>m.data==='authorized'),closed:auth.closed,draft:document.getElementById('draft').value})");
    check('message and close callbacks return to the untouched origin page', () => {
      assert.deepEqual(authResult, { authorized: true, closed: true, draft: 'unsaved A' });
    });

    await evalPage(a, `window.open(${JSON.stringify(foreign + '/oauth/authorize')},'_blank');true`);
    const cross = await pageAt(a, foreign + '/oauth/authorize', true);
    await evalPage(cross.pageId, `opener.postMessage('cross-authorized',${JSON.stringify(origin)});true`);
    await until(() => evalPage(a, `messages.some(m=>m.data==='cross-authorized'&&m.origin===${JSON.stringify(foreign)})`), 'cross-origin postMessage');
    await tabIds([a]);
    checks++;

    const b = (await command('createProfile', { name: '账号 B', startUrl: origin + '/root' })).activeId;
    await pageAt(b, '/root');
    const initialB = await evalPage(b, "({cookie:document.cookie,account:localStorage.getItem('account')})");
    check('another environment cannot read account A', () => assert.deepEqual(initialB, { cookie: '', account: null }));
    await evalPage(b, "document.cookie='account=B;Path=/';window.open('/works','_blank');true");
    await pageAt(b, '/works');
    assert.match(await evalPage(b, 'document.cookie'), /account=B/);
    await tabIds([a, b]);
    await shell.locator(`button[data-focus-key="tab:${a}"]`).click();
    await until(async () => (await state()).activeId === a, 'account A selected');
    const resumed = await pageAt(a, foreign + '/oauth/authorize', true);
    check('the environment tab reopens its pending authorization view', () => assert.equal(resumed.pageId, cross.pageId));
    await shell.locator('#temporary-page-button').click();
    await pageAt(a, '/root');
    await tabIds([a, b]);
    assert.equal(await evalPage(a, "document.getElementById('draft').value"), 'unsaved A');
    checks++;

    await evalPage(a, "document.getElementById('post').click();true");
    await pageAt(a, '/posted', true);
    check('target blank form preserves one POST body and source origin', () => {
      const posts = requests.filter(r => r.path === '/posted');
      assert.equal(posts.length, 1);
      assert.equal(posts[0].method, 'POST');
      assert.equal(posts[0].body, 'challenge=test-nonce');
      assert.equal(posts[0].origin, origin);
    });
    await tabIds([a, b]);
    await shell.locator('#temporary-page-button').click();
    await pageAt(a, '/root');

    await evalPage(a, "window.open('about:blank','blank-write').document.write('<title>同步授权页</title><p>ready</p>');true");
    await until(async () => (await state()).openTabs.find(tab => tab.id === a)?.title === '同步授权页', 'blank document write');
    await tabIds([a, b]);
    await shell.locator('#temporary-page-button').click();
    await pageAt(a, '/root');
    checks++;

    await evalPage(a, "for(let i=0;i<3;i++)window.open('/burst'+i,'_blank');true");
    await pageAt(a, '/burst2');
    await tabIds([a, b]);
    await evalPage(a, "window.open('file:///C:/Windows/win.ini');true");
    const details = await app.evaluate(({ BrowserWindow }) => {
      const windows = BrowserWindow.getAllWindows();
      return { windows: windows.length, popups: windows[0].contentView.children.filter(view => view.webContents?.pageTabId).length };
    });
    check('ordinary and blocked requests create no popup contents or desktop windows', () => {
      assert.deepEqual(details, { windows: 1, popups: 0 });
    });

    await evalPage(a, "window.open('/checkout','checkout');true");
    await pageAt(a, '/checkout', true);
    const metrics = await shell.evaluate(() => ({
      dpr: devicePixelRatio, overflow: document.documentElement.scrollWidth > innerWidth,
      buttonFits: document.getElementById('temporary-page-button').getBoundingClientRect().right <= innerWidth
    }));
    check('temporary controls stay in the window at the selected display scale', () => {
      assert(!metrics.overflow);
      assert(metrics.buttonFits);
    });
    await shell.locator(`button[data-focus-key="close:${a}"]`).click();
    await until(async () => !(await state()).openTabs.some(tab => tab.id === a), 'environment A closed');
    await tabIds([b]);
    assert.match(await evalPage(b, 'document.cookie'), /account=B/);
    const left = await app.evaluate(({ BrowserWindow }, id) =>
      BrowserWindow.getAllWindows()[0].contentView.children.filter(view => view.webContents?.profileId === id).length, a);
    check('closing an environment also releases its temporary page without affecting peers', () => assert.equal(left, 0));

    await command('openProfile', a);
    await pageAt(a, '/burst2');
    await evalPage(a, "window.open('/checkout','checkout');true");
    await pageAt(a, '/checkout', true);
    await closeApp();
    await launch();
    await pageAt(a, '/burst2');
    const restored = await state();
    check('restart restores the main page and original isolated cookie', () => {
      assert.equal(restored.profiles.find(profile => profile.id === a).startUrl, origin + '/root');
      assert(restored.openTabs.every(tab => !tab.popupAvailable));
    });
    assert.match(await evalPage(a, 'document.cookie'), /account=A/);
    console.log(JSON.stringify({tabsSummary:{scale,checks:checks-before,metrics}}));
  }catch(error){let diagnostic;try{diagnostic={tabs:(await state()).openTabs,requests}}catch{}const detail=JSON.stringify({uiFailure:{message:error.message,stack:error.stack,lastStep,scale,checks,diagnostic}});console.error(detail);console.log('::error title=Internal tab scenario::'+detail.replace(/%/g,'%25').replace(/\n/g,'%0A'));throw error;}finally{await closeApp().catch(async()=>{app?.process()?.kill();await app?.close().catch(()=>{});});server.close();server.closeAllConnections();crossServer.close();crossServer.closeAllConnections();fs.rmSync(directory,{recursive:true,force:true});clearTimeout(watchdog);}
}
(async()=>{for(const scale of [1,1.25,1.5])await run(scale);console.log(`${checks} internal-tab real-window checks passed`);})().catch(error=>{console.error(JSON.stringify({uiFailure:{message:error.message,stack:error.stack}}));process.exitCode=1;});
