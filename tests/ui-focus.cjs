'use strict';

const assert = require('node:assert/strict');

// Reproduce user input against real controls. Native :focus-visible may still
// match after Shift; the regression concerns the painted outline and account
// state, while keyboard navigation must continue to show its focus indicator.
async function verifyInputFocus({ shell, state, ids, check, prefix, screenshot, eventually, clickable }) {
  const key = (type, id) => `[data-focus-key="${type}:${id}"]`;
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const snapshot = () => shell.evaluate(() => {
    const name = node => node?.dataset?.focusKey || node?.id || node?.tagName;
    const actions = [...document.querySelectorAll('[data-focus-key], #sidebar-create, #sidebar-overview, #tab-create')];
    const rings = actions.filter(node => {
      const css = getComputedStyle(node);
      return node.matches(':focus') && css.outlineStyle !== 'none' && parseFloat(css.outlineWidth) > 0 && css.outlineColor !== 'rgba(0, 0, 0, 0)';
    }).map(name);
    const selection = getSelection();
    const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
    return { activeElement: name(document.activeElement), rings,
      activeRows: [...document.querySelectorAll('.profile-row.active [data-focus-key^="open:"]')].map(name),
      selectedCards: range && !range.collapsed ? [...document.querySelectorAll('.profile-card')].filter(card => range.intersectsNode(card)).length : 0 };
  });
  const expectState = async (id, ringKey = null) => {
    const publicState = await state(), visual = await snapshot();
    assert.equal(publicState.activeId, id, 'wheel and modifiers must not switch accounts');
    assert.deepEqual(visual.activeRows, id ? [`open:${id}`] : [], 'only the current environment may have an active row');
    assert.equal(visual.selectedCards, 0, 'scrolling must not create a multi-card text selection');
    if (ringKey) assert.deepEqual(visual.rings, [ringKey], 'keyboard focus must retain one visible outline');
    else assert.deepEqual(visual.rings, [], 'pointer-focused environment controls must not acquire a keyboard outline');
    return visual;
  };
  const scroll = selector => shell.locator(selector).evaluate(node => ({ x: node.scrollLeft, y: node.scrollTop }));
  const wheel = async (selector, amount, requireMovement = false) => {
    await shell.locator(selector).hover();
    const before = await scroll(selector);
    const previousEvents = await shell.evaluate(() => window.__qiyeFocusWheelEvents.length);
    await shell.mouse.wheel(0, amount);
    await eventually(() => shell.evaluate(previous => window.__qiyeFocusWheelEvents.length > previous, previousEvents), 'real wheel event delivered');
    if (requireMovement) await eventually(async () => {
      const after = await scroll(selector);
      return after.x !== before.x || after.y !== before.y;
    }, `${selector} scrolls with an ordinary wheel`);
    // Let hover transitions settle before checking painted outlines. Shift can
    // route the wheel horizontally on an OS; its axis is deliberately untouched.
    await pause(180);
    return { before, after: await scroll(selector) };
  };
  const waitFocus = focusKey => eventually(() => shell.evaluate(focusKey => document.activeElement?.dataset.focusKey === focusKey, focusKey), `focus restored to ${focusKey}`);
  const dismiss = async button => {
    await shell.locator(button).click();
    await eventually(() => shell.evaluate(() => !document.querySelector('dialog[open]')), 'dialog closed');
  };
  await shell.evaluate(() => {
    window.__qiyeFocusWheelEvents = [];
    window.__qiyeFocusWheelHandler = event => window.__qiyeFocusWheelEvents.push({ shift: event.shiftKey, x: event.deltaX, y: event.deltaY });
    document.addEventListener('wheel', window.__qiyeFocusWheelHandler, { capture: true, passive: true });
  });
  try {
    await shell.locator(key('open', ids[0])).click();
    await eventually(async () => (await state()).activeId === ids[0], 'pointer-selected environment');
    await expectState(ids[0]);
    check(prefix('clicking an already open environment keeps a single active row without a focus ring'), () => assert.ok(true));

    await shell.keyboard.down('Shift');
    await expectState(ids[0]);
    check(prefix('Shift alone does not paint an outline around a mouse-focused environment'), () => assert.ok(true));
    await wheel('#profile-list', 160);
    await expectState(ids[0]);
    await wheel('#profile-list', -160);
    await shell.mouse.move(10, 10);
    await expectState(ids[0]);
    const shiftEvents = await shell.evaluate(() => window.__qiyeFocusWheelEvents.filter(event => event.shift));
    check(prefix('Shift wheel in both directions and pointer movement preserve environment selection and pointer focus'), () => {
      assert.ok(shiftEvents.some(event => event.y > 0 || event.x > 0));
      assert.ok(shiftEvents.some(event => event.y < 0 || event.x < 0));
    });
    await shell.keyboard.up('Shift');
    await shell.locator(key('open', ids[0])).click();
    const rowScroll = await wheel('#profile-list', 160, true);
    await expectState(ids[0]);
    check(prefix('ordinary wheel actually scrolls saved environments without changing the account'), () => assert.notDeepEqual(rowScroll.after, rowScroll.before));

    for (const id of [ids[1], ids[0], ids[1]]) {
      await shell.locator(key('open', id)).click();
      await eventually(async () => (await state()).activeId === id, 'consecutive pointer activation');
      await expectState(id);
    }
    const repeatedState = await state();
    check(prefix('consecutive mouse clicks switch only their target and keep one tab per environment'), () => assert.equal(repeatedState.openTabs.filter(tab => tab.id === ids[1]).length, 1));

    await shell.locator('#sidebar-overview').click();
    await eventually(async () => (await state()).activeId === null, 'overview after pointer page change');
    await shell.keyboard.down('Shift');
    await expectState(null);
    await wheel('#overview-view', 100);
    await expectState(null);
    await shell.keyboard.up('Shift');
    check(prefix('page changes followed by Shift scrolling keep overview selected without an extra outline'), () => assert.ok(true));

    const editorKey = `card-edit:${ids[0]}`;
    await shell.locator(key('card-edit', ids[0])).click();
    await shell.locator('#profile-dialog').waitFor({ state: 'visible' });
    const name = await shell.locator('#profile-name').inputValue();
    await shell.locator('#profile-name').press('Control+A');
    const nameSelection = await shell.locator('#profile-name').evaluate(node => ({ start: node.selectionStart, end: node.selectionEnd, length: node.value.length }));
    await shell.locator('#profile-notes').fill('原生表单文字仍可选择 · synthetic notes');
    await shell.locator('#profile-notes').press('Control+A');
    const notesSelection = await shell.locator('#profile-notes').evaluate(node => ({ start: node.selectionStart, end: node.selectionEnd, length: node.value.length }));
    check(prefix('real Ctrl+A selects input and textarea text after a mouse-opened editor'), () => {
      assert.ok(name.length > 0);
      for (const selected of [nameSelection, notesSelection]) { assert.equal(selected.start, 0); assert.equal(selected.end, selected.length); }
    });
    await dismiss('#profile-cancel');
    await waitFocus(editorKey);
    await expectState(null);
    check(prefix('cancelling a card editor restores the same logical control after rendering'), () => assert.equal((nameSelection.end), name.length));
    await shell.keyboard.down('Shift');
    await expectState(null);
    await wheel('#overview-view', 120);
    await wheel('#overview-view', -120);
    await expectState(null);
    await shell.keyboard.up('Shift');

    await shell.locator(key('card-edit', ids[0])).click();
    await shell.locator('#profile-delete').click();
    await shell.locator('#delete-dialog').waitFor({ state: 'visible' });
    await dismiss('#delete-cancel');
    await waitFocus(editorKey);
    await expectState(null);
    const afterDeleteCancel = await state();
    check(prefix('keeping an environment in delete confirmation restores its original card editor control'), () => assert.ok(afterDeleteCancel.profiles.some(profile => profile.id === ids[0])));

    await shell.locator(key('card-edit', ids[0])).hover();
    const cardScroll = await wheel('#overview-view', 160, true);
    await expectState(null);
    check(prefix('ordinary wheel actually scrolls account cards and Shift after editing creates no extra selection'), () => assert.notDeepEqual(cardScroll.after, cardScroll.before));
    await screenshot('pointer-focus-scroll');

    await shell.locator(key('open', ids[0])).click();
    await eventually(async () => (await state()).activeId === ids[0], 'environment selected before keyboard navigation');
    await shell.keyboard.press('Tab');
    await waitFocus(`edit:${ids[0]}`);
    await expectState(ids[0], `edit:${ids[0]}`);
    await shell.keyboard.press('Shift+Tab');
    await waitFocus(`open:${ids[0]}`);
    await expectState(ids[0], `open:${ids[0]}`);
    check(prefix('Tab and Shift+Tab show one visible keyboard focus indicator on the correct controls'), () => assert.ok(true));

    await shell.keyboard.down('Shift');
    await wheel('#tab-list', 90);
    await expectState(ids[0], `open:${ids[0]}`);
    await wheel('#tab-list', -90);
    await expectState(ids[0], `open:${ids[0]}`);
    await shell.keyboard.up('Shift');
    check(prefix('Shift scrolling preserves an existing keyboard focus indicator'), () => assert.ok(true));
    await shell.keyboard.press('Tab');
    await waitFocus(`edit:${ids[0]}`);
    await shell.keyboard.press('Enter');
    await shell.locator('#profile-dialog').waitFor({ state: 'visible' });
    await shell.keyboard.press('Escape');
    await eventually(() => shell.evaluate(() => !document.querySelector('dialog[open]')), 'keyboard editor dismissed');
    await waitFocus(`edit:${ids[0]}`);
    await expectState(ids[0], `edit:${ids[0]}`);
    check(prefix('Enter opens an editor and Escape restores its redrawn control with keyboard focus visible'), () => assert.ok(true));

    await shell.keyboard.press('Tab');
    await waitFocus(`open:${ids[1]}`);
    await shell.keyboard.press('Space');
    await eventually(async () => (await state()).activeId === ids[1], 'Space activates the next environment');
    await expectState(ids[1], `open:${ids[1]}`);
    check(prefix('Space activates the keyboard-focused environment and preserves focus across rendering'), () => assert.ok(true));

    await shell.locator('#sidebar-overview').click();
    await eventually(async () => (await state()).activeId === null, 'overview for Enter activation');
    await shell.keyboard.press('Tab');
    await shell.keyboard.press('Tab');
    await waitFocus(`open:${ids[0]}`);
    await shell.keyboard.press('Enter');
    await eventually(async () => (await state()).activeId === ids[0], 'Enter reopens an environment from overview');
    await expectState(ids[0], `open:${ids[0]}`);
    check(prefix('Enter activates an environment from overview without losing keyboard focus'), () => assert.ok(true));
    await screenshot('keyboard-focus-scroll');
    // End through a pointer action so the existing user-flow checks start from
    // the same input mode as ordinary mouse use.
    await clickable(key('open', ids[0]));
    await shell.locator(key('open', ids[0])).click();
    await expectState(ids[0]);
  } finally {
    await shell.keyboard.up('Shift').catch(() => {});
    await shell.evaluate(() => { document.removeEventListener('wheel', window.__qiyeFocusWheelHandler, true); delete window.__qiyeFocusWheelHandler; delete window.__qiyeFocusWheelEvents; }).catch(() => {});
  }
}

module.exports = { verifyInputFocus };
