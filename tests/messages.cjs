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
    await shell.locator('[data-module="data"]').click(); await shell.locator('#messages-start').waitFor();
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
    await shell.waitForFunction(() => document.querySelector('#messages-stats').textContent.includes('待核实'));
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
    await shell.locator('#sidebar-toggle').click(); await shell.locator('[data-module="publish"]').click(); await shell.locator('[data-module="data"]').click();
    const collapsed = await shell.evaluate(() => document.querySelector('.app-shell').classList.contains('sidebar-collapsed')); check('module switching preserves explicit collapsed preference', () => assert(collapsed));
    await shell.locator('#messages-search').fill('抖音'); await command('settings', { intervalSeconds: 60 });
    const search = await shell.locator('#messages-search').inputValue(); check('search text survives background state refresh', () => assert.equal(search, '抖音'));
    const measure = await shell.evaluate(() => { const root = document.getElementById('messages-module').getBoundingClientRect(); return { width:innerWidth, height:innerHeight, dpr:devicePixelRatio, right:root.right, documentOverflow:document.documentElement.scrollWidth>innerWidth, tableScroll:document.querySelector('.messages-table-scroll').scrollWidth }; });
    check('responsive summary stays in viewport at selected display scale', () => { assert(!measure.documentOverflow); assert(measure.right <= measure.width + 1); });
    fs.mkdirSync(output, { recursive: true }); await shell.screenshot({ path: path.join(output, `messages-${scale}.png`) });
    await command('settings', { selectedIds: [b.id], intervalSeconds: 120 }); await command('start'); await command('pause');
    const stopped = await app.evaluate(({ BrowserWindow }) => ({ pages:BrowserWindow.getAllWindows()[0].contentView.children.filter(v=>v.webContents?.messageProfileId).length, active:globalThis.__messageFixture.service.active.size, timer:!!globalThis.__messageFixture.service.timer }));
    check('pause releases background pages, listeners and local timer', () => assert.deepEqual(stopped, { pages:0, active:0, timer:false }));
    await command('open', b.id); await until(() => shell.evaluate(() => browserAPI.getState()).then(s => s.activeId === b.id && s.openTabs.find(t => t.id === b.id)?.url === chat), 'correct environment jump');
    const jumped = await shell.evaluate(() => browserAPI.getState()); check('message shortcut is bound to B environment ID and official list route', () => { assert.equal(jumped.activeId,b.id); assert.equal(jumped.openTabs.find(t=>t.id===b.id).url,chat); });
    await until(() => shell.evaluate(() => document.querySelector('.app-shell').dataset.module === 'environment'), 'jump updates renderer navigation');
    const count = (await original()).length; await command('open',b.id); assert.equal((await original()).length,count); checks++;
    await app.close(); app = null; await launch(); const restored = await command('state');
    check('restart restores settings and count baselines, with auto-resume opt-in only', () => { assert.equal(restored.config.sound,false); assert.equal(restored.config.intervalSeconds,120); assert.equal(restored.running,false); assert.equal(restored.rows.find(r=>r.id===b.id).baseline.unread,5); });
    console.log(JSON.stringify({ messageSummary:{scale,checks:checks-before,...measure} }));
  } catch(error) { console.error(JSON.stringify({ uiFailure:{scale,message:error.message,stack:error.stack} })); throw error; }
  finally { if(app) await app.close(); fs.rmSync(directory,{recursive:true,force:true}); }
}
(async()=>{for(const scale of [1,1.25,1.5])await run(scale);console.log(`${checks} message-monitor real-window checks passed`);})().catch(error=>{console.error(error);process.exitCode=1;});
