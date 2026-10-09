'use strict';

const fs = require('node:fs');
const path = require('node:path');
const modules = require('./navigation-modules.json');
const moduleIds = new Set(modules.map(module => module.id));
const defaults = () => ({ version: 1, activeModule: 'environment', sidebarCollapsed: false,
  environmentSearch: '', environmentScroll: 0, panelScroll: {}, menuScroll: {}, railScroll: 0, windowSize: null });

// UI preferences deliberately live outside profiles.json and browser Sessions.
class UIPreferences {
  constructor(directory) {
    fs.mkdirSync(directory, { recursive: true });
    this.file = path.join(directory, 'ui-preferences.json');
    this.state = defaults();
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (saved.version === 1) this.state = this.validate(saved, true);
    } catch { /* Missing or invalid optional UI preferences use a safe layout. */ }
  }

  get() { return structuredClone(this.state); }

  validate(input, loading = false) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('无效的界面配置');
    const next = { ...this.state };
    const allowed = new Set(Object.keys(defaults()));
    if (!loading && Object.keys(input).some(key => !allowed.has(key) || key === 'version')) throw new Error('不支持的界面配置');
    if (Object.hasOwn(input, 'activeModule')) {
      if (!moduleIds.has(input.activeModule)) throw new Error('无效的导航模块');
      next.activeModule = input.activeModule;
    }
    if (Object.hasOwn(input, 'sidebarCollapsed')) {
      if (typeof input.sidebarCollapsed !== 'boolean') throw new Error('无效的侧栏状态');
      next.sidebarCollapsed = input.sidebarCollapsed;
    }
    if (Object.hasOwn(input, 'environmentSearch')) {
      if (typeof input.environmentSearch !== 'string' || input.environmentSearch.length > 560) throw new Error('无效的搜索条件');
      next.environmentSearch = input.environmentSearch;
    }
    const scroll = value => Number.isFinite(value) && value >= 0 && value <= 1e8;
    for (const key of ['environmentScroll', 'railScroll']) {
      if (!Object.hasOwn(input, key)) continue;
      if (!scroll(input[key])) throw new Error('无效的列表位置');
      next[key] = input[key];
    }
    for (const key of ['panelScroll', 'menuScroll']) {
      if (!Object.hasOwn(input, key)) continue;
      if (!input[key] || typeof input[key] !== 'object' || Array.isArray(input[key]) ||
        Object.entries(input[key]).some(([id, value]) => !moduleIds.has(id) || !scroll(value))) throw new Error('无效的页面位置');
      next[key] = { ...input[key] };
    }
    if (Object.hasOwn(input, 'windowSize')) {
      const size = input.windowSize;
      if (size !== null && (!size || !['width', 'height'].every(key => Number.isInteger(size[key]) && size[key] >= 100 && size[key] <= 10000))) throw new Error('无效的窗口尺寸');
      next.windowSize = size === null ? null : { width: size.width, height: size.height };
    }
    return next;
  }

  update(input) {
    const next = this.validate(input);
    const temp = `${this.file}.tmp`;
    const fd = fs.openSync(temp, 'w', 0o600);
    try { fs.writeFileSync(fd, `${JSON.stringify(next, null, 2)}\n`); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    fs.renameSync(temp, this.file);
    this.state = next;
    return this.get();
  }
}

module.exports = { UIPreferences };
