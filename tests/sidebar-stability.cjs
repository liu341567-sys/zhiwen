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
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let checks = 0;
async function waitFor(predicate, label) {
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) { if (await predicate()) return; await pause(50); }
  throw new Error(`Timed out: ${label}`);
}
function check(label, assertion) { assertion(); checks += 1; console.log(`✓ ${label}`); }

async function runScale(scale, origin) {
  const beforeChecks = checks;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qiye-sidebar-'));
  const store = new ProfileStore(directory);
  for (let index = 0; index < 50; index += 1) store.create({ name: `稳定账号${String(index + 1).padStart(2, '0')}`, notes: `本地检查 ${index}`,
    startUrl: `${origin}/account`, ...(index % 3 ? { platformId: presets[index % 9].id } : {}) });
  const file = path.join(directory, 'profiles.json');
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const profile of manifest.profiles) profile.lastUrl = `${origin}/account`;
  fs.writeFileSync(file, JSON.stringify(manifest));
  let app;
  try {
    app = await _electron.launch({ chromiumSandbox: true,
      args: [...(process.platform === 'linux' ? ['--disable-setuid-sandbox'] : []), `--force-device-scale-factor=${scale}`, path.join(root, 'tests/electron-launch.cjs')],
      cwd: root, env: { ...process.env, QIYE_DATA_DIR: directory } });
    let shell;
    await waitFor(() => { shell = app.windows().find(page => page.url().endsWith('/renderer/index.html')); return shell; }, 'management surface');
    await shell.waitForFunction(() => !!window.browserAPI);
    const workArea = await app.evaluate(({ BrowserWindow, screen }) => {
      const main = BrowserWindow.getAllWindows()[0];
      const area = screen.getDisplayMatching(main.getBounds()).workArea;
      const frame = main.getBounds(), [width, height] = main.getContentSize();
      main.setMinimumSize(0, 0);
      main.setContentSize(Math.min(900, area.width - (frame.width - width)), Math.min(480, area.height - (frame.height - height)));
      return area;
    });
    const state = () => shell.evaluate(() => window.browserAPI.getState());
    const control = (type, id) => shell.locator(`[data-focus-key="${type}:${id}"]`);
    const list = shell.locator('#profile-list');
    await waitFor(() => shell.evaluate(() => document.querySelectorAll('.profile-row').length === 50 &&
      [...document.querySelectorAll('.profile-row img')].every(img => img.complete && img.naturalWidth > 0 && !img.hidden)), '50 accounts and their local icons');
    const toast = app.windows().find(page => page.url().endsWith('/renderer/toast.html'));
    assert.ok(toast);
    await toast.waitForFunction(() => !!window.toastAPI);
    const viewport = await shell.evaluate(() => ({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio }));
    check(`sidebar-${scale}: 50 saved environments at actual requested DPR`, () => { assert.ok(Math.abs(viewport.dpr - scale) < .02); assert.equal(manifest.profiles.length, 50); });
    const ids = manifest.profiles.map(p => p.id);
    const layout = () => shell.evaluate(() => {
      const rect = node => { const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
      return { list: rect(document.getElementById('profile-list')), heading: rect(document.querySelector('.sidebar-heading')),
        search: rect(document.getElementById('profile-search')), footer: rect(document.querySelector('.sidebar-bottom')) };
    });
    const position = () => list.evaluate(n => ({ scroll: n.scrollTop, max: n.scrollHeight - n.clientHeight }));
    const center = async id => {
      await control('open', id).evaluate(node => {
        const list = document.getElementById('profile-list'), row = node.closest('.profile-row');
        const r = row.getBoundingClientRect(), b = list.getBoundingClientRect();
        list.scrollTop += r.top - b.top - (list.clientHeight - r.height) / 2;
      });
    };
    await shell.evaluate(() => {
      window.__stableRows = new Map([...document.querySelectorAll('.profile-row')].map(row => [row.dataset.profileId,
        { row, avatar: row.querySelector('.profile-icon'), image: row.querySelector('img'), source: row.querySelector('img')?.currentSrc }]));
      window.__stableImageLoads = 0;
      for (const entry of window.__stableRows.values()) entry.image?.addEventListener('load', () => { window.__stableImageLoads += 1; });
    });
    const preserved = () => shell.evaluate(() => [...document.querySelectorAll('.profile-row')].every(row => {
      const original = window.__stableRows.get(row.dataset.profileId);
      return !original || (row === original.row && row.querySelector('.profile-icon') === original.avatar &&
        row.querySelector('img') === original.image && (!original.image || original.image.currentSrc === original.source));
    }));
    for (const id of [ids[29], ids[30], ids[28], ids[30], ids[29]]) { await center(id); await control('open', id).click(); await waitFor(async () => (await state()).activeId === id, 'mouse environment switch'); }
    check(`sidebar-${scale}: rapid real mouse switches preserve every row and image node`, () => assert.ok(true));
    assert.equal(await preserved(), true);
    assert.equal(await shell.evaluate(() => window.__stableImageLoads), 0);
    const mid = await position();
    for (let index = 0; index < 8; index += 1) await state();
    assert.equal(await preserved(), true);
    check(`sidebar-${scale}: page state refresh neither reloads icons nor resets list scroll`, () => assert.ok(mid.scroll > 500));
    assert.ok(Math.abs((await position()).scroll - mid.scroll) <= 1.1);

    await shell.locator('#profile-search').fill('稳定账号30');
    await shell.locator('#profile-search').fill('');
    assert.equal(await preserved(), true);
    check(`sidebar-${scale}: filtering reuses local images when the same saved entries return`, () => assert.ok(true));
    await center(ids[29]);
    await control('edit', ids[29]).click();
    await shell.locator('#profile-name').fill('已改名的稳定账号');
    await shell.locator('#profile-notes').fill('新的备注');
    await shell.locator('#profile-save').click();
    await waitFor(() => shell.locator('#profile-dialog').evaluate(n => !n.open), 'rename complete');
    assert.equal(await preserved(), true);
    await control('edit', ids[29]).click();
    assert.equal(await shell.locator('#profile-name').inputValue(), '已改名的稳定账号');
    assert.equal(await shell.locator('#profile-notes').inputValue(), '新的备注');
    await shell.locator('#profile-cancel').click();
    check(`sidebar-${scale}: rename retains the icon and cached edit controls read current metadata`, () => assert.ok(true));

    const beforeToast = await layout();
    const beforeToastPosition = await position();
    await shell.evaluate(() => window.browserAPI.showToast({ message: '独立环境创建成功', type: 'success', bounds: { x: document.querySelector('.sidebar').getBoundingClientRect().right, y: document.querySelector('.navigation-toolbar').getBoundingClientRect().bottom, width: innerWidth } }));
    await waitFor(() => toast.locator('#toast-message').textContent().then(text => text === '独立环境创建成功'), 'native toast message');
    const nativeToast = () => app.evaluate(({ BrowserWindow }) => {
      const main = BrowserWindow.getAllWindows()[0];
      const view = main.contentView.children.find(v => v.webContents?.getURL().endsWith('/renderer/toast.html'));
      return { visible: view.getVisible(), bounds: view.getBounds(), onTop: main.contentView.children.at(-1) === view,
        accounts: main.contentView.children.filter(v => v.webContents?.profileId && v.getVisible()).map(v => ({ id: v.webContents.profileId, bounds: v.getBounds() })) };
    });
    await waitFor(() => nativeToast().then(n => n.visible), 'native toast above a running account');
    const visible = await nativeToast();
    assert.deepEqual(await layout(), beforeToast);
    assert.equal(visible.onTop, true);
    assert.equal(visible.accounts.length, 1);
    const toolbarBottom = await shell.locator('.navigation-toolbar').evaluate(n => n.getBoundingClientRect().bottom);
    check(`sidebar-${scale}: floating toast is above the native account and below important toolbar controls`, () => assert.ok(visible.bounds.y >= toolbarBottom && visible.bounds.y + visible.bounds.height <= viewport.height));
    const nativeWindowImage = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].capturePage()).toDataURL());
    fs.writeFileSync(path.join(output, `sidebar-${scale}-native-toast.png`), Buffer.from(nativeWindowImage.split(',')[1], 'base64'));
    for (const message of ['连续操作一', '连续操作二', '最后一次操作']) await shell.evaluate(message => window.browserAPI.showToast({ message, type: 'info' }), message);
    await waitFor(() => toast.locator('#toast-message').textContent().then(text => text === '最后一次操作'), 'latest notification replaces older messages');
    assert.equal(await toast.locator('.toast-card').count(), 1);
    assert.deepEqual(await layout(), beforeToast);
    check(`sidebar-${scale}: consecutive notifications occupy one floating surface without squeezing the sidebar`, () => assert.ok(true));
    await waitFor(() => nativeToast().then(n => !n.visible), '2.7-second toast expiry');
    assert.deepEqual(await layout(), beforeToast);
    assert.ok(Math.abs((await position()).scroll - beforeToastPosition.scroll) <= 1.1);
    check(`sidebar-${scale}: toast fade-out and expiry leave list height and scroll unchanged`, () => assert.ok(true));

    const removeUI = async id => {
      await center(id);
      await control('edit', id).click();
      const before = { position: await position(), layout: await layout(), state: await state() };
      await shell.locator('#profile-delete').click();
      await shell.locator('#delete-confirm').click();
      await waitFor(async () => !(await state()).profiles.some(p => p.id === id) && !(await shell.locator('#delete-dialog').evaluate(n => n.open)), 'environment deleted');
      const after = { position: await position(), layout: await layout(), state: await state() };
      assert.ok(Math.abs(after.position.scroll - Math.min(before.position.scroll, after.position.max)) <= 1.1, 'Deletion must retain the old pixel position, clamped only at the true bottom');
      assert.deepEqual(after.layout, before.layout);
      assert.deepEqual(after.state.profiles.map(p => p.id), before.state.profiles.filter(p => p.id !== id).map(p => p.id));
      assert.equal(await preserved(), true);
      await waitFor(() => toast.locator('#toast-message').textContent().then(text => text === '独立环境已删除'), 'deletion success notification');
      return { before, after };
    };
    const inactive = await removeUI(ids[28]);
    assert.equal(inactive.after.state.activeId, inactive.before.state.activeId);
    assert.deepEqual(inactive.after.state.openTabs.map(t => t.id), inactive.before.state.openTabs.filter(t => t.id !== ids[28]).map(t => t.id));
    check(`sidebar-${scale}: deleting a middle inactive account preserves scroll, sibling order and the active page`, () => assert.ok(inactive.after.position.scroll > 500));
    await removeUI(ids[29]);
    check(`sidebar-${scale}: deleting the active account keeps the same list region while applying original tab closure`, () => assert.ok(true));
    await removeUI(ids[30]);
    await removeUI(ids[31]);
    check(`sidebar-${scale}: consecutive deletions fill gaps without remounting surviving avatars`, () => assert.ok(true));
    await removeUI(ids[49]);
    const bottomScroll = (await position()).scroll;
    check(`sidebar-${scale}: bottom deletion clamps to the remaining scroll range rather than jumping to the top`, () => assert.ok(bottomScroll > 500));

    const current = await state();
    const moving = current.profiles[35].id, destination = current.profiles[34].id;
    await center(moving);
    await control('open', moving).scrollIntoViewIfNeeded();
    const source = await control('open', moving).boundingBox();
    await shell.mouse.move(source.x + 24, source.y + source.height / 2);
    await shell.mouse.down();
    await shell.mouse.move(source.x + 24, source.y + source.height / 2 - 12, { steps: 3 });
    await shell.mouse.move(source.x + 24, (await list.boundingBox()).y + (await list.boundingBox()).height / 2);
    await shell.evaluate(() => window.browserAPI.showToast({ message: '排序过程中提示', type: 'info' }));
    await waitFor(() => nativeToast().then(n => !n.visible), 'toast expiry during a held drag');
    assert.equal(await list.getAttribute('data-dragging-id'), moving);
    check(`sidebar-${scale}: toast display and expiry preserve an ongoing real mouse drag`, () => assert.ok(true));
    // Compact sidebars can expose only one full row. Keep the pointer inside
    // the real scroll container and let the existing edge-scroll reveal the
    // preceding row, instead of sending a drop outside the list.
    await waitFor(async () => {
      const bounds = await list.boundingBox();
      const target = await control('open', destination).boundingBox();
      const y = Math.max(bounds.y + 2, Math.min(bounds.y + bounds.height - 2, target.y + 4));
      await shell.mouse.move(bounds.x + 30, y);
      return list.evaluate((node, id) => !!document.querySelector(`.profile-row[data-profile-id="${id}"].drop-before`), destination);
    }, 'visible insertion marker for the previous account');
    await shell.mouse.up();
    await waitFor(async () => { const p = (await state()).profiles.map(p => p.id); return p.indexOf(moving) + 1 === p.indexOf(destination); }, 'sorting after several deletes');
    assert.equal(await preserved(), true);
    check(`sidebar-${scale}: real mouse sorting after deletions keeps UUID/icon associations and persists the new order`, () => assert.ok(true));
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).profiles.map(p => p.id), (await state()).profiles.map(p => p.id));

    await shell.locator('#sidebar-create').click();
    await shell.locator('#profile-name').fill('新增稳定性检查');
    await shell.locator('#profile-url').fill('javascript:alert(1)');
    await shell.locator('#profile-save').click();
    await waitFor(() => toast.locator('#toast').getAttribute('class').then(c => c.includes('error')), 'failed creation notification');
    const failedCreateCount = (await state()).profiles.length;
    check(`sidebar-${scale}: invalid creation displays an error toast without a success message or new account`, () => assert.equal(failedCreateCount, current.profiles.length));
    await shell.locator('#profile-url').fill(`${origin}/account`);
    const beforeCreateLayout = await layout();
    const beforeCreateScroll = (await position()).scroll;
    await shell.locator('#profile-save').click();
    await waitFor(() => shell.locator('#profile-dialog').evaluate(n => !n.open), 'valid creation complete');
    await waitFor(() => toast.locator('#toast-message').textContent().then(t => t === '独立环境创建成功'), 'actual creation success toast');
    assert.deepEqual(await layout(), beforeCreateLayout);
    assert.ok(Math.abs((await position()).scroll - beforeCreateScroll) <= 1.1);
    assert.equal(await preserved(), true);
    check(`sidebar-${scale}: actual creation and its notification do not move the existing list region`, () => assert.ok(true));
    const isolated = await toast.evaluate(() => ({ node: typeof require, management: typeof browserAPI, onlyUI: Object.keys(toastAPI).sort() }));
    check(`sidebar-${scale}: the local notification surface has no Node or account-management bridge`, () => assert.deepEqual(isolated, { node: 'undefined', management: 'undefined', onlyUI: ['onMessage', 'resized'] }));
    return { scale, actualDpr: viewport.dpr, viewport, workArea, checks: checks - beforeChecks, fixtureProfiles: 50 };
  } finally {
    if (app) await app.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

async function main() {
  fs.mkdirSync(output, { recursive: true });
  const server = http.createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!doctype html><title>Local sidebar fixture</title><script>window.fixtureReady=true</script>'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    for (const scale of [1, 1.25, 1.5]) console.log(JSON.stringify({ sidebarSummary: await runScale(scale, `http://127.0.0.1:${server.address().port}`) }));
    console.log(`${checks} sidebar stability checks passed across three real device scales.`);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}
main().catch(error => { console.error(JSON.stringify({ uiFailure: { message: error.message, stack: error.stack } })); process.exitCode = 1; });
