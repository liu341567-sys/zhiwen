'use strict';

// Run the installed executable without Playwright's Electron loader or switches.
// CDP is confined to loopback and the app uses a fresh, explicit user-data path.
const assert = require('node:assert/strict');
const platformPresets = require('../src/platform-presets.json');
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
    await shell.screenshot({ path: path.join(outputDirectory, 'installed-startup.png') });
    const created = await shell.evaluate(startUrl => window.browserAPI.createProfile({ name: '安装检查', notes: 'Local native app fixture', startUrl }), fixtureUrl);
    assert.equal(created.profiles.length, 1);
    const id = created.profiles[0].id;
    let accountPage = await pageFor(instance, fixtureUrl);
    await accountPage.evaluate(() => {
      document.cookie = 'installedAccount=native-preview; Max-Age=86400; Path=/; SameSite=Lax';
      document.cookie = 'installedSession=native-preview; Path=/; SameSite=Lax';
      localStorage.setItem('installedAccount', 'native-preview');
      sessionStorage.setItem('installedAccount', 'native-preview');
    });
    const edited = await shell.evaluate(id => window.browserAPI.updateProfile(id, { name: '安装检查 · 已编辑', notes: 'Saved local note' }), id);
    assert.equal(edited.profiles[0].name, '安装检查 · 已编辑');
    assert.equal(edited.profiles[0].notes, 'Saved local note');
    // Associate an existing loopback environment without changing lastUrl or
    // issuing real platform login requests. Restart must retain both metadata
    // and the original account session while the packaged logo stays local.
    const preset = platformPresets.find(item => item.id === 'douyin');
    const associated = await shell.evaluate(({ id, platformId }) => window.browserAPI.updateProfile(id, { platformId }), { id, platformId: preset.id });
    assert.equal(associated.profiles[0].platformId, preset.id);
    assert.equal(associated.profiles[0].startUrl, preset.launchUrl);
    assert.equal(associated.profiles[0].lastUrl, fixtureUrl);
    await assertPlatformAvatar(shell, id, preset);
    await shell.evaluate(id => window.browserAPI.closeProfile(id), id);
    const closed = await shell.evaluate(() => window.browserAPI.getState());
    assert.equal(closed.openTabs.length, 0);
    assert.equal(closed.profiles.length, 1);
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
    assert.equal(manifest.profiles[0].platformId, preset.id);
    assert.equal(manifest.profiles[0].startUrl, preset.launchUrl);
    instance = await launch(executable, dataDirectory);
    const restored = await instance.shell.evaluate(() => window.browserAPI.getState());
    assert.equal(restored.profiles.length, 1);
    assert.equal(restored.profiles[0].id, id);
    assert.equal(restored.profiles[0].platformId, preset.id);
    assert.equal(restored.profiles[0].startUrl, preset.launchUrl);
    assert.equal(restored.openTabs.length, 1);
    await assertLocalPlatformImages(instance.shell);
    await assertPlatformAvatar(instance.shell, id, preset);
    assertAccount(await accountState(await pageFor(instance, fixtureUrl)));
    await instance.shell.screenshot({ path: path.join(outputDirectory, 'installed-restored.png') });
    await closeNormally(instance);
    instance = null;
    fs.writeFileSync(path.join(outputDirectory, 'installed-check.json'), JSON.stringify({
      passed: true, brand: expectedBrand, closeMethod: 'WM_CLOSE',
      nativeElectronLaunch: true, profileCreatedEditedReopenedAndRestarted: true,
      persistentAndSessionCookiesRestored: true, localAndSessionStorageRestored: true,
      localPlatformImageCount: platformImages.length, platformAssociationAndIconRestored: true,
    }, null, 2));
    console.log('Installed Windows native launch, original brand ratio, account persistence, popup session inheritance and normal WM_CLOSE shutdown passed.');
  } finally {
    await cleanupFailedInstance(instance);
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
