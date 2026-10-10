'use strict';

(() => {
  const api = window.browserAPI;
  const $ = (id) => document.getElementById(id);
  const colors = [
    { name: 'orange', label: '橙色', value: '#e87941' },
    { name: 'green', label: '绿色', value: '#5b8d79' },
    { name: 'blue', label: '蓝色', value: '#658ac0' },
    { name: 'purple', label: '紫色', value: '#9473b5' },
    { name: 'gold', label: '金色', value: '#c39c49' },
    { name: 'pink', label: '粉色', value: '#ca7181' },
  ];
  const iconPaths = {
    panel: ['M3 3h18v18H3zM9 3v18'],
    upload: ['M12 16V3m-5 5 5-5 5 5M4 15v6h16v-6'],
    video: ['M3 5h12v14H3zM15 9l6-4v14l-6-4'],
    image: ['M3 3h18v18H3zM3 16l6-6 5 5 3-3 4 4M15 7h.01'],
    article: ['M5 3h14v18H5zM8 7h8M8 11h8M8 15h5'],
    clock: ['M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0ZM12 6v6l4 2'],
    chart: ['M4 3v18h17M8 16v-5M13 16V7M18 16V4'],
    sparkles: ['m12 3 3 6 6 3-6 3-3 6-3-6-6-3 6-3 3-6ZM20 2v4M18 4h4'],
    plus: ['M12 5v14M5 12h14'],
    grid: ['M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z'],
    search: ['M21 21l-5-5', 'M18 10.5a7.5 7.5 0 1 1-15 0 7.5 7.5 0 0 1 15 0Z'],
    'chevron-right': ['m9 5 7 7-7 7'],
    'arrow-left': ['M19 12H5m6-6-6 6 6 6'],
    'arrow-right': ['M5 12h14m-6-6 6 6-6 6'],
    reload: ['M20 7v5h-5', 'M20 12a8 8 0 1 0-2 5M20 7l-3-3'],
    layers: ['m12 3 10 5-10 5L2 8l10-5Z', 'm2 12 10 5 10-5M2 16l10 5 10-5'],
    lock: ['M6 10h12v11H6z', 'M8 10V6a4 4 0 0 1 8 0v4M12 14v3'],
    sliders: ['M4 21v-7M4 10V3M12 21v-11M12 6V3M20 21v-3M20 14V3M1 10h6M9 6h6M17 14h6'],
    user: ['M20 21v-2a6 6 0 0 0-6-6h-4a6 6 0 0 0-6 6v2', 'M16 6a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z'],
    'shield-check': ['m12 2 8 4v6c0 5-8 10-8 10S4 17 4 12V6l8-4Z', 'm8 12 3 3 5-6'],
    folder: ['M3 7V4h6l2 3h10v13H3V7Z'],
    'folder-plus': ['M3 7V4h6l2 3h10v13H3V7Z', 'M12 10v7M8.5 13.5h7'],
    info: ['M12 11v6M12 7h.01', 'M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0Z'],
    x: ['m6 6 12 12M18 6 6 18'],
    trash: ['M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7'],
    'alert-triangle': ['m12 3 10 18H2L12 3Z', 'M12 9v5M12 17h.01'],
    globe: ['M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0Z', 'M2 12h20M12 2a17 17 0 0 1 0 20 17 17 0 0 1 0-20Z'],
    pencil: ['m15 5 4 4M4 16l12-12a2.8 2.8 0 0 1 4 4L8 20l-5 1 1-5Z'],
  };
  let state = { profiles: [], openTabs: [], activeId: null, dataPath: '', platformPresets: [] };
  let previousActiveId = null;
  let editId = null;
  let deleteId = null;
  let dialogBusy = false;
  let modalOpening = false;
  let focusBeforeModal = null;
  let focusKeyBeforeModal = null;
  let boundsFrame = 0;
  let lastBounds = '';
  const profileRows = new Map();
  let previousProfileQuery = null;
  let cardsFingerprint = null;
  let platformChoicesBuilt = false;
  let selectedPlatformId = null;
  let customUrlDraft = '';
  let profileErrorField = null;
  let profileInvalidFrame = 0;
  let profileDrag = null;
  let profileRowsDeferred = false;
  let dragScrollFrame = 0;
  let cancelledDragPointerId = null;
  let suppressProfileClick = false;
  let suppressClickTimer = 0;
  const dialogIds = ['profile-dialog', 'delete-dialog', 'diagnostics-dialog'];
  let diagnosticsReport = null;
  let diagnosticsBusy = false;
  let diagnosticsTimer = null;
  let diagnosticsPollGeneration = 0;
  const navigation = window.createNavigationController({ api, icon, notify,
    beforeChange: finishProfileDrag, blocked: dialogIsOpen,
    changed: () => {
      renderNavigation();
      scheduleBounds();
      api?.positionToast(toastBounds()).catch(() => {});
    }
  });
  window.getNavigationPreferences = () => navigation.preferences();

  // Modifier-only key presses must not turn a mouse-focused environment
  // control into a keyboard selection. Keep actual keyboard navigation visible.
  const navigationKeys = new Set(['Tab', 'Enter', ' ', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown', 'Escape']);
  document.addEventListener('pointerdown', () => {
    document.documentElement.dataset.environmentFocus = 'pointer';
  }, { capture: true, passive: true });
  document.addEventListener('keydown', (event) => {
    if (navigationKeys.has(event.key)) document.documentElement.dataset.environmentFocus = 'keyboard';
  }, { capture: true });

  function icon(name) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.6');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    for (const d of iconPaths[name] || iconPaths.grid) {
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', d);
      svg.append(path);
    }
    return svg;
  }

  document.querySelectorAll('[data-icon]').forEach((node) => node.append(icon(node.dataset.icon)));

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = String(text);
    return node;
  }

  function button(className, label, action, iconName) {
    const node = element('button', className);
    node.type = 'button';
    if (iconName) node.append(icon(iconName));
    if (label) node.append(document.createTextNode(label));
    node.addEventListener('click', action);
    return node;
  }

  function colorName(value) { return (colors.find((item) => item.value === value) || colors[0]).name; }
  function findProfile(id) { return state.profiles.find((profile) => profile.id === id); }
  function isOpen(id) { return state.openTabs.some((tab) => tab.id === id); }
  function activeTab() { return state.openTabs.find((tab) => tab.id === state.activeId); }
  function dialogIsOpen() { return !!document.querySelector('dialog[open]') || modalOpening; }
  function initials(name) { return Array.from(String(name || '环境').trim())[0] || '环'; }
  function findPlatform(id) { return Array.isArray(state.platformPresets) ? state.platformPresets.find((preset) => preset.id === id) : undefined; }

  function avatar(profile) {
    const node = element('span', 'profile-icon', initials(profile.name));
    node.dataset.color = colorName(profile.color);
    node.setAttribute('aria-hidden', 'true');
    const platform = findPlatform(profile.platformId);
    if (platform) {
      const image = element('img', 'profile-platform-image');
      image.alt = '';
      image.draggable = false;
      image.hidden = true;
      image.addEventListener('load', () => {
        image.hidden = false;
        node.replaceChildren(image);
        node.classList.add('has-platform-icon');
        node.dataset.platformId = platform.id;
      }, { once: true });
      image.addEventListener('error', () => {
        node.replaceChildren(document.createTextNode(initials(profile.name)));
        node.classList.remove('has-platform-icon');
        delete node.dataset.platformId;
      }, { once: true });
      node.append(image);
      image.src = platform.iconResource;
    }
    return node;
  }

  function syncPlatformSelection() {
    for (const input of $('platform-presets').querySelectorAll('input[name="platform"]')) input.checked = input.value === selectedPlatformId;
    $('custom-platform').checked = selectedPlatformId === null;
    $('profile-url-field').hidden = selectedPlatformId !== null;
    $('profile-url').readOnly = Boolean(editId) || selectedPlatformId !== null;
    $('profile-url').disabled = dialogBusy || Boolean(editId);
    $('profile-launch-settings').disabled = dialogBusy || Boolean(editId);
  }

  function choosePlatform(id) {
    if (dialogBusy || editId) return;
    const platform = findPlatform(id);
    if (platform) {
      if (selectedPlatformId === null) customUrlDraft = $('profile-url').value;
      selectedPlatformId = platform.id;
      $('profile-url').value = platform.launchUrl;
    } else {
      selectedPlatformId = null;
      $('profile-url').value = customUrlDraft;
    }
    syncPlatformSelection();
  }

  function buildPlatformChoices() {
    if (platformChoicesBuilt || !Array.isArray(state.platformPresets) || !state.platformPresets.length) return;
    const choices = state.platformPresets.map((platform) => {
      const label = element('label', 'platform-preset');
      label.dataset.platformId = platform.id;
      const input = element('input', 'platform-preset-input');
      input.type = 'radio';
      input.name = 'platform';
      input.value = platform.id;
      input.disabled = dialogBusy || Boolean(editId);
      input.setAttribute('aria-label', platform.displayName);
      input.addEventListener('change', () => { if (input.checked) choosePlatform(platform.id); });
      const content = element('span', 'platform-preset-content');
      const image = element('img', 'platform-preset-image');
      image.alt = '';
      image.hidden = true;
      const fallback = element('span', 'platform-preset-fallback', initials(platform.displayName));
      fallback.setAttribute('aria-hidden', 'true');
      image.addEventListener('load', () => { image.hidden = false; fallback.hidden = true; }, { once: true });
      image.addEventListener('error', () => { image.hidden = true; fallback.hidden = false; }, { once: true });
      content.append(image, fallback, element('span', 'platform-preset-name', platform.displayName));
      label.append(input, content);
      image.src = platform.iconResource;
      return label;
    });
    $('platform-presets').replaceChildren(...choices);
    $('platform-presets-status').hidden = true;
    platformChoicesBuilt = true;
    syncPlatformSelection();
  }

  function status(profile) {
    const node = element('span', 'profile-meta');
    node.append(element('span', `status-dot${isOpen(profile.id) ? '' : ' closed'}`));
    node.append(document.createTextNode(isOpen(profile.id) ? '已打开' : '已保存'));
    return node;
  }

  function applyState(next) {
    if (!next || !Array.isArray(next.profiles) || !Array.isArray(next.openTabs)) return;
    state = next;
    navigation.initialize(next);
    buildPlatformChoices();
    render();
  }

  async function call(method, ...args) {
    if (!api || typeof api[method] !== 'function') throw new Error('浏览器接口尚未连接，请重新启动应用。');
    if (['openProfile', 'createProfile', 'showOverview'].includes(method)) await navigation.environmentAction();
    const result = await api[method](...args);
    applyState(result);
    return result;
  }

  async function action(method, ...args) {
    try { return await call(method, ...args); }
    catch (error) { notify(error.message || '操作未能完成，请重试。', 'error'); }
  }

  function toastBounds() {
    const toolbar = document.querySelector('.navigation-toolbar').getBoundingClientRect();
    const main = document.querySelector('.main-panel').getBoundingClientRect();
    return { x: Math.round(main.left), y: Math.round(toolbar.bottom), width: Math.round(main.width) };
  }

  function notify(message, type = 'success') {
    api?.showToast({ message: String(message).slice(0, 1000), type, bounds: toastBounds() }).catch(() => {});
  }

  function updateProfileRow(entry, profile) {
    entry.row.classList.toggle('active', state.activeId === profile.id);
    const title = profile.notes ? `${profile.name}\n${profile.notes}` : profile.name;
    if (entry.open.title !== title) entry.open.title = title;
    entry.open.setAttribute('aria-label', `打开环境：${profile.name}`);
    entry.edit.setAttribute('aria-label', `编辑环境：${profile.name}`);
    if (entry.name.textContent !== profile.name) entry.name.textContent = profile.name;
    const opened = isOpen(profile.id);
    entry.dot.classList.toggle('closed', !opened);
    const statusText = opened ? '已打开' : '已保存';
    if (entry.statusText.nodeValue !== statusText) entry.statusText.nodeValue = statusText;
    const platform = findPlatform(profile.platformId);
    const avatarKey = platform ? `${platform.id}:${platform.iconResource}` : '';
    if (entry.avatarKey !== avatarKey) {
      const next = avatar(profile);
      entry.avatar.replaceWith(next);
      entry.avatar = next;
      entry.avatarKey = avatarKey;
    }
    entry.avatar.dataset.color = colorName(profile.color);
    const initial = [...entry.avatar.childNodes].find(node => node.nodeType === Node.TEXT_NODE);
    if (initial && initial.nodeValue !== initials(profile.name)) initial.nodeValue = initials(profile.name);
  }

  function profileRow(profile) {
    let entry = profileRows.get(profile.id);
    if (!entry) {
      const row = element('div', 'profile-row');
      row.dataset.profileId = profile.id;
      const open = button('profile-open', '', () => action('openProfile', profile.id));
      open.dataset.focusKey = `open:${profile.id}`;
      const label = element('span', 'profile-row-text');
      const name = element('span', 'profile-name');
      const meta = element('span', 'profile-meta');
      const dot = element('span', 'status-dot');
      const statusText = document.createTextNode('');
      meta.append(dot, statusText);
      label.append(name, meta);
      const image = avatar(profile);
      open.append(image, label);
      const edit = button('icon-button profile-edit', '', () => {
        const current = findProfile(profile.id);
        if (current) openProfileDialog(current);
      }, 'pencil');
      edit.title = '编辑环境';
      edit.dataset.focusKey = `edit:${profile.id}`;
      row.append(open, edit);
      const platform = findPlatform(profile.platformId);
      entry = { row, open, edit, name, dot, statusText, avatar: image, avatarKey: platform ? `${platform.id}:${platform.iconResource}` : '' };
      profileRows.set(profile.id, entry);
    }
    updateProfileRow(entry, profile);
    return entry.row;
  }

  function renderProfiles() {
    const query = $('profile-search').value.trim().toLocaleLowerCase();
    const filtered = state.profiles.filter((profile) => `${profile.name} ${profile.notes || ''}`.toLocaleLowerCase().includes(query));
    $('profile-count').textContent = String(state.profiles.length);
    $('overview-count').textContent = String(state.profiles.length);
    $('sidebar-overview').classList.toggle('active', !state.activeId);
    $('sidebar-overview').setAttribute('aria-current', state.activeId ? 'false' : 'page');
    // A captured gesture keeps its existing nodes and insertion markers until
    // release. Normal updates reconcile by UUID without remounting icons.
    if (!profileDrag) {
      profileRowsDeferred = false;
      const list = $('profile-list');
      const sidebar = document.querySelector('.sidebar');
      const savedScroll = query === previousProfileQuery ? list.scrollTop : 0;
      const savedSidebarScroll = sidebar.scrollTop;
      const ids = new Set(state.profiles.map(profile => profile.id));
      const visible = new Set(filtered.map(profile => profile.id));
      for (const [id, entry] of profileRows) {
        if (!ids.has(id)) { entry.row.remove(); profileRows.delete(id); }
      }
      for (const row of [...list.children]) if (!visible.has(row.dataset.profileId)) row.remove();
      let position = list.firstElementChild;
      for (const profile of filtered) {
        const row = profileRow(profile);
        if (row !== position) list.insertBefore(row, position);
        position = row.nextElementSibling;
      }
      list.hidden = !filtered.length;
      $('sidebar-empty').hidden = Boolean(filtered.length);
      if (navigation.environmentVisible()) list.scrollTop = Math.min(savedScroll, Math.max(0, list.scrollHeight - list.clientHeight));
      sidebar.scrollTop = Math.min(savedSidebarScroll, Math.max(0, sidebar.scrollHeight - sidebar.clientHeight));
      previousProfileQuery = query;
    } else {
      profileRowsDeferred = true;
      for (const row of $('profile-list').children) row.classList.toggle('active', row.dataset.profileId === state.activeId);
    }
    $('sidebar-empty').replaceChildren(document.createTextNode(state.profiles.length ? '没有找到匹配的环境' : '还没有保存的环境'), element('br'), element('span', '', state.profiles.length ? '试试其他名称或备注' : '从新建第一个环境开始'));
    const creationOrder = [...state.profiles].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id.localeCompare(b.id));
    const fingerprint = JSON.stringify(creationOrder.map(profile => [profile.id, profile.name, profile.notes, profile.color, profile.createdAt, profile.platformId, isOpen(profile.id)]));
    if (fingerprint !== cardsFingerprint) {
    cardsFingerprint = fingerprint;
    $('profile-cards').replaceChildren(...creationOrder.map((profile) => {
      const card = element('article', 'profile-card');
      const top = element('div', 'card-top');
      const edit = button('icon-button', '', () => openProfileDialog(profile), 'pencil');
      edit.title = '编辑环境';
      edit.setAttribute('aria-label', `编辑环境：${profile.name}`);
      edit.dataset.focusKey = `card-edit:${profile.id}`;
      top.append(avatar(profile), edit);
      const title = element('h3', 'card-title', profile.name);
      title.title = profile.name;
      const footer = element('div', 'card-footer');
      const cardStatus = status(profile);
      cardStatus.className = 'card-status';
      const open = button('card-open', isOpen(profile.id) ? '切换到环境' : '打开环境', () => action('openProfile', profile.id));
      open.append(icon('arrow-right'));
      open.setAttribute('aria-label', `${isOpen(profile.id) ? '切换到' : '打开'}环境：${profile.name}`);
      open.dataset.focusKey = `card-open:${profile.id}`;
      footer.append(cardStatus, open);
      card.append(top, title, element('p', 'card-note', profile.notes || '暂无备注，可在编辑中记录账号用途。'), footer);
      return card;
    }));
    }
    $('overview-empty').hidden = Boolean(state.profiles.length);
    $('profile-cards').hidden = !state.profiles.length;
  }

  function clearDropIndicators() {
    for (const row of $('profile-list').children) row.classList.remove('drop-before', 'drop-after');
  }

  function updateDropTarget() {
    if (!profileDrag?.started) return;
    clearDropIndicators();
    profileDrag.validTarget = false;
    const list = $('profile-list');
    const bounds = list.getBoundingClientRect();
    if (profileDrag.x < bounds.left || profileDrag.x > bounds.right || profileDrag.y < bounds.top || profileDrag.y > bounds.bottom) return;
    const rows = [...list.children].filter((row) => row.dataset.profileId !== profileDrag.id && findProfile(row.dataset.profileId));
    if (!rows.length) return;
    const before = rows.find((row) => {
      const rect = row.getBoundingClientRect();
      return profileDrag.y < rect.top + rect.height / 2;
    });
    if (before) {
      profileDrag.beforeId = before.dataset.profileId;
      before.classList.add('drop-before');
    } else {
      const last = rows[rows.length - 1];
      // In a filtered list, drop after the last visible result without moving
      // it past the hidden records that originally followed that result.
      const lastIndex = state.profiles.findIndex((profile) => profile.id === last.dataset.profileId);
      profileDrag.beforeId = state.profiles.slice(lastIndex + 1).find((profile) => profile.id !== profileDrag.id)?.id || null;
      last.classList.add('drop-after');
    }
    profileDrag.validTarget = true;
  }

  function scrollDuringDrag(time) {
    dragScrollFrame = 0;
    if (!profileDrag?.started) return;
    const list = $('profile-list');
    const rect = list.getBoundingClientRect();
    const edge = Math.min(36, rect.height / 3);
    const elapsed = Math.min(32, Math.max(1, time - (profileDrag.scrollTime || time)));
    profileDrag.scrollTime = time;
    if (profileDrag.x >= rect.left && profileDrag.x <= rect.right && profileDrag.y >= rect.top && profileDrag.y <= rect.bottom) {
      const upward = Math.max(0, Math.min(1, (rect.top + edge - profileDrag.y) / edge));
      const downward = Math.max(0, Math.min(1, (profileDrag.y - rect.bottom + edge) / edge));
      list.scrollTop += (downward - upward) * elapsed * .55;
    }
    updateDropTarget();
    dragScrollFrame = requestAnimationFrame(scrollDuringDrag);
  }

  function suppressDragClick() {
    suppressProfileClick = true;
    window.clearTimeout(suppressClickTimer);
    // Pointer-up's synthetic click belongs to this gesture; the next deliberate
    // click remains a normal open/switch action.
    suppressClickTimer = window.setTimeout(() => { suppressProfileClick = false; }, 0);
  }

  function finishProfileDrag(save = false, released = false) {
    const drag = profileDrag;
    if (!drag) return;
    profileDrag = null;
    cancelAnimationFrame(dragScrollFrame);
    dragScrollFrame = 0;
    if (drag.started) {
      if (released) suppressDragClick();
      else cancelledDragPointerId = drag.pointerId;
      delete $('profile-list').dataset.draggingId;
      drag.row.classList.remove('is-dragging');
      clearDropIndicators();
      if ($('profile-list').hasPointerCapture(drag.pointerId)) $('profile-list').releasePointerCapture(drag.pointerId);
      const moving = findProfile(drag.id);
      const currentIndex = state.profiles.findIndex((profile) => profile.id === drag.id);
      const currentNext = state.profiles[currentIndex + 1]?.id || null;
      const canSave = save && drag.validTarget && moving && (drag.beforeId === null || findProfile(drag.beforeId));
      if (canSave && currentNext !== drag.beforeId) {
        const profiles = state.profiles.filter((profile) => profile.id !== drag.id);
        const index = drag.beforeId === null ? profiles.length : profiles.findIndex((profile) => profile.id === drag.beforeId);
        profiles.splice(index, 0, moving);
        state = { ...state, profiles };
        render();
        // Submit just the moved ID and destination to preserve concurrent edits
        // and newly created environments in the main process's current list.
        action('moveProfile', drag.id, drag.beforeId).then((result) => { if (!result) action('getState'); });
      } else render();
    } else if (profileRowsDeferred) {
      // A click is dispatched after pointer-up. Do not remove its original
      // button until the browser has delivered that normal open/switch action.
      requestAnimationFrame(() => render());
    }
  }

  $('profile-list').addEventListener('pointerdown', (event) => {
    if (event.button === 0 && profileDrag) finishProfileDrag();
    cancelledDragPointerId = null;
    if (event.button !== 0 || event.pointerType !== 'mouse' || dialogIsOpen() || event.target.closest('.profile-edit')) return;
    const row = event.target.closest('.profile-row');
    if (!row || !findProfile(row.dataset.profileId)) return;
    profileDrag = { id: row.dataset.profileId, pointerId: event.pointerId, row, startX: event.clientX, startY: event.clientY, x: event.clientX, y: event.clientY, started: false, validTarget: false, beforeId: null };
  });
  document.addEventListener('pointermove', (event) => {
    if (!profileDrag || event.pointerId !== profileDrag.pointerId) return;
    if (!(event.buttons & 1)) { finishProfileDrag(); return; }
    profileDrag.x = event.clientX;
    profileDrag.y = event.clientY;
    if (!profileDrag.started) {
      if (Math.hypot(event.clientX - profileDrag.startX, event.clientY - profileDrag.startY) < 8) return;
      const row = [...$('profile-list').children].find((item) => item.dataset.profileId === profileDrag.id);
      if (!row || !findProfile(profileDrag.id)) { finishProfileDrag(); return; }
      profileDrag.row = row;
      profileDrag.started = true;
      row.classList.add('is-dragging');
      $('profile-list').dataset.draggingId = profileDrag.id;
      $('profile-list').setPointerCapture(event.pointerId);
      dragScrollFrame = requestAnimationFrame(scrollDuringDrag);
    }
    event.preventDefault();
    updateDropTarget();
  }, { capture: true });
  document.addEventListener('pointerup', (event) => {
    if (event.pointerId === cancelledDragPointerId) {
      cancelledDragPointerId = null;
      suppressDragClick();
    }
    if (!profileDrag || event.pointerId !== profileDrag.pointerId) return;
    profileDrag.x = event.clientX;
    profileDrag.y = event.clientY;
    updateDropTarget();
    finishProfileDrag(true, true);
  }, { capture: true });
  document.addEventListener('pointercancel', (event) => { if (profileDrag?.pointerId === event.pointerId) finishProfileDrag(); }, { capture: true });
  $('profile-list').addEventListener('lostpointercapture', (event) => {
    if (profileDrag?.started && event.pointerId === profileDrag.pointerId && !$('profile-list').hasPointerCapture(event.pointerId)) finishProfileDrag();
  });
  $('profile-list').addEventListener('click', (event) => {
    if (!suppressProfileClick || event.detail === 0) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    suppressProfileClick = false;
  }, { capture: true });
  $('profile-list').addEventListener('dragstart', (event) => event.preventDefault());
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !profileDrag) return;
    event.preventDefault();
    finishProfileDrag();
  }, { capture: true });
  window.addEventListener('blur', () => finishProfileDrag());

  function renderTabs() {
    const overview = element('div', `tab overview-tab${state.activeId ? '' : ' active'}`);
    const home = button('tab-select', '工作空间', () => action('showOverview'), 'grid');
    home.role = 'tab';
    home.setAttribute('aria-selected', String(!state.activeId));
    home.setAttribute('aria-controls', 'overview-view');
    home.dataset.focusKey = 'overview-tab';
    overview.append(home);
    const tabs = state.openTabs.map((tab) => {
      const profile = findProfile(tab.id);
      if (!profile) return null;
      const root = element('div', `tab${state.activeId === tab.id ? ' active' : ''}`);
      const select = button('tab-select', '', () => action('openProfile', tab.id));
      select.role = 'tab';
      select.setAttribute('aria-selected', String(state.activeId === tab.id));
      select.setAttribute('aria-controls', 'browser-view');
      select.dataset.focusKey = `tab:${tab.id}`;
      const dot = element('span', 'tab-color-dot');
      dot.dataset.color = colorName(profile.color);
      select.append(dot, element('span', '', profile.name));
      select.title = `${profile.name}${tab.title ? ` · ${tab.title}` : ''}`;
      const close = button('icon-button tab-close', '', () => action('closeProfile', tab.id), 'x');
      close.title = '关闭标签页（保留环境数据）';
      close.setAttribute('aria-label', `关闭 ${profile.name} 标签页，保留环境数据`);
      close.dataset.focusKey = `close:${tab.id}`;
      root.append(select, close);
      return root;
    }).filter(Boolean);
    $('tab-list').replaceChildren(overview, ...tabs);
  }

  function renderNavigation() {
    const tab = activeTab();
    const environment = navigation.module() === 'environment';
    const browsing = environment && Boolean(tab);
    const leased = state.publishingLeases?.includes(state.activeId);
    $('publishing-lease').hidden = !leased;
    $('module-view').hidden = environment;
    document.querySelector('.tab-bar').hidden = !environment;
    document.querySelector('.navigation-toolbar').hidden = !environment;
    $('overview-view').hidden = !environment || browsing;
    $('browser-view').hidden = !browsing;
    $('back-button').disabled = leased || !tab || !tab.canGoBack;
    $('forward-button').disabled = leased || !tab || !tab.canGoForward;
    $('reload-button').disabled = leased || !tab;
    $('active-settings').disabled = !tab;
    $('login-diagnostics-button').disabled = !tab;
    $('settings-edit-environment').disabled = !tab;
    $('address-input').disabled = leased || !tab;
    $('address-environment').hidden = !tab;
    if (previousActiveId !== state.activeId || document.activeElement !== $('address-input')) {
      $('address-input').value = tab ? (tab.url || findProfile(tab.id)?.lastUrl || findProfile(tab.id)?.startUrl || '') : '';
    }
    $('address-icon').replaceChildren(icon(tab ? 'globe' : 'grid'));
    $('browser-loading').hidden = !tab?.loading;
    $('browser-error').hidden = !tab?.error;
    $('browser-error-message').textContent = tab?.error ? (typeof tab.error === 'string' ? tab.error : tab.error.message || '请检查网络连接，或尝试输入其他网址。') : '';
    previousActiveId = state.activeId;
  }

  function render() {
    const focusKey = document.activeElement?.dataset.focusKey;
    const activeChanged = previousActiveId !== state.activeId;
    renderProfiles();
    renderTabs();
    renderNavigation();
    $('persistence-warning').hidden = !state.persistenceWarning;
    $('persistence-warning').textContent = state.persistenceWarning || '';
    $('data-path-detail').textContent = state.dataPath || '尚未取得保存位置';
    navigation.sync();
    if (focusKey) {
      const match = [...document.querySelectorAll('[data-focus-key]')].find((node) => node.dataset.focusKey === focusKey);
      match?.focus({ preventScroll: true });
    }
    if (activeChanged) $('tab-list').querySelector('.tab.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    scheduleBounds();
  }

  function scheduleBounds() {
    if (boundsFrame) return;
    boundsFrame = requestAnimationFrame(() => {
      boundsFrame = 0;
      // Hidden module panes have zero geometry. Preserve the running account's
      // viewport instead of resizing it to zero on a navigation switch.
      if (navigation.module() !== 'environment') return;
      const rect = $('browser-viewport').getBoundingClientRect();
      const browsing = Boolean(activeTab());
      const bounds = { x: Math.round(rect.x), y: Math.round(rect.y), width: browsing ? Math.round(rect.width) : 0, height: browsing ? Math.round(rect.height) : 0 };
      if (!browsing) {
        const available = $('overview-view').getBoundingClientRect();
        bounds.backing = { x: Math.round(available.x), y: Math.round(available.y), width: Math.round(available.width), height: Math.round(available.height) };
      }
      const key = JSON.stringify(bounds);
      if (key === lastBounds) return;
      lastBounds = key;
      if (api?.setContentBounds) api.setContentBounds(bounds).catch((error) => {
        lastBounds = '';
        notify(error.message || '网页视图未能更新。', 'error');
      });
    });
  }

  async function setOverlay(visible) {
    await call('setOverlayVisible', visible);
    if (!visible) scheduleBounds();
  }

  function setDialogBusy(value) {
    dialogBusy = value;
    ['profile-save', 'profile-cancel', 'profile-dialog-close', 'profile-delete', 'delete-confirm', 'delete-cancel', 'delete-dialog-close'].forEach((id) => { $(id).disabled = value; });
    document.querySelectorAll('input[name="platform"]').forEach((input) => { input.disabled = value || Boolean(editId); });
    syncPlatformSelection();
    $('profile-save').textContent = value ? '正在保存…' : (editId ? '保存修改' : '创建并打开');
    $('delete-confirm').textContent = value ? '正在删除…' : '永久删除';
  }

  function selectColor(value) {
    const choice = $('color-choices').querySelector(`input[value="${colors.some((color) => color.value === value) ? value : colors[0].value}"]`);
    if (choice) choice.checked = true;
  }

  for (const color of colors) {
    const label = element('label', 'color-choice');
    label.title = color.label;
    const input = element('input');
    input.type = 'radio';
    input.name = 'color';
    input.value = color.value;
    input.setAttribute('aria-label', color.label);
    const swatch = element('span', 'color-swatch');
    swatch.dataset.color = color.name;
    label.append(input, swatch);
    $('color-choices').append(label);
  }

  async function openProfileDialog(profile = null) {
    if (dialogIsOpen()) return;
    finishProfileDrag();
    modalOpening = true;
    focusBeforeModal = document.activeElement;
    focusKeyBeforeModal = focusBeforeModal?.dataset.focusKey;
    try {
      await setOverlay(true);
      editId = profile ? profile.id : null;
      $('profile-form').reset();
      $('profile-name').value = profile?.name || '';
      $('profile-notes').value = profile?.notes || '';
      $('profile-url').value = profile?.startUrl || 'https://www.douyin.com';
      customUrlDraft = $('profile-url').value;
      selectedPlatformId = findPlatform(profile?.platformId)?.id || null;
      syncPlatformSelection();
      selectColor(profile?.color || colors[state.profiles.length % colors.length].value);
      $('profile-dialog-title').textContent = profile ? '编辑环境' : '新建独立环境';
      // Disable native close requests too: Chromium's repeated Escape can
      // issue a non-cancelable request after a prevented cancel event.
      $('profile-dialog').setAttribute('closedby', profile ? 'closerequest' : 'none');
      $('profile-dialog-description').textContent = profile ? '更新名称、备注与环境颜色，便于识别这个账号空间。' : '从全新的登录状态开始，为一个账号创建专属空间。';
      $('profile-launch-help').textContent = profile ? '启动网址及平台在创建后不可修改；再次打开会恢复上次的页面。' : '首次打开时访问的网址；再次打开会恢复上次的页面。';
      $('profile-cancel').hidden = !profile;
      $('profile-delete').hidden = !profile;
      $('new-profile-tip').hidden = Boolean(profile);
      clearProfileError();
      setDialogBusy(false);
      $('profile-dialog').showModal();
      $('profile-dialog-body').scrollTop = 0;
      $('profile-name').focus({ preventScroll: true });
      if (profile) $('profile-name').select();
    } catch (error) {
      notify(error.message || '无法打开编辑窗口。', 'error');
      await action('setOverlayVisible', false);
    } finally { modalOpening = false; }
  }

  async function closeDialog(dialog, restoreFocus = true) {
    if (dialogBusy || (dialog.id === 'diagnostics-dialog' && diagnosticsBusy)) return;
    if (dialog.id === 'diagnostics-dialog') stopDiagnosticsPolling();
    dialog.close();
    await action('setOverlayVisible', false);
    scheduleBounds();
    if (restoreFocus) {
      const target = focusBeforeModal?.isConnected ? focusBeforeModal :
        [...document.querySelectorAll('[data-focus-key]')].find((node) => node.dataset.focusKey === focusKeyBeforeModal);
      (target || $('sidebar-create')).focus({ preventScroll: true });
    }
  }

  function stopDiagnosticsPolling() {
    diagnosticsPollGeneration += 1;
    window.clearTimeout(diagnosticsTimer);
    diagnosticsTimer = null;
  }

  function renderDiagnostics() {
    const running = diagnosticsReport?.running === true;
    $('diagnostics-start').disabled = diagnosticsBusy;
    $('diagnostics-stop').disabled = diagnosticsBusy || !running;
    $('diagnostics-save').disabled = diagnosticsBusy || !diagnosticsReport;
    $('diagnostics-close').disabled = diagnosticsBusy;
    $('diagnostics-dialog-close').disabled = diagnosticsBusy;
    if (!diagnosticsReport) {
      $('diagnostics-status').textContent = '尚未开始记录。';
      $('diagnostics-report').hidden = true;
      $('diagnostics-report').textContent = '';
      return;
    }
    const seconds = Number.isFinite(diagnosticsReport.remainingSeconds) ? Math.max(0, Math.ceil(diagnosticsReport.remainingSeconds)) : 0;
    $('diagnostics-status').textContent = running ? `正在记录，最多还剩 ${seconds} 秒。` : '记录已结束，可以查看或保存报告。';
    const visibleReport = {};
    for (const key of ['schemaVersion', 'runtime', 'counters', 'page', 'running', 'remainingSeconds', 'stopReason']) {
      if (Object.hasOwn(diagnosticsReport, key)) visibleReport[key] = diagnosticsReport[key];
    }
    $('diagnostics-report').textContent = JSON.stringify(visibleReport, null, 2);
    $('diagnostics-report').hidden = false;
  }

  function scheduleDiagnosticsPoll() {
    window.clearTimeout(diagnosticsTimer);
    diagnosticsTimer = null;
    if (!$('diagnostics-dialog').open || !diagnosticsReport?.running || diagnosticsBusy) return;
    const generation = diagnosticsPollGeneration;
    diagnosticsTimer = window.setTimeout(async () => {
      diagnosticsTimer = null;
      try {
        const report = await call('getLoginDiagnostics');
        if (generation !== diagnosticsPollGeneration || !$('diagnostics-dialog').open) return;
        diagnosticsReport = report;
        renderDiagnostics();
        scheduleDiagnosticsPoll();
      } catch (error) {
        if (generation !== diagnosticsPollGeneration || !$('diagnostics-dialog').open) return;
        $('diagnostics-error').textContent = error.message || '诊断报告未能更新，请关闭后重新打开。';
        $('diagnostics-error').hidden = false;
      }
    }, 1000);
  }

  async function openDiagnosticsDialog() {
    if (!activeTab() || dialogIsOpen()) return;
    finishProfileDrag();
    modalOpening = true;
    focusBeforeModal = document.activeElement;
    focusKeyBeforeModal = focusBeforeModal?.dataset.focusKey;
    stopDiagnosticsPolling();
    try {
      await setOverlay(true);
      diagnosticsReport = await call('getLoginDiagnostics');
      diagnosticsBusy = false;
      $('diagnostics-error').hidden = true;
      renderDiagnostics();
      $('diagnostics-dialog').showModal();
      $('diagnostics-start').focus();
      scheduleDiagnosticsPoll();
    } catch (error) {
      notify(error.message || '无法打开登录诊断。', 'error');
      await action('setOverlayVisible', false);
    } finally { modalOpening = false; }
  }

  async function runDiagnosticsAction(method) {
    if (diagnosticsBusy) return;
    diagnosticsBusy = true;
    stopDiagnosticsPolling();
    $('diagnostics-error').hidden = true;
    renderDiagnostics();
    try {
      const result = await call(method);
      if (method === 'saveLoginDiagnostics') {
        diagnosticsReport = await call('getLoginDiagnostics');
        if (result?.saved) notify('诊断报告已保存。');
      } else diagnosticsReport = result;
      diagnosticsBusy = false;
      renderDiagnostics();
      if (method === 'startLoginDiagnostics') {
        await closeDialog($('diagnostics-dialog'));
        notify('请在网页手动执行一次登录，再打开“登录诊断”查看或保存报告。', 'info');
      } else scheduleDiagnosticsPoll();
    } catch (error) {
      diagnosticsBusy = false;
      renderDiagnostics();
      $('diagnostics-error').textContent = error.message || '诊断操作未能完成，请重试。';
      $('diagnostics-error').hidden = false;
      scheduleDiagnosticsPoll();
    }
  }

  async function openDeleteDialog() {
    const profile = findProfile(editId);
    if (!profile || dialogBusy) return;
    deleteId = profile.id;
    $('profile-dialog').close();
    $('delete-profile-name').textContent = profile.name;
    $('delete-error').hidden = true;
    $('delete-dialog').showModal();
    $('delete-cancel').focus();
  }

  function normalizeUrl(value) {
    let candidate = value.trim();
    if (!candidate) throw new Error('请填写启动网址。');
    if (!/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(candidate)) candidate = `https://${candidate}`;
    let url;
    try { url = new URL(candidate); } catch { throw new Error('请填写有效网址，例如 https://www.douyin.com。'); }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('启动网址需要以 https:// 或 http:// 开头。');
    if (!url.hostname || url.username || url.password) throw new Error('请填写不含账号密码的网页地址。');
    return url.href;
  }

  function clearProfileError() {
    $('profile-form-error').hidden = true;
    if (profileErrorField) {
      profileErrorField.removeAttribute('aria-invalid');
      profileErrorField.removeAttribute('aria-errormessage');
      profileErrorField = null;
    }
  }

  function revealProfileField(field) {
    if (!$('profile-dialog').open || !field || field.disabled) return;
    field.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
    field.focus({ preventScroll: true });
  }

  // Keep the browser's required-field message, and reveal only the first
  // invalid control when several fields fail the same validation attempt.
  $('profile-form').addEventListener('invalid', (event) => {
    if (profileInvalidFrame) return;
    const field = event.target;
    profileInvalidFrame = requestAnimationFrame(() => {
      profileInvalidFrame = 0;
      revealProfileField(field);
    });
  }, true);
  $('profile-form').addEventListener('input', clearProfileError);
  $('profile-dialog').addEventListener('wheel', (event) => {
    if (!$('profile-dialog-body').contains(event.target)) event.preventDefault();
  }, { passive: false });

  $('profile-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (dialogBusy) return;
    clearProfileError();
    let invalidField = null;
    try {
      const name = $('profile-name').value.trim();
      if (!name) {
        invalidField = $('profile-name');
        throw new Error('请为环境填写一个名称。');
      }
      const input = { name, notes: $('profile-notes').value.trim(), color: $('color-choices').querySelector('input:checked')?.value || colors[0].value };
      if (!editId) {
        const platform = findPlatform(selectedPlatformId);
        if (selectedPlatformId && !platform) throw new Error('所选平台暂不可用，请重新选择平台或填写自定义网址。');
        if (!platform) invalidField = $('profile-url');
        input.startUrl = platform ? platform.launchUrl : normalizeUrl($('profile-url').value);
        invalidField = null;
        input.platformId = platform?.id || null;
      }
      setDialogBusy(true);
      await call(editId ? 'updateProfile' : 'createProfile', ...(editId ? [editId, input] : [input]));
      const wasEditing = Boolean(editId);
      setDialogBusy(false);
      await closeDialog($('profile-dialog'), false);
      notify(wasEditing ? '环境信息已保存。' : '独立环境创建成功');
    } catch (error) {
      $('profile-form-error').textContent = error.message || '保存失败，请重试。';
      $('profile-form-error').hidden = false;
      setDialogBusy(false);
      notify(error.message || '保存失败，请重试。', 'error');
      if (invalidField) {
        profileErrorField = invalidField;
        invalidField.setAttribute('aria-invalid', 'true');
        invalidField.setAttribute('aria-errormessage', 'profile-form-error');
        revealProfileField(invalidField);
      }
    }
  });

  $('delete-confirm').addEventListener('click', async () => {
    if (!deleteId || dialogBusy) return;
    $('delete-error').hidden = true;
    try {
      setDialogBusy(true);
      await call('deleteProfile', deleteId);
      setDialogBusy(false);
      await closeDialog($('delete-dialog'), false);
      notify('独立环境已删除');
      deleteId = null;
    } catch (error) {
      $('delete-error').textContent = error.message || '删除失败，请重试。';
      $('delete-error').hidden = false;
      setDialogBusy(false);
      notify(error.message || '删除失败，请重试。', 'error');
    }
  });

  for (const id of ['sidebar-create', 'tab-create', 'welcome-create', 'cards-create', 'empty-create']) $(id).addEventListener('click', () => openProfileDialog());
  $('custom-platform').addEventListener('change', () => { if ($('custom-platform').checked) choosePlatform(null); });
  $('profile-url').addEventListener('input', () => { if (selectedPlatformId === null) customUrlDraft = $('profile-url').value; });
  for (const id of ['sidebar-overview', 'error-overview']) $(id).addEventListener('click', () => action('showOverview'));
  $('profile-search').addEventListener('input', () => { finishProfileDrag(); renderProfiles(); });
  $('active-settings').addEventListener('click', () => { const profile = findProfile(state.activeId); if (profile) openProfileDialog(profile); });
  $('settings-edit-environment').addEventListener('click', () => { const profile = findProfile(state.activeId); if (profile) openProfileDialog(profile); });
  $('login-diagnostics-button').addEventListener('click', openDiagnosticsDialog);
  $('diagnostics-start').addEventListener('click', () => runDiagnosticsAction('startLoginDiagnostics'));
  $('diagnostics-stop').addEventListener('click', () => runDiagnosticsAction('stopLoginDiagnostics'));
  $('diagnostics-save').addEventListener('click', () => runDiagnosticsAction('saveLoginDiagnostics'));
  $('back-button').addEventListener('click', () => action('goBack'));
  $('forward-button').addEventListener('click', () => action('goForward'));
  for (const id of ['reload-button', 'error-reload']) $(id).addEventListener('click', () => action('reload'));
  $('address-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!activeTab()) return;
    const url = $('address-input').value.trim();
    if (!url) return;
    $('address-input').blur();
    await action('navigate', url);
  });
  $('address-input').addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    $('address-input').value = activeTab()?.url || '';
    $('address-input').blur();
  });
  $('data-path-button').addEventListener('click', () => {
    const expanded = !$('data-path-detail').hidden;
    $('data-path-detail').hidden = expanded;
    $('data-path-button').setAttribute('aria-expanded', String(!expanded));
    if (!expanded) $('data-path-detail').scrollIntoView({ block: 'nearest' });
  });
  $('profile-delete').addEventListener('click', openDeleteDialog);
  $('profile-cancel').addEventListener('click', () => { if (editId) closeDialog($('profile-dialog')); });
  $('profile-dialog-close').addEventListener('click', () => closeDialog($('profile-dialog')));
  for (const id of ['delete-cancel', 'delete-dialog-close']) $(id).addEventListener('click', () => closeDialog($('delete-dialog')));
  for (const id of ['diagnostics-close', 'diagnostics-dialog-close']) $(id).addEventListener('click', () => closeDialog($('diagnostics-dialog')));
  for (const id of dialogIds) {
    const dialog = $(id);
    dialog.addEventListener('cancel', (event) => {
      event.preventDefault();
      if (dialog.id !== 'profile-dialog' || editId) closeDialog(dialog);
    });
    dialog.addEventListener('click', (event) => {
      if (event.target !== dialog) return;
      if (dialog.id === 'profile-dialog' && !editId) return;
      const rect = dialog.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) closeDialog(dialog);
    });
  }

  function handleShortcut(key) {
    if (dialogIsOpen()) return;
    if (key === 't') openProfileDialog();
    else if (key === 'l' && activeTab()) { $('address-input').focus(); $('address-input').select(); }
    else if (key === 'w' && activeTab()) action('closeProfile', state.activeId);
  }
  document.addEventListener('keydown', (event) => {
    if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
    const key = event.key.toLowerCase();
    if (!['t', 'l', 'w'].includes(key)) return;
    event.preventDefault();
    handleShortcut(key);
  });
  api?.onShortcut?.(handleShortcut);
  window.addEventListener('resize', () => {
    scheduleBounds();
    api?.positionToast(toastBounds()).catch(() => {});
  });
  new ResizeObserver(scheduleBounds).observe($('browser-viewport'));
  $('developer-open').addEventListener('click',()=>api.openDeveloperTools().catch(error=>notify(error.message,'error')));
  $('lease-takeover').addEventListener('click',()=>window.dispatchEvent(new CustomEvent('publishing:takeover-request',{detail:state.activeId})));
  window.publishingNavigateEnvironment = ()=>navigation.select('environment',true);
  window.publishingNotify = notify;
  api?.onState(applyState);
  render();
  action('getState');
})();
