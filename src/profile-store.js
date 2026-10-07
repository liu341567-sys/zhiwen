'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const DEFAULT_URL = 'https://www.douyin.com/';
const COLORS = ['#e87941', '#5b8d79', '#658ac0', '#9473b5', '#c39c49', '#ca7181'];
const ID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

function normalizeUrl(value = DEFAULT_URL) {
  if (typeof value !== 'string' || value.length > 4096) throw new Error('请输入有效的网址');
  const text = value.trim();
  if (!text) return DEFAULT_URL;
  const url = new URL(/^[a-z][a-z\d+.-]*:/i.test(text) ? text : `https://${text}`);
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) {
    throw new Error('只支持不含用户名和密码的 HTTP 或 HTTPS 网址');
  }
  return url.href;
}

function partitionFor(id) {
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) throw new Error('无效的环境标识');
  return `persist:account-${id}`;
}

function textField(value, max, label, allowEmpty = true) {
  if (typeof value !== 'string') throw new Error(`${label}必须是文字`);
  const text = value.trim();
  if (text.length > max || (!allowEmpty && !text)) throw new Error(`${label}需为 1–${max} 个字符`);
  return text;
}

class ProfileStore {
  constructor(dataDir) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.file = path.join(dataDir, 'profiles.json');
    this.state = { version: 1, profiles: [], openIds: [], activeId: null };
    if (fs.existsSync(this.file)) {
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (saved.version !== 1 || !Array.isArray(saved.profiles) || !Array.isArray(saved.openIds)) {
        throw new Error('环境清单格式不正确，请先备份数据，避免覆盖原有账号环境');
      }
      const seen = new Set();
      for (const profile of saved.profiles) {
        partitionFor(profile.id);
        if (seen.has(profile.id)) throw new Error('环境清单存在重复标识');
        seen.add(profile.id);
        textField(profile.name, 60, '环境名称', false);
        textField(profile.notes, 500, '备注');
        if (!COLORS.includes(profile.color)) throw new Error('无效的环境颜色');
        normalizeUrl(profile.startUrl);
        normalizeUrl(profile.lastUrl);
        if (!Number.isFinite(Date.parse(profile.createdAt))) throw new Error('无效的创建时间');
      }
      if (new Set(saved.openIds).size !== saved.openIds.length || saved.openIds.some(id => !seen.has(id)) ||
          (saved.activeId !== null && !saved.openIds.includes(saved.activeId))) {
        throw new Error('环境清单的打开状态不正确');
      }
      this.state = saved;
    }
  }

  getState() { return structuredClone(this.state); }

  get(id) {
    partitionFor(id);
    const profile = this.state.profiles.find(item => item.id === id);
    if (!profile) throw new Error('此环境不存在');
    return structuredClone(profile);
  }

  // Atomic replacement avoids a partial manifest when the app is interrupted.
  save() {
    const temp = `${this.file}.tmp`;
    const fd = fs.openSync(temp, 'w', 0o600);
    try {
      fs.writeFileSync(fd, `${JSON.stringify(this.state, null, 2)}\n`);
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    fs.renameSync(temp, this.file);
  }

  create(input = {}) {
    const id = randomUUID();
    const startUrl = normalizeUrl(input.startUrl);
    const profile = {
      id,
      name: textField(input.name ?? `环境 ${this.state.profiles.length + 1}`, 60, '环境名称', false),
      notes: textField(input.notes ?? '', 500, '备注'),
      color: input.color ?? COLORS[this.state.profiles.length % COLORS.length],
      startUrl,
      lastUrl: startUrl,
      createdAt: new Date().toISOString()
    };
    if (!COLORS.includes(profile.color)) throw new Error('请选择有效的环境颜色');
    this.state.profiles.push(profile);
    this.save();
    return structuredClone(profile);
  }

  update(id, input) {
    const profile = this.get(id);
    if (input.name !== undefined) profile.name = textField(input.name, 60, '环境名称', false);
    if (input.notes !== undefined) profile.notes = textField(input.notes, 500, '备注');
    if (input.startUrl !== undefined) profile.startUrl = normalizeUrl(input.startUrl);
    if (input.color !== undefined) {
      if (!COLORS.includes(input.color)) throw new Error('请选择有效的环境颜色');
      profile.color = input.color;
    }
    this.state.profiles[this.state.profiles.findIndex(item => item.id === id)] = profile;
    this.save();
    return structuredClone(profile);
  }

  open(id) {
    this.get(id);
    if (!this.state.openIds.includes(id)) this.state.openIds.push(id);
    this.state.activeId = id;
    this.save();
  }

  activate(id) {
    if (id !== null && !this.state.openIds.includes(id)) throw new Error('请先打开此环境');
    this.state.activeId = id;
    this.save();
  }

  close(id) {
    this.get(id);
    const index = this.state.openIds.indexOf(id);
    this.state.openIds = this.state.openIds.filter(item => item !== id);
    if (this.state.activeId === id) this.state.activeId = this.state.openIds[Math.min(index, this.state.openIds.length - 1)] ?? null;
    this.save();
  }

  touchUrl(id, url) {
    const normalized = normalizeUrl(url);
    const profile = this.get(id);
    if (profile.lastUrl === normalized) return;
    this.state.profiles.find(item => item.id === id).lastUrl = normalized;
    this.save();
  }

  remove(id) {
    this.close(id);
    this.state.profiles = this.state.profiles.filter(item => item.id !== id);
    this.save();
  }
}

module.exports = { ProfileStore, normalizeUrl, partitionFor, COLORS };
