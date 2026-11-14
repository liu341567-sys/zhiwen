'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const { _electron } = require('playwright-core');
const root = path.resolve(__dirname, '..'), output = path.join(root, 'test-results/ui');
let checks = 0, lastStep = "startup";
const delay = ms => new Promise(r => setTimeout(r, ms));
const check = (label, fn) => { lastStep=label; fn(); checks++; console.log('✓ ' + label); };
async function until(fn, label) { lastStep=label; const end = Date.now() + 18000; while (Date.now() < end) { if (await fn()) return; await delay(60); } throw Error('Timed out: ' + label); }
async function run(scale) {
  let app, shell, origin; const before = checks, directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qiye-tabs-')), requests = [];
  const watchdog=setTimeout(()=>{console.error(JSON.stringify({uiFailure:{message:'Internal tab scenario exceeded 150s',scale,lastStep,checks}}));app?.process()?.kill();process.exit(1);},150000);
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, origin); let body = ''; for await (const chunk of req) body += chunk;
    requests.push({ path: u.pathname, method: req.method, body, referrer: req.headers.referer });
    if (u.pathname === '/download') { res.writeHead(200, { 'Content-Disposition': 'attachment; filename="test.txt"' }); res.end('test'); return; }
    if (u.pathname === '/coop') res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(`<!doctype html><title>${u.pathname}</title><input id="draft"><a id="ordinary" href="/same">普通跳转</a><a id="blank" href="/blank" target="_blank">新标签</a><a id="background" href="/background" target="_blank">后台标签</a><a id="no-referrer" href="/noref" target="_blank" rel="noreferrer">无引荐来源</a><form target="_blank" method="post" action="/posted"><input name="challenge" value="test-nonce"><button id="post">提交表单</button></form><script>window.token=crypto.randomUUID();window.messages=[];addEventListener('message',e=>messages.push({data:e.data,origin:e.origin}));window.ready=true;</script>`);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r)); origin = `http://127.0.0.1:${server.address().port}`;
  const crossServer=http.createServer(server.listeners('request')[0]);await new Promise(r=>crossServer.listen(0,'127.0.0.1',r));const foreign=`http://127.0.0.1:${crossServer.address().port}`;
  const command = (name, ...args) => shell.evaluate(({ name, args }) => browserAPI[name](...args), { name, args });
  const evalPage = (id, code) => app.evaluate(async ({ BrowserWindow }, { id, code }) => {
    const wc = BrowserWindow.getAllWindows()[0].contentView.children.map(v => v.webContents).find(wc => wc && !wc.isDestroyed() && (wc.pageTabId || wc.profileId) === id);
    if (!wc) throw Error('Missing page ' + id); return wc.executeJavaScript(code);
  }, { id, code });
  const state = () => command('getState');
  async function child(route) { let tab; await until(async () => { tab = (await state()).openTabs.find(t => t.child && t.url === origin + route && !t.loading); return tab; }, route); await until(() => evalPage(tab.id, 'window.ready===true'), 'child ready'); return tab; }
  async function closeApp() { if (!app) return; const process = app.process(); await app.evaluate(({ app }) => app.quit()); await until(() => process.exitCode !== null, 'normal exit'); await app.close().catch(() => {}); app = null; }
  try {
    async function launch() {
      app = await _electron.launch({ chromiumSandbox: true, args: [...(process.platform === 'linux' ? ['--disable-setuid-sandbox'] : []), `--force-device-scale-factor=${scale}`, path.join(root, 'tests/electron-launch.cjs')], cwd: root, env: { ...process.env, QIYE_DATA_DIR: directory } });
      await until(() => { shell = app.windows().find(p => p.url().endsWith('/renderer/index.html')); return shell; }, 'manager');
      await shell.waitForFunction(() => !document.body.classList.contains('navigation-loading'));
    }
    await launch();
    let s = await command('createProfile', { name: '账号 A', startUrl: origin + '/root' }); const a = s.activeId;
    await until(() => evalPage(a, 'window.ready===true'), 'root');
    await evalPage(a, "document.cookie='account=A;Path=/';localStorage.setItem('account','A');sessionStorage.setItem('nonce','A');document.getElementById('draft').value='unsaved A';true");
    const token = await evalPage(a, 'window.token');
    await evalPage(a, "location.href='/same';true"); await until(async () => (await state()).openTabs.find(t=>t.id===a)?.url===origin+'/same', 'normal navigation');
    check('ordinary links keep the original tab', () => {}); assert.equal((await state()).openTabs.length, 1);
    await command('navigate', origin + '/root'); await until(() => evalPage(a, "location.pathname==='/root'&&window.ready"), 'root back');
    await evalPage(a, "document.getElementById('draft').value='unsaved A';window.parentToken=window.token;window.auth=window.open('/auth','authorization');true");
    const auth = await child('/auth');
    s = await state(); check('window.open registers one selected internal tab bound to original environment', () => { assert.equal(s.openTabs.length, 2); assert.equal(auth.environmentId, a); assert.equal(s.activeId, a); assert.equal(s.activeTabId, auth.id); });
    const windows = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length); check('popup creates no extra BrowserWindow', () => assert.equal(windows, 1));
    const identity = await evalPage(auth.id, "({cookie:document.cookie,local:localStorage.getItem('account'),nonce:sessionStorage.getItem('nonce'),opener:opener!==null,api:typeof browserAPI,node:typeof require})");
    check('child inherits cookies/localStorage and native opener sessionStorage clone, with no privileged API', () => { assert(identity.cookie.includes('account=A')); assert.equal(identity.local, 'A'); assert.equal(identity.nonce, 'A'); assert.equal(identity.opener, true); assert.equal(identity.api, 'undefined'); assert.equal(identity.node, 'undefined'); });
    await evalPage(auth.id, `opener.postMessage('authorized',${JSON.stringify(origin)});true`); await until(() => evalPage(a, "messages.some(m=>m.data==='authorized')"), 'OAuth postMessage'); checks++;
    await evalPage(a,`window.open(${JSON.stringify(foreign+'/cross-auth')},'cross-auth');true`);let cross;
    await until(async()=>{cross=(await state()).openTabs.find(t=>t.url===foreign+'/cross-auth'&&!t.loading);return cross;},'cross-origin auth');
    await evalPage(cross.id,`opener.postMessage('cross-authorized',${JSON.stringify(origin)});true`);
    await until(()=>evalPage(a,`messages.some(m=>m.data==='cross-authorized'&&m.origin===${JSON.stringify(foreign)})`),'cross-origin postMessage');checks++;
    await command('closeTab',cross.id);
    await evalPage(a, "window.authAgain=window.open('/auth-next','authorization');true"); const named = await child('/auth-next');
    check('named authorization window is reused rather than duplicated', () => { assert.equal(named.id, auth.id); }); assert.equal((await state()).openTabs.length, 2); checks++;
    await evalPage(auth.id, "sessionStorage.setItem('nonce','child-only');document.title='授权完成';true"); await until(async () => (await state()).openTabs.find(t=>t.id===auth.id)?.title==='授权完成', 'title update');
    check('root draft and sessionStorage are not overwritten by child', () => {}); assert.equal(await evalPage(a, "document.getElementById('draft').value"), 'unsaved A'); assert.equal(await evalPage(a, "sessionStorage.getItem('nonce')"), 'A');
    await evalPage(auth.id, 'window.close();true'); await until(async()=>!(await state()).openTabs.some(t=>t.id===auth.id),'self close'); assert.equal((await state()).activeTabId,a); checks++;
    await evalPage(a, "document.getElementById('blank').click();true"); const blank = await child('/blank');
    check('target blank respects implicit noopener without replaying root nonce',()=>{});assert.deepEqual(await evalPage(blank.id,"({opener:opener===null,nonce:sessionStorage.getItem('nonce')})"),{opener:true,nonce:null});
    await command('selectTab', a); await evalPage(a, "document.getElementById('post').click();true"); const posted = await child('/posted');
    check('target blank form preserves one POST body rather than rewriting to GET',()=>{const posts=requests.filter(r=>r.path==='/posted');assert.equal(posts.length,1);assert.equal(posts[0].method,'POST');assert.equal(posts[0].body,'challenge=test-nonce');});
    await command('selectTab',a);await evalPage(a,"document.getElementById('no-referrer').click();true");const noref=await child('/noref');check('noreferrer keeps its native referrer privacy',()=>assert.equal(requests.find(r=>r.path==='/noref').referrer,undefined));
    await command('selectTab',a);
    // Ctrl-click exercises Chromium's deferred guest path.
    const aPage = app.windows().find(p=>p.url()===origin+'/root');
    await aPage.locator('#background').click({modifiers:['Control']});const background=await child('/background');
    check('deferred background link loads once and keeps the current tab selected',()=>{});assert.equal((await state()).activeTabId,a);assert.equal(requests.filter(r=>r.path==='/background').length,1);
    s=await command('createProfile',{name:'账号 B',startUrl:origin+'/root'});const b=s.activeId;await until(()=>evalPage(b,'window.ready===true'),'B ready');
    const initialB=await evalPage(b,"({cookie:document.cookie,local:localStorage.getItem('account')})");check('a second environment cannot inherit account A data',()=>{assert(!initialB.cookie.includes('account=A'));assert.equal(initialB.local,null);});
    await evalPage(b,"document.cookie='account=B;Path=/';window.open('/b-child');true");const bChild=await child('/b-child');assert.equal(bChild.environmentId,b);assert((await evalPage(bChild.id,'document.cookie')).includes('account=B'));checks++;
    await command('openProfile',a);check('returning to environment retains its selected page and in-memory root',()=>{});assert.equal((await state()).activeTabId,a);assert.equal(await evalPage(a,'window.token===window.parentToken'),true);
    await command('selectTab',blank.id);await command('navigate',origin+'/child-next');const navigated=await child('/child-next');assert.equal(navigated.id,blank.id);assert.equal(await evalPage(a,'location.pathname'),'/root');checks++;
    await command('closeTab',blank.id);assert((await state()).openTabs.some(t=>t.id===posted.id));assert.equal(await evalPage(a,"document.getElementById('draft').value"),'unsaved A');checks++;
    await evalPage(a,"window.open('about:blank','blank-write').document.write('<title>同步授权页</title><p>ready</p>');true");await until(async()=>(await state()).openTabs.some(t=>t.title==='同步授权页'),'blank document write');checks++;
    await evalPage(a,"window.open('/coop');true");const coop=await child('/coop');assert.equal(await evalPage(coop.id,'opener===null'),true);checks++;
    const count=(await state()).openTabs.length;await evalPage(a,"for(let i=0;i<3;i++)window.open('/burst'+i,'_blank');true");await until(async()=>(await state()).openTabs.length===count+3,'burst');await delay(200);assert.equal((await state()).openTabs.length,count+3);checks++;
    await evalPage(a,"window.open('file:///C:/Windows/win.ini');true");assert.equal((await state()).openTabs.length,count+3);checks++;
    await command('selectTab',noref.id);await shell.locator(`button[data-focus-key="close:${noref.id}"]`).click();assert(!(await state()).openTabs.some(t=>t.id===noref.id));checks++;
    const metrics=await shell.evaluate(()=>({dpr:devicePixelRatio,overflow:document.documentElement.scrollWidth>innerWidth,close:[...document.querySelectorAll('.tab:not(.overview-tab)')].map(t=>{const r=t.getBoundingClientRect(),c=t.querySelector('.tab-close').getBoundingClientRect();return{rightGap:r.right-c.right,width:c.width};})}));
    check('existing close-button alignment and viewport survive many internal tabs',()=>{assert(!metrics.overflow);assert(metrics.close.every(c=>Math.abs(c.rightGap-metrics.close[0].rightGap)<1));assert(metrics.close.every(c=>c.width===metrics.close[0].width));});
    await command('closeProfile',b);assert(!(await state()).openTabs.some(t=>t.environmentId===b));assert((await state()).openTabs.some(t=>t.id===a));checks++;
    await closeApp();await launch();s=await state();check('restart preserves root environment and cookies without replaying transient authorization pages',()=>{assert.equal(s.openTabs.filter(t=>t.child).length,0);assert.equal(s.profiles.length,2);assert.equal(s.profiles.find(p=>p.id===a).startUrl,origin+'/root');});await until(()=>evalPage(a,'window.ready===true'),'restored A');assert((await evalPage(a,'document.cookie')).includes('account=A'));checks++;
    console.log(JSON.stringify({tabsSummary:{scale,checks:checks-before,metrics}}));
  }catch(error){console.error(JSON.stringify({uiFailure:{message:error.message,stack:error.stack,lastStep,scale,checks}}));throw error;}finally{clearTimeout(watchdog);await closeApp().catch(async()=>{app?.process()?.kill();await app?.close().catch(()=>{});});server.close();server.closeAllConnections();crossServer.close();crossServer.closeAllConnections();fs.rmSync(directory,{recursive:true,force:true});}
}
(async()=>{for(const scale of [1,1.25,1.5])await run(scale);console.log(`${checks} internal-tab real-window checks passed`);})().catch(error=>{console.error(JSON.stringify({uiFailure:{message:error.message,stack:error.stack}}));process.exitCode=1;});
