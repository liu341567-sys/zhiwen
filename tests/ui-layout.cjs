'use strict';

// Real Electron windows, real device scale, loopback pages and disposable data.
// No viewport emulation, real platform login, browser sandbox bypass or HAR.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { _electron } = require('playwright-core');
const { verifyInputFocus } = require('./ui-focus.cjs');
const { seedLegacyPlatforms, verifyLegacyPlatforms, verifyPlatforms } = require('./ui-platforms.cjs');
const { verifyInteractions } = require('./ui-interactions.cjs');

const root = path.resolve(__dirname, '..');
const output = path.join(root, 'test-results', 'ui');
const scales = [1, 1.25, 1.5];
const names = ['账号', '运营主账号', '超长账号🚀Campaign_2026_ABCDEFGHIJKLMNOPQRSTUVWXYZ_0123456789'];
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
let passed = 0;

function check(label, assertion) {
  assertion();
  passed += 1;
  console.log(`✓ ${label}`);
}

async function eventually(predicate, description, timeout = 12_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(80);
  }
  throw new Error(`Timed out: ${description}`);
}

async function runScale(scale, origin) {
  const checksBefore = passed;
  const testedTargets = [];
  const skippedTargets = [];
  const combinedTargets = [];
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `qiye-ui-${scale}-`));
  const legacy = seedLegacyPlatforms(directory);
  const scaleLabel = `scale-${Math.round(scale * 100)}`;
  let app;
  let shell;
  let currentSize = 'startup';
  let screenshotSequence = 0;
  const prefix = label => `${scaleLabel} ${currentSize}: ${label}`;
  try {
    app = await _electron.launch({
      chromiumSandbox: true,
      args: [
        ...(process.platform === 'linux' ? ['--disable-setuid-sandbox'] : []),
        `--force-device-scale-factor=${scale}`,
        path.join(root, 'tests', 'electron-launch.cjs'),
      ],
      cwd: root,
      env: { ...process.env, QIYE_DATA_DIR: directory },
      timeout: 45_000,
    });
    await eventually(async () => {
      shell = app.windows().find(page => page.url().startsWith('file:') && page.url().endsWith('/renderer/index.html'));
      return Boolean(shell);
    }, 'management shell');
    await shell.waitForFunction(() => Boolean(window.browserAPI?.getState));
    const state = () => shell.evaluate(() => window.browserAPI.getState());
    const key = (type, id) => `[data-focus-key="${type}:${id}"]`;
    const tab = id => `.tab:has(${key('tab', id)})`;
    const screenshot = async label => {
      await shell.screenshot({ path: path.join(output, `${scaleLabel}-${currentSize}-${String(++screenshotSequence).padStart(2, '0')}-${label}.png`) });
    };
    const nativeViews = () => app.evaluate(({ BrowserWindow }) => {
      const main = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/renderer/index.html'));
      return main.contentView.children.filter(view => view.webContents?.profileId).map(view => ({
        id: view.webContents.profileId, visible: view.getVisible(), bounds: view.getBounds(),
      }));
    });
    const viewScript = (id, code) => app.evaluate(({ BrowserWindow }, { id, code }) => {
      const wc = BrowserWindow.getAllWindows().flatMap(window => window.contentView.children)
        .map(view => view.webContents).find(wc => wc?.profileId === id);
      if (!wc || wc.isDestroyed()) throw new Error('Missing local fixture view');
      return wc.executeJavaScript(code);
    }, { id, code });
    const waitForView = id => eventually(async () => {
      const views = await nativeViews();
      if (!views.some(view => view.id === id)) return false;
      return viewScript(id, 'Boolean(window.fixtureReady)');
    }, 'loopback fixture');
    const shortcut = async (id, letter) => {
      await app.evaluate(({ BrowserWindow }, { id, letter }) => {
        const wc = BrowserWindow.getAllWindows().flatMap(window => window.contentView.children)
          .map(view => view.webContents).find(wc => wc?.profileId === id);
        wc.focus();
        wc.sendInputEvent({ type: 'keyDown', keyCode: letter, modifiers: ['control'] });
        if (!wc.isDestroyed()) wc.sendInputEvent({ type: 'keyUp', keyCode: letter, modifiers: ['control'] });
      }, { id, letter });
    };
    const clickable = async selector => {
      const locator = shell.locator(selector);
      await locator.scrollIntoViewIfNeeded();
      const hit = await locator.evaluate(node => {
        const rect = node.getBoundingClientRect();
        const target = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
        return { inside: rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth + 1 && rect.bottom <= innerHeight + 1,
          hit: target === node || node.contains(target), width: rect.width, height: rect.height };
      });
      assert.equal(hit.inside, true, `${selector} must remain reachable inside the window`);
      assert.equal(hit.hit, true, `${selector} center must receive input`);
    };
    const checkDialog = async (dialogId, controls, label) => {
      await shell.locator(`#${dialogId}`).waitFor({ state: 'visible' });
      await eventually(async () => (await nativeViews()).every(view => !view.visible), 'website views hidden behind dialog');
      const outer = await shell.locator(`#${dialogId}`).evaluate(node => {
        const rect = node.getBoundingClientRect();
        return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom,
          width: innerWidth, height: innerHeight, scrollHeight: node.scrollHeight, clientHeight: node.clientHeight };
      });
      assert.ok(outer.left >= -1 && outer.top >= -1 && outer.right <= outer.width + 1 && outer.bottom <= outer.height + 1, `${dialogId} frame must fit`);
      for (const control of controls) {
        const locator = shell.locator(`#${control}`);
        if (control === 'profile-url' && await locator.isDisabled()) {
          await locator.scrollIntoViewIfNeeded();
          const locked = await locator.evaluate(node => {
            const box = node.getBoundingClientRect();
            return { readOnly: node.readOnly, width: box.width, height: box.height,
              inside: box.left >= 0 && box.top >= 0 && box.right <= innerWidth + 1 && box.bottom <= innerHeight + 1 };
          });
          assert.equal(locked.readOnly, true, 'An existing environment URL must be read-only');
          assert.ok(locked.inside && locked.width > 0 && locked.height > 0, 'The locked URL must remain legible inside the editor');
        } else await clickable(`#${control}`);
      }
      check(prefix(`${label} controls can scroll fully into view; native website is hidden`), () => assert.ok(outer.clientHeight > 0));
      await screenshot(label);
      if (outer.scrollHeight > outer.clientHeight + 1) {
        await shell.locator(`#${dialogId}`).evaluate(node => { node.scrollTop = node.scrollHeight; });
        await screenshot(`${label}-bottom`);
      }
    };
    const closeDialog = async buttonId => {
      await shell.locator(`#${buttonId}`).click();
      await eventually(() => shell.evaluate(() => !document.querySelector('dialog[open]')), 'dialog closed');
    };
    const nativeBoundsMatch = async () => {
      await eventually(async () => {
        const activeId = (await state()).activeId;
        const native = (await nativeViews()).find(view => view.id === activeId);
        const dom = await shell.locator('#browser-viewport').evaluate(node => {
          const rect = node.getBoundingClientRect();
          return { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) };
        });
        return native?.visible && ['x', 'y', 'width', 'height'].every(field => Math.abs(native.bounds[field] - dom[field]) <= 1);
      }, 'native content follows DOM viewport');
      const layout = await shell.evaluate(() => {
        const viewport = document.getElementById('browser-viewport').getBoundingClientRect();
        const toolbar = document.querySelector('.navigation-toolbar').getBoundingClientRect();
        const sidebar = document.querySelector('.sidebar').getBoundingClientRect();
        return { noHorizontalPageOverflow: document.documentElement.scrollWidth <= innerWidth + 1,
          toolbarAboveWebsite: toolbar.bottom <= viewport.top + 1,
          sidebarBeforeWebsite: sidebar.right <= viewport.left + 1,
          websiteFitsWindow: viewport.right <= innerWidth + 1 && viewport.bottom <= innerHeight + 1,
          websiteWidth: viewport.width, websiteHeight: viewport.height };
      });
      check(prefix('native website bounds track CSS and leave toolbar/sidebar reachable'), () => {
        assert.ok(layout.noHorizontalPageOverflow);
        assert.ok(layout.toolbarAboveWebsite && layout.sidebarBeforeWebsite && layout.websiteFitsWindow);
        assert.ok(layout.websiteWidth > 0 && layout.websiteHeight > 0);
      });
    };
    const createUI = async (name, route) => {
      await shell.locator('#sidebar-create').click();
      await shell.locator('#profile-name').fill(name);
      await shell.locator('#profile-notes').fill('本地测试备注 · 关闭后持续使用');
      await shell.locator('#profile-url').fill(origin + route);
      await clickable('#profile-save');
      await shell.locator('#profile-save').click();
      await eventually(async () => (await state()).profiles.some(profile => profile.name === name) && !(await shell.locator('#profile-dialog').evaluate(node => node.open)), 'created profile');
      const profile = (await state()).profiles.find(profile => profile.name === name);
      await waitForView(profile.id);
      return profile.id;
    };

    const startup = await app.evaluate(({ app, BrowserWindow, screen }) => {
      const main = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/renderer/index.html'));
      return { workArea: screen.getPrimaryDisplay().workArea, displayScale: screen.getPrimaryDisplay().scaleFactor,
        bounds: main.getBounds(), content: main.getContentBounds(), minimum: main.getMinimumSize(), noSandbox: app.commandLine.hasSwitch('no-sandbox') };
    });
    const dpr = await shell.evaluate(() => devicePixelRatio);
    check(prefix('actual devicePixelRatio matches requested scale and Chromium sandbox remains enabled'), () => {
      assert.ok(Math.abs(dpr - scale) < .02, `requested ${scale}; actual ${dpr}`);
      assert.equal(startup.noSandbox, false);
    });
    check(prefix('initial native window and minimum fit the actual scaled work area'), () => {
      assert.ok(startup.bounds.width <= startup.workArea.width + 2 && startup.bounds.height <= startup.workArea.height + 2);
      assert.ok(startup.minimum[0] <= startup.workArea.width && startup.minimum[1] <= startup.workArea.height);
    });
    console.log(JSON.stringify({ scale, actualDpr: dpr, workArea: startup.workArea, initialWindow: startup.bounds,
      note: 'Real Electron scaling; host OS is recorded, not a claim of physical Windows DPI verification.', platform: process.platform }));
    await shell.locator('.brand-logo').waitFor({ state: 'visible' });
    await eventually(() => shell.locator('.brand-logo').evaluate(node => node.complete && node.naturalWidth > 0), 'real wordmark image loaded');
    const brand = await shell.locator('.brand-logo').evaluate(node => {
      const rect = node.getBoundingClientRect();
      return { naturalWidth: node.naturalWidth, naturalHeight: node.naturalHeight, width: rect.width, height: rect.height };
    });
    check(prefix('real wordmark loads at its original aspect ratio'), () => {
      assert.equal(brand.naturalWidth, 1253);
      assert.equal(brand.naturalHeight, 559);
      assert.ok(Math.abs(brand.width / brand.height - brand.naturalWidth / brand.naturalHeight) < .03);
    });
    await verifyLegacyPlatforms({ shell, state, check, prefix, eventually, directory, legacy });
    await screenshot('overview');

    // Lower only the disposable test window's minimum for the CSS 900×480 case.
    // Production work-area clamping was already asserted above.
    const temporaryMinimum = await app.evaluate(({ BrowserWindow }) => {
      const main = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/renderer/index.html'));
      main.setMinimumSize(0, 0);
      return main.getMinimumSize();
    });
    assert.deepEqual(temporaryMinimum, [0, 0], 'Only the disposable test window minimum is released for the 900×480 CSS check');
    const ids = [];
    for (let index = 0; index < names.length; index += 1) ids.push(await createUI(names[index], `/account-${index}`));
    check(prefix('short, medium and long emoji/ASCII environment names create through the user form'), () => assert.equal(new Set(ids).size, 3));
    const sandboxEvidence = await app.evaluate(({ BrowserWindow }, id) => {
      const wc = BrowserWindow.getAllWindows().flatMap(window => window.contentView.children).map(view => view.webContents).find(wc => wc?.profileId === id);
      return globalThis.__qiyeTestRuntime.renderers.get(wc.id);
    }, ids[0]);
    check(prefix('local fixture renderer reports actual sandbox and context isolation'), () => {
      assert.equal(sandboxEvidence?.sandboxed, true);
      assert.equal(sandboxEvidence?.contextIsolated, true);
    });
    await viewScript(ids[0], "localStorage.setItem('ui-account', 'synthetic-A'); document.cookie = 'uiAccount=A; Max-Age=86400; Path=/'; true");
    const peer = await viewScript(ids[1], "({ value: localStorage.getItem('ui-account'), cookie: document.cookie })");
    check(prefix('simultaneously opened user environments remain independently logged in'), () => {
      assert.equal(peer.value, null);
      assert.equal(peer.cookie.includes('uiAccount='), false);
    });
    for (let index = 0; index < 6; index += 1) {
      await shell.evaluate(input => window.browserAPI.createProfile(input), { name: `同时操作账号 ${index + 1}`, notes: '本地测试', startUrl: `${origin}/extra-${index}` });
    }
    const targets = [
      { width: 1440, height: 900, label: 'desktop' },
      { width: 1024, height: 680, label: 'compact' },
      { width: 900, height: 480, label: 'small' },
      ...(scale === 1.5 ? [{ width: 1280, height: 720, label: 'full-hd-effective-150' }] : []),
    ];
    const seen = new Set();
    for (const target of targets) {
      const frameWidth = Math.max(0, startup.bounds.width - startup.content.width);
      const frameHeight = Math.max(0, startup.bounds.height - startup.content.height);
      const width = Math.min(target.width, startup.workArea.width - frameWidth);
      const height = Math.min(target.height, startup.workArea.height - frameHeight);
      if (width < 600 || height < 350) {
        skippedTargets.push({ label: target.label, requested: { width: target.width, height: target.height }, available: { width, height } });
        console.log(`↷ ${scaleLabel} ${target.label}: work area is too small for the supported layout (${width}×${height}).`);
        continue;
      }
      const sizeKey = `${width}x${height}`;
      if (seen.has(sizeKey)) {
        combinedTargets.push({ label: target.label, actual: { width, height } });
        continue;
      }
      seen.add(sizeKey);
      testedTargets.push({ label: target.label, requested: { width: target.width, height: target.height }, actual: { width, height } });
      currentSize = sizeKey;
      await app.evaluate(({ BrowserWindow }, { width, height, workArea }) => {
        const main = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/renderer/index.html'));
        main.setPosition(workArea.x, workArea.y);
        main.setContentSize(width, height);
      }, { width, height, workArea: startup.workArea });
      await eventually(() => shell.evaluate(({ width, height }) => Math.abs(innerWidth - width) <= 1 && Math.abs(innerHeight - height) <= 1, { width, height }), 'real resized content size');
      console.log(JSON.stringify({ scale, case: target.label, requested: { width: target.width, height: target.height }, actual: { width, height }, monitorClamped: width !== target.width || height !== target.height }));
      await shell.locator(key('tab', ids[0])).click();
      await eventually(async () => (await state()).activeId === ids[0], 'selected short-name tab');
      await nativeBoundsMatch();

      const measure = () => shell.evaluate(ids => ids.map(id => {
        const select = document.querySelector(`[data-focus-key="tab:${id}"]`);
        const tab = select.closest('.tab');
        const close = tab.querySelector('.tab-close');
        const label = select.querySelector('span:last-child');
        const box = tab.getBoundingClientRect();
        const button = close.getBoundingClientRect();
        const text = label.getBoundingClientRect();
        const style = getComputedStyle(label);
        return { id, rightInset: box.right - button.right, buttonWidth: button.width, buttonHeight: button.height,
          labelRight: text.right, closeLeft: button.left, ellipsis: style.textOverflow, overflow: style.overflowX,
          longTextClipped: label.scrollWidth > label.clientWidth + 1, fontSize: parseFloat(style.fontSize) };
      }), ids);
      const before = await measure();
      console.log(JSON.stringify({ scale, viewport: currentSize, tabMeasurements: before.map(item => ({
        nameKind: item.id === ids[0] ? 'short' : item.id === ids[1] ? 'medium' : 'long',
        rightInset: item.rightInset, closeWidth: item.buttonWidth, closeHeight: item.buttonHeight, fontSize: item.fontSize,
      })) }));
      check(prefix('all name lengths reserve the same close area and a usable 28–32 px hit target'), () => {
        assert.ok(Math.max(...before.map(item => item.rightInset)) - Math.min(...before.map(item => item.rightInset)) <= 1);
        for (const item of before) {
          assert.ok(item.buttonWidth >= 27.5 && item.buttonWidth <= 32.5 && item.buttonHeight >= 27.5 && item.buttonHeight <= 32.5);
          assert.ok(item.labelRight <= item.closeLeft + 1, 'label box cannot cover close control');
        }
        assert.equal(before[2].ellipsis, 'ellipsis');
        assert.ok(['hidden', 'clip'].includes(before[2].overflow));
        assert.equal(before[2].longTextClipped, true);
      });
      await shell.locator(tab(ids[1])).hover();
      await shell.locator(key('tab', ids[1])).click();
      const after = await measure();
      check(prefix('hover and active selection do not move close controls'), () => {
        for (let index = 0; index < before.length; index += 1) assert.ok(Math.abs(before[index].rightInset - after[index].rightInset) <= 1);
      });
      await shell.locator('#tab-list').evaluate(node => { node.scrollLeft = 0; });
      const overflow = await shell.locator('#tab-list').evaluate(node => ({ width: node.clientWidth, scrollWidth: node.scrollWidth, left: node.scrollLeft }));
      await shell.locator('#tab-list').hover();
      await shell.mouse.wheel(600, 0);
      await eventually(() => shell.locator('#tab-list').evaluate(node => node.scrollLeft > 1), 'real horizontal tab scrolling');
      check(prefix('many tabs remain horizontally scrollable without overflowing the page'), () => assert.ok(overflow.scrollWidth > overflow.width));
      await screenshot('tabs-browser');

      await shortcut(ids[1], 't');
      await checkDialog('profile-dialog', ['profile-name', 'profile-notes', 'profile-url', 'profile-save', 'profile-dialog-close'], 'create-dialog');
      assert.equal(await shell.locator('#profile-cancel').isVisible(), false, 'Only the close icon dismisses creation');
      await closeDialog('profile-dialog-close');
      await shell.locator(key('edit', ids[2])).click();
      await checkDialog('profile-dialog', ['profile-name', 'profile-notes', 'profile-url', 'profile-delete', 'profile-save', 'profile-cancel'], 'edit-dialog');
      await shell.locator('#profile-delete').click();
      await checkDialog('delete-dialog', ['delete-cancel', 'delete-confirm', 'delete-dialog-close'], 'delete-dialog');
      await closeDialog('delete-cancel');
      const afterDeleteCancel = await state();
      check(prefix('cancelling deletion preserves the saved long-name environment'), () => assert.ok(afterDeleteCancel.profiles.some(profile => profile.id === ids[2])));

      await shell.locator('#login-diagnostics-button').click();
      await checkDialog('diagnostics-dialog', ['diagnostics-start', 'diagnostics-close', 'diagnostics-dialog-close'], 'diagnostics-dialog');
      await closeDialog('diagnostics-close');
      await shell.locator('#data-path-button').click();
      await clickable('#data-path-button');
      const dataPath = await shell.locator('#data-path-detail').textContent();
      check(prefix('saved-data location is reachable and points to the disposable profile directory'), () => assert.ok(dataPath.includes(directory)));
      await shell.locator('#data-path-button').click();
      await nativeBoundsMatch();
    }

    await verifyInputFocus({ shell, state, ids, check, prefix, screenshot, eventually, clickable });
    await verifyPlatforms({ app, shell, state, check, prefix, screenshot, eventually, clickable,
      origin, directory, viewScript, waitForView });
    await verifyInteractions({ app, shell, state, ids, check, prefix, screenshot, eventually, clickable,
      origin, directory, viewScript, waitForView });

    // User flow after the smallest geometry pass: rename, navigation, close and
    // reopen use normal controls. These checks protect data while changing CSS.
    await shell.locator(key('tab', ids[1])).click();
    await shell.locator('#active-settings').click();
    await shell.locator('#profile-name').fill('团队主账号');
    await shell.locator('#profile-notes').fill('修改后的本地备注');
    await shell.locator('#profile-save').click();
    await eventually(async () => (await state()).profiles.find(profile => profile.id === ids[1])?.name === '团队主账号', 'edited name saved');
    const edited = (await state()).profiles.find(profile => profile.id === ids[1]);
    check(prefix('editing through the user dialog retains profile identity'), () => {
      assert.equal(edited.id, ids[1]);
      assert.equal(edited.name, '团队主账号');
      assert.equal(edited.notes, '修改后的本地备注');
    });
    await shell.locator(key('tab', ids[0])).click();
    await shortcut(ids[0], 'l');
    await eventually(() => shell.evaluate(() => document.activeElement.id === 'address-input'), 'Ctrl+L focuses address input');
    await shell.locator('#address-input').fill(`${origin}/saved-page`);
    await shell.locator('#address-input').press('Enter');
    await eventually(async () => (await state()).profiles.find(profile => profile.id === ids[0])?.lastUrl === `${origin}/saved-page`, 'last visited URL saved');
    await waitForView(ids[0]);
    await shortcut(ids[0], 'w');
    await eventually(async () => !(await state()).openTabs.some(tab => tab.id === ids[0]), 'Ctrl+W closes only active tab');
    await shell.locator(key('open', ids[0])).click();
    await waitForView(ids[0]);
    const reopened = await viewScript(ids[0], "({ url: location.href, value: localStorage.getItem('ui-account'), cookie: document.cookie })");
    check(prefix('Ctrl+L/Ctrl+W and reopening preserve account data, environment and last URL'), () => {
      assert.equal(reopened.url, `${origin}/saved-page`);
      assert.equal(reopened.value, 'synthetic-A');
      assert.ok(reopened.cookie.includes('uiAccount=A'));
    });
    assert.ok(seen.size > 0, 'Each device scale must exercise a real layout inside the available work area');
    const closeLocator = shell.locator(key('close', ids[2]));
    await clickable(key('close', ids[2]));
    await closeLocator.click();
    await eventually(async () => !(await state()).openTabs.some(tab => tab.id === ids[2]), 'close icon closes its own tab');
    await shell.locator(key('open', ids[2])).click();
    await waitForView(ids[2]);
    const afterCloseReopen = await state();
    check(prefix('clicking the fixed close target keeps its saved environment reopenable'), () => {
      assert.equal(afterCloseReopen.activeId, ids[2]);
      assert.ok(afterCloseReopen.profiles.some(profile => profile.id === ids[2] && profile.name === names[2]));
      assert.equal(afterCloseReopen.openTabs.filter(tab => tab.id === ids[2]).length, 1);
    });

    await shell.locator('#login-diagnostics-button').click();
    await shell.locator('#diagnostics-start').click();
    await eventually(() => shell.locator('#diagnostics-dialog').evaluate(node => !node.open), 'diagnostics start returns to website');
    await shell.locator('#login-diagnostics-button').click();
    await eventually(() => shell.locator('#diagnostics-stop').isEnabled(), 'diagnostics recording is active');
    await checkDialog('diagnostics-dialog', ['diagnostics-stop', 'diagnostics-save', 'diagnostics-close'], 'diagnostics-recording');
    await shell.locator('#diagnostics-stop').click();
    await eventually(() => shell.locator('#diagnostics-status').textContent().then(text => text.includes('已结束')), 'diagnostics stopped');
    const report = JSON.parse(await shell.locator('#diagnostics-report').textContent());
    check(prefix('diagnostics start/stop and scrollable report stay usable without collecting login credentials'), () => {
      assert.equal(report.running, false);
      assert.ok(report.runtime);
      assert.equal(Object.hasOwn(report, 'har'), false);
    });
    await closeDialog('diagnostics-close');
    await nativeBoundsMatch();
    await screenshot('final-browser');
    return { scale, actualDpr: dpr, workArea: startup.workArea, passed: passed - checksBefore,
      testedTargets, skippedTargets, combinedTargets };
  } catch (error) {
    if (shell && !shell.isClosed()) await shell.screenshot({ path: path.join(output, `${scaleLabel}-${currentSize}-FAILED.png`) }).catch(() => {});
    throw error;
  } finally {
    if (app) await app.close().catch(() => {});
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

async function main() {
  fs.mkdirSync(output, { recursive: true });
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end('<!doctype html><meta charset="utf-8"><title>本地账号页面</title><style>body{font:18px sans-serif;padding:28px;background:#f6f8fc;color:#26324a}</style><h1>本地账号测试页面</h1><p>只验证浏览器界面和临时环境。</p><script>window.fixtureReady=true</script>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const results = [];
    for (const scale of scales) {
      const result = await runScale(scale, origin);
      results.push(result);
      console.log(JSON.stringify({ scaleSummary: result }));
    }
    const skipped = results.reduce((total, result) => total + result.skippedTargets.length, 0);
    const layouts = results.reduce((total, result) => total + result.testedTargets.length, 0);
    console.log(`\n${passed} real-window UI checks passed across ${layouts} distinct layouts at 100%, 125% and 150%; ${skipped} layout requests skipped because the actual work area is too small. Platform: ${process.platform}. Screenshots: ${output}`);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}

main().catch(error => {
  console.error(error);
  // Keep a compact diagnostic last so Windows CI retains the cause when a
  // deepEqual assertion prints a long array diff before this line.
  console.log(JSON.stringify({ uiFailure: { name: error.name, message: String(error.message).slice(0, 500),
    stack: String(error.stack || '').split('\n').filter(line => /^\s+at /.test(line)).slice(0, 6),
    details: error.uiDetails || null } }));
  process.exitCode = 1;
});
