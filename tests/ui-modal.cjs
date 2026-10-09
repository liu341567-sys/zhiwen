'use strict';

const assert = require('node:assert/strict');

const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

// Runs in every real window layout, rather than a browser-emulated viewport.
// Only transient form fields are changed; no environment is created here.
async function verifyCreateModal(context) {
  const { shell, state, check, prefix, screenshot, eventually, origin } = context;
  const initialState = await state();
  const profileIds = initialState.profiles.map(profile => profile.id);
  const body = shell.locator('#profile-dialog-body');
  const snapshot = () => shell.evaluate(() => {
    const box = id => {
      const rect = document.getElementById(id).getBoundingClientRect();
      return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom,
        width: rect.width, height: rect.height };
    };
    const dimensions = id => {
      const node = document.getElementById(id), style = getComputedStyle(node);
      return { scrollTop: node.scrollTop, scrollHeight: node.scrollHeight, clientHeight: node.clientHeight,
        overflowY: style.overflowY, flexShrink: style.flexShrink };
    };
    const hit = id => {
      const node = document.getElementById(id), rect = node.getBoundingClientRect();
      const target = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
      return target === node || node.contains(target);
    };
    const brand = document.createElement('span');
    brand.style.cssText = 'position:fixed;visibility:hidden;color:var(--brand)';
    document.body.append(brand);
    const brandColor = getComputedStyle(brand).color;
    brand.remove();
    return { viewport: { width: innerWidth, height: innerHeight },
      dialog: box('profile-dialog'), header: box('profile-dialog-header'), body: box('profile-dialog-body'),
      footer: box('profile-dialog-footer'), close: box('profile-dialog-close'), save: box('profile-save'),
      title: box('profile-dialog-title'), tip: box('new-profile-tip'),
      outerScroll: dimensions('profile-dialog'), formScroll: dimensions('profile-form'), bodyScroll: dimensions('profile-dialog-body'),
      closeHit: hit('profile-dialog-close'), saveHit: hit('profile-save'),
      nameFont: parseFloat(getComputedStyle(document.getElementById('profile-name')).fontSize),
      saveFont: parseFloat(getComputedStyle(document.getElementById('profile-save')).fontSize),
      presetFonts: [...document.querySelectorAll('.platform-preset-name')].map(node => parseFloat(getComputedStyle(node).fontSize)),
      saveBackground: getComputedStyle(document.getElementById('profile-save')).backgroundColor,
      saveColor: getComputedStyle(document.getElementById('profile-save')).color,
      brandColor,
      children: [...document.getElementById('profile-form').children].map(node => node.id),
    };
  });
  const background = () => shell.evaluate(() => ({
    pageX: window.scrollX, pageY: window.scrollY,
    nodes: ['profile-list', 'tab-list', 'overview-view'].map(id => {
      const node = document.getElementById(id);
      return { id, x: node.scrollLeft, y: node.scrollTop };
    }),
    sidebar: { x: document.querySelector('.sidebar').scrollLeft, y: document.querySelector('.sidebar').scrollTop },
  }));
  const draft = () => shell.evaluate(() => ({
    open: document.getElementById('profile-dialog').open,
    name: document.getElementById('profile-name').value,
    notes: document.getElementById('profile-notes').value,
    url: document.getElementById('profile-url').value,
    selected: [...document.querySelectorAll('#profile-form input[name="platform"]:checked')].map(input => input.value),
    color: document.querySelector('#color-choices input:checked')?.value,
  }));
  const positionedField = selector => shell.locator(selector).evaluate(node => {
    const rect = node.getBoundingClientRect(), body = document.getElementById('profile-dialog-body').getBoundingClientRect();
    return { focused: document.activeElement === node, missing: node.validity.valueMissing,
      fullyVisible: rect.top >= body.top - 1 && rect.bottom <= body.bottom + 1 && rect.left >= body.left - 1 && rect.right <= body.right + 1 };
  });
  const assertPinned = (current, initial, label) => {
    for (const region of ['header', 'footer', 'close', 'save', 'title']) {
      for (const edge of ['left', 'top', 'right', 'bottom']) {
        assert.ok(Math.abs(current[region][edge] - initial[region][edge]) <= 1.1, `${label}: ${region}.${edge} must not move with the form`);
      }
    }
    assert.ok(current.closeHit && current.saveHit, `${label}: both fixed controls must receive input`);
    for (const control of [current.close, current.save]) {
      assert.ok(control.left >= current.dialog.left && control.right <= current.dialog.right &&
        control.top >= current.dialog.top && control.bottom <= current.dialog.bottom,
      `${label}: close and save must remain inside the dialog`);
    }
    assert.equal(current.outerScroll.scrollTop, 0, `${label}: the outer dialog cannot scroll`);
    assert.equal(current.formScroll.scrollTop, 0, `${label}: the form shell cannot scroll`);
  };
  const scrollTo = async fraction => {
    await body.evaluate((node, fraction) => { node.scrollTop = (node.scrollHeight - node.clientHeight) * fraction; }, fraction);
    await shell.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    return snapshot();
  };
  const wheelAt = async (point, amount) => {
    const before = await shell.evaluate(() => window.__qiyeModalWheelCount);
    await shell.mouse.move(point.x, point.y);
    await shell.mouse.wheel(0, amount);
    await eventually(() => shell.evaluate(before => window.__qiyeModalWheelCount > before, before), 'real modal wheel delivered');
    await pause(150);
  };
  await shell.locator('#profile-dialog').waitFor({ state: 'visible' });
  await eventually(() => shell.evaluate(() => document.activeElement.id === 'profile-name' && document.getElementById('profile-dialog-body').scrollTop <= 1), 'new modal starts at the name field');
  // Opening over the previous pointer position can briefly hover the primary
  // action. Sample its normal color only after the real hover transition ends.
  await shell.mouse.move(2, 2);
  await eventually(() => shell.locator('#profile-save').evaluate(node => !node.matches(':hover') &&
    node.getAnimations().every(animation => animation.playState !== 'running')), 'normal primary color transition settled');
  const initial = await snapshot();
  check(prefix('creation uses one bounded header/body/footer form without shrinking its readable controls'), () => {
    assert.deepEqual(initial.children, ['profile-dialog-header', 'profile-dialog-body', 'profile-dialog-footer']);
    assert.ok(initial.dialog.height <= initial.viewport.height * .9 + 2, 'The modal must leave vertical safety space');
    assert.ok(initial.dialog.top >= 15 && initial.dialog.bottom <= initial.viewport.height - 15);
    assert.ok(initial.dialog.left >= 15 && initial.dialog.right <= initial.viewport.width - 15);
    assert.ok(initial.dialog.width >= Math.min(478, initial.viewport.width - 34) && initial.dialog.width <= 481, 'The existing 480 px modal width is retained');
    assert.ok(initial.header.bottom <= initial.body.top + 1 && initial.body.bottom <= initial.footer.top + 1);
    assert.ok(initial.body.height > 40 && ['auto', 'scroll'].includes(initial.bodyScroll.overflowY));
    assert.equal(initial.header.height > 0 && initial.footer.height > 0, true);
    assert.ok(['hidden', 'clip'].includes(initial.outerScroll.overflowY));
    assert.ok(initial.outerScroll.scrollHeight <= initial.outerScroll.clientHeight + 2, 'No second outer scrollbar');
    assert.ok(initial.formScroll.scrollHeight <= initial.formScroll.clientHeight + 2, 'No second form-shell scrollbar');
    assert.ok(initial.close.width >= 33 && initial.close.height >= 33);
    assert.ok(initial.save.height >= 39 && initial.nameFont >= 14 && initial.saveFont >= 14);
    assert.ok(initial.presetFonts.length === 9 && initial.presetFonts.every(size => size >= 14));
    assert.equal(initial.saveColor, 'rgb(255, 255, 255)');
    assert.equal(initial.saveBackground, initial.brandColor, 'The create action retains the existing solid brand blue');
    if (initial.viewport.height <= 550) assert.ok(initial.bodyScroll.scrollHeight > initial.bodyScroll.clientHeight + 20, 'Compact windows must exercise actual body overflow');
  });
  check(prefix('opening creation starts at the form top with its name field focused'), () => assert.equal(initial.bodyScroll.scrollTop, 0));

  for (const [label, fraction] of [['top', 0], ['middle', .5], ['bottom', 1]]) {
    const current = await scrollTo(fraction);
    check(prefix(`creation ${label}: close, title and blue create button stay visible at fixed positions`), () => assertPinned(current, initial, label));
    if (label === 'bottom') {
      check(prefix('the final isolation explanation is wholly visible above the fixed action bar'), () => {
        assert.ok(current.tip.height > 0 && current.tip.top >= current.body.top - 1 && current.tip.bottom <= current.body.bottom + 1);
        assert.ok(current.tip.bottom <= current.footer.top + 1);
      });
    }
    await screenshot(`create-fixed-${label}`);
  }

  const backgroundBefore = await background();
  await shell.evaluate(() => {
    window.__qiyeModalWheelCount = 0;
    window.__qiyeModalWheelListener = () => { window.__qiyeModalWheelCount += 1; };
    document.addEventListener('wheel', window.__qiyeModalWheelListener, { capture: true, passive: true });
  });
  try {
    let current = await scrollTo(0);
    const bodyPoint = { x: current.body.right - 12, y: (current.body.top + current.body.bottom) / 2 };
    await wheelAt(bodyPoint, 240);
    if (current.bodyScroll.scrollHeight > current.bodyScroll.clientHeight + 1) {
      await eventually(() => body.evaluate(node => node.scrollTop > 1), 'a real wheel scrolls only the middle form');
    }
    assertPinned(await snapshot(), initial, 'real middle wheel');
    await scrollTo(1);
    await wheelAt(bodyPoint, 480);
    await scrollTo(0);
    await wheelAt(bodyPoint, -480);
    // Real wheel events over the footer, header and backdrop must not leak to
    // the sidebar/cards, including when the body is already at either edge.
    for (const point of [
      { x: current.header.left + 12, y: current.header.top + 12 },
      { x: current.footer.left + 12, y: current.footer.top + 12 },
      { x: 2, y: 2 },
      { x: 12, y: Math.min(initial.viewport.height - 12, initial.body.top + 20) },
    ]) await wheelAt(point, 480);
    const backgroundAfter = await background();
    const outsideWheel = await snapshot();
    check(prefix('real body wheel and boundary overscroll keep the header/footer and all background scroll positions unchanged'), () => {
      assert.deepEqual(backgroundAfter, backgroundBefore);
      assert.equal(outsideWheel.bodyScroll.scrollTop, 0, 'Wheel input outside the body cannot move the form');
      assertPinned(outsideWheel, initial, 'outside-body wheel');
    });

    await shell.locator('#profile-name').fill('三段弹窗验证草稿');
    await shell.locator('#profile-notes').fill('表单滚动、背景点击与 Escape 均不能改变此备注');
    await shell.locator('#profile-url').fill(`${origin}/modal-layout-draft`);
    await shell.locator('#color-choices input').last().check();
    await shell.locator('#platform-presets input').last().check();
    const savedDraft = await draft();
    const selectedState = await shell.evaluate(() => ({ hidden: document.getElementById('profile-url-field').hidden,
      customWillValidate: document.getElementById('profile-url').willValidate }));
    assert.equal(selectedState.hidden, true, 'A chosen preset removes the unused custom field from the body');
    assert.equal(selectedState.customWillValidate, false);
    for (const fraction of [0, .5, 1]) {
      await scrollTo(fraction);
      await shell.mouse.click(2, 2);
      await shell.mouse.click(initial.viewport.width - 2, initial.viewport.height - 2);
      await shell.keyboard.press('Escape');
      await shell.keyboard.press('Escape');
      assert.deepEqual(await draft(), savedDraft, 'Repeated Escape and backdrop clicks retain all draft fields at every scroll position');
    }
    check(prefix('top/middle/bottom scrolling, six backdrop clicks and repeated Escape preserve the selected platform, color and complete draft'), () => assert.equal(savedDraft.open, true));
    await shell.locator('#custom-platform').check();
    const restoredCustomUrl = await shell.locator('#profile-url').inputValue();
    check(prefix('returning from a preset restores the custom URL draft in the independently scrolling body'), () => assert.equal(restoredCustomUrl, `${origin}/modal-layout-draft`));

    await shell.locator('#profile-name').fill('');
    await scrollTo(1);
    await shell.locator('#profile-save').click();
    await eventually(async () => (await positionedField('#profile-name')).focused, 'native required validation focuses the offscreen name');
    const emptyName = await positionedField('#profile-name');
    check(prefix('fixed-footer submit locates and exposes an empty required name without losing the draft'), () => {
      assert.ok(emptyName.focused && emptyName.missing && emptyName.fullyVisible);
    });

    await shell.locator('#profile-name').fill('   ');
    await scrollTo(1);
    await shell.locator('#profile-save').click();
    await shell.locator('#profile-form-error').waitFor({ state: 'visible' });
    await eventually(async () => (await positionedField('#profile-name')).focused, 'trimmed-name validation focuses the name');
    const whitespaceName = await positionedField('#profile-name');
    check(prefix('application validation locates a whitespace-only name inside the body'), () => assert.ok(whitespaceName.focused && whitespaceName.fullyVisible));

    await shell.locator('#profile-name').fill('三段弹窗验证草稿');
    await shell.locator('#profile-url').fill('');
    await scrollTo(0);
    await shell.locator('#profile-save').click();
    await eventually(async () => (await positionedField('#profile-url')).focused, 'native required validation focuses the offscreen custom URL');
    const emptyUrl = await positionedField('#profile-url');
    check(prefix('fixed-footer submit locates an empty custom URL from the form top'), () => assert.ok(emptyUrl.focused && emptyUrl.missing && emptyUrl.fullyVisible));

    await shell.locator('#profile-url').fill('javascript:alert(1)');
    await scrollTo(0);
    await shell.locator('#profile-save').click();
    await shell.locator('#profile-form-error').waitFor({ state: 'visible' });
    await eventually(async () => (await positionedField('#profile-url')).focused, 'custom URL validation focuses its rejected field');
    const invalidUrl = await positionedField('#profile-url');
    assert.deepEqual((await state()).profiles.map(profile => profile.id), profileIds, 'Every failed submit retains the existing account list');
    check(prefix('invalid custom URL is focused and fully exposed while existing environments remain unchanged'), () => assert.ok(invalidUrl.focused && invalidUrl.fullyVisible));
    assert.equal((await draft()).notes, savedDraft.notes);
    assert.equal((await draft()).color, savedDraft.color);
    const afterValidation = await snapshot();
    assertPinned(await scrollTo(1), afterValidation, 'scrolling after validation');

    // Leave the normal layout helper a fresh creation dialog. This also tests
    // scroll reset after explicitly closing a previously scrolled invalid draft.
    await scrollTo(1);
    await shell.locator('#profile-dialog-close').click();
    await eventually(() => shell.locator('#profile-dialog').evaluate(node => !node.open), 'the fixed close icon dismisses creation from the bottom');
    await shell.locator('#sidebar-create').click();
    await eventually(() => shell.evaluate(() => document.activeElement.id === 'profile-name' && document.getElementById('profile-dialog-body').scrollTop <= 1), 'reopening resets the middle form to the name');
    const reopened = await draft();
    check(prefix('closing from the form bottom and reopening resets scroll/focus without creating an account'), () => {
      assert.equal(reopened.open, true);
      assert.equal(reopened.name, '');
      assert.equal(reopened.notes, '');
      assert.deepEqual(reopened.selected, ['custom']);
    });
    const after = await state();
    assert.deepEqual(after.profiles.map(profile => profile.id), profileIds);
    assert.equal(after.activeId, initialState.activeId, 'Background clicks cannot activate another account');
    assert.deepEqual(after.openTabs.map(tab => tab.id), initialState.openTabs.map(tab => tab.id), 'Modal interaction cannot change open accounts');
  } finally {
    await shell.evaluate(() => {
      document.removeEventListener('wheel', window.__qiyeModalWheelListener, true);
      delete window.__qiyeModalWheelListener;
      delete window.__qiyeModalWheelCount;
    }).catch(() => {});
  }
}

module.exports = { verifyCreateModal };
