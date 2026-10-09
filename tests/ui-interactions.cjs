'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Actual mouse input in a sandboxed Electron window. Metadata is read through
// the public management bridge and the on-disk manifest; no real site logins.
async function verifyInteractions(context) {
  const { app, shell, state, ids, check, prefix, screenshot, eventually,
    origin, directory, viewScript, waitForView } = context;
  const initial = await state();
  const created = [];
  const key = (type, id) => `[data-focus-key="${type}:${id}"]`;
  const row = id => `.profile-row:has(${key('open', id)})`;
  const order = async () => (await state()).profiles.map(profile => profile.id);
  const disk = () => JSON.parse(fs.readFileSync(path.join(directory, 'profiles.json'), 'utf8'));
  const sidebarOrder = () => shell.locator('.profile-row .profile-open').evaluateAll(nodes =>
    nodes.map(node => node.dataset.focusKey.slice('open:'.length)));
  const sidebarIdentity = async (profiles, activeId) => {
    // Read current rows inside one renderer task: a CDP-resolved element array
    // may detach when a queued state broadcast replaces the sidebar. Wait for
    // the exact account set, active row and images before sampling identities.
    let last, previous, settled;
    try {
      await eventually(async () => {
        last = await shell.evaluate(({ profiles, activeId }) => {
          const nodes = [...document.querySelectorAll('#profile-list .profile-row')];
          const ids = nodes.map(node => node.dataset.profileId);
          const activeIds = nodes.filter(node => node.classList.contains('active')).map(node => node.dataset.profileId);
          const matchesOrder = ids.length === profiles.length && ids.every((id, index) => id === profiles[index].id);
          const matchesActive = activeIds.length === (activeId ? 1 : 0) && (!activeId || activeIds[0] === activeId);
          const ready = matchesOrder && matchesActive && nodes.every((node, index) => {
            const avatar = node.querySelector('.profile-icon');
            const box = avatar?.getBoundingClientRect();
            return node.isConnected && avatar?.isConnected && box.width === 36 && box.height === 36 &&
              [...avatar.querySelectorAll('img')].every(image => image.isConnected && image.complete && image.naturalWidth > 0 && !image.hidden && image.currentSrc);
          });
          const records = ready ? nodes.map(node => {
            const avatar = node.querySelector('.profile-icon');
            return { id: node.dataset.profileId, name: node.querySelector('.profile-name').textContent,
              platformId: avatar.dataset.platformId || null, image: avatar.querySelector('img')?.currentSrc || null,
              initial: avatar.textContent, tint: getComputedStyle(avatar).backgroundColor, active: node.classList.contains('active') };
          }) : null;
          return { ready, ids, activeIds, records };
        }, { profiles, activeId });
        const serialized = last.ready && JSON.stringify(last.records);
        if (serialized && serialized === previous) { settled = last.records; return true; }
        previous = serialized;
        return false;
      }, 'connected sidebar identities, local images and the latest active row settle');
    } catch (error) {
      error.uiDetails = { check: 'sidebarIdentity readiness', expectedCount: profiles.length, actualCount: last?.ids.length,
        expectedActiveId: activeId, actualActiveIds: last?.activeIds, ready: last?.ready };
      throw error;
    }
    return settled;
  };
  const moved = (list, id, beforeId = null) => {
    const result = list.filter(value => value !== id);
    result.splice(beforeId === null ? result.length : result.indexOf(beforeId), 0, id);
    return result;
  };
  const waitOrder = expected => eventually(async () => {
    const actual = await order();
    return actual.length === expected.length && actual.every((id, index) => id === expected[index]);
  }, 'released drag order reaches the authoritative saved state');
  const closeDialog = () => eventually(() => shell.locator('#profile-dialog').evaluate(node => !node.open), 'dialog closed');
  const form = () => shell.evaluate(() => ({
    open: document.getElementById('profile-dialog').open,
    name: document.getElementById('profile-name').value,
    notes: document.getElementById('profile-notes').value,
    url: document.getElementById('profile-url').value,
    selected: [...document.querySelectorAll('#profile-dialog input[name="platform"]:checked')].map(input => input.value),
  }));
  const dragMarkers = () => shell.locator('.profile-row.is-dragging, .profile-row.drop-before, .profile-row.drop-after').count();
  const clearDrag = () => eventually(async () => await dragMarkers() === 0, 'drag feedback removed');
  const geometry = selector => shell.locator(selector).evaluate(node => {
    const box = node.getBoundingClientRect();
    return { x: box.x, y: box.y, width: box.width, height: box.height, bottom: box.bottom };
  });
  const point = async id => {
    // Native view loading legitimately rerenders idle rows. Scroll the current
    // matching node synchronously, then measure its freshly resolved successor
    // rather than waiting for an old ElementHandle to survive those broadcasts.
    await shell.locator(key('open', id)).evaluate(node => node.scrollIntoView({ block: 'nearest', inline: 'nearest' }));
    const box = await geometry(key('open', id));
    return { x: box.x + Math.min(50, box.width / 2), y: box.y + box.height / 2 };
  };
  const begin = async id => {
    const start = await point(id);
    await shell.mouse.move(start.x, start.y);
    await shell.mouse.down();
    await shell.mouse.move(start.x + 12, start.y, { steps: 3 });
    await eventually(() => shell.locator(row(id)).evaluate(node => node.classList.contains('is-dragging')), 'movement beyond the threshold begins sorting');
    return start;
  };
  const moveTo = async (id, fraction, x) => {
    // A 150% Windows work area can show only one row. Sample both bounds every
    // frame while the held mouse triggers real edge scrolling; a one-sided
    // check could mistakenly accept a target already scrolled above the list.
    const deadline = Date.now() + 12_000;
    while (Date.now() < deadline) {
      const current = await shell.locator(row(id)).evaluate((node, fraction) => {
        const list = document.getElementById('profile-list');
        const bounds = list.getBoundingClientRect(), box = node.getBoundingClientRect();
        return { top: bounds.top, bottom: bounds.bottom, y: box.top + box.height * fraction,
          gap: fraction < .5 ? box.top - 1 : box.bottom + 4,
          scrollTop: list.scrollTop, maximum: list.scrollHeight - list.clientHeight };
      }, fraction);
      const pointInside = current.y > current.top + 1 && current.y < current.bottom - 1;
      const gapInside = current.gap >= current.top - 1 && current.gap <= current.bottom - 1;
      if (pointInside && (gapInside || current.scrollTop <= 1 || current.scrollTop >= current.maximum - 1)) {
        await shell.mouse.move(x, current.y, { steps: 3 });
        return;
      }
      const downward = current.y >= current.bottom - 1 || current.gap > current.bottom - 1;
      await shell.mouse.move(x, downward ? current.bottom - 4 : current.top + 4);
      await new Promise(resolve => setTimeout(resolve, 16));
    }
    throw new Error(`The real held mouse could not reveal the drop target: ${id}`);
  };
  const marker = async () => {
    const actual = await shell.locator('.profile-row.drop-before, .profile-row.drop-after').evaluateAll(nodes => nodes.map(node => {
      const side = node.classList.contains('drop-before') ? 'before' : 'after';
      const style = getComputedStyle(node, side === 'before' ? '::before' : '::after');
      return { id: node.querySelector('.profile-open').dataset.focusKey.slice('open:'.length), side,
        background: style.backgroundColor, height: parseFloat(style.height), content: style.content };
    }));
    assert.equal(actual.length, 1, 'Only one insertion position may be indicated');
    assert.ok(actual[0].height >= 1 && actual[0].content !== 'none', 'Insertion line must be visible');
    assert.notEqual(actual[0].background, 'rgba(0, 0, 0, 0)', 'Insertion feedback must be painted');
    const brandBlue = await shell.evaluate(() => {
      const probe = document.createElement('span');
      probe.style.color = 'var(--sidebar-action)';
      document.body.append(probe);
      const color = getComputedStyle(probe).color;
      probe.remove();
      return color;
    });
    assert.equal(actual[0].background, brandBlue, 'Insertion feedback must use the existing brand blue');
    return actual[0];
  };
  let originalWindow;
  try {
    // Creation has one explicit dismissal control. Backdrop and Escape retain
    // typed values, selected preset, and the draft custom URL.
    await shell.locator('#sidebar-create').click();
    await shell.locator('#profile-dialog').waitFor({ state: 'visible' });
    await shell.locator('#profile-name').fill('防误触创建草稿');
    await shell.locator('#profile-notes').fill('背景点击与 Escape 不应丢失这些内容');
    await shell.locator('#profile-url').fill(`${origin}/protected-draft`);
    await shell.locator('#platform-presets [data-platform-id="kuaishou"] input').check();
    const protectedDraft = await form();
    const outside = await shell.evaluate(() => ({ x: innerWidth - 2, y: innerHeight - 2 }));
    await shell.mouse.click(2, 2);
    assert.equal((await form()).open, true, 'Top-left backdrop click must keep creation open');
    await shell.mouse.click(outside.x, outside.y);
    assert.equal((await form()).open, true, 'Bottom-right backdrop click must keep creation open');
    await shell.keyboard.press('Escape');
    assert.equal((await form()).open, true, 'Escape must keep creation open');
    await shell.keyboard.press('Escape');
    const afterOutside = await form();
    check(prefix('background clicks and repeated Escape keep creation open and preserve all draft values'), () => {
      assert.deepEqual(afterOutside, protectedDraft);
      assert.equal(afterOutside.open, true);
    });
    check(prefix('creation offers only the explicit close icon as a dismissal button'), () => {
      assert.equal(protectedDraft.selected[0], 'kuaishou');
    });
    assert.equal(await shell.locator('#profile-cancel').isVisible(), false);
    assert.equal(await shell.locator('#profile-dialog-close').isEnabled(), true);
    await shell.locator('#custom-platform').check();
    assert.equal(await shell.locator('#profile-url').inputValue(), `${origin}/protected-draft`);
    await shell.locator('#profile-dialog-close').click();
    await closeDialog();
    const afterDismiss = await state();
    check(prefix('explicit close discards only the uncreated draft and restores its original launcher'), () => {
      assert.deepEqual(afterDismiss.profiles, initial.profiles);
    });
    assert.equal(await shell.evaluate(() => document.activeElement.id), 'sidebar-create');

    await shell.locator('#sidebar-create').click();
    await shell.locator('#profile-name').fill('校验未通过的草稿');
    await shell.locator('#profile-url').fill('javascript:alert(1)');
    await shell.locator('#profile-save').click();
    await shell.locator('#profile-form-error').waitFor({ state: 'visible' });
    await shell.mouse.click(2, 2);
    await shell.keyboard.press('Escape');
    const invalid = await form();
    check(prefix('failed creation validation retains its error and draft even after outside input'), () => {
      assert.equal(invalid.open, true);
      assert.equal(invalid.name, '校验未通过的草稿');
      assert.equal(invalid.url, 'javascript:alert(1)');
    });
    assert.equal(await shell.locator('#profile-form-error').isVisible(), true);
    await shell.locator('#profile-dialog-close').click();
    await closeDialog();

    await shell.locator('#sidebar-create').click();
    await shell.locator('#profile-name').fill('排序筛选甲');
    await shell.locator('#profile-url').fill(`${origin}/sorting-A`);
    await shell.locator('#profile-save').click();
    await closeDialog();
    const first = (await state()).profiles.find(profile => profile.name === '排序筛选甲');
    assert.ok(first);
    created.push(first.id);
    await waitForView(first.id);
    await shell.evaluate(id => window.browserAPI.closeProfile(id), first.id);
    check(prefix('successful creation still closes the protected dialog and saves the environment normally'), () => {
      assert.equal(first.startUrl, `${origin}/sorting-A`);
      assert.equal(Object.hasOwn(first, 'platformId'), false);
    });
    await shell.evaluate(input => window.browserAPI.createProfile(input), { name: '排序筛选乙', notes: '仅用于临时排序回归', startUrl: `${origin}/sorting-B`, color: '#9473b5' });
    const second = (await state()).profiles.find(profile => profile.name === '排序筛选乙');
    assert.ok(second);
    created.push(second.id);
    await waitForView(second.id);
    await shell.evaluate(id => window.browserAPI.closeProfile(id), second.id);
    await shell.evaluate(input => window.browserAPI.createProfile(input), { name: '后台可删除临时环境', startUrl: `${origin}/sorting-inactive` });
    const inactive = (await state()).profiles.find(profile => profile.name === '后台可删除临时环境');
    assert.ok(inactive);
    created.push(inactive.id);
    await waitForView(inactive.id);
    await shell.evaluate(id => window.browserAPI.closeProfile(id), inactive.id);
    await shell.evaluate(id => window.browserAPI.openProfile(id), ids[0]);
    await waitForView(ids[0]);

    // Enough visible space for adjacent-row pointer input at each actual DPR;
    // edge auto-scroll still exercises overflow rather than a giant viewport.
    originalWindow = await app.evaluate(({ BrowserWindow, screen }) => {
      const main = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/renderer/index.html'));
      const previous = main.getContentBounds();
      const frame = main.getBounds();
      const workArea = screen.getPrimaryDisplay().workArea;
      main.setContentSize(Math.min(1000, workArea.width - (frame.width - previous.width)),
        Math.min(800, workArea.height - (frame.height - previous.height)));
      return { width: previous.width, height: previous.height };
    });
    console.log(JSON.stringify({ interactionWindow: await shell.evaluate(() => ({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio })) }));
    await shell.locator('#profile-search').fill('');
    await shell.locator('#profile-list').evaluate(node => { node.scrollTop = 0; });
    const originalOrder = await order();
    const clickTarget = originalOrder[1];
    const smallStart = await point(clickTarget);
    await shell.mouse.move(smallStart.x, smallStart.y);
    await shell.mouse.down();
    await shell.evaluate(selector => { window.__qiyeSortClickSource = document.querySelector(selector); }, key('open', clickTarget));
    await state(); // The real state IPC broadcasts while the pointer is held.
    assert.equal(await shell.evaluate(selector => window.__qiyeSortClickSource === document.querySelector(selector), key('open', clickTarget)), true, 'State refresh must preserve the pressed button until its synthetic click');
    await shell.mouse.move(smallStart.x + 3, smallStart.y + 2, { steps: 3 });
    assert.equal(await dragMarkers(), 0);
    await shell.mouse.up();
    await eventually(async () => (await state()).activeId === clickTarget, 'small movement remains a normal environment click');
    const afterSmall = await state();
    await waitForView(clickTarget);
    check(prefix('sub-threshold pointer movement across a state refresh preserves order and still activates exactly the clicked account'), () => {
      assert.deepEqual(afterSmall.profiles.map(profile => profile.id), originalOrder);
      assert.equal(afterSmall.openTabs.filter(tab => tab.id === clickTarget).length, 1);
    });

    await shell.locator('#profile-list').evaluate(node => { node.scrollTop = 0; });
    const beforeDrag = await state();
    const identitiesBeforeDrag = new Map((await sidebarIdentity(beforeDrag.profiles, beforeDrag.activeId)).map(record => [record.id, record]));
    const dragId = originalOrder[0], targetId = originalOrder[1];
    const source = await begin(dragId);
    const sourceVisual = await shell.locator(row(dragId)).evaluate(node => ({ opacity: parseFloat(getComputedStyle(node).opacity), active: node.classList.contains('active') }));
    await moveTo(targetId, .75, source.x);
    const insertion = await marker();
    check(prefix('thresholded dragging dims only its source and paints one blue insertion indicator'), () => {
      assert.ok(sourceVisual.opacity > 0 && sourceVisual.opacity < 1);
      assert.equal(insertion.id, originalOrder[2]);
      assert.equal(insertion.side, 'before');
    });
    await shell.evaluate(selector => {
      window.__qiyeSortSource = document.querySelector(selector);
      window.__qiyeSortMutations = 0;
      window.__qiyeSortEvents = [];
      window.__qiyeSortEventListeners = [];
      const listen = (node, type) => {
        const handler = event => window.__qiyeSortEvents.push({ type, pointerId: event.pointerId,
          buttons: event.buttons, key: event.key, focus: document.activeElement?.dataset.focusKey || document.activeElement?.id,
          draggingId: document.getElementById('profile-list').dataset.draggingId });
        node.addEventListener(type, handler, true);
        window.__qiyeSortEventListeners.push({ node, type, handler });
      };
      listen(window, 'blur');
      listen(document.getElementById('profile-list'), 'lostpointercapture');
      listen(document, 'pointercancel');
      listen(document, 'keydown');
      listen(document.getElementById('profile-search'), 'input');
      window.__qiyeSortObserver = new MutationObserver(records => { window.__qiyeSortMutations += records.length; });
      window.__qiyeSortObserver.observe(document.getElementById('profile-list'), { childList: true });
    }, row(dragId));
    const trace = async phase => console.log(JSON.stringify({ sortPhase: phase, evidence: await shell.evaluate(selector => ({
      draggingId: document.getElementById('profile-list').dataset.draggingId,
      sameNode: window.__qiyeSortSource === document.querySelector(selector), connected: window.__qiyeSortSource.isConnected,
      mutations: window.__qiyeSortMutations, events: window.__qiyeSortEvents.splice(0),
    }), row(dragId)) }));
    await state();
    await trace('state');
    await shell.evaluate(({ id, notes }) => window.browserAPI.updateProfile(id, { notes }), { id: second.id, notes: '后台备注更新期间继续拖动' });
    await trace('inactive profile update');
    await shell.evaluate(id => window.browserAPI.deleteProfile(id), inactive.id);
    await trace('inactive profile delete');
    await shell.evaluate(input => window.browserAPI.createProfile(input), { name: '拖动期间临时新增', startUrl: `${origin}/sorting-concurrent` });
    await trace('create');
    const concurrent = (await state()).profiles.find(profile => profile.name === '拖动期间临时新增');
    await trace('state after create');
    assert.ok(concurrent);
    created.push(concurrent.id);
    await waitForView(concurrent.id);
    await trace('fixture loaded');
    const stableSource = await shell.evaluate(selector => ({
      sameNode: window.__qiyeSortSource === document.querySelector(selector),
      connected: window.__qiyeSortSource.isConnected,
      mutations: window.__qiyeSortMutations,
      markers: document.querySelectorAll('.profile-row.drop-before, .profile-row.drop-after').length,
    }), row(dragId));
    check(prefix('state broadcasts and concurrent creation/deletion preserve the captured source and insertion feedback without replacing sidebar rows'), () => {
      assert.equal(stableSource.sameNode, true);
      assert.equal(stableSource.connected, true);
      assert.equal(stableSource.mutations, 0);
      assert.equal(stableSource.markers, 1);
    });
    await shell.evaluate(() => window.__qiyeSortObserver.disconnect());
    const duringDrag = await state();
    const latestOrder = originalOrder.filter(id => id !== inactive.id).concat(concurrent.id);
    assert.deepEqual(duringDrag.profiles.map(profile => profile.id), latestOrder, 'Hover previews must not sort the latest list, discard newly created accounts or restore deleted accounts');
    assert.equal(duringDrag.activeId, concurrent.id, 'The explicit creation activates its own new account');
    assert.equal(duringDrag.profiles.find(profile => profile.id === second.id).notes, '后台备注更新期间继续拖动');
    const atMiddle = async () => {
      const bounds = await geometry('#profile-list');
      await shell.mouse.move(source.x, bounds.y + bounds.height / 2, { steps: 3 });
      return marker();
    };
    const destinationFor = insertion => insertion.side === 'before' ? insertion.id
      : latestOrder.slice(latestOrder.indexOf(insertion.id) + 1).find(id => id !== dragId) || null;
    // Loading the new account takes real time. A held pointer at an edge must
    // keep scrolling during that time; it is therefore incorrect to expect the
    // earlier indicator to remain the destination. Stop at the non-edge middle
    // and use the actually displayed insertion position for the released move.
    let finalInsertion = await atMiddle();
    if (destinationFor(finalInsertion) === latestOrder[1]) {
      const progress = await shell.locator('#profile-list').evaluate(node => {
        const bounds = node.getBoundingClientRect();
        const firstRow = node.querySelector('.profile-row');
        return { top: bounds.top, bottom: bounds.bottom, scrollTop: node.scrollTop,
          required: Math.min(node.scrollHeight - node.clientHeight, node.scrollTop + firstRow.getBoundingClientRect().height + 5) };
      });
      await shell.mouse.move(source.x, progress.bottom - 4);
      const deadline = Date.now() + 12_000;
      while (Date.now() < deadline && !await shell.locator('#profile-list').evaluate((node, required) => node.scrollTop >= required - 1, progress.required)) {
        await new Promise(resolve => setTimeout(resolve, 16));
      }
      assert.ok(await shell.locator('#profile-list').evaluate((node, required) => node.scrollTop >= required - 1, progress.required), 'Held edge scrolling must advance by a real row before choosing another drop');
      finalInsertion = await atMiddle();
    }
    const destination = destinationFor(finalInsertion);
    let expected = moved(latestOrder, dragId, destination);
    assert.notDeepEqual(expected, latestOrder, 'This real mouse gesture must change the saved order');
    console.log(JSON.stringify({ finalSortDestination: finalInsertion, beforeId: destination,
      viewport: await shell.locator('#profile-list').evaluate(node => {
        const bounds = node.getBoundingClientRect();
        return { top: bounds.top, bottom: bounds.bottom, height: bounds.height, scrollTop: node.scrollTop };
      }) }));
    await screenshot('sidebar-sort-preview');
    await shell.mouse.up();
    await waitOrder(expected);
    await clearDrag();
    const afterDrag = await state();
    check(prefix('dropping an account reorders the sidebar and saves the exact order without switching accounts or changing profile data'), () => {
      assert.equal(afterDrag.activeId, duringDrag.activeId);
      assert.deepEqual(afterDrag.openTabs.map(tab => tab.id), duringDrag.openTabs.map(tab => tab.id));
      const records = new Map(duringDrag.profiles.map(profile => [profile.id, profile]));
      assert.deepEqual(afterDrag.profiles, expected.map(id => records.get(id)));
      assert.deepEqual(disk().profiles.map(profile => profile.id), expected);
      assert.equal(afterDrag.profiles.find(profile => profile.id === second.id).notes, '后台备注更新期间继续拖动');
      assert.equal(disk().profiles.find(profile => profile.id === second.id).notes, '后台备注更新期间继续拖动');
    });
    assert.deepEqual(await sidebarOrder(), expected);
    const identitiesAfterDrag = await sidebarIdentity(afterDrag.profiles, afterDrag.activeId);
    const expectedIdentities = expected.filter(id => id !== concurrent.id).map(id => ({ ...identitiesBeforeDrag.get(id), active: id === duringDrag.activeId }));
    const originalIdentitiesAfterDrag = identitiesAfterDrag.filter(record => record.id !== concurrent.id);
    const concurrentIdentity = identitiesAfterDrag.find(record => record.id === concurrent.id);
    check(prefix('names, avatar resources, colors and the active highlight follow their original environment IDs after sorting'), () => {
      try {
        assert.deepEqual(originalIdentitiesAfterDrag, expectedIdentities);
        assert.equal(concurrentIdentity.name, concurrent.name);
        assert.equal(concurrentIdentity.initial, Array.from(concurrent.name)[0]);
        assert.equal(concurrentIdentity.active, true);
        assert.equal(concurrentIdentity.platformId, null);
      } catch (error) {
        let firstMismatch;
        for (let index = 0; index < expectedIdentities.length && !firstMismatch; index += 1) {
          const actual = originalIdentitiesAfterDrag[index], wanted = expectedIdentities[index];
          for (const field of Object.keys(wanted)) {
            if (actual?.[field] !== wanted[field]) { firstMismatch = { id: wanted.id, field, actual: actual?.[field], expected: wanted[field] }; break; }
          }
        }
        error.uiDetails = { check: 'sidebar identity after sorting', firstMismatch,
          concurrent: { id: concurrent.id, actual: concurrentIdentity, expectedName: concurrent.name, expectedInitial: Array.from(concurrent.name)[0] } };
        throw error;
      }
    });
    const account = await viewScript(ids[0], "({value:localStorage.getItem('ui-account'),cookie:document.cookie})");
    check(prefix('sorting retains the existing isolated account cookie and localStorage'), () => {
      assert.equal(account.value, 'synthetic-A');
      assert.ok(account.cookie.includes('uiAccount=A'));
    });
    // Closing an active native view invalidates pointer capture on Chromium.
    // Do it only after this gesture's release; native cancellation is exercised
    // independently below, without pretending a lost capture must continue.
    await shell.evaluate(id => window.browserAPI.closeProfile(id), concurrent.id);
    await shell.evaluate(id => window.browserAPI.deleteProfile(id), concurrent.id);
    expected = expected.filter(id => id !== concurrent.id);
    await shell.locator('#sidebar-overview').click();
    await shell.locator(key('open', clickTarget)).click();
    await eventually(async () => (await state()).activeId === clickTarget, 'account reactivated after overview');
    check(prefix('switching pages and reopening an environment preserve the saved sidebar order'), () => assert.deepEqual(disk().profiles.map(profile => profile.id), expected));
    assert.deepEqual(await sidebarOrder(), expected);

    const cancelOrder = await order();
    await begin(cancelOrder[0]);
    await moveTo(cancelOrder[1], .75, source.x);
    await shell.keyboard.press('Escape');
    await shell.mouse.up();
    await clearDrag();
    check(prefix('Escape cancels an in-progress sort without persisting a preview or activating its source'), () => assert.ok(true));
    assert.deepEqual(await order(), cancelOrder);
    assert.equal((await state()).activeId, clickTarget);

    // Drag to the bottom edge and keep the pointer stationary: animation-frame
    // scrolling must reach rows that were initially outside the viewport.
    await shell.locator('#profile-list').evaluate(node => { node.scrollTop = 0; });
    const downwardOrder = await order();
    const downId = downwardOrder[0];
    const downStart = await begin(downId);
    const listBox = await geometry('#profile-list');
    const scrollRange = await shell.locator('#profile-list').evaluate(node => node.scrollHeight - node.clientHeight);
    assert.ok(scrollRange > 80, 'Edge scrolling requires genuinely hidden rows');
    await shell.mouse.move(downStart.x, listBox.bottom - 5, { steps: 6 });
    await eventually(() => shell.locator('#profile-list').evaluate(node => node.scrollTop >= node.scrollHeight - node.clientHeight - 2), 'held drag automatically reaches the bottom of the saved list');
    const atBottom = await shell.locator('#profile-list').evaluate(node => node.scrollTop);
    await marker();
    await shell.mouse.up();
    const downExpected = moved(downwardOrder, downId);
    await waitOrder(downExpected);
    await clearDrag();
    check(prefix('holding a drag at the bottom edge scrolls to an unseen final account and drops at the end'), () => {
      assert.ok(atBottom >= scrollRange - 2);
      assert.deepEqual(disk().profiles.map(profile => profile.id), downExpected);
    });
    assert.equal((await state()).activeId, clickTarget);

    const upStart = await begin(downId);
    const topBox = await geometry('#profile-list');
    await shell.mouse.move(upStart.x, topBox.y + 5, { steps: 6 });
    await eventually(() => shell.locator('#profile-list').evaluate(node => node.scrollTop <= 1), 'held drag automatically reaches the top of the saved list');
    await marker();
    await shell.mouse.up();
    const upExpected = moved(downExpected, downId, downExpected[0]);
    await waitOrder(upExpected);
    await clearDrag();
    check(prefix('holding a drag at the top edge scrolls upward and inserts before the initially hidden first account'), () => assert.deepEqual(disk().profiles.map(profile => profile.id), upExpected));
    assert.equal((await state()).activeId, clickTarget);

    const editBox = await geometry(key('edit', clickTarget));
    await shell.mouse.move(editBox.x + editBox.width / 2, editBox.y + editBox.height / 2);
    await shell.mouse.down();
    await shell.mouse.move(editBox.x + editBox.width / 2 + 9, editBox.y + editBox.height / 2, { steps: 3 });
    assert.equal(await dragMarkers(), 0, 'The edit button is not a sorting handle');
    await shell.mouse.up();
    await shell.locator('#profile-dialog').waitFor({ state: 'visible' });
    const editState = await form();
    check(prefix('pointer movement on the edit button opens the normal locked editor without starting a drag'), () => {
      assert.equal(editState.name, (beforeDrag.profiles.find(profile => profile.id === clickTarget)).name);
      assert.equal(editState.open, true);
    });
    assert.equal(await shell.locator('#profile-url').isDisabled(), true);
    await shell.keyboard.press('Escape');
    await closeDialog();
    assert.deepEqual(await order(), upExpected);

    await shell.locator('#profile-list').evaluate(node => { node.scrollTop = 0; });
    await shell.locator('#profile-list').hover();
    await shell.mouse.wheel(0, 180);
    await eventually(() => shell.locator('#profile-list').evaluate(node => node.scrollTop > 1), 'ordinary wheel still scrolls the draggable saved list');
    check(prefix('ordinary wheel scrolling changes neither saved ordering nor the active account'), () => assert.deepEqual(disk().profiles.map(profile => profile.id), upExpected));
    assert.equal((await state()).activeId, clickTarget);

    // The native view can invalidate a mouse gesture when it is closed. Real
    // lostpointercapture must cancel cleanly rather than manufacture a drop or
    // turn the eventual mouse-up into activation of the closed source account.
    await shell.evaluate(input => window.browserAPI.createProfile(input), { name: '原生捕获取消临时环境', startUrl: `${origin}/sorting-native-cancel` });
    const native = (await state()).profiles.find(profile => profile.name === '原生捕获取消临时环境');
    assert.ok(native);
    created.push(native.id);
    await waitForView(native.id);
    await shell.evaluate(() => { window.__qiyeSortEvents.length = 0; });
    await begin(first.id); // Deliberately sort a saved, currently closed source.
    const nativeOrder = await order();
    await shell.evaluate(id => window.browserAPI.closeProfile(id), native.id);
    await clearDrag();
    const afterNativeClose = await state();
    const nativeEvents = await shell.evaluate(() => window.__qiyeSortEvents.splice(0));
    await shell.mouse.up();
    await clearDrag();
    const afterNativeUp = await state();
    check(prefix('native pointer-capture loss cancels sorting without saving a drop or reopening the closed source on mouse-up'), () => {
      assert.ok(nativeEvents.some(event => event.type === 'lostpointercapture'));
      assert.deepEqual(afterNativeUp.profiles.map(profile => profile.id), nativeOrder);
      assert.equal(afterNativeUp.activeId, afterNativeClose.activeId);
      assert.equal(afterNativeUp.openTabs.some(tab => tab.id === first.id), false);
    });
    await shell.locator(key('open', first.id)).click();
    await eventually(async () => (await state()).activeId === first.id, 'a deliberate click works immediately after native cancellation');
    await waitForView(first.id);
    check(prefix('the next deliberate click after native drag cancellation opens and activates its own account normally'), () => assert.ok(true));
    await shell.evaluate(id => window.browserAPI.closeProfile(id), first.id);
    await shell.evaluate(id => window.browserAPI.deleteProfile(id), native.id);
    await shell.evaluate(id => window.browserAPI.openProfile(id), clickTarget);
    assert.deepEqual(await order(), upExpected);

    // Filtered ordering is a relative move, not replacement with visible IDs.
    await shell.evaluate(({ id, beforeId }) => window.browserAPI.moveProfile(id, beforeId), { id: first.id, beforeId: ids[1] });
    await shell.evaluate(({ id, beforeId }) => window.browserAPI.moveProfile(id, beforeId), { id: second.id, beforeId: ids[2] });
    await shell.locator('#profile-search').fill('排序筛选');
    await eventually(() => shell.locator('.profile-row').count().then(count => count === 2), 'filter shows exactly the two saved sorting fixtures');
    const filteredBefore = await order();
    assert.deepEqual(await sidebarOrder(), [first.id, second.id]);
    const filteredStart = await begin(second.id);
    await moveTo(first.id, .25, filteredStart.x);
    await marker();
    await shell.mouse.up();
    const filteredExpected = moved(filteredBefore, second.id, first.id);
    await waitOrder(filteredExpected);
    await clearDrag();
    assert.deepEqual(await sidebarOrder(), [second.id, first.id]);
    await shell.locator('#profile-search').fill('');
    check(prefix('sorting filtered accounts preserves every hidden account and its relative position'), () => {
      assert.deepEqual(disk().profiles.map(profile => profile.id), filteredExpected);
      assert.deepEqual(filteredExpected.filter(id => id !== second.id), filteredBefore.filter(id => id !== second.id));
    });
    assert.deepEqual(await sidebarOrder(), filteredExpected);

    // Reordering must not reintroduce the modifier-induced outline defect.
    await shell.locator(key('open', clickTarget)).click();
    await shell.keyboard.down('Shift');
    await shell.locator('#profile-list').hover();
    await shell.mouse.wheel(0, 120);
    await shell.mouse.wheel(0, -120);
    await shell.keyboard.up('Shift');
    const shiftVisual = await shell.evaluate(() => ({
      dragging: document.querySelectorAll('.profile-row.is-dragging, .profile-row.drop-before, .profile-row.drop-after').length,
      active: [...document.querySelectorAll('.profile-row.active .profile-open')].map(node => node.dataset.focusKey.slice('open:'.length)),
      outlines: [...document.querySelectorAll('.profile-row button')].filter(node => {
        const style = getComputedStyle(node);
        return node.matches(':focus') && style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0;
      }).length,
    }));
    check(prefix('Shift wheel after dragging neither reorders accounts nor leaves extra outlines or selection markers'), () => {
      assert.deepEqual(shiftVisual.active, [clickTarget]);
      assert.equal(shiftVisual.dragging, 0);
      assert.equal(shiftVisual.outlines, 0);
    });
    assert.deepEqual(await order(), filteredExpected);
    await screenshot('sidebar-sort-persisted');
  } finally {
    await shell.mouse.up().catch(() => {});
    await shell.keyboard.up('Shift').catch(() => {});
    await shell.keyboard.press('Escape').catch(() => {});
    await shell.locator('#profile-search').fill('').catch(() => {});
    await shell.evaluate(() => window.__qiyeSortObserver?.disconnect()).catch(() => {});
    await shell.evaluate(() => {
      for (const item of window.__qiyeSortEventListeners || []) item.node.removeEventListener(item.type, item.handler, true);
    }).catch(() => {});
    for (const id of created) {
      if ((await state()).profiles.some(profile => profile.id === id)) await shell.evaluate(id => window.browserAPI.deleteProfile(id), id).catch(() => {});
    }
    // Preserve the original suite's keyboard traversal and tab ordering.
    for (let index = initial.profiles.length - 1; index >= 0; index -= 1) {
      await shell.evaluate(({ id, beforeId }) => window.browserAPI.moveProfile(id, beforeId), {
        id: initial.profiles[index].id, beforeId: initial.profiles[index + 1]?.id ?? null,
      }).catch(() => {});
    }
    if (initial.activeId) await shell.evaluate(id => window.browserAPI.openProfile(id), initial.activeId).catch(() => {});
    else await shell.evaluate(() => window.browserAPI.showOverview()).catch(() => {});
    if (originalWindow) await app.evaluate(({ BrowserWindow }, size) => {
      const main = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/renderer/index.html'));
      main.setContentSize(size.width, size.height);
    }, originalWindow).catch(() => {});
  }
}

module.exports = { verifyInteractions };
