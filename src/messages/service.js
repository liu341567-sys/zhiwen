'use strict';
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { MessageStore, compareCount } = require('./store');
const douyin = require('./douyin');
const descriptions = {
  success: '已读取官网未读计数；增量为数量变化估算', closed: '环境不存在或已关闭', wrong_page: '官方列表发生跳转，未读取其他页面',
  unrecognized: '未识别到明确的私信总数，不能视为零', ambiguous: '多个私信计数不一致，待核实',
  login_required: '账号需要重新登录', verification: '平台要求安全验证', loading: '官网页面正在加载',
  timeout: '官方列表加载或读取超时', load_error: '官方私信列表加载失败', session_error: '原账号会话无法恢复', page_changed: '巡检期间页面发生变化',
  busy: '账号正在发布或录制，本次等待', unsupported: '平台暂未支持', disabled: '未纳入监测', paused: '尚未巡检',
};
class MessageService {
  static async create(options) { const { default: Queue } = await import('p-queue'); return new MessageService(options, Queue); }
  constructor({ directory, profiles, getView, releaseView = () => {}, isBusy = () => false, reserveAccount = () => () => {},
    changed = () => {}, notify = () => {}, reveal = async () => {}, now = Date.now, adapters = [douyin] }, Queue) {
    this.store = new MessageStore(path.join(directory, 'messages'));
    Object.assign(this, { profiles, getView, releaseView, isBusy, reserveAccount, changed, notify, reveal, now });
    this.adapters = new Map(adapters.map(a => [a.id, a]));
    this.config = this.store.settings(); this.queue = new Queue({ concurrency: this.config.concurrency });
    this.running = false; this.closed = false; this.cycle = null; this.scanJob = null; this.timer = null; this.nextAt = null;
    this.controllers = new Map(); this.jobs = new Map(); this.active = new Set();
  }
  initialize() { if (this.config.enabled && this.config.autoResume) this.start().catch(() => {}); return this.state(); }
  selected(profile) { return this.adapters.has(profile.platformId) && (this.config.selectedIds === null || this.config.selectedIds.includes(profile.id)); }
  state() {
    const rows = this.profiles().map(p => {
      const adapter = this.adapters.get(p.platformId), monitored = this.selected(p), stored = this.store.get('results', p.id);
      const result = !adapter || !monitored ? { status: !adapter ? 'unsupported' : 'disabled', unread: null, increase: null }
        : stored?.platformId === p.platformId ? stored : { status: 'paused', unread: null, increase: null };
      return { id: p.id, name: p.name, platformId: p.platformId || null, platformName: adapter?.name || '', supported: !!adapter, monitored,
        platformVerified: adapter?.verified === true, result, description: descriptions[result.status], checking: this.active.has(p.id),
        baseline: this.store.get('baselines', p.id) };
    });
    const monitored = rows.filter(r => r.monitored), fresh = monitored.filter(r => r.result.status === 'success');
    const units = { messages: 0, conversations: 0, unknown: 0 };
    for (const r of fresh) if (r.result.exact) units[r.result.unit || 'unknown'] += r.result.unread;
    const cycle = this.cycle || this.store.get('settings', 'lastCycle');
    return { config: this.config, running: this.running, checking: !!this.scanJob, nextAt: this.nextAt, cycle, rows, alerts: this.store.alerts(),
      summary: { monitored: monitored.length, success: cycle?.success || 0, unreadAccounts: fresh.filter(r => r.result.unread > 0).length,
        unread: units, reliableAccounts: fresh.filter(r => r.result.exact).length, newMessages: null,
        increases: cycle?.increases || { messages: 0, conversations: 0, unknown: 0 }, anomalies: monitored.filter(r => !['success', 'paused', 'busy'].includes(r.result.status)).length } };
  }
  update(input) {
    if (this.closed) throw new Error('私信监测已关闭');
    if (Object.hasOwn(input || {}, 'enabled')) throw new Error('请使用开始或暂停按钮');
    this.config = this.store.settings(input); this.queue.concurrency = this.config.concurrency;
    for (const [id, controller] of this.controllers) { const profile = this.profiles().find(p => p.id === id); if (!profile || !this.selected(profile)) controller.abort(); }
    if (this.running && !this.scanJob) this.schedule(); this.changed(); return this.state();
  }
  schedule() {
    clearTimeout(this.timer); this.timer = null; this.nextAt = null;
    if (!this.running || this.closed) return;
    this.nextAt = this.now() + this.config.intervalSeconds * 1000;
    this.timer = setTimeout(() => { this.scan().catch(() => {}); }, this.config.intervalSeconds * 1000); this.timer.unref?.();
  }
  async start() {
    if (this.closed) throw new Error('私信监测已关闭');
    this.running = true; this.config = this.store.settings({ enabled: true }); this.changed(); await this.scan(); return this.state();
  }
  async pause({ persist = true } = {}) {
    this.running = false; clearTimeout(this.timer); this.timer = null; this.nextAt = null;
    if (persist) this.config = this.store.settings({ enabled: false });
    this.controller?.abort(); for (const c of this.controllers.values()) c.abort();
    await this.scanJob?.catch(() => {}); this.changed(); return this.state();
  }
  async cancelAccount(id) { this.controllers.get(id)?.abort(); if (this.active.has(id)) await this.jobs.get(id)?.catch(() => {}); this.releaseView(id); }
  async scan({ ids, force = false } = {}) {
    if (this.closed) throw new Error('私信监测已关闭');
    if (this.scanJob) return this.scanJob;
    if (ids !== undefined && (!Array.isArray(ids) || ids.length > 500 || ids.some(id => typeof id !== 'string'))) throw new Error('巡检账号选择无效');
    clearTimeout(this.timer); this.timer = null; this.nextAt = null;
    const profiles = this.profiles(); this.store.prune(profiles.map(p => p.id));
    const selected = profiles.filter(p => this.selected(p) && (!ids || ids.includes(p.id)));
    const controller = this.controller = new AbortController(), changes = [];
    const cycle = this.cycle = { id: randomUUID(), startedAt: this.now(), completedAt: null, total: selected.length, done: 0, success: 0, errors: 0, increases: { messages: 0, conversations: 0, unknown: 0 } };
    this.scanJob = (async () => {
      for (const profile of selected) {
        const job = this.queue.add(async () => {
          if (controller.signal.aborted || !this.profiles().some(p => p.id === profile.id) || !this.selected(profile)) return;
          const previous = this.store.get('results', profile.id);
          if (!force && previous?.retryAt > this.now()) { cycle.done++; return; }
          const local = new AbortController(); this.controllers.set(profile.id, local); this.active.add(profile.id); this.changed();
          const abort = () => local.abort(); controller.signal.addEventListener('abort', abort, { once: true });
          let release, result;
          try {
            if (this.isBusy(profile.id)) result = { status: 'busy' };
            else {
              try { release = this.reserveAccount(profile.id); } catch { result = { status: 'busy' }; }
              if (!result) {
                const adapter = this.adapters.get(profile.platformId);
                try { const wc = await this.getView(profile.id, local.signal, adapter); result = await adapter.read(wc, local.signal); }
                catch (e) { result = { status: descriptions[e.code] ? e.code : 'load_error' }; }
              }
            }
            if (local.signal.aborted || result.status === 'aborted') return;
            if (!this.profiles().some(p => p.id === profile.id && p.platformId === profile.platformId)) return;
            this.saveSample(profile, result, previous, cycle, changes);
          } finally {
            this.releaseView(profile.id); release?.(); this.active.delete(profile.id); this.controllers.delete(profile.id);
            controller.signal.removeEventListener('abort', abort); cycle.done++; this.changed();
          }
        });
        this.jobs.set(profile.id, job);
      }
      const outcomes = await Promise.allSettled([...this.jobs.values()]);
      cycle.errors += outcomes.filter(r => r.status === 'rejected').length;
      cycle.completedAt = this.now(); cycle.aborted = controller.signal.aborted;
      this.store.put('settings', 'lastCycle', cycle);
      if (!controller.signal.aborted && changes.length) await Promise.resolve(this.notify(changes, this.config)).catch(() => {});
    })().finally(() => { this.jobs.clear(); this.scanJob = null; this.controller = null; this.schedule(); this.changed(); });
    this.changed(); await this.scanJob; return this.state();
  }
  saveSample(profile, result, previous, cycle, changes) {
    const now = this.now();
    const validCount = Number.isSafeInteger(result.unread) && result.unread >= 0 && result.unread <= 1000000;
    const status = descriptions[result.status] && (result.status !== 'success' || validCount) ? result.status : 'unrecognized';
    const exact = status === 'success' && result.exact !== false && Number.isSafeInteger(result.unread) && result.unread >= 0 && result.unread <= 1000000;
    const unit = ['messages', 'conversations', 'unknown'].includes(result.unit) ? result.unit : 'unknown';
    const baseline = this.store.get('baselines', profile.id);
    const count = compareCount(baseline?.platformId === profile.platformId ? baseline : null, { unread: exact ? result.unread : null, unit, exact }, now);
    const failures = status === 'success' || status === 'busy' ? 0 : Math.min(10, (previous?.failures || 0) + 1);
    const saved = { status, platformId: profile.platformId, checkedAt: now, cycleId: cycle.id,
      unread: status === 'success' && Number.isSafeInteger(result.unread) ? result.unread : null, exact, unit, newMessages: null,
      increase: exact ? count.increase : null, first: count.first, failures,
      retryAt: failures ? now + Math.min(3600000, this.config.intervalSeconds * 1000 * 2 ** failures) : null };
    const change = exact && count.increase > 0 && !count.first ? { environmentId: profile.id, platformId: profile.platformId, name: profile.name,
      unread: result.unread, increase: count.increase, unit, newMessages: null, basis: 'count-estimate', cycleId: cycle.id } : null;
    this.store.transaction(() => {
      if (exact) this.store.put('baselines', profile.id, { ...count.baseline, platformId: profile.platformId });
      this.store.put('results', profile.id, saved);
      if (!['success', 'busy'].includes(status)) this.store.diagnostic(profile.id, { status, locator: result.diagnostic?.locator || 'official-message-list', candidates: result.diagnostic?.candidates || 0,
        structure: (result.diagnostic?.structure || []).slice(0, 40).map(n => ({ tag: ['iframe', 'button', 'span', 'div', 'a', 'li'].includes(n.tag) ? n.tag : 'other', role: ['tab', 'navigation', 'status'].includes(n.role) ? n.role : null, kind: ['iframe', 'unread', 'badge', 'navigation'].includes(n.kind) ? n.kind : 'unknown', numeric: /^\d+\+?$/.test(n.numeric || '') ? n.numeric : null, label: ['全部消息', '未读消息', '私信', '消息', '未读', '全部'].includes(n.label) ? n.label : null })),
        nodes: (result.diagnostic?.nodes || []).slice(0, 12).map(n => ({ tag: String(n.tag).replace(/[^a-z0-9-]/g, '').slice(0, 30), role: ['tab', 'button', 'navigation'].includes(n.role) ? n.role : null, kind: ['explicit-unread-total', 'unread-tab', 'private-message-navigation'].includes(n.kind) ? n.kind : 'unknown' })) }, now);
      if (change) this.store.recordAlert(change, now);
    });
    if (change) { changes.push(change); cycle.increases[unit] += change.increase; }
    if (status === 'success') cycle.success++; else if (status !== 'busy') cycle.errors++;
  }
  async open(id) {
    const profile = this.profiles().find(p => p.id === id), adapter = this.adapters.get(profile?.platformId);
    if (!adapter) throw new Error('此账号平台暂未支持私信跳转');
    await this.cancelAccount(id);
    if (this.isBusy(id)) throw new Error('此账号正在发布或录制，请完成后查看消息');
    await this.reveal(id, adapter.launchUrl); return this.state();
  }
  diagnostics(id) { return this.store.diagnostics(id); }
  async shutdown() { if (this.closed) return; await this.pause({ persist: false }); this.closed = true; this.store.close(); }
}
module.exports = { MessageService, descriptions };
