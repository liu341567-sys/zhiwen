'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { _electron } = require('playwright-core');
const { ProfileStore } = require('../src/profile-store');
const root = path.resolve(__dirname, '..'), output = path.join(root, 'test-results/ui');
const home = 'https://creator.douyin.com/creator-micro/home', chat = 'https://creator.douyin.com/creator-micro/data/following/chat';
const pause = ms => new Promise(r => setTimeout(r, ms)); let checks = 0;
function check(label, fn) { fn(); checks++; console.log('✓ ' + label); }
async function until(fn, label) { const end = Date.now() + 18000; while (Date.now() < end) { if (await fn()) return; await pause(50); } throw Error('Timed out: ' + label); }
async function run(scale) {
  const before = checks, directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qiye-messages-native-'));
  const store = new ProfileStore(directory), a = store.create({ name: '抖音 A', platformId: 'douyin', startUrl: home }), b = store.create({ name: '抖音 B', platformId: 'douyin', startUrl: home });
  const c = store.create({ name: '知乎未适配', platformId: 'zhihu', startUrl: 'https://www.zhihu.com/' });
  store.touchUrl(a.id, home); store.touchUrl(b.id, home);
  const legacy = store.create({name:'旧自定义账号',startUrl:home});
  let app, shell;
  async function launch() {
    app = await _electron.launch({ chromiumSandbox: true, args: [...(process.platform === 'linux' ? ['--disable-setuid-sandbox'] : []), `--force-device-scale-factor=${scale}`, path.join(root, 'tests/electron-launch.cjs')], cwd: root, env: { ...process.env, QIYE_DATA_DIR: directory, QIYE_MESSAGES_FIXTURE: '1' } });
    await until(() => { shell = app.windows().find(p => p.url().endsWith('/renderer/index.html')); return shell; }, 'manager window');
    await shell.waitForFunction(() => document.querySelector('[data-module="data"]') && !document.body.classList.contains('navigation-loading'));
    await until(() => shell.evaluate(() => messagesAPI.command('state').then(() => true).catch(() => false)), 'monitor installed');
    await app.evaluate(({ BrowserWindow, screen }) => { const w = BrowserWindow.getAllWindows()[0], area = screen.getDisplayMatching(w.getBounds()).workArea, f = w.getBounds(), s = w.getContentSize(); w.setMinimumSize(0,0); w.setContentSize(Math.min(1100, area.width - f.width + s[0]), Math.min(720, area.height - f.height + s[1])); });
  }
  const command = (name, input) => shell.evaluate(({ name, input }) => messagesAPI.command(name, input), { name, input });
  const set = async (id, value) => app.evaluate((_, { id, value }) => { globalThis.__messageFixture.samples[id] = value; }, { id, value });
  const original = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].contentView.children.filter(v => v.webContents?.profileId).map(v => ({ id: v.webContents.profileId, wc: v.webContents.id, visible: v.getVisible() })));
  try {
    await launch(); await command('settings', { sound: false, systemNotifications: false });
    await shell.evaluate(id => browserAPI.openProfile(id), a.id);
    let page; await until(() => { page = app.windows().find(p => p.url() === home); return page; }, 'original account page'); await page.waitForFunction(() => window.ready);
    await page.evaluate(() => { document.cookie = 'account=A;Path=/;Secure'; localStorage.setItem('preserved', 'A'); document.getElementById('editing').value = 'draft survives'; });
    const token = await page.evaluate(() => window.originalToken), native = await original();
    await shell.locator('[data-module="data"]').click(); await shell.locator('[data-data-page="messages"]').click(); await shell.locator('#messages-start').waitFor();
    await set(a.id, 8); await set(b.id, 3); const first = await command('scan');
    check('initial samples build silent per-account baselines', () => { assert.equal(first.summary.unread.messages, 11); assert.equal(first.summary.newMessages, null); assert.equal(first.rows.find(r => r.id === c.id).result.status, 'unsupported'); });
    const evidence = await app.evaluate(() => ({ pages: globalThis.__messageFixture.pages, notifications: globalThis.__messageFixture.notifications.length }));
    check('native background page uses original Session, never leaks A cookie into B', () => { assert(evidence.pages.find(p => p.id === a.id).cookies.some(c => c.name === 'account' && c.value === 'A')); assert(!evidence.pages.find(p => p.id === b.id).cookies.some(c => c.name === 'account')); assert.equal(evidence.notifications, 0); });
    const retainedNative = await original();
    check('original WebContents identity and hidden visibility remain intact', () => assert.deepEqual(retainedNative, native.map(n => ({ ...n, visible: false }))));
    assert.equal(await page.evaluate(() => window.originalToken), token); assert.equal(await page.locator('#editing').inputValue(), 'draft survives'); assert.equal(await page.evaluate(() => localStorage.getItem('preserved')), 'A');
    const state = await shell.evaluate(() => browserAPI.getState()); check('closed monitored account stays closed in normal tabs and retains startup config', () => { assert(!state.openTabs.some(t => t.id === b.id)); assert.equal(state.profiles.find(p => p.id === a.id).startUrl, a.startUrl); assert.equal(state.profiles.find(p => p.id === a.id).lastUrl, home); });
    await shell.waitForSelector('#messages-rows tr[data-environment-id] img');
    await shell.evaluate(() => { window.messageRow = document.querySelector('#messages-rows tr'); window.messageLogo = window.messageRow.querySelector('img'); });
    await set(a.id, 11); await set(b.id, 5); const second = await command('scan');
    const notified = await app.evaluate(() => globalThis.__messageFixture.notifications);
    check('multi-account increases produce one aggregate estimated alert', () => { assert.equal(notified.length, 1); assert.equal(notified[0].length, 2); assert.equal(second.summary.increases.messages, 5); });
    await shell.waitForFunction(() => document.querySelector('#messages-stats').children.length === 3);
    const retainedNodes = await shell.evaluate(() => window.messageRow === document.querySelector('#messages-rows tr') && window.messageLogo === window.messageRow.querySelector('img'));
    check('row and loaded image nodes stay stable across scans', () => assert(retainedNodes));
    await command('scan'); assert.equal(await app.evaluate(() => globalThis.__messageFixture.notifications.length), 1); checks++;
    const toast = await app.evaluate(async ({ BrowserWindow }) => { const wc = BrowserWindow.getAllWindows()[0].contentView.children.find(v => v.webContents?.getURL().endsWith('/renderer/toast.html'))?.webContents; return wc ? wc.executeJavaScript("({action:!document.getElementById('toast-action').hidden,text:document.getElementById('toast-message').textContent})") : null; });
    check('reminder appears in independent floating Toast with quick entry', () => { assert(toast?.action); assert(toast.text.includes('2 个账号')); });
    await set(a.id, 'absent'); const absent = await command('scan'); check('missing badge never means zero; reliable baseline retained', () => { const row = absent.rows.find(r => r.id === a.id); assert.equal(row.result.unread, null); assert.equal(row.baseline.unread, 11); assert.equal(row.result.status, 'unrecognized'); });
    const diagnostic = await command('diagnostics', a.id); check('structural diagnostics do not capture conversations, passwords, cookies or input values', () => { assert(!JSON.stringify(diagnostic).includes('DO_NOT_EXPORT')); assert(!JSON.stringify(diagnostic).includes('account=A')); });
    await set(a.id, '99+'); const capped = await command('scan'); check('99+ is a lower bound, not an exact total or zero', () => { const r = capped.rows.find(r => r.id === a.id); assert.equal(r.result.unread, 99); assert.equal(r.result.exact, false); assert.equal(r.baseline.unread, 11); });
    await set(a.id, 'conflict'); const conflict = await command('scan'); assert.equal(conflict.rows.find(r => r.id === a.id).result.status, 'ambiguous'); checks++;
    await set(a.id, 'login'); const login = await command('scan'); assert.equal(login.rows.find(r => r.id === a.id).result.status, 'login_required'); checks++;
    await set(a.id, 0); const zero = await command('scan'); assert.equal(zero.rows.find(r => r.id === a.id).result.unread, 0); checks++;
    await set(a.id, 'rows'); const partial = await command('scan');
    check('visible conversation badges are a lower bound, never an invented total', () => { const r=partial.rows.find(r=>r.id===a.id); assert.equal(r.result.status,'partial'); assert.equal(r.result.unread,6); assert.equal(r.result.exact,false); assert.equal(r.baseline.unread,0); assert.equal(partial.summary.lowerBounds.unknown,6); });
    await set(a.id, 'rowsPlus'); const changedRows = await command('scan');
    check('stable conversation counts compare locally, without exporting peer IDs', () => { assert.equal(changedRows.rows.find(r=>r.id===a.id).result.increase,2); assert(!JSON.stringify(changedRows).includes('private-key')); assert.equal(changedRows.summary.increases.unknown,2); });
    await set(a.id, 'completeRows'); const complete = await command('scan');
    check('full mounted list requires explicit ARIA completeness before summing as total', () => { const r=complete.rows.find(r=>r.id===a.id); assert.equal(r.result.exact,true); assert.equal(r.result.unread,6); assert.equal(complete.summary.unread.unknown,6); });
    await set(a.id, 'nestedRows'); const nested = await command('scan');
    check('nested badges from the supplied diagnostic are counted once per repeated avatar row, excluding navigation and generic numbers', () => { const r=nested.rows.find(r=>r.id===a.id); assert.equal(r.result.status,'partial'); assert.equal(r.result.unread,24); assert.equal(r.result.exact,false); });
    await set(a.id, 'selectedRow'); const selectedRow = await command('scan');
    check('selected-state class modifiers do not hide one conversation from the count', () => { assert.equal(selectedRow.rows.find(r=>r.id===a.id).result.unread,5); });
    await set(a.id, 'nestedSingle'); const single = await command('scan');
    check('single renamed conversation in an explicit chat list is recognised', () => { assert.equal(single.rows.find(r=>r.id===a.id).result.unread,4); });
    await set(a.id, 'renamedRows'); const renamed = await command('scan');
    check('repeated avatar rows survive renamed containers and non-div row tags', () => { assert.equal(renamed.rows.find(r=>r.id===a.id).result.unread,5); });
    await set(a.id, 'unrelatedCards'); const unrelated = await command('scan');
    check('numeric cards without conversation evidence are never reported as private messages', () => { assert.equal(unrelated.rows.find(r=>r.id===a.id).result.status,'unrecognized'); });
    await shell.waitForFunction(() => !document.getElementById('messages-start').hidden && !document.getElementById('messages-scan').disabled);
    const simple = await shell.evaluate(() => ({advanced:document.querySelector('.messages-advanced').open,visibleActions:[...document.querySelectorAll('.messages-buttons > button')].filter(n=>!n.hidden).map(n=>n.id),stats:document.getElementById('messages-stats').children.length}));
    check('first-time UI exposes only a monitor switch and refresh, with advanced settings collapsed', () => { assert.equal(simple.advanced,false); assert.equal(simple.stats,3); assert.deepEqual(simple.visibleActions,['messages-start','messages-scan']); });
    await shell.locator('#sidebar-toggle').click(); await shell.locator('[data-module="publish"]').click(); await shell.locator('[data-module="data"]').click();
    const collapsed = await shell.evaluate(() => document.querySelector('.app-shell').classList.contains('sidebar-collapsed')); check('module switching preserves explicit collapsed preference', () => assert(collapsed));
    await shell.locator('#messages-search').fill('抖音'); await command('settings', { intervalSeconds: 60 });
    const search = await shell.locator('#messages-search').inputValue(); check('search text survives background state refresh', () => assert.equal(search, '抖音'));
    const measure = await shell.evaluate(() => { const root = document.getElementById('messages-module').getBoundingClientRect(); return { width:innerWidth, height:innerHeight, dpr:devicePixelRatio, right:root.right, documentOverflow:document.documentElement.scrollWidth>innerWidth, tableScroll:document.querySelector('.messages-table-scroll').scrollWidth }; });
    check('responsive summary stays in viewport at selected display scale', () => { assert(!measure.documentOverflow); assert(measure.right <= measure.width + 1); });
    fs.mkdirSync(output, { recursive: true }); await shell.screenshot({ path: path.join(output, `messages-${scale}.png`) });
    await command('platform',{id:legacy.id,platformId:'douyin'}); await set(legacy.id,2); const linked = await command('scan');
    const unchangedLegacy = await shell.evaluate(id=>browserAPI.getState().then(s=>s.profiles.find(p=>p.id===id)),legacy.id);
    check('legacy custom environments can monitor without changing original platform or URL',()=>{assert.equal(linked.rows.find(r=>r.id===legacy.id).result.unread,2);assert.equal(unchangedLegacy.platformId,legacy.platformId);assert.equal(Object.hasOwn(unchangedLegacy,'platformId'),Object.hasOwn(legacy,'platformId')); assert.equal(unchangedLegacy.startUrl,legacy.startUrl);});
    await command('platform',{id:legacy.id,platformId:null});
    if (scale === 1) {
      await set(a.id,8); await set(b.id,5); await command('settings',{selectedIds:[a.id,b.id],intervalSeconds:30});
      const started = await command('start'), due = started.nextAt;
      for(let i=0;i<3;i++){await pause(150);const refreshed=await command('scan');assert.equal(refreshed.nextAt,due);}
      check('real-window manual refreshes retain the original automatic 30-second deadline',()=>assert.equal(due,started.nextAt));
      await pause(Math.max(0,due-Date.now()-1000));
      let automatic;await until(async()=>{automatic=await command('state');return !automatic.checking&&automatic.cycle.startedAt>=due;},'actual automatic timer after manual refreshes');
      check('native automatic timer runs at its original deadline after repeated refreshes',()=>{assert(automatic.cycle.startedAt<due+10000);assert.equal(automatic.nextAt,due+30000);});
      measure.timerCase={intervalSeconds:30,manualRefreshes:3,delayMs:automatic.cycle.startedAt-due};
      const paused=await command('pause');check('pausing removes the displayed automatic deadline',()=>assert.equal(paused.nextAt,null));
    }
    await shell.evaluate(ids => { for (const id of ids) document.querySelector(`#messages-rows tr[data-environment-id="${id}"] input`).click(); }, [a.id,b.id]);
    await until(() => command('state').then(s => s.config.selectedIds?.length === 0), 'rapid per-account deselection');
    const selected = await command('state'); check('rapid checkbox changes do not lose the previous account selection update', () => assert.deepEqual(selected.config.selectedIds,[]));
    await command('settings', { selectedIds: [b.id], intervalSeconds: 120 }); await command('start'); await command('pause');
    const stopped = await app.evaluate(({ BrowserWindow }) => ({ pages:BrowserWindow.getAllWindows()[0].contentView.children.filter(v=>v.webContents?.messageProfileId).length, active:globalThis.__messageFixture.service.active.size, timer:!!globalThis.__messageFixture.service.timer }));
    check('pause releases background pages, listeners and local timer', () => assert.deepEqual(stopped, { pages:0, active:0, timer:false }));
    await command('open', b.id); await until(() => shell.evaluate(() => browserAPI.getState()).then(s => s.activeId === b.id && s.openTabs.find(t => t.id === b.id)?.url === chat), 'correct environment jump');
    const jumped = await shell.evaluate(() => browserAPI.getState()); check('message shortcut is bound to B environment ID and official list route', () => { assert.equal(jumped.activeId,b.id); assert.equal(jumped.openTabs.find(t=>t.id===b.id).url,chat); });
    await until(() => shell.evaluate(() => document.querySelector('.app-shell').dataset.module === 'environment'), 'jump updates renderer navigation');
    const count = (await original()).length; await command('open',b.id); assert.equal((await original()).length,count); checks++;
    const chatPage=app.windows().find(p=>p.url()===chat);await chatPage.waitForFunction(()=>window.ready);
    await chatPage.evaluate(()=>{const log=document.createElement('div');log.setAttribute('role','log');log.innerHTML='<div class="message-row"><span class="avatar">A</span><span class="badge">99</span></div><div class="message-row"><span class="avatar">B</span><span class="badge">100</span></div>';log.append(document.createTextNode('PRIVATE_CHAT_DO_NOT_EXPORT'));document.body.append(log);const input=document.createElement('textarea');input.id='chat-draft';input.placeholder='请输入消息';input.value='PRIVATE_DRAFT_DO_NOT_EXPORT';document.body.append(input);const send=document.createElement('button');send.textContent='发送';send.onclick=()=>window.sent=true;document.body.append(send);window.conversationToken=crypto.randomUUID();});
    const conversationToken=await chatPage.evaluate(()=>window.conversationToken);
    const chatNativeId=await app.evaluate(({BrowserWindow},id)=>BrowserWindow.getAllWindows()[0].contentView.children.find(v=>v.webContents?.profileId===id).webContents.id,b.id);
    await shell.locator('[data-module="data"]').click(); const conversationCheck=await command('scan');
    check('an open original conversation is flagged as limited coverage while preserving real unread counts',()=>{const r=conversationCheck.rows.find(r=>r.id===b.id);assert.equal(r.result.activeConversation,true);assert.equal(r.result.unread,5);assert.equal(r.result.visibleConversations,0);assert(r.description.includes('自动标为已读'));});
    await shell.locator('#messages-coverage').waitFor({state:'visible'});
    const retainedChat=await chatPage.evaluate(()=>({token:window.conversationToken,draft:document.getElementById('chat-draft').value,sent:!!window.sent}));
    check('read-only conversation detection preserves the page, draft and send state',()=>assert.deepEqual(retainedChat,{token:conversationToken,draft:'PRIVATE_DRAFT_DO_NOT_EXPORT',sent:false}));
    const latestProbe=await app.evaluate(()=>globalThis.__messageFixture.pages.at(-1));
    check('a selected conversation uses an independent same-account list instead of the chat DOM',()=>{assert.equal(latestProbe.id,b.id);assert.equal(latestProbe.original,false);assert.notEqual(latestProbe.wc,chatNativeId);});
    const conversationDiagnostic=await command('diagnostics',b.id);
    check('conversation diagnostic provides coverage without exporting chat text or composer values',()=>{assert.equal(conversationDiagnostic.context.activeConversation,true);assert(!JSON.stringify(conversationDiagnostic).includes('DO_NOT_EXPORT'));});
    await app.close(); app = null; await launch(); const restored = await command('state');
    check('restart restores settings and count baselines, with auto-resume opt-in only', () => { assert.equal(restored.config.sound,false); assert.equal(restored.config.intervalSeconds,120); assert.equal(restored.running,false); assert.equal(restored.rows.find(r=>r.id===b.id).baseline.unread,5); });
    console.log(JSON.stringify({ messageSummary:{scale,checks:checks-before,...measure} }));
  } catch(error) { console.error(JSON.stringify({ uiFailure:{scale,message:error.message,stack:error.stack} })); throw error; }
  finally { if(app) await app.close(); fs.rmSync(directory,{recursive:true,force:true}); }
}
(async()=>{for(const scale of [1,1.25,1.5])await run(scale);console.log(`${checks} message-monitor real-window checks passed`);})().catch(error=>{console.error(error);process.exitCode=1;});
