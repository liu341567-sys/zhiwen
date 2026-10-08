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
  let toastSequence = 0;
  let platformChoicesBuilt = false;
  let selectedPlatformId = null;
  let customUrlDraft = '';
  let originalStartUrl = '';
  let profileUrlAtOpen = '';
  let platformSelectionChanged = false;
  const dialogIds = ['profile-dialog', 'delete-dialog', 'diagnostics-dialog'];
  let diagnosticsReport = null;
  let diagnosticsBusy = false;
  let diagnosticsTimer = null;
  let diagnosticsPollGeneration = 0;

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
  function dialogIsOpen() { return dialogIds.some((id) => $(id).open) || modalOpening; }
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
    $('profile-url').readOnly = selectedPlatformId !== null;
  }

  function choosePlatform(id) {
    if (dialogBusy) return;
    platformSelectionChanged = true;
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
      input.disabled = dialogBusy;
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
    buildPlatformChoices();
    render();
  }

  async function call(method, ...args) {
    if (!api || typeof api[method] !== 'function') throw new Error('浏览器接口尚未连接，请重新启动应用。');
    const result = await api[method](...args);
    applyState(result);
    return result;
  }

  async function action(method, ...args) {
    try { return await call(method, ...args); }
    catch (error) { notify(error.message || '操作未能完成，请重试。', 'error'); }
  }

  function notify(message, type = 'success') {
    const toast = element('div', `toast ${type}`, message);
    toast.dataset.toastId = String(++toastSequence);
    $('toast-stack').append(toast);
    while ($('toast-stack').children.length > 2) $('toast-stack').firstElementChild.remove();
    window.setTimeout(() => toast.remove(), type === 'error' ? 11000 : 5500);
  }

  function renderProfiles() {
    const query = $('profile-search').value.trim().toLocaleLowerCase();
    const filtered = state.profiles.filter((profile) => `${profile.name} ${profile.notes || ''}`.toLocaleLowerCase().includes(query));
    $('profile-count').textContent = String(state.profiles.length);
    $('overview-count').textContent = String(state.profiles.length);
    $('sidebar-overview').classList.toggle('active', !state.activeId);
    $('sidebar-overview').setAttribute('aria-current', state.activeId ? 'false' : 'page');
    const rows = filtered.map((profile) => {
      const row = element('div', `profile-row${state.activeId === profile.id ? ' active' : ''}`);
      const open = button('profile-open', '', () => action('openProfile', profile.id));
      open.setAttribute('aria-label', `打开环境：${profile.name}`);
      open.title = profile.notes ? `${profile.name}\n${profile.notes}` : profile.name;
      open.dataset.focusKey = `open:${profile.id}`;
      const label = element('span', 'profile-row-text');
      label.append(element('span', 'profile-name', profile.name), status(profile));
      open.append(avatar(profile), label);
      const edit = button('icon-button profile-edit', '', () => openProfileDialog(profile), 'pencil');
      edit.title = '编辑环境';
      edit.setAttribute('aria-label', `编辑环境：${profile.name}`);
      edit.dataset.focusKey = `edit:${profile.id}`;
      row.append(open, edit);
      return row;
    });
    $('profile-list').replaceChildren(...rows);
    $('profile-list').hidden = !rows.length;
    $('sidebar-empty').hidden = Boolean(rows.length);
    $('sidebar-empty').replaceChildren(document.createTextNode(state.profiles.length ? '没有找到匹配的环境' : '还没有保存的环境'), element('br'), element('span', '', state.profiles.length ? '试试其他名称或备注' : '从新建第一个环境开始'));
    $('profile-cards').replaceChildren(...state.profiles.map((profile) => {
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
    $('overview-empty').hidden = Boolean(state.profiles.length);
    $('profile-cards').hidden = !state.profiles.length;
  }

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
    const browsing = Boolean(tab);
    $('overview-view').hidden = browsing;
    $('browser-view').hidden = !browsing;
    $('back-button').disabled = !tab || !tab.canGoBack;
    $('forward-button').disabled = !tab || !tab.canGoForward;
    $('reload-button').disabled = !tab;
    $('active-settings').disabled = !tab;
    $('login-diagnostics-button').disabled = !tab;
    $('address-input').disabled = !tab;
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
      const rect = $('browser-viewport').getBoundingClientRect();
      const browsing = Boolean(activeTab());
      const bounds = { x: Math.round(rect.x), y: Math.round(rect.y), width: browsing ? Math.round(rect.width) : 0, height: browsing ? Math.round(rect.height) : 0 };
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
    document.querySelectorAll('input[name="platform"]').forEach((input) => { input.disabled = value; });
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
    modalOpening = true;
    focusBeforeModal = document.activeElement;
    focusKeyBeforeModal = focusBeforeModal?.dataset.focusKey;
    try {
      await setOverlay(true);
      editId = profile ? profile.id : null;
      $('profile-form').reset();
      $('profile-name').value = profile?.name || '';
      $('profile-notes').value = profile?.notes || '';
      originalStartUrl = profile?.startUrl || 'https://www.douyin.com';
      $('profile-url').value = originalStartUrl;
      customUrlDraft = $('profile-url').value;
      selectedPlatformId = findPlatform(profile?.platformId)?.id || null;
      if (selectedPlatformId) $('profile-url').value = findPlatform(selectedPlatformId).launchUrl;
      profileUrlAtOpen = $('profile-url').value;
      platformSelectionChanged = false;
      syncPlatformSelection();
      selectColor(profile?.color || colors[state.profiles.length % colors.length].value);
      $('profile-dialog-title').textContent = profile ? '编辑环境' : '新建独立环境';
      $('profile-dialog-description').textContent = profile ? '更新名称、备注与启动网址，便于识别这个账号空间。' : '从全新的登录状态开始，为一个账号创建专属空间。';
      $('profile-delete').hidden = !profile;
      $('new-profile-tip').hidden = Boolean(profile);
      $('profile-form-error').hidden = true;
      setDialogBusy(false);
      $('profile-dialog').showModal();
      $('profile-name').focus();
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

  $('profile-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (dialogBusy) return;
    $('profile-form-error').hidden = true;
    try {
      const name = $('profile-name').value.trim();
      if (!name) throw new Error('请为环境填写一个名称。');
      const platform = findPlatform(selectedPlatformId);
      if (selectedPlatformId && !platform) throw new Error('所选平台暂不可用，请重新选择平台或填写自定义网址。');
      const input = { name, notes: $('profile-notes').value.trim(), color: $('color-choices').querySelector('input:checked')?.value || colors[0].value };
      const launchSettingsUnchanged = Boolean(editId) && !platformSelectionChanged && $('profile-url').value === profileUrlAtOpen;
      if (!launchSettingsUnchanged) {
        input.startUrl = platform ? platform.launchUrl : normalizeUrl($('profile-url').value);
        input.platformId = platform?.id || null;
      }
      setDialogBusy(true);
      await call(editId ? 'updateProfile' : 'createProfile', ...(editId ? [editId, input] : [input]));
      const wasEditing = Boolean(editId);
      setDialogBusy(false);
      await closeDialog($('profile-dialog'), false);
      notify(wasEditing ? '环境信息已保存。' : '独立环境已创建，可以登录新的账号。');
    } catch (error) {
      $('profile-form-error').textContent = error.message || '保存失败，请重试。';
      $('profile-form-error').hidden = false;
      setDialogBusy(false);
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
      notify('环境及其浏览数据已删除。');
      deleteId = null;
    } catch (error) {
      $('delete-error').textContent = error.message || '删除失败，请重试。';
      $('delete-error').hidden = false;
      setDialogBusy(false);
    }
  });

  for (const id of ['sidebar-create', 'tab-create', 'welcome-create', 'cards-create', 'empty-create']) $(id).addEventListener('click', () => openProfileDialog());
  $('custom-platform').addEventListener('change', () => { if ($('custom-platform').checked) choosePlatform(null); });
  $('profile-url').addEventListener('input', () => { if (selectedPlatformId === null) customUrlDraft = $('profile-url').value; });
  for (const id of ['sidebar-overview', 'error-overview']) $(id).addEventListener('click', () => action('showOverview'));
  $('profile-search').addEventListener('input', renderProfiles);
  $('active-settings').addEventListener('click', () => { const profile = findProfile(state.activeId); if (profile) openProfileDialog(profile); });
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
  for (const id of ['profile-cancel', 'profile-dialog-close']) $(id).addEventListener('click', () => closeDialog($('profile-dialog')));
  for (const id of ['delete-cancel', 'delete-dialog-close']) $(id).addEventListener('click', () => closeDialog($('delete-dialog')));
  for (const id of ['diagnostics-close', 'diagnostics-dialog-close']) $(id).addEventListener('click', () => closeDialog($('diagnostics-dialog')));
  for (const id of dialogIds) {
    const dialog = $(id);
    dialog.addEventListener('cancel', (event) => { event.preventDefault(); closeDialog(dialog); });
    dialog.addEventListener('click', (event) => {
      if (event.target !== dialog) return;
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
  window.addEventListener('resize', scheduleBounds);
  new ResizeObserver(scheduleBounds).observe($('browser-viewport'));
  api?.onState(applyState);
  render();
  action('getState');
})();
