'use strict';

// Run the installed executable without Playwright's Electron loader or switches.
// CDP is confined to loopback and the app uses a fresh, explicit user-data path.
const assert = require('node:assert/strict');
const platformPresets = require('../src/platform-presets.json');
const { ProfileStore } = require('../src/profile-store');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { chromium } = require('playwright-core');

function argumentsFrom(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index];
    if (!['--exe', '--data', '--output'].includes(key) || !values[index + 1] || result[key]) {
      throw new Error('Usage: node tests/windows-installed.cjs --exe <installed.exe> --data <new directory> --output <artifact directory>');
    }
    result[key] = path.resolve(values[index + 1]);
  }
  if (!result['--exe'] || !result['--data'] || !result['--output']) throw new Error('Missing installed application test paths');
  return result;
}

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function freeLoopbackPort() {
  const listener = net.createServer();
  await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve); });
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  return port;
}

async function debugEndpoint(port, instance) {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (instance.finished) throw new Error(`Installed application exited before CDP was available: ${instance.exitCode}\n${instance.logs}`);
    try {
      const result = await new Promise((resolve, reject) => {
        const request = http.get(`http://127.0.0.1:${port}/json/version`, response => {
          let text = '';
          response.setEncoding('utf8');
          response.on('data', data => { text += data; });
          response.on('end', () => {
            try { resolve(JSON.parse(text)); } catch (error) { reject(error); }
          });
        });
        request.setTimeout(1000, () => request.destroy(new Error('CDP not ready')));
        request.on('error', reject);
      });
      if (typeof result.webSocketDebuggerUrl === 'string') {
        const endpoint = new URL(result.webSocketDebuggerUrl);
        assert.ok(endpoint.protocol === 'ws:' && ['127.0.0.1', 'localhost'].includes(endpoint.hostname) && Number(endpoint.port) === port,
          'The debugging endpoint must remain on this loopback port');
        return result.webSocketDebuggerUrl;
      }
    } catch { /* The native browser may still be initializing. */ }
    await delay(150);
  }
  throw new Error(`Installed application did not expose loopback CDP\n${instance.logs}`);
}

async function launch(executable, dataDirectory) {
  const port = await freeLoopbackPort();
  const child = spawn(executable, [`--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1'], {
    cwd: path.dirname(executable), env: { ...process.env, QIYE_DATA_DIR: dataDirectory },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: false,
  });
  const instance = { child, finished: false, exitCode: null, logs: '', browser: null, shell: null };
  const collect = data => { instance.logs = (instance.logs + data.toString()).slice(-16000); };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  instance.exit = new Promise(resolve => {
    child.once('error', error => { instance.logs += error.message; instance.finished = true; resolve(); });
    child.once('exit', code => { instance.exitCode = code; instance.finished = true; resolve(); });
  });
  try {
    instance.browser = await chromium.connectOverCDP(await debugEndpoint(port, instance), { timeout: 30_000 });
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      instance.shell = instance.browser.contexts().flatMap(context => context.pages())
        .find(page => page.url().startsWith('file:') && page.url().endsWith('/renderer/index.html'));
      if (instance.shell) break;
      await delay(100);
    }
    assert.ok(instance.shell, 'The installed account-management window must load');
    await instance.shell.waitForFunction(() => Boolean(window.browserAPI?.getState));
    return instance;
  } catch (error) {
    await cleanupFailedInstance(instance);
    throw error;
  }
}

async function closeNormally(instance) {
  // CloseMainWindow sends WM_CLOSE. The app's ordinary before-quit handler must
  // finish persistence and exit; a terminated process cannot pass this check.
  const command = `$ErrorActionPreference='Stop'; $appProcess=Get-Process -Id ${instance.child.pid}; if (!$appProcess.CloseMainWindow()) { throw 'WM_CLOSE could not reach the application window' }`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8', timeout: 15_000 });
  if (result.error || result.status !== 0) throw new Error(`Could not close the installed app normally: ${result.error?.message || result.stderr || result.stdout}`);
  let deadline;
  try {
    await Promise.race([instance.exit, new Promise((_resolve, reject) => {
      deadline = setTimeout(() => reject(new Error('Installed app did not finish its normal shutdown')), 45_000);
    })]);
  } finally { clearTimeout(deadline); }
  assert.equal(instance.exitCode, 0, `Normal application shutdown failed\n${instance.logs}`);
  await instance.browser.close().catch(() => {});
}

async function cleanupFailedInstance(instance) {
  if (!instance) return;
  if (!instance.finished) {
    try { await closeNormally(instance); }
    catch {
      // Failure cleanup only: this never counts as a successful shutdown test.
      instance.child.kill();
      await Promise.race([instance.exit, delay(5000)]);
    }
  }
  await instance.browser?.close().catch(() => {});
}

async function pageFor(instance, url) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const page = instance.browser.contexts().flatMap(context => context.pages()).find(candidate => candidate.url() === url);
    if (page) {
      await page.waitForFunction(() => Boolean(window.fixtureReady));
      return page;
    }
    await delay(100);
  }
  throw new Error('Installed account environment did not load its local page');
}

async function accountState(page) {
  return page.evaluate(() => ({
    cookie: document.cookie,
    storage: localStorage.getItem('installedAccount'),
    temporary: sessionStorage.getItem('installedAccount'),
    node: typeof require, manager: typeof browserAPI,
  }));
}

function assertAccount(state) {
  assert.match(state.cookie, /(?:^|; )installedAccount=native-preview(?:;|$)/);
  assert.match(state.cookie, /(?:^|; )installedSession=native-preview(?:;|$)/);
  assert.equal(state.storage, 'native-preview');
  assert.equal(state.temporary, 'native-preview');
  assert.equal(state.node, 'undefined');
  assert.equal(state.manager, 'undefined');
}

async function assertLocalPlatformImages(shell) {
  await shell.waitForFunction(presets => presets.every(preset => {
    const option = [...document.querySelectorAll('#platform-presets [data-platform-id]')]
      .find(node => node.dataset.platformId === preset.id);
    const image = option?.querySelector('img');
    return image?.complete && image.naturalWidth > 0 && !image.hidden;
  }), platformPresets);
  const images = await shell.evaluate(() => [...document.querySelectorAll('#platform-presets [data-platform-id]')].map(option => {
    const image = option.querySelector('img');
    return { id: option.dataset.platformId, source: image.currentSrc, width: image.naturalWidth, height: image.naturalHeight };
  }));
  assert.equal(images.length, platformPresets.length);
  for (const preset of platformPresets) {
    const image = images.find(item => item.id === preset.id);
    assert.equal(image.source, new URL(preset.iconResource, shell.url()).href);
    assert.equal(new URL(image.source).protocol, 'file:', 'Platform logos must come from installed local resources');
    assert.ok(image.width > 0 && image.height > 0);
  }
  return images;
}

async function assertPlatformAvatar(shell, id, preset) {
  await shell.waitForFunction(({ id, platformId }) => {
    const control = [...document.querySelectorAll('.profile-open')].find(node => node.dataset.focusKey === `open:${id}`);
    const avatar = control?.querySelector('.profile-icon');
    const image = avatar?.querySelector('img');
    return avatar?.dataset.platformId === platformId && image?.complete && image.naturalWidth > 0;
  }, { id, platformId: preset.id });
  const source = await shell.evaluate(id => [...document.querySelectorAll('.profile-open')]
    .find(node => node.dataset.focusKey === `open:${id}`).querySelector('img').currentSrc, id);
  assert.equal(source, new URL(preset.iconResource, shell.url()).href);
}

async function assertLaunchLocked(shell, id) {
  const result = await shell.evaluate(async id => {
    const before = (await window.browserAPI.getState()).profiles;
    const errors = [];
    for (const change of [{ startUrl: 'https://example.com/forbidden' }, { platformId: 'zhihu' }, { platformId: null }]) {
      try {
        await window.browserAPI.updateProfile(id, { ...change, name: '不应保存的名称' });
        errors.push(null);
      } catch (error) { errors.push(error.message); }
    }
    return { before, after: (await window.browserAPI.getState()).profiles, errors };
  }, id);
  assert.ok(result.errors.every(message => typeof message === 'string' && /不可修改/.test(message)), 'Installed IPC must reject launch configuration changes');
  assert.deepEqual(result.after, result.before, 'A rejected edit must preserve every profile and its metadata');
}

async function assertInstalledCreationLayout(shell, accountPage, outputDirectory) {
  const before = await shell.evaluate(() => window.browserAPI.getState());
  await accountPage.evaluate(() => {
    window.__installedModalClicks = 0;
    window.__installedModalClickListener = () => { window.__installedModalClicks += 1; };
    document.addEventListener('click', window.__installedModalClickListener, true);
  });
  const measure = () => shell.evaluate(() => {
    const rect = id => {
      const box = document.getElementById(id).getBoundingClientRect();
      return { left: box.left, top: box.top, right: box.right, bottom: box.bottom, width: box.width, height: box.height };
    };
    const hit = id => {
      const node = document.getElementById(id), box = node.getBoundingClientRect();
      const target = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
      return target === node || node.contains(target);
    };
    const dialog = document.getElementById('profile-dialog'), body = document.getElementById('profile-dialog-body');
    const probe = document.createElement('span');
    probe.style.cssText = 'position:fixed;visibility:hidden;color:var(--brand)';
    document.body.append(probe);
    const brand = getComputedStyle(probe).color;
    probe.remove();
    return { viewport: { width: innerWidth, height: innerHeight }, dialog: rect('profile-dialog'),
      header: rect('profile-dialog-header'), body: rect('profile-dialog-body'), footer: rect('profile-dialog-footer'),
      title: rect('profile-dialog-title'), close: rect('profile-dialog-close'), save: rect('profile-save'), tip: rect('new-profile-tip'),
      scroll: { outer: dialog.scrollTop, outerHeight: dialog.clientHeight, outerContent: dialog.scrollHeight,
        body: body.scrollTop, bodyHeight: body.clientHeight, bodyContent: body.scrollHeight },
      overflow: { outer: getComputedStyle(dialog).overflowY, body: getComputedStyle(body).overflowY },
      closeHit: hit('profile-dialog-close'), saveHit: hit('profile-save'),
      primary: { background: getComputedStyle(document.getElementById('profile-save')).backgroundColor,
        text: getComputedStyle(document.getElementById('profile-save')).color, brand },
    };
  });
  try {
    await shell.locator('#sidebar-create').click();
    await shell.locator('#profile-dialog').waitFor({ state: 'visible' });
    await shell.waitForFunction(() => document.activeElement.id === 'profile-name' && document.getElementById('profile-dialog-body').scrollTop <= 1);
    const top = await measure();
    assert.ok(top.dialog.height <= top.viewport.height * .9 + 2 && top.dialog.top >= 15 && top.dialog.bottom <= top.viewport.height - 15);
    assert.ok(['hidden', 'clip'].includes(top.overflow.outer) && ['auto', 'scroll'].includes(top.overflow.body));
    assert.equal(top.scroll.outer, 0);
    assert.ok(top.scroll.outerContent <= top.scroll.outerHeight + 2, 'The installed modal cannot have an outer scrollbar');
    assert.ok(top.header.bottom <= top.body.top + 1 && top.body.bottom <= top.footer.top + 1);
    assert.equal(top.primary.background, top.primary.brand);
    assert.equal(top.primary.text, 'rgb(255, 255, 255)');
    assert.ok(top.close.width >= 33 && top.close.height >= 33 && top.save.height >= 39);
    assert.ok(top.closeHit && top.saveHit);

    // This is real CDP mouse input at a point overlapping the native website
    // view's normal bounds. If that view stays above the shell, the website
    // receives the click and the manager textarea cannot receive focus.
    const overlap = await shell.locator('#profile-notes').evaluate(node => {
      const box = node.getBoundingClientRect(), website = document.getElementById('browser-viewport').getBoundingClientRect();
      const x = box.x + box.width / 2, y = box.y + box.height / 2;
      return x > website.left && x < website.right && y > website.top && y < website.bottom;
    });
    assert.equal(overlap, true, 'The installed modal pointer check must overlap the native website area');
    await shell.locator('#profile-notes').click();
    await shell.waitForFunction(() => document.activeElement.id === 'profile-notes');
    assert.equal(await accountPage.evaluate(() => window.__installedModalClicks), 0, 'The native website must not intercept a modal click');
    await shell.locator('#profile-dialog-body').evaluate(node => { node.scrollTop = node.scrollHeight; });
    await shell.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const bottom = await measure();
    for (const region of ['header', 'footer', 'title', 'close', 'save']) {
      for (const edge of ['left', 'top', 'right', 'bottom']) {
        assert.ok(Math.abs(bottom[region][edge] - top[region][edge]) <= 1.1, `Installed ${region}.${edge} cannot move when the form scrolls`);
      }
    }
    assert.ok(bottom.closeHit && bottom.saveHit, 'Both installed controls remain clickable at the form bottom');
    assert.equal(bottom.scroll.outer, 0);
    assert.ok(bottom.tip.top >= bottom.body.top - 1 && bottom.tip.bottom <= bottom.body.bottom + 1 && bottom.tip.bottom <= bottom.footer.top + 1,
      'The installed modal must expose its complete final explanation above the footer');
    if (bottom.scroll.bodyContent > bottom.scroll.bodyHeight + 1) {
      assert.ok(bottom.scroll.body >= bottom.scroll.bodyContent - bottom.scroll.bodyHeight - 1, 'The middle body reaches its genuine bottom');
    }
    await shell.screenshot({ path: path.join(outputDirectory, 'installed-creation-fixed-actions.png') });
    await shell.locator('#profile-dialog-close').click();
    await shell.waitForFunction(() => !document.getElementById('profile-dialog').open);
    const after = await shell.evaluate(() => window.browserAPI.getState());
    assert.deepEqual(after.profiles, before.profiles, 'Testing installed modal layout must not create or edit an environment');
    assert.equal(after.activeId, before.activeId);
    assert.deepEqual(after.openTabs.map(tab => tab.id), before.openTabs.map(tab => tab.id));
    return { top, bottom, nativeWebsitePointerBlocked: true };
  } finally {
    await accountPage.evaluate(() => {
      document.removeEventListener('click', window.__installedModalClickListener, true);
      delete window.__installedModalClickListener;
      delete window.__installedModalClicks;
    }).catch(() => {});
  }
}

async function main() {
  if (process.platform !== 'win32' || process.env.GITHUB_ACTIONS !== 'true' || !process.env.RUNNER_TEMP) {
    throw new Error('This installation smoke test runs only on an ephemeral GitHub Windows runner');
  }
  const options = argumentsFrom(process.argv.slice(2));
  const executable = options['--exe'];
  const dataDirectory = options['--data'];
  const outputDirectory = options['--output'];
  const runnerRoot = path.resolve(process.env.RUNNER_TEMP);
  for (const directory of [path.dirname(executable), dataDirectory, outputDirectory]) {
    const relative = path.relative(runnerRoot, directory);
    assert.ok(relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative), 'Test paths must remain inside RUNNER_TEMP');
  }
  assert.equal(fs.existsSync(dataDirectory), false, 'Use a new directory rather than overwriting existing browser data');
  fs.mkdirSync(outputDirectory, { recursive: true });
  const wordmark = fs.readFileSync(path.join(__dirname, '..', 'src', 'assets', 'qiye-wordmark.png'));
  assert.equal(wordmark.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  const expectedBrand = { width: wordmark.readUInt32BE(16), height: wordmark.readUInt32BE(20) };
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end('<!doctype html><meta charset="utf-8"><title>Installed browser fixture</title><script>window.fixtureReady=true</script><h1>Local installed account check</h1>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const fixtureUrl = `http://127.0.0.1:${server.address().port}/account`;
  // A closed, previously saved platform environment exercises upgrade loading
  // without issuing any real platform request. Its last page remains loopback.
  const preset = platformPresets.find(item => item.id === 'douyin');
  const seedStore = new ProfileStore(dataDirectory);
  const platformProfile = seedStore.create({ name: '安装检查 · 已有平台', platformId: preset.id });
  seedStore.touchUrl(platformProfile.id, fixtureUrl);
  let instance;
  try {
    instance = await launch(executable, dataDirectory);
    const shell = instance.shell;
    await shell.waitForFunction(() => { const image = document.querySelector('.brand-logo'); return image?.complete && image.naturalWidth > 0; });
    const brand = await shell.evaluate(() => {
      const image = document.querySelector('.brand-logo');
      const rect = image.getBoundingClientRect();
      return { width: image.naturalWidth, height: image.naturalHeight, displayWidth: rect.width, displayHeight: rect.height,
        clipped: rect.right > innerWidth || rect.bottom > innerHeight, webdriver: navigator.webdriver, source: image.currentSrc };
    });
    assert.deepEqual({ width: brand.width, height: brand.height }, expectedBrand);
    assert.ok(brand.displayWidth > 0 && brand.displayHeight > 0 && !brand.clipped);
    assert.ok(Math.abs((brand.displayWidth / brand.displayHeight) / (brand.width / brand.height) - 1) < 0.01, 'The packaged brand image must retain its original aspect ratio');
    assert.equal(brand.webdriver, false, 'This installed smoke test must not load Playwright Electron automation switches');
    assert.match(brand.source, /\/assets\/qiye-wordmark\.png$/);
    const platformImages = await assertLocalPlatformImages(shell);
    await assertPlatformAvatar(shell, platformProfile.id, preset);
    await assertLaunchLocked(shell, platformProfile.id);
    await shell.screenshot({ path: path.join(outputDirectory, 'installed-startup.png') });
    const created = await shell.evaluate(startUrl => window.browserAPI.createProfile({ name: '安装检查', notes: 'Local native app fixture', startUrl }), fixtureUrl);
    assert.equal(created.profiles.length, 2);
    const id = created.profiles.find(profile => profile.name === '安装检查').id;
    let accountPage = await pageFor(instance, fixtureUrl);
    await accountPage.evaluate(() => {
      document.cookie = 'installedAccount=native-preview; Max-Age=86400; Path=/; SameSite=Lax';
      document.cookie = 'installedSession=native-preview; Path=/; SameSite=Lax';
      localStorage.setItem('installedAccount', 'native-preview');
      sessionStorage.setItem('installedAccount', 'native-preview');
    });
    const creationLayout = await assertInstalledCreationLayout(shell, accountPage, outputDirectory);
    const edited = await shell.evaluate(id => window.browserAPI.updateProfile(id, { name: '安装检查 · 已编辑', notes: 'Saved local note' }), id);
    assert.equal(edited.profiles.find(profile => profile.id === id).name, '安装检查 · 已编辑');
    assert.equal(edited.profiles.find(profile => profile.id === id).notes, 'Saved local note');
    await assertLaunchLocked(shell, id);
    const moved = await shell.evaluate(({ id, beforeId }) => window.browserAPI.moveProfile(id, beforeId), { id, beforeId: platformProfile.id });
    assert.deepEqual(moved.profiles.map(profile => profile.id), [id, platformProfile.id]);
    assert.deepEqual(moved.openTabs.map(tab => tab.id), [id]);
    assert.equal(moved.activeId, id);
    assert.equal(moved.profiles[1].platformId, preset.id);
    assert.equal(moved.profiles[1].startUrl, preset.launchUrl);
    await shell.evaluate(id => window.browserAPI.closeProfile(id), id);
    const closed = await shell.evaluate(() => window.browserAPI.getState());
    assert.equal(closed.openTabs.length, 0);
    assert.equal(closed.profiles.length, 2);
    await shell.evaluate(id => window.browserAPI.openProfile(id), id);
    accountPage = await pageFor(instance, fixtureUrl);
    assertAccount(await accountState(accountPage));
    await accountPage.evaluate(url => { window.open(url, '_blank'); }, fixtureUrl.replace('/account', '/popup'));
    const popup = await pageFor(instance, fixtureUrl.replace('/account', '/popup'));
    const popupIdentity = await popup.evaluate(() => ({ cookie: document.cookie, node: typeof require, manager: typeof browserAPI }));
    assert.match(popupIdentity.cookie, /installedAccount=native-preview/);
    assert.equal(popupIdentity.node, 'undefined');
    assert.equal(popupIdentity.manager, 'undefined');
    await popup.close();
    await closeNormally(instance);
    instance = null;

    const manifest = JSON.parse(fs.readFileSync(path.join(dataDirectory, 'profiles.json'), 'utf8'));
    assert.equal(manifest.profiles[0].id, id);
    assert.equal(manifest.profiles[0].name, '安装检查 · 已编辑');
    assert.equal(manifest.profiles[0].notes, 'Saved local note');
    assert.deepEqual(manifest.profiles.map(profile => profile.id), [id, platformProfile.id]);
    assert.equal(Object.hasOwn(manifest.profiles[0], 'platformId'), false);
    assert.equal(manifest.profiles[0].startUrl, fixtureUrl);
    assert.equal(manifest.profiles[1].platformId, preset.id);
    assert.equal(manifest.profiles[1].startUrl, preset.launchUrl);
    instance = await launch(executable, dataDirectory);
    const restored = await instance.shell.evaluate(() => window.browserAPI.getState());
    assert.equal(restored.profiles.length, 2);
    assert.deepEqual(restored.profiles.map(profile => profile.id), [id, platformProfile.id]);
    assert.equal(restored.profiles[0].startUrl, fixtureUrl);
    assert.equal(Object.hasOwn(restored.profiles[0], 'platformId'), false);
    assert.equal(restored.profiles[1].platformId, preset.id);
    assert.equal(restored.profiles[1].startUrl, preset.launchUrl);
    assert.equal(restored.openTabs.length, 1);
    await assertLocalPlatformImages(instance.shell);
    await assertPlatformAvatar(instance.shell, platformProfile.id, preset);
    await assertLaunchLocked(instance.shell, id);
    await assertLaunchLocked(instance.shell, platformProfile.id);
    const sidebarOrder = await instance.shell.evaluate(() => [...document.querySelectorAll('.profile-open')].map(node => node.dataset.focusKey.slice('open:'.length)));
    assert.deepEqual(sidebarOrder, [id, platformProfile.id]);
    assertAccount(await accountState(await pageFor(instance, fixtureUrl)));
    await instance.shell.screenshot({ path: path.join(outputDirectory, 'installed-restored.png') });
    await closeNormally(instance);
    instance = null;
    fs.writeFileSync(path.join(outputDirectory, 'installed-check.json'), JSON.stringify({
      passed: true, brand: expectedBrand, closeMethod: 'WM_CLOSE',
      nativeElectronLaunch: true, profileCreatedEditedReopenedAndRestarted: true,
      persistentAndSessionCookiesRestored: true, localAndSessionStorageRestored: true,
      localPlatformImageCount: platformImages.length, platformAssociationAndIconRestored: true,
      profileOrderRestored: true, launchConfigurationLocked: true,
      fixedCreationHeaderAndFooter: true, creationLayout,
    }, null, 2));
    console.log('Installed Windows native launch, original brand ratio, fixed creation header/footer, account persistence, popup session inheritance and normal WM_CLOSE shutdown passed.');
  } finally {
    await cleanupFailedInstance(instance);
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
