'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { _electron } = require('playwright-core');
const { ProfileStore } = require('../src/profile-store');
const presets = require('../src/platform-presets.json');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'test-results', 'ui');
const pause = ms => new Promise(r => setTimeout(r, ms));
let checks = 0;
async function until(test, label) { const end = Date.now() + 12000; while (Date.now() < end) { if (await test()) return; await pause(50); } throw new Error(`Timed out: ${label}`); }
function check(label, test) { test(); checks++; console.log(`✓ ${label}`); }
async function run(scale, origin) {
  const before = checks;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qiye-navigation-'));
  const store = new ProfileStore(directory);
  for (let i = 0; i < 50; i++) {
    const profile = store.create({ name: `导航账号${String(i + 1).padStart(2, '0')}`, startUrl: origin, ...(i % 3 ? { platformId: presets[i % 9].id } : {}) });
    store.touchUrl(profile.id, origin);
  }
  const ids = store.getState().profiles.map(p => p.id);
  let app;
  const launch = async () => {
    app = await _electron.launch({ chromiumSandbox: true, args: [...(process.platform === 'linux' ? ['--disable-setuid-sandbox'] : []),
      `--force-device-scale-factor=${scale}`, path.join(root, 'tests/electron-launch.cjs')], cwd: root, env: { ...process.env, QIYE_DATA_DIR: directory } });
    let shell; await until(() => { shell = app.windows().find(page => page.url().endsWith('/renderer/index.html')); return shell; }, 'manager');
    await shell.waitForFunction(() => document.querySelector('[data-module="environment"]') && !document.body.classList.contains('navigation-loading'));
    await until(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), 'native window ready');
    await until(() => { const file = path.join(directory, 'ui-preferences.json'); return fs.existsSync(file) && !!JSON.parse(fs.readFileSync(file, 'utf8')).windowSize; }, 'initial layout saved even without a resize');
    return shell;
  };
  try {
    let shell = await launch();
    const area = await app.evaluate(({ BrowserWindow, screen }) => {
      const main = BrowserWindow.getAllWindows()[0], area = screen.getDisplayMatching(main.getBounds()).workArea;
      main.setMinimumSize(0, 0); const frame = main.getBounds(), size = main.getContentSize();
      main.setContentSize(Math.min(1000, area.width - frame.width + size[0]), Math.min(700, area.height - frame.height + size[1])); return area;
    });
    const state = () => shell.evaluate(() => browserAPI.getState());
    const select = id => shell.locator(`button[data-module="${id}"]`).click();
    const preview = id => shell.locator(`button[data-module="${id}"]`).click({ button: 'right' });
    const toggleBounds = () => shell.locator('#sidebar-toggle').boundingBox();
    const layout = () => shell.evaluate(() => {
      const r = n => { const b = n.getBoundingClientRect(); return { x: b.x, y: b.y, width: b.width, height: b.height }; };
      return { main: r(document.querySelector('.main-panel')), rail: r(document.querySelector('.global-navigation')), sidebar: r(document.querySelector('.sidebar')), list: r(document.querySelector('#profile-list')) };
    });
    const identity = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].contentView.children
      .filter(v => v.webContents?.profileId).map(v => ({ id: v.webContents.profileId, wc: v.webContents.id, bounds: v.getBounds(), visible: v.getVisible() })));
    await shell.evaluate(id => browserAPI.openProfile(id), ids[30]);
    let account; await until(() => { account = app.windows().find(page => page.url() === origin); return account; }, 'account');
    await account.waitForFunction(() => window.ready);
    await account.evaluate(() => { window.navigationToken = crypto.randomUUID(); localStorage.setItem('navigation-data', 'retained'); document.cookie = 'navigation=retained;Path=/'; });
    const token = await account.evaluate(() => window.navigationToken);
    const baseNative = await identity();
    await shell.locator('#profile-list').evaluate(n => n.scrollTop = 1800);
    await pause(150);
    await shell.waitForFunction(() => [...document.querySelectorAll('.profile-row img')].every(img => img.complete && img.naturalWidth > 0));
    await shell.evaluate(() => window.__navRows = [...document.querySelectorAll('.profile-row')].map(row => ({ row, icon: row.querySelector('.profile-icon'), image: row.querySelector('img'), id: row.dataset.profileId })));
    const sameRows = () => shell.evaluate(() => window.__navRows.every(old => old.row.isConnected && old.row.querySelector('.profile-icon') === old.icon && old.row.querySelector('img') === old.image));
    const initial = await layout();
    check(`navigation-${scale}: fixed rail and secondary width leave a flexible workspace`, () => { assert.equal(initial.rail.width, 64); assert.equal(initial.sidebar.width, 240); assert.ok(initial.main.width >= 360); });
    await shell.waitForFunction(() => { const logo = document.querySelector('.rail-logo'); return logo.complete && logo.naturalWidth > 0; });
    const branding = await shell.evaluate(() => {
      const logo = document.querySelector('.rail-logo'), rect = logo.getBoundingClientRect();
      const rail = document.querySelector('.global-navigation').getBoundingClientRect();
      const title = document.getElementById('secondary-title'), heading = title.getBoundingClientRect();
      const create = document.getElementById('sidebar-create').getBoundingClientRect();
      return { natural: [logo.naturalWidth, logo.naturalHeight], rect: { width: rect.width, height: rect.height },
        centered: Math.abs((rect.left + rect.right) / 2 - (rail.left + rail.right) / 2) <= 1,
        oldLogoCount: document.querySelectorAll('#environment-sidebar-content .brand, .brand-logo').length,
        title: title.textContent, titleFits: title.scrollWidth <= title.clientWidth && title.scrollHeight <= title.clientHeight,
        titleGap: create.top - heading.bottom, toggleCount: document.querySelectorAll('#sidebar-toggle').length,
        oldControls: document.querySelectorAll('#sidebar-collapse, #sidebar-expand, #settings-sidebar-toggle').length };
    });
    const fixedToggle = await toggleBounds();
    await shell.screenshot({ path: path.join(output, `navigation-${scale}-expanded.png`) });
    check(`navigation-${scale}: original vertical logo is proportional and centered; redundant logo and collapse controls are absent`, () => {
      assert.deepEqual(branding.natural, [998, 1313]); assert.ok(branding.centered);
      assert.ok(Math.abs(branding.rect.width / branding.rect.height - 998 / 1313) < .01);
      assert.equal(branding.oldLogoCount, 0); assert.equal(branding.oldControls, 0); assert.equal(branding.toggleCount, 1);
      assert.equal(branding.title, '账号环境管理'); assert.equal(branding.titleFits, true); assert.ok(branding.titleGap < 30);
    });
    const scroll = await shell.locator('#profile-list').evaluate(n => n.scrollTop);
    await select('publish');
    await shell.locator('#planned-module').waitFor({ state: 'visible' });
    assert.equal(await shell.locator('.secondary-menu-button:disabled').count(), 5);
    assert.equal((await state()).activeId, ids[30]);
    const otherNative = await identity();
    assert.equal(otherNative[0].wc, baseNative[0].wc); assert.deepEqual(otherNative[0].bounds, baseNative[0].bounds);
    check(`navigation-${scale}: publishing contains only planned menus without closing or resizing the running account`, () => assert.equal(otherNative[0].visible, false));
    await select('data'); await select('ai'); await select('settings');
    await shell.locator('#settings-module').waitFor({ state: 'visible' });
    assert.ok((await shell.locator('#settings-data-path').textContent()).includes(directory));
    await select('environment');
    await until(() => identity().then(v => v[0].visible), 'account visible again');
    assert.equal(await sameRows(), true);
    assert.ok(Math.abs(await shell.locator('#profile-list').evaluate(n => n.scrollTop) - scroll) <= 1);
    assert.deepEqual(await account.evaluate(() => ({ token: window.navigationToken, stored: localStorage.getItem('navigation-data'), cookie: document.cookie })),
      { token, stored: 'retained', cookie: 'navigation=retained' });
    assert.deepEqual((await state()).profiles.map(p => p.id), ids);
    check(`navigation-${scale}: returning preserves account token, cookies, storage, rows, icons, scroll and ordering`, () => assert.ok(true));
    await shell.locator('#profile-search').fill('导航账号3');
    const filtered = await shell.locator('.profile-row').count();
    await select('publish'); await select('environment');
    assert.equal(await shell.locator('#profile-search').inputValue(), '导航账号3'); assert.equal(await shell.locator('.profile-row').count(), filtered);
    check(`navigation-${scale}: module switches preserve the environment search`, () => assert.ok(true));
    await shell.locator('#profile-search').fill('');
    await shell.locator('#profile-list').evaluate(n => n.scrollTop = 1800);
    await shell.locator('#sidebar-toggle').click();
    await until(() => shell.locator('.app-shell').getAttribute('class').then(c => c.includes('sidebar-collapsed')), 'collapsed');
    await until(() => identity().then(v => v[0].bounds.x === 64), 'expanded native account viewport');
    const collapsed = await layout(), collapsedNative = await identity();
    check(`navigation-${scale}: full collapse releases exactly the secondary width without recreating the account`, () => { assert.equal(collapsed.main.width - initial.main.width, 240); assert.equal(collapsedNative[0].wc, baseNative[0].wc); });
    await shell.evaluate(() => {
      window.__sidebarTransitions = [];
      window.__sidebarObserver = new MutationObserver(records => {
        window.__sidebarTransitions.push(...records.map(record => record.oldValue));
      });
      window.__sidebarObserver.observe(document.querySelector('.app-shell'), { attributes: true, attributeFilter: ['class'], attributeOldValue: true });
    });
    for (const id of ['publish', 'data', 'ai', 'settings', 'environment', 'environment']) {
      await select(id);
      assert.equal(await shell.locator('#secondary-sidebar').isVisible(), false);
      assert.deepEqual((await layout()).main, collapsed.main);
      assert.equal((await state()).uiPreferences.sidebarCollapsed, true);
      assert.deepEqual(await toggleBounds(), fixedToggle);
    }
    const transitions = await shell.evaluate(() => { window.__sidebarObserver.disconnect(); return window.__sidebarTransitions; });
    check(`navigation-${scale}: every normal module click keeps the sidebar hidden without a transient cover or changing layout preference`, () => {
      assert.ok(transitions.every(value => value.includes('sidebar-collapsed') && !value.includes('sidebar-overlay')));
    });
    await preview('environment');
    await until(() => shell.locator('.app-shell').getAttribute('class').then(c => c.includes('sidebar-overlay')), 'explicit temporary cover');
    await pause(200);
    assert.deepEqual((await layout()).main, collapsed.main);
    assert.equal((await layout()).sidebar.x, 64);
    const coverNative = await identity();
    assert.deepEqual(coverNative[0].bounds, collapsedNative[0].bounds); assert.equal(coverNative[0].wc, baseNative[0].wc);
    assert.equal(await shell.locator('#navigation-page-frame').isVisible(), true);
    check(`navigation-${scale}: temporary sidebar covers rather than resizes the workspace and retains the same native viewport`, () => assert.ok(true));
    const closeHit = await shell.locator('#sidebar-overlay-close').evaluate(n => { const r = n.getBoundingClientRect(); return n.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)); });
    assert.equal(closeHit, true, 'The temporary sidebar close control must be visible and clickable above the backdrop');
    await shell.screenshot({ path: path.join(output, `navigation-${scale}-overlay.png`) });
    const coverListHeight = (await layout()).list.height;
    const railCount = await shell.locator('#primary-navigation > button').count();
    await shell.evaluate(() => { for (let i = 0; i < 20; i++) { const b = document.createElement('button'); b.className = 'rail-button'; b.textContent = '测试'; document.getElementById('primary-navigation').append(b); } });
    assert.equal((await layout()).list.height, coverListHeight);
    const beforeRailScroll = await shell.locator('#profile-list').evaluate(n => n.scrollTop);
    await shell.locator('#primary-navigation').evaluate(n => n.scrollTop = n.scrollHeight);
    assert.equal(await shell.locator('#profile-list').evaluate(n => n.scrollTop), beforeRailScroll);
    assert.deepEqual(await toggleBounds(), fixedToggle);
    await shell.evaluate(count => { const rail = document.getElementById('primary-navigation'); while (rail.children.length > count) rail.lastElementChild.remove(); rail.scrollTop = 0; }, railCount);
    check(`navigation-${scale}: adding and scrolling global entries cannot compress or scroll the account list`, () => assert.ok(true));
    const mainBox = collapsed.main;
    await shell.mouse.click(mainBox.x + mainBox.width - 20, mainBox.y + 180);
    await until(() => shell.locator('.app-shell').getAttribute('class').then(c => !c.includes('sidebar-overlay')), 'outside close');
    await until(() => identity().then(v => v[0].visible), 'live native page restored');
    assert.deepEqual((await layout()).main, collapsed.main); assert.equal(await account.evaluate(() => window.navigationToken), token);
    await preview('environment');
    await shell.locator('#sidebar-overlay-close').click();
    await preview('environment');
    await shell.locator('#sidebar-toggle').click();
    assert.equal(await shell.locator('#secondary-sidebar').isVisible(), false);
    assert.equal((await state()).uiPreferences.sidebarCollapsed, true);
    await shell.locator('button[data-module="environment"]').focus();
    await shell.locator('button[data-module="environment"]').press('Shift+F10');
    await shell.locator(`[data-focus-key="open:${ids[31]}"]`).click();
    await until(async () => (await state()).activeId === ids[31] && !(await shell.locator('.app-shell').getAttribute('class')).includes('sidebar-overlay'), 'selection closes temporary menu');
    assert.deepEqual((await layout()).main, collapsed.main);
    check(`navigation-${scale}: outside click, close control and successful account selection close only the temporary sidebar`, () => assert.ok(true));
    await shell.locator('#sidebar-toggle').click();
    await until(() => shell.locator('.app-shell').getAttribute('class').then(c => !c.includes('sidebar-collapsed')), 'pinned expansion');
    assert.equal((await layout()).main.x, 304);
    assert.equal(await sameRows(), true);
    check(`navigation-${scale}: explicit expansion restores the sidebar without remounting its rows`, () => assert.ok(true));
    const toggleLabel = await shell.locator('#sidebar-toggle').getAttribute('aria-label');
    check(`navigation-${scale}: one fixed bottom control retains position across expanded, collapsed, cover and rail scrolling states`, () => {
      assert.equal(toggleLabel, '收起侧栏');
    });
    assert.deepEqual(await toggleBounds(), fixedToggle);
    await shell.locator('#profile-search').fill('导航账号');
    await shell.locator('#profile-list').evaluate(n => n.scrollTop = 1600);
    await pause(180); const savedScroll = await shell.locator('#profile-list').evaluate(n => n.scrollTop);
    await shell.locator('#sidebar-toggle').click(); await select('publish');
    assert.equal(await shell.locator('#secondary-sidebar').isVisible(), false);
    await pause(250);
    const saved = JSON.parse(fs.readFileSync(path.join(directory, 'ui-preferences.json'), 'utf8'));
    assert.equal(saved.sidebarCollapsed, true); assert.equal(saved.activeModule, 'publish'); assert.equal(saved.environmentSearch, '导航账号');
    assert.ok(Math.abs(saved.environmentScroll - savedScroll) <= 1);
    const savedWindowState = await app.evaluate(({ BrowserWindow }) => {
      const main = BrowserWindow.getAllWindows()[0], { width, height } = main.getBounds(), normal = main.getNormalBounds();
      return { visible: { width, height }, normal: { width: normal.width, height: normal.height }, maximized: main.isMaximized() };
    });
    assert.deepEqual(saved.windowSize, savedWindowState.normal);
    assert.equal(saved.windowMaximized, savedWindowState.maximized);
    const savedWindow = savedWindowState.visible;
    await app.close(); app = null;
    shell = await launch();
    assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMaximized()), savedWindowState.maximized);
    const restoredWindow = await app.evaluate(({ BrowserWindow }) => { const { width, height } = BrowserWindow.getAllWindows()[0].getBounds(); return { width, height }; });
    assert.ok(Math.abs(restoredWindow.width - savedWindow.width) <= 2 && Math.abs(restoredWindow.height - savedWindow.height) <= 2, 'Window size is restored within native device-pixel rounding');
    assert.equal(await shell.locator('#planned-title').textContent(), '内容发布中心');
    assert.ok((await shell.locator('.app-shell').getAttribute('class')).includes('sidebar-collapsed'));
    assert.ok(!(await shell.locator('.app-shell').getAttribute('class')).includes('sidebar-overlay'));
    await select('environment');
    assert.equal(await shell.locator('#secondary-sidebar').isVisible(), false);
    await preview('environment');
    assert.equal(await shell.locator('#profile-search').inputValue(), '导航账号');
    await until(() => shell.locator('#profile-list').evaluate(n => n.scrollTop > 1000), 'restored list position');
    assert.deepEqual((await state()).profiles.map(p => p.id), ids);
    check(`navigation-${scale}: restart restores module, collapsed preference, search, scroll and account order but never a stale overlay`, () => assert.ok(true));
    await shell.locator('#profile-list').evaluate(n => n.scrollTop = 1450);
    const lastScroll = await shell.locator('#profile-list').evaluate(n => n.scrollTop);
    await app.close(); app = null;
    const finalPreferences = JSON.parse(fs.readFileSync(path.join(directory, 'ui-preferences.json'), 'utf8'));
    assert.ok(Math.abs(finalPreferences.environmentScroll - lastScroll) <= 1);
    shell = await launch();
    await select('environment');
    assert.equal(await shell.locator('#secondary-sidebar').isVisible(), false);
    await preview('environment');
    await until(() => shell.locator('#profile-list').evaluate(n => n.scrollTop > 1000), 'last immediate scroll checkpoint');
    check(`navigation-${scale}: immediate exit after a final scroll checkpoints the current UI without preserving a temporary cover`, () => assert.ok(true));
    await shell.locator('#sidebar-overlay-close').click();
    await shell.locator('#sidebar-toggle').click();
    await app.evaluate(({ BrowserWindow }) => { const main = BrowserWindow.getAllWindows()[0]; main.unmaximize(); main.setMinimumSize(0, 0); main.setContentSize(600, 480); });
    await until(() => shell.locator('.app-shell').getAttribute('class').then(c => c.includes('sidebar-collapsed')), 'narrow adaptation');
    assert.equal(await shell.evaluate(() => innerWidth), 600);
    assert.equal(JSON.parse(fs.readFileSync(path.join(directory, 'ui-preferences.json'), 'utf8')).sidebarCollapsed, false);
    await select('environment');
    assert.equal(await shell.locator('#secondary-sidebar').isVisible(), false);
    await shell.locator('#sidebar-toggle').click();
    await until(() => shell.locator('#secondary-sidebar').isVisible(), 'explicit narrow cover');
    assert.ok((await layout()).main.width >= 530);
    await shell.locator('#sidebar-toggle').click();
    assert.equal(await shell.locator('#secondary-sidebar').isVisible(), false);
    check(`navigation-${scale}: narrow-window cover preserves a usable main workspace`, () => assert.ok(true));
    return { scale, actualDpr: await shell.evaluate(() => devicePixelRatio), workArea: area, checks: checks - before, fixtureProfiles: 50 };
  } finally { if (app) await app.close(); fs.rmSync(directory, { recursive: true, force: true }); }
}
(async () => {
  fs.mkdirSync(output, { recursive: true });
  const server = http.createServer((_q, r) => r.end('<!doctype html><title>Local navigation account</title><script>window.ready=true</script><p>Live account retained</p>'));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  try { for (const scale of [1, 1.25, 1.5]) console.log(JSON.stringify({ navigationSummary: await run(scale, `http://127.0.0.1:${server.address().port}/`) })); console.log(`${checks} navigation checks passed across three real device scales.`); }
  finally { server.closeAllConnections(); await new Promise(r => server.close(r)); }
})().catch(error => { console.error(JSON.stringify({ uiFailure: { message: error.message, stack: error.stack } })); process.exitCode = 1; });
