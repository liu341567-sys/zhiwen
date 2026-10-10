'use strict';

// One controller owns navigation and layout; account rows remain in their own
// DOM subtree and browser instances remain owned by the main process.
window.createNavigationController = ({ api, icon, changed, beforeChange, blocked, notify }) => {
  const $ = id => document.getElementById(id);
  const shell = document.querySelector('.app-shell');
  let modules = [];
  let preferences = null;
  let activeModule = 'environment';
  let overlay = false;
  let busy = false;
  let initialized = false;
  let compact = innerWidth < 640;
  let saveTimer;
  let restoreFrame;
  let restoringEnvironment = false;
  let compactTimer;
  const menus = new Map();
  const environmentVisible = () => activeModule === 'environment' && (!collapsed() || overlay);
  const collapsed = () => compact || preferences?.sidebarCollapsed === true;
  const module = () => modules.find(item => item.id === activeModule);

  function collect() {
    if (!preferences) return;
    if (environmentVisible() && !restoringEnvironment && !$('environment-sidebar-content').hidden) preferences.environmentScroll = $('profile-list').scrollTop;
    preferences.environmentSearch = $('profile-search').value;
    preferences.railScroll = $('primary-navigation').scrollTop;
    if (activeModule !== 'environment') {
      preferences.panelScroll[activeModule] = $('module-view').scrollTop;
      if (!collapsed() || overlay) preferences.menuScroll[activeModule] = $('module-sidebar-content').scrollTop;
    } else if (!$('overview-view').hidden) preferences.panelScroll.environment = $('overview-view').scrollTop;
  }
  async function save() {
    if (!preferences) return;
    clearTimeout(saveTimer);
    const { activeModule: id, sidebarCollapsed, environmentSearch, environmentScroll, panelScroll, menuScroll, railScroll } = preferences;
    await api.updateUIPreferences({ activeModule: id, sidebarCollapsed, environmentSearch, environmentScroll, panelScroll, menuScroll, railScroll });
  }
  function scheduleSave() { collect(); clearTimeout(saveTimer); saveTimer = setTimeout(() => save().catch(error => notify(error.message || '界面偏好未能保存。', 'error')), 120); }

  function menu(item) {
    if (menus.has(item.id)) return menus.get(item.id);
    const container = document.createElement('div');
    container.className = 'secondary-menu';
    let group;
    for (const entry of item.items) {
      if (entry.group && entry.group !== group) { group=entry.group; const heading=document.createElement('h3');heading.className='publish-menu-group';heading.textContent=group;container.append(heading); }
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'secondary-menu-button';
      const label = document.createElement('span'); label.textContent = entry.label;
      button.append(icon(entry.icon), label);
      if (entry.developer) {button.addEventListener('click',()=>api.openDeveloperTools().catch(error=>notify(error.message,'error')));}
      else if (entry.publishing) {
        button.dataset.publishPage=entry.id;
        if(entry.planned){const badge=document.createElement('span');badge.className='planned-badge';badge.textContent='规划中';button.append(badge);}
        button.addEventListener('click',async()=>{
          if(overlay)await closeOverlay();
          window.dispatchEvent(new CustomEvent('publishing:page',{detail:entry.id}));
        });
      } else if (entry.route && $(entry.route)) {
        button.dataset.route = entry.route;
        button.addEventListener('click', async () => {
          for (const sibling of container.children) sibling.classList.toggle('active', sibling === button);
          if (overlay) await closeOverlay();
          $(entry.route).scrollIntoView({ block: 'start', behavior: 'instant' });
          scheduleSave();
        });
      } else {
        button.disabled = true;
        const badge = document.createElement('span'); badge.className = 'planned-badge'; badge.textContent = '规划中';
        button.append(badge); button.title = `${entry.label} · 规划中`;
      }
      container.append(button);
    }
    if (item.mode === 'planned') {
      const note = document.createElement('p'); note.className = 'module-sidebar-note'; note.textContent = '功能正在规划中，现有账号环境可继续使用。';
      container.append(note);
    }
    menus.set(item.id, container);
    return container;
  }

  function render() {
    const item = module();
    const savedEnvironmentScroll = preferences.environmentScroll;
    restoringEnvironment = true;
    shell.classList.toggle('sidebar-collapsed', collapsed());
    shell.classList.toggle('sidebar-overlay', overlay);
    shell.dataset.module = activeModule;
    $('secondary-title').textContent = item?.label || '账号环境管理';
    const expanded = !collapsed() || overlay;
    const toggleButton = $('sidebar-toggle');
    const toggleLabel = expanded ? '收起侧栏' : '展开侧栏';
    toggleButton.title = compact && !expanded ? `${toggleLabel}（窗口较窄，临时显示）` : toggleLabel;
    toggleButton.setAttribute('aria-label', toggleLabel);
    toggleButton.setAttribute('aria-expanded', String(expanded));
    if (toggleButton.dataset.expanded !== String(expanded)) {
      toggleButton.dataset.expanded = String(expanded);
      const label = document.createElement('span'); label.textContent = expanded ? '收起' : '展开';
      toggleButton.replaceChildren(icon(expanded ? 'arrow-left' : 'arrow-right'), label);
    }
    $('sidebar-overlay-close').hidden = !overlay;
    $('sidebar-overlay-backdrop').hidden = !overlay;
    for (const button of document.querySelectorAll('button[data-module]')) {
      const selected = button.dataset.module === activeModule;
      button.classList.toggle('active', selected);
      button.setAttribute('aria-current', selected ? 'page' : 'false');
      button.setAttribute('aria-expanded', String(selected && (!collapsed() || overlay)));
    }
    $('environment-sidebar-content').hidden = activeModule !== 'environment';
    $('module-sidebar-content').hidden = activeModule === 'environment';
    if (item && activeModule !== 'environment') {
      const next = menu(item);
      if ($('module-sidebar-content').firstElementChild !== next) $('module-sidebar-content').replaceChildren(next);
      $('planned-module').hidden = item.mode !== 'planned';
      $('settings-module').hidden = item.mode !== 'settings';
      $('publishing-module').hidden = item.mode !== 'publishing';
      $('developer-module').hidden = item.mode !== 'developer';
      if(item.mode === 'publishing')window.dispatchEvent(new Event('publishing:visible'));
      if (item.mode === 'planned') {
        $('planned-title').textContent = item.label;
        $('planned-description').textContent = item.description;
        $('planned-icon').replaceChildren(icon(item.icon));
      }
    }
    // Restore the retained list after making it visible, before paint. A second
    // pass covers initial row creation; hidden-list scroll events must not replace
    // the saved position during the native visibility / DOM transition.
    if (environmentVisible()) $('profile-list').scrollTop = savedEnvironmentScroll;
    cancelAnimationFrame(restoreFrame);
    restoreFrame = requestAnimationFrame(() => {
      if (environmentVisible()) $('profile-list').scrollTop = savedEnvironmentScroll;
      restoringEnvironment = false;
      if (activeModule === 'environment' && !overlay) $('overview-view').scrollTop = preferences.panelScroll.environment || 0;
      else if (activeModule !== 'environment') {
        $('module-view').scrollTop = preferences.panelScroll[activeModule] || 0;
        $('module-sidebar-content').scrollTop = preferences.menuScroll[activeModule] || 0;
      }
      $('primary-navigation').scrollTop = preferences.railScroll;
    });
    changed();
  }

  async function closeOverlay() {
    if (!overlay) return;
    collect();
    overlay = false;
    render();
    await api.setNavigationOverlay(false);
    $('navigation-page-frame').hidden = true;
    $('navigation-page-frame').removeAttribute('src');
    if (!blocked()) document.querySelector(`button[data-module="${activeModule}"]`)?.focus({ preventScroll: true });
    await save();
  }

  async function showOverlay() {
    if (overlay || !collapsed()) return;
    beforeChange();
    const result = await api.setNavigationOverlay(true);
    if (result.frame) { $('navigation-page-frame').src = result.frame; $('navigation-page-frame').hidden = false; }
    overlay = true;
    render();
    $('sidebar-overlay-close').focus({ preventScroll: true });
  }

  async function select(id, force = false) {
    if (!modules.some(item => item.id === id) || (!force && blocked())) return;
    collect(); beforeChange();
    if (overlay) await closeOverlay();
    const previous = activeModule;
    activeModule = id; preferences.activeModule = id;
    // Persist and switch native visibility together before changing local panes.
    try { await save(); } catch (error) { activeModule = previous; preferences.activeModule = previous; throw error; }
    render();
    // Module selection never changes the pinned sidebar preference or opens a
    // temporary cover. Only an explicit layout / context-menu action does so.
  }
  async function toggle() {
    if (blocked()) return;
    if (overlay) {
      await closeOverlay();
      $('sidebar-toggle').focus({ preventScroll: true });
      return;
    }
    // A narrow workspace retains the saved pinned preference and uses a cover
    // only when the user explicitly requests it with this same fixed control.
    if (compact) {
      await showOverlay();
      $('sidebar-toggle').focus({ preventScroll: true });
      return;
    }
    collect(); beforeChange();
    preferences.sidebarCollapsed = !preferences.sidebarCollapsed;
    try { await save(); } catch (error) { preferences.sidebarCollapsed = !preferences.sidebarCollapsed; throw error; }
    render();
    $('sidebar-toggle').focus({ preventScroll: true });
  }
  function guarded(action) {
    return async () => {
      if (busy || blocked()) return;
      busy = true;
      try { await action(); } catch (error) { notify(error.message || '导航未能切换。', 'error'); }
      finally { busy = false; }
    };
  }

  window.addEventListener('publishing:selected',event=>{for(const b of document.querySelectorAll('[data-publish-page]')){b.classList.toggle('active',b.dataset.publishPage===event.detail);b.setAttribute('aria-current',b.dataset.publishPage===event.detail?'page':'false');}});
  $('sidebar-toggle').addEventListener('click', guarded(toggle));
  $('sidebar-overlay-close').addEventListener('click', guarded(closeOverlay));
  $('sidebar-overlay-backdrop').addEventListener('click', guarded(closeOverlay));
  $('module-return').addEventListener('click', guarded(() => select('environment')));
  $('profile-list').addEventListener('scroll', () => { if (initialized && environmentVisible()) scheduleSave(); }, { passive: true });
  $('profile-search').addEventListener('input', scheduleSave);
  $('overview-view').addEventListener('scroll', scheduleSave, { passive: true });
  $('module-view').addEventListener('scroll', scheduleSave, { passive: true });
  $('module-sidebar-content').addEventListener('scroll', () => { if (!collapsed() || overlay) scheduleSave(); }, { passive: true });
  $('primary-navigation').addEventListener('scroll', scheduleSave, { passive: true });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && overlay && !blocked()) { event.preventDefault(); guarded(closeOverlay)(); }
  });
  async function adapt() {
    const next = innerWidth < 640;
    if (next === compact) return;
    if (busy) { compactTimer = setTimeout(adapt, 30); return; }
    busy = true;
    try { collect(); beforeChange(); if (overlay) await closeOverlay(); compact = next; render(); }
    catch (error) { notify(error.message || '布局未能更新。', 'error'); }
    finally { busy = false; }
  }
  window.addEventListener('resize', () => { clearTimeout(compactTimer); compactTimer = setTimeout(adapt, 0); });
  window.addEventListener('pagehide', () => { collect(); save().catch(() => {}); });

  return {
    initialize(snapshot) {
      if (initialized || !snapshot.navigationModules || !snapshot.uiPreferences) return;
      modules = snapshot.navigationModules; preferences = structuredClone(snapshot.uiPreferences);
      activeModule = preferences.activeModule;
      $('profile-search').value = preferences.environmentSearch;
      for (const item of modules) {
        const button = document.createElement('button'); button.type = 'button'; button.className = 'rail-button';
        button.dataset.module = item.id;
        const moduleLabel = item.mode === 'planned' ? `${item.label} · 规划中` : item.label;
        button.title = `${moduleLabel}；收起后右键可临时查看菜单`;
        button.setAttribute('aria-label', moduleLabel); button.setAttribute('aria-controls', 'secondary-sidebar');
        const label = document.createElement('span'); label.textContent = item.shortName;
        button.append(icon(item.icon), label);
        button.addEventListener('click', guarded(() => select(item.id)));
        const preview = guarded(async () => {
          if (!collapsed()) return;
          if (activeModule !== item.id) await select(item.id);
          await showOverlay();
        });
        button.addEventListener('contextmenu', event => { event.preventDefault(); preview(); });
        button.addEventListener('keydown', event => {
          if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
            event.preventDefault(); preview();
          }
        });
        $(item.pinned ? 'pinned-navigation' : 'primary-navigation').append(button);
      }
      initialized = true; render(); document.body.classList.remove('navigation-loading');
    },
    module: () => activeModule,
    select,
    preferences() {
      collect();
      if (!preferences) return null;
      const { activeModule: id, sidebarCollapsed, environmentSearch, environmentScroll, panelScroll, menuScroll, railScroll } = preferences;
      return structuredClone({ activeModule: id, sidebarCollapsed, environmentSearch, environmentScroll, panelScroll, menuScroll, railScroll });
    },
    environmentVisible,
    async environmentAction() {
      if (activeModule !== 'environment') await select('environment', true);
      if (overlay) await closeOverlay();
    },
    sync() { $('settings-data-path').textContent = $('data-path-detail').textContent; },
  };
};
