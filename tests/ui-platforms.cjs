'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ProfileStore } = require('../src/profile-store.js');

function seedLegacyPlatforms(directory) {
  const presets = require('../src/platform-presets.json');
  const store = new ProfileStore(directory);
  const custom = store.create({ name: '旧版自定义账号', notes: 'Synthetic legacy fixture', startUrl: presets[0].launchUrl });
  const unknown = store.create({ name: '未知平台旧账号', notes: 'Synthetic unknown platform fixture', startUrl: presets[8].launchUrl });
  const filename = path.join(directory, 'profiles.json');
  const manifest = JSON.parse(fs.readFileSync(filename, 'utf8'));
  const saved = manifest.profiles.find(profile => profile.id === unknown.id);
  saved.platformId = 'future-platform-fixture';
  // A valid but deliberately noncanonical URL tests preservation on rename.
  saved.startUrl = 'https://www.zhihu.com:443/signin?next=%2f';
  saved.lastUrl = saved.startUrl;
  fs.writeFileSync(filename, `${JSON.stringify(manifest, null, 2)}\n`);
  return { custom, unknown: { ...saved } };
}

async function verifyLegacyPlatforms(context) {
  const { shell, state, check, prefix, eventually, directory, legacy } = context;
  const key = (type, id) => `[data-focus-key="${type}:${id}"]`;
  const current = await state();
  const icons = await shell.evaluate(ids => ids.map(id => {
    const icon = document.querySelector(`[data-focus-key="open:${id}"] .profile-icon`);
    return { id, text: icon.textContent, hasImage: Boolean(icon.querySelector('img')) };
  }), [legacy.custom.id, legacy.unknown.id]);
  check(prefix('loaded custom and unknown platform profiles retain default avatars without URL inference'), () => {
    assert.equal(current.openTabs.length, 0);
    assert.equal(current.profiles.find(profile => profile.id === legacy.unknown.id).platformId, legacy.unknown.platformId);
    assert.deepEqual(icons.map(icon => icon.hasImage), [false, false]);
    assert.deepEqual(icons.map(icon => icon.text), [Array.from(legacy.custom.name)[0], Array.from(legacy.unknown.name)[0]]);
  });
  await shell.locator(key('edit', legacy.custom.id)).click();
  await shell.locator('#profile-dialog').waitFor({ state: 'visible' });
  const custom = await shell.evaluate(() => ({ checked: document.getElementById('custom-platform').checked,
    hidden: document.getElementById('profile-url-field').hidden, readOnly: document.getElementById('profile-url').readOnly,
    disabled: document.getElementById('profile-url').disabled,
    platformsDisabled: [...document.querySelectorAll('#profile-dialog input[name="platform"]')].every(input => input.disabled),
    url: document.getElementById('profile-url').value }));
  check(prefix('a legacy URL matching a preset stays custom, with launch settings locked after upgrade'), () => {
    assert.equal(custom.checked, true);
    assert.equal(custom.hidden, false);
    assert.equal(custom.readOnly, true);
    assert.equal(custom.disabled, true);
    assert.equal(custom.platformsDisabled, true);
    assert.equal(custom.url, legacy.custom.startUrl);
  });
  await shell.locator('#profile-cancel').click();
  await eventually(() => shell.locator('#profile-dialog').evaluate(node => !node.open), 'legacy custom dialog cancelled');
  await shell.locator(key('edit', legacy.unknown.id)).click();
  await shell.locator('#profile-dialog').waitFor({ state: 'visible' });
  await shell.locator('#profile-name').fill('未知平台改名后');
  await shell.locator('#profile-notes').fill('Updated synthetic legacy note');
  await shell.locator('#profile-save').click();
  await eventually(() => shell.locator('#profile-dialog').evaluate(node => !node.open), 'legacy rename saved');
  const renamed = (await state()).profiles.find(profile => profile.id === legacy.unknown.id);
  const saved = JSON.parse(fs.readFileSync(path.join(directory, 'profiles.json'), 'utf8')).profiles.find(profile => profile.id === legacy.unknown.id);
  check(prefix('renaming and editing notes preserve unknown saved platform metadata and the original raw URL'), () => {
    assert.equal(renamed.name, '未知平台改名后');
    assert.equal(renamed.notes, 'Updated synthetic legacy note');
    for (const record of [renamed, saved]) {
      assert.equal(record.id, legacy.unknown.id);
      assert.equal(record.platformId, legacy.unknown.platformId);
      assert.equal(record.startUrl, legacy.unknown.startUrl);
      assert.equal(record.lastUrl, legacy.unknown.lastUrl);
    }
  });
  for (const id of [legacy.custom.id, legacy.unknown.id]) await shell.evaluate(id => window.browserAPI.deleteProfile(id), id);
  await eventually(() => shell.locator('.profile-row').count().then(count => count === 0), 'legacy fixtures removed before the existing UI flow');
}

// Runs once in each real, sandboxed Electron scale from ui-layout.cjs. Only
// exact preset entry URLs are redirected, inside this disposable test app.
async function verifyPlatforms(context) {
  const { app, shell, state, check, prefix, screenshot, eventually, clickable,
    origin, directory, viewScript, waitForView } = context;
  const initial = await state();
  const presets = initial.platformPresets;
  assert.equal(presets.length, 9, 'Nine documented platform choices must reach the management shell');
  const created = [];
  const key = (type, id) => `[data-focus-key="${type}:${id}"]`;
  const option = id => `#platform-presets [data-platform-id="${id}"]`;
  const avatar = id => `.profile-row:has(${key('open', id)}) .profile-icon`;
  const profile = async id => (await state()).profiles.find(item => item.id === id);
  const dialogClosed = () => eventually(() => shell.locator('#profile-dialog').evaluate(node => !node.open), 'platform dialog closed');
  const openCreate = async () => {
    await shell.locator('#sidebar-create').click();
    await shell.locator('#profile-dialog').waitFor({ state: 'visible' });
  };
  const choose = async id => {
    await clickable(option(id));
    await shell.locator(`${option(id)} input`).check();
  };
  const selection = () => shell.evaluate(() => ({
    checked: [...document.querySelectorAll('#profile-dialog input[name="platform"]:checked')].map(input => input.value),
    url: document.getElementById('profile-url').value,
    hidden: document.getElementById('profile-url-field').hidden,
    readOnly: document.getElementById('profile-url').readOnly,
    disabled: document.getElementById('profile-url').disabled,
    platformsDisabled: [...document.querySelectorAll('#profile-dialog input[name="platform"]')].every(input => input.disabled),
    willValidate: document.getElementById('profile-url').willValidate,
  }));
  const save = async () => {
    await clickable('#profile-save');
    await shell.locator('#profile-save').click();
    await dialogClosed();
  };
  const edit = async id => {
    await shell.locator(key('edit', id)).click();
    await shell.locator('#profile-dialog').waitFor({ state: 'visible' });
  };
  const hasImage = async (id, preset) => {
    let actual;
    await eventually(async () => {
      actual = await shell.locator(avatar(id)).evaluate((node, preset) => {
        const image = node.querySelector('img');
        const box = node.getBoundingClientRect();
        return { loaded: Boolean(image?.complete && image.naturalWidth > 0 && !image.hidden),
          platformId: node.dataset.platformId, src: image?.currentSrc,
          expectedSrc: new URL(preset.iconResource, location.href).href, connected: node.isConnected,
          width: box.width, height: box.height };
      }, preset);
      return actual.loaded && actual.platformId === preset.id && actual.src === actual.expectedSrc && actual.connected && actual.width === 36 && actual.height === 36;
    }, 'saved platform avatar loaded');
    assert.equal(actual.platformId, preset.id);
    assert.equal(actual.src, actual.expectedSrc);
    assert.equal(new URL(actual.src).protocol, 'file:');
    assert.equal(actual.connected, true);
    assert.equal(actual.width, 36);
    assert.equal(actual.height, 36);
  };
  const palette = () => shell.evaluate(() => {
    const create = getComputedStyle(document.getElementById('sidebar-create'));
    const row = document.querySelector('.profile-row.active');
    const selected = row && getComputedStyle(row);
    return { createColor: create.color, createBackground: create.backgroundColor,
      selectedBackground: selected?.backgroundColor, selectedBorder: selected?.borderColor,
      selectedNameColor: row && getComputedStyle(row.querySelector('.profile-name')).color,
      selectedStatusColor: row && getComputedStyle(row.querySelector('.profile-meta')).color };
  });
  const settledPalette = async () => {
    await shell.mouse.move(0, 0);
    await palette(); // Flush styles so any pointer-leave transition is known.
    await shell.evaluate(async () => {
      const nodes = [document.getElementById('sidebar-create'), document.querySelector('.profile-row.active')];
      await Promise.all(nodes.flatMap(node => node ? node.getAnimations().map(animation => animation.finished.catch(() => {})) : []));
    });
    return palette();
  };
  const originalPalette = await settledPalette();

  await app.evaluate(({ session }, { presets, origin }) => {
    const previous = session.fromPartition;
    const test = { previous, sessions: new Set(), records: [], unexpected: [] };
    const byUrl = new Map(presets.map(preset => [preset.launchUrl, preset.id]));
    globalThis.__qiyePlatformUITest = test;
    session.fromPartition = (...args) => {
      const own = previous(...args);
      if (String(args[0]).startsWith('persist:account-') && !test.sessions.has(own)) {
        test.sessions.add(own);
        const profileId = String(args[0]).slice('persist:account-'.length);
        own.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
          const platformId = byUrl.get(details.url);
          if (platformId && details.resourceType === 'mainFrame') {
            test.records.push({ profileId, platformId, url: details.url });
            callback({ redirectURL: `${origin}/preset-${platformId}` });
          } else {
            const url = new URL(details.url);
            if (['http:', 'https:'].includes(url.protocol) && url.origin !== origin) {
              test.unexpected.push({ profileId, url: details.url, resourceType: details.resourceType });
              callback({ cancel: true });
            } else callback({});
          }
        });
      }
      return own;
    };
  }, { presets, origin });

  try {
    await openCreate();
    await eventually(() => shell.locator('#platform-presets img').evaluateAll(images => images.length === 9 &&
      images.every(image => image.complete && image.naturalWidth > 0 && !image.hidden)), 'all nine local platform images loaded');
    const grid = await shell.locator('#platform-presets').evaluate((node, presets) => [...node.children].map((label, index) => {
      const image = label.querySelector('img');
      const input = label.querySelector('input');
      const box = label.getBoundingClientRect();
      return { id: label.dataset.platformId, text: label.innerText.trim(), type: input.type,
        src: image.currentSrc, expectedSrc: new URL(presets[index].iconResource, location.href).href,
        x: Math.round(box.x), y: Math.round(box.y), width: box.width, height: box.height };
    }), presets);
    check(prefix('nine platform options form a 3×3 grid with local loaded icons and short labels only'), () => {
      assert.equal(grid.length, 9);
      assert.equal(new Set(grid.map(item => item.x)).size, 3);
      assert.equal(new Set(grid.map(item => item.y)).size, 3);
      for (let index = 0; index < presets.length; index += 1) {
        assert.equal(grid[index].id, presets[index].id);
        assert.equal(grid[index].text, presets[index].displayName);
        assert.equal(grid[index].type, 'radio');
        assert.equal(grid[index].src, grid[index].expectedSrc);
        assert.equal(new URL(grid[index].src).protocol, 'file:');
        assert.ok(grid[index].width > 0 && grid[index].height > 0);
      }
    });
    const start = await selection();
    check(prefix('new custom environments keep the default editable URL without inferring a platform'), () => {
      assert.deepEqual(start.checked, ['custom']);
      assert.equal(start.hidden, false);
      assert.equal(start.readOnly, false);
      assert.equal(start.willValidate, true);
      assert.equal(new URL(start.url).href, 'https://www.douyin.com/');
    });
    const customDraft = `${origin}/platform-custom-draft`;
    await shell.locator('#profile-url').fill(customDraft);
    for (const preset of presets) {
      await choose(preset.id);
      const current = await selection();
      assert.deepEqual(current.checked, [preset.id], 'Selecting a preset must uncheck every other radio');
      assert.equal(current.url, preset.launchUrl, 'The hidden URL must retain the canonical raw launch string');
      assert.equal(current.hidden, true);
      assert.equal(current.readOnly, true);
      assert.equal(current.willValidate, false, 'A hidden preset URL must not interfere with native form validation');
    }
    await clickable('#custom-platform');
    await shell.locator('#custom-platform').check();
    assert.equal((await selection()).url, customDraft);
    assert.equal((await selection()).hidden, false);
    check(prefix('all nine choices are reachable and exclusively selected; custom draft survives switching'), () => assert.deepEqual((grid.map(item => item.id)), presets.map(item => item.id)));

    await choose(presets[0].id);
    await shell.locator('#profile-notes').click();
    await shell.keyboard.press('Tab');
    await eventually(() => shell.evaluate(() => document.activeElement === document.querySelector('#platform-presets input:checked')), 'Tab reaches the selected native platform radio');
    await shell.keyboard.press('ArrowRight');
    const keyboard = await selection();
    const ring = await shell.locator(`${option(presets[1].id)} .platform-preset-content`).evaluate(node => {
      const input = node.previousElementSibling;
      const style = getComputedStyle(node);
      const probe = document.createElement('span');
      probe.style.cssText = 'position:fixed;visibility:hidden;color:var(--focus)';
      document.body.append(probe);
      const expectedColor = getComputedStyle(probe).color;
      probe.remove();
      return { width: parseFloat(style.outlineWidth), style: style.outlineStyle, color: style.outlineColor,
        expectedColor, focusVisible: input.matches(':focus-visible'), actuallyFocused: document.activeElement === input };
    });
    check(prefix('native Tab and arrow keys change the single platform selection with a visible keyboard focus ring'), () => {
      assert.deepEqual(keyboard.checked, [presets[1].id]);
      assert.equal(keyboard.url, presets[1].launchUrl);
      // Fractional DPR rounds 2 CSS px to 1.6 px at 125% in Chromium.
      assert.ok(ring.width >= 1 && ring.style !== 'none');
      assert.equal(ring.color, ring.expectedColor);
      assert.equal(ring.focusVisible, true);
      assert.equal(ring.actuallyFocused, true);
    });
    await shell.locator('#custom-platform').check();
    await shell.locator('#profile-name').fill('平台预设甲');
    await shell.locator('#profile-url').fill('javascript:alert(1)');
    await shell.locator('#profile-save').click();
    await shell.locator('#profile-form-error').waitFor({ state: 'visible' });
    const invalid = await state();
    check(prefix('custom URL validation keeps an invalid scheme in the dialog without creating an environment'), () => {
      assert.equal(invalid.profiles.length, initial.profiles.length);
    });
    await choose(presets[0].id);
    await screenshot('platform-presets-selected');
    await save();
    const first = (await state()).profiles.find(item => item.name === '平台预设甲');
    assert.ok(first, 'Preset creation must produce a saved environment');
    created.push(first.id);
    await waitForView(first.id);
    await hasImage(first.id, presets[0]);
    const firstNavigation = await app.evaluate(() => globalThis.__qiyePlatformUITest.records);
    check(prefix('preset creation saves its identity and raw entry URL, and first navigation uses that exact URL'), () => {
      assert.equal(first.platformId, presets[0].id);
      assert.equal(first.startUrl, presets[0].launchUrl);
      assert.deepEqual(firstNavigation.filter(item => item.profileId === first.id), [{ profileId: first.id, platformId: presets[0].id, url: presets[0].launchUrl }]);
    });

    await openCreate();
    await shell.locator('#profile-name').fill('平台预设乙');
    await choose(presets[0].id);
    await save();
    const second = (await state()).profiles.find(item => item.name === '平台预设乙');
    assert.ok(second);
    created.push(second.id);
    await waitForView(second.id);
    await hasImage(second.id, presets[0]);
    const platformPalette = await settledPalette();
    check(prefix('platform avatars preserve the existing sidebar create and selected-row colors'), () => assert.deepEqual(platformPalette, originalPalette));
    await viewScript(first.id, "localStorage.setItem('platform-account','synthetic-preset-A'); document.cookie='platformAccount=A; Max-Age=86400; Path=/'; true");
    const fresh = await viewScript(second.id, "({storage:localStorage.getItem('platform-account'), cookie:document.cookie})");
    await viewScript(second.id, "localStorage.setItem('platform-account','synthetic-preset-B'); document.cookie='platformAccount=B; Max-Age=86400; Path=/'; true");
    await viewScript(first.id, "localStorage.removeItem('platform-account'); document.cookie='platformAccount=; Max-Age=0; Path=/'; true");
    const peer = await viewScript(second.id, "({storage:localStorage.getItem('platform-account'), cookie:document.cookie})");
    const partitions = await app.evaluate(({ BrowserWindow }) => {
      const views = BrowserWindow.getAllWindows().flatMap(window => window.contentView.children).filter(view => view.webContents?.profileId);
      const ids = globalThis.__qiyePlatformUITest.records.map(record => record.profileId);
      const selected = views.filter(view => ids.includes(view.webContents.profileId));
      return selected.length === 2 && selected[0].webContents.session !== selected[1].webContents.session;
    });
    check(prefix('two accounts on one preset use distinct UUIDs and real cookie/localStorage sessions; logout cannot affect the peer'), () => {
      assert.notEqual(first.id, second.id);
      assert.equal(second.platformId, first.platformId);
      assert.equal(partitions, true);
      assert.equal(fresh.storage, null);
      assert.equal(fresh.cookie.includes('platformAccount='), false);
      assert.equal(peer.storage, 'synthetic-preset-B');
      assert.ok(peer.cookie.includes('platformAccount=B'));
    });

    const oldUrl = await viewScript(first.id, 'location.href');
    await edit(first.id);
    assert.deepEqual((await selection()).checked, [presets[0].id]);
    await shell.locator('#profile-name').fill('预设甲已改名');
    await save();
    const renamed = await profile(first.id);
    check(prefix('renaming a preset environment retains its UUID, platform association and current page'), () => {
      assert.equal(renamed.name, '预设甲已改名');
      assert.equal(renamed.platformId, presets[0].id);
      assert.equal(renamed.startUrl, presets[0].launchUrl);
      assert.equal(renamed.lastUrl, oldUrl);
    });
    await edit(first.id);
    const lockedPreset = await selection();
    check(prefix('preset editing displays its original selection but disables every launch-setting control'), () => {
      assert.deepEqual(lockedPreset.checked, [presets[0].id]);
      assert.equal(lockedPreset.readOnly, true);
      assert.equal(lockedPreset.disabled, true);
      assert.equal(lockedPreset.platformsDisabled, true);
      assert.equal(lockedPreset.url, presets[0].launchUrl);
    });
    await shell.locator('#profile-cancel').click();
    await dialogClosed();
    const beforeRejected = await profile(first.id);
    const diskBeforeRejected = fs.readFileSync(path.join(directory, 'profiles.json'), 'utf8');
    const rejected = await shell.evaluate(async ({ id, input }) => {
      try { await window.browserAPI.updateProfile(id, input); return null; }
      catch (error) { return error.message; }
    }, { id: first.id, input: { name: '不得保存的名称', platformId: presets[1].id, startUrl: presets[1].launchUrl } });
    const afterRejected = await profile(first.id);
    const unchangedPage = await viewScript(first.id, 'location.href');
    check(prefix('configuration updates reject platform and URL changes atomically without changing the account page or icon'), () => {
      assert.ok(rejected?.includes('环境创建后不可修改启动网址或平台'));
      assert.deepEqual(afterRejected, beforeRejected);
      assert.equal(fs.readFileSync(path.join(directory, 'profiles.json'), 'utf8'), diskBeforeRejected);
      assert.equal(unchangedPage, oldUrl);
    });
    await hasImage(first.id, presets[0]);

    // Different launch modes remain available at creation. Existing accounts
    // must never be repurposed just to exercise another platform or avatar.
    await openCreate();
    await shell.locator('#profile-name').fill('首次设置小红书');
    await choose(presets[1].id);
    await save();
    const alternative = (await state()).profiles.find(item => item.name === '首次设置小红书');
    assert.ok(alternative);
    created.push(alternative.id);
    await waitForView(alternative.id);
    await hasImage(alternative.id, presets[1]);
    check(prefix('new environments still choose another platform with its own canonical URL and logo'), () => {
      assert.equal(alternative.platformId, presets[1].id);
      assert.equal(alternative.startUrl, presets[1].launchUrl);
      assert.equal(afterRejected.platformId, presets[0].id);
    });

    await openCreate();
    await shell.locator('#profile-name').fill('首次设置自定义');
    await shell.locator('#profile-url').fill(presets[2].launchUrl);
    await save();
    const custom = (await state()).profiles.find(item => item.name === '首次设置自定义');
    assert.ok(custom);
    created.push(custom.id);
    await waitForView(custom.id);
    check(prefix('a newly created custom URL matching an official entry retains the default avatar without platform inference'), () => {
      assert.equal(Object.hasOwn(custom, 'platformId'), false);
      assert.equal(custom.startUrl, new URL(presets[2].launchUrl).href);
    });
    assert.equal(await shell.locator(`${avatar(custom.id)} img`).count(), 0);
    await edit(custom.id);
    const customEdit = await selection();
    check(prefix('custom editing shows its original URL while locking the URL and every platform mode'), () => {
      assert.deepEqual(customEdit.checked, ['custom']);
      assert.equal(customEdit.hidden, false);
      assert.equal(customEdit.readOnly, true);
      assert.equal(customEdit.disabled, true);
      assert.equal(customEdit.platformsDisabled, true);
      assert.equal(customEdit.url, new URL(presets[2].launchUrl).href);
    });
    await shell.locator('#profile-cancel').click();
    await dialogClosed();
    const customBefore = await profile(custom.id);
    const customRejected = await shell.evaluate(async ({ id, platformId }) => {
      try { await window.browserAPI.updateProfile(id, { notes: '不得保存的备注', platformId }); return null; }
      catch (error) { return error.message; }
    }, { id: custom.id, platformId: presets[0].id });
    const customAfter = await profile(custom.id);
    check(prefix('a custom environment cannot acquire a platform through another update path'), () => {
      assert.ok(customRejected?.includes('环境创建后不可修改启动网址或平台'));
      assert.deepEqual(customAfter, customBefore);
    });

    await shell.locator(key('close', second.id)).click();
    await eventually(async () => !(await state()).openTabs.some(tab => tab.id === second.id), 'preset account closed');
    await shell.locator(key('open', second.id)).click();
    await waitForView(second.id);
    await hasImage(second.id, presets[0]);
    const reopened = await profile(second.id);
    const reopenedData = await viewScript(second.id, "({storage:localStorage.getItem('platform-account'),cookie:document.cookie})");
    const saved = JSON.parse(fs.readFileSync(path.join(directory, 'profiles.json'), 'utf8')).profiles.find(item => item.id === second.id);
    check(prefix('close/reopen and the written profile manifest preserve platform identity and account data'), () => {
      assert.equal(reopened.platformId, presets[0].id);
      assert.equal(saved.platformId, presets[0].id);
      assert.equal(saved.startUrl, presets[0].launchUrl);
      assert.equal(reopenedData.storage, 'synthetic-preset-B');
      assert.ok(reopenedData.cookie.includes('platformAccount=B'));
    });

    await shell.locator(`${avatar(second.id)} img`).evaluate(image => { image.src = new URL('__missing-platform-test-image__', image.src).href; });
    await eventually(() => shell.locator(avatar(second.id)).evaluate(node => !node.classList.contains('has-platform-icon') && !node.querySelector('img')), 'failed local avatar falls back to initials');
    const failedImage = await shell.locator(avatar(second.id)).textContent();
    const afterFailedImage = await profile(second.id);
    check(prefix('a real local image load failure falls back to initials without losing the saved platform identity'), () => {
      assert.equal(failedImage, Array.from(second.name)[0]);
      assert.equal(afterFailedImage.platformId, presets[0].id);
    });
    const unexpected = await app.evaluate(() => globalThis.__qiyePlatformUITest.unexpected);
    check(prefix('platform entry interception performs no requests to real platform accounts or external resources'), () => assert.deepEqual(unexpected, []));
    await shell.locator('#sidebar-overview').click();
    await screenshot('platform-accounts-overview');
  } finally {
    // Restore the existing layout test's accounts, hooks and active page. Only
    // profiles created by this helper are removed from the temporary manifest.
    try {
      for (const id of created) await shell.evaluate(id => window.browserAPI.deleteProfile(id), id);
      if (initial.activeId) await shell.evaluate(id => window.browserAPI.openProfile(id), initial.activeId);
      else await shell.evaluate(() => window.browserAPI.showOverview());
    } finally {
      await app.evaluate(({ session }) => {
        const test = globalThis.__qiyePlatformUITest;
        if (!test) return;
        session.fromPartition = test.previous;
        for (const own of test.sessions) own.webRequest.onBeforeRequest(null);
        delete globalThis.__qiyePlatformUITest;
      });
    }
  }
}

module.exports = { seedLegacyPlatforms, verifyLegacyPlatforms, verifyPlatforms };
