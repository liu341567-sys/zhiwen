'use strict';
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { MessageStore, compareCount, compareConversations } = require('./store');
const douyin = require('./douyin');
const retryPolicyVersion = 2;
const descriptions = {
  partial: '仅统计已加载会话，完整总数待核实；不会进入会话',
  success: '已读取官网未读计数；增量为数量变化估算', closed: '环境不存在或已关闭', wrong_page: '官方列表发生跳转，未读取其他页面',
  unrecognized: '暂未识别到会话未读角标，请打开消息页查看或发送诊断', ambiguous: '多个私信计数不一致，待核实',
  login_required: '账号需要重新登录', verification: '平台要求安全验证', loading: '官网页面正在加载',
  timeout: '官方列表加载或读取超时', load_error: '官方私信列表加载失败', session_error: '原账号会话无法恢复', page_changed: '巡检期间页面发生变化',
  busy: '账号正在发布或录制，本次等待', unsupported: '平台暂未支持', disabled: '未纳入监测', paused: '尚未巡检',
};
class MessageService {
  static async create(options) { const { default: Queue } = await import('p-queue'); return new MessageService(options, Queue); }
  constructor({ directory, profiles, getView, releaseView = () => {}, isBusy = () => false, reserveAccount = () => () => {},
    changed = () => {}, notify = () => {}, reveal = async () => {}, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, adapters = [douyin] }, Queue) {
    this.store = new MessageStore(path.join(directory, 'messages'));
    Object.assign(this, { profiles, getView, releaseView, isBusy, reserveAccount, changed, notify, reveal, now, setTimer, clearTimer });
    this.adapters = new Map(adapters.map(a => [a.id, a]));
    this.identitySalt = this.store.get('settings', 'identitySalt') || randomUUID(); this.store.put('settings', 'identitySalt', this.identitySalt);
    this.config = this.store.settings(); this.queue = new Queue({ concurrency: this.config.concurrency });
    this.running = false; this.closed = false; this.cycle = null; this.scanJob = null; this.timer = null; this.nextAt = null;
    this.controllers = new Map(); this.jobs = new Map(); this.active = new Set();
  }
  initialize() { if (this.config.enabled && this.config.autoResume) this.start({ force: false }).catch(() => {}); return this.state(); }
  accountProfiles() { return this.profiles().map(p => ({ ...p, originalPlatformId: p.platformId || null, platformId: p.platformId || this.config.platformOverrides[p.id] || null })); }
  assignPlatform(id, platformId) {
    const profile = this.profiles().find(p => p.id === id);
    if (!profile || profile.platformId || ![null, 'douyin'].includes(platformId)) throw new Error('仅自定义环境可设置单独的巡检平台');
    const overrides = { ...this.config.platformOverrides };
    if (platformId) overrides[id] = platformId; else delete overrides[id];
    return this.update({ platformOverrides: overrides });
  }
  selected(profile) { return this.adapters.has(profile.platformId) && (this.config.selectedIds === null || this.config.selectedIds.includes(profile.id)); }
  state() {
    const rows = this.accountProfiles().map(p => {
      const adapter = this.adapters.get(p.platformId), monitored = this.selected(p), stored = this.store.get('results', p.id);
      const result = !adapter || !monitored ? { status: !adapter ? 'unsupported' : 'disabled', unread: null, increase: null }
        : stored?.platformId === p.platformId ? { ...stored, ...(stored.retryPolicyVersion === retryPolicyVersion ? {} : { failures: 0, retryAt: null }) } : { status: 'paused', unread: null, increase: null };
      return { id: p.id, name: p.name, platformId: p.platformId || null, platformName: adapter?.name || '', supported: !!adapter, monitored,
        platformVerified: adapter?.verified === true, customEnvironment: !p.originalPlatformId, result, description: descriptions[result.status], checking: this.active.has(p.id),
        baseline: (() => { const b = this.store.get('baselines', p.id); return Number.isSafeInteger(b?.unread) ? { unread: b.unread, unit: b.unit, checkedAt: b.checkedAt } : null; })() };
    });
    const monitored = rows.filter(r => r.monitored), fresh = monitored.filter(r => ['success', 'partial'].includes(r.result.status));
    const units = { messages: 0, conversations: 0, unknown: 0 }, lowerBounds = { ...units };
    for (const r of fresh) { if (r.result.exact) units[r.result.unit || 'unknown'] += r.result.unread; else if (Number.isSafeInteger(r.result.unread)) lowerBounds[r.result.unit || 'unknown'] += r.result.unread; }
    const cycle = this.cycle || this.store.get('settings', 'lastCycle');
    return { config: this.config, running: this.running, checking: !!this.scanJob, nextAt: this.nextAt, cycle, rows, alerts: this.store.alerts(),
      summary: { monitored: monitored.length, success: cycle?.success || 0, unreadAccounts: fresh.filter(r => r.result.unread > 0).length,
        unread: units, lowerBounds, partialAccounts: fresh.filter(r => !r.result.exact).length, observedAccounts: fresh.length, reliableAccounts: fresh.filter(r => r.result.exact).length, newMessages: null,
        increases: cycle?.increases || { messages: 0, conversations: 0, unknown: 0 }, anomalies: monitored.filter(r => !['success', 'partial', 'paused', 'busy'].includes(r.result.status)).length } };
  }
  update(input) {
    if (this.closed) throw new Error('私信监测已关闭');
    if (Object.hasOwn(input || {}, 'enabled')) throw new Error('请使用开始或暂停按钮');
    const previousInterval = this.config.intervalSeconds;
    this.config = this.store.settings(input); this.queue.concurrency = this.config.concurrency;
    for (const [id, controller] of this.controllers) { const profile = this.accountProfiles().find(p => p.id === id); if (!profile || !this.selected(profile)) controller.abort(); }
    if (this.running) this.schedule({ reset: previousInterval !== this.config.intervalSeconds }); this.changed(); return this.state();
  }
  select(id, selected) {
    if (typeof selected !== 'boolean' || !this.accountProfiles().some(p => p.id === id && this.adapters.has(p.platformId))) throw new Error('监测账号选择无效');
    const ids = new Set(this.config.selectedIds === null ? this.accountProfiles().filter(p => this.adapters.has(p.platformId)).map(p => p.id) : this.config.selectedIds);
    if (selected) ids.add(id); else ids.delete(id);
    return this.update({ selectedIds: [...ids] });
  }
  schedule({ reset = false } = {}) {
    this.clearTimer(this.timer); this.timer = null;
    if (!this.running || this.closed) { this.nextAt = null; return; }
    const now = this.now();
    if (reset || this.nextAt === null) this.nextAt = now + this.config.intervalSeconds * 1000;
    // A due cycle waits for the current check instead of overlapping it. Keep
    // its deadline: manual refresh must not restart the automatic countdown.
    if (this.scanJob && this.nextAt <= now) return;
    this.timer = this.setTimer(() => {
      this.timer = null;
      if (!this.running || this.closed) return;
      if (this.scanJob) { this.changed(); return; }
      this.scan({ automatic: true }).catch(() => {});
    }, Math.max(0, this.nextAt - now)); this.timer.unref?.();
  }
  async start({ force = true } = {}) {
    if (this.closed) throw new Error('私信监测已关闭');
    if (this.running) return this.state();
    this.running = true; this.config = this.store.settings({ enabled: true });
    this.schedule({ reset: true }); this.changed(); await this.scan({ force }); return this.state();
  }
  async pause({ persist = true } = {}) {
    this.running = false; this.clearTimer(this.timer); this.timer = null; this.nextAt = null;
    if (persist) this.config = this.store.settings({ enabled: false });
    this.controller?.abort(); for (const c of this.controllers.values()) c.abort();
    await this.scanJob?.catch(() => {}); this.changed(); return this.state();
  }
  async cancelAccount(id) { this.controllers.get(id)?.abort(); if (this.active.has(id)) await this.jobs.get(id)?.catch(() => {}); this.releaseView(id); }
  async scan({ ids, force = false, automatic = false } = {}) {
    if (this.closed) throw new Error('私信监测已关闭');
    if (this.scanJob) return this.scanJob;
    if (ids !== undefined && (!Array.isArray(ids) || ids.length > 500 || ids.some(id => typeof id !== 'string'))) throw new Error('巡检账号选择无效');
    if (automatic && (!this.running || this.closed)) return this.state();
    if (automatic) {
      const now = this.now(), interval = this.config.intervalSeconds * 1000;
      // Consume overdue ticks once. After sleep or a long check, do not enqueue
      // one job for every missed interval or shift the anchor to refresh time.
      this.nextAt = (this.nextAt ?? now) + (Math.floor(Math.max(0, now - (this.nextAt ?? now)) / interval) + 1) * interval;
    }
    const profiles = this.accountProfiles(); this.store.prune(profiles.map(p => p.id));
    const selected = profiles.filter(p => this.selected(p) && (!ids || ids.includes(p.id)));
    const controller = this.controller = new AbortController(), changes = [];
    const cycle = this.cycle = { id: randomUUID(), startedAt: this.now(), completedAt: null, total: selected.length, done: 0, success: 0, errors: 0, increases: { messages: 0, conversations: 0, unknown: 0 } };
    this.scanJob = (async () => {
      for (const profile of selected) {
        const job = this.queue.add(async () => {
          if (controller.signal.aborted || !this.accountProfiles().some(p => p.id === profile.id) || !this.selected(profile)) return;
          const previous = this.store.get('results', profile.id);
          if (!force && previous?.retryPolicyVersion === retryPolicyVersion && previous?.retryAt > this.now()) { cycle.done++; return; }
          const local = new AbortController(); this.controllers.set(profile.id, local); this.active.add(profile.id); this.changed();
          const abort = () => local.abort(); controller.signal.addEventListener('abort', abort, { once: true });
          let release, result;
          try {
            if (this.isBusy(profile.id)) result = { status: 'busy' };
            else {
              try { release = this.reserveAccount(profile.id); } catch { result = { status: 'busy' }; }
              if (!result) {
                const adapter = this.adapters.get(profile.platformId);
                try { const wc = await this.getView(profile.id, local.signal, adapter); result = await adapter.read(wc, local.signal, { identitySalt: this.identitySalt, environmentId: profile.id }); }
                catch (e) { result = { status: descriptions[e.code] ? e.code : 'load_error' }; }
              }
            }
            if (local.signal.aborted || result.status === 'aborted') return;
            if (!this.accountProfiles().some(p => p.id === profile.id && p.platformId === profile.platformId)) return;
            this.saveSample(profile, result, previous, cycle, changes, { force });
          } finally {
            try { this.releaseView(profile.id); } catch { cycle.errors++; }
            try { release?.(); } finally { this.active.delete(profile.id); this.controllers.delete(profile.id); }
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
    this.schedule(); this.changed(); await this.scanJob; return this.state();
  }
  saveSample(profile, result, previous, cycle, changes, { force = false } = {}) {
    const now = this.now();
    const validCount = Number.isSafeInteger(result.unread) && result.unread >= 0 && result.unread <= 1000000;
    const status = descriptions[result.status] && (!['success', 'partial'].includes(result.status) || validCount) ? result.status : 'unrecognized';
    const exact = status === 'success' && result.exact !== false && Number.isSafeInteger(result.unread) && result.unread >= 0 && result.unread <= 1000000;
    const unit = ['messages', 'conversations', 'unknown'].includes(result.unit) ? result.unit : 'unknown';
    const baseline = this.store.get('baselines', profile.id);
    const previousConversations = baseline?.platformId === profile.platformId ? baseline?.conversationCounts || {} : {};
    const conversation = compareConversations(previousConversations, result.conversations, now);
    const method = exact ? 'total' : status === 'partial' ? 'conversations' : null;
    const methodChanged = !!method && !!baseline?.lastMethod && baseline.lastMethod !== method;
    const count = compareCount(baseline?.platformId === profile.platformId ? baseline : null, { unread: exact ? result.unread : null, unit, exact }, now);
    const failed = !['success', 'partial', 'busy'].includes(status);
    const priorFailures = previous?.retryPolicyVersion === retryPolicyVersion && Number.isSafeInteger(previous.failures) ? Math.max(0, Math.min(10, previous.failures)) : 0;
    // Only scheduled failures grow automatic backoff. Repeated user refreshes
    // may bypass a delay, but must never move that existing deadline later.
    const failures = failed ? Math.min(10, priorFailures + (force ? 0 : 1)) : 0;
    const retryAt = !failed ? null : force
      ? previous?.retryPolicyVersion === retryPolicyVersion && previous.retryAt > now ? previous.retryAt : null
      : now + Math.min(3600000, this.config.intervalSeconds * 1000 * 2 ** failures);
    const saved = { status, platformId: profile.platformId, checkedAt: now, cycleId: cycle.id,
      unread: ['success', 'partial'].includes(status) && Number.isSafeInteger(result.unread) ? result.unread : null, exact, unit, newMessages: null,
      increase: methodChanged ? 0 : exact ? count.increase : status === 'partial' && conversation.overlap ? conversation.increases[unit] : null, first: methodChanged || (status === 'partial' ? conversation.overlap === 0 && Object.keys(conversation.ledger).length > 0 : count.first), failures,
      visibleConversations: result.visibleConversations || 0, completeList: result.completeList === true,
      retryPolicyVersion, retryAt };
    const increase = exact ? count.increase : status === 'partial' ? conversation.increases[unit] : 0;
    const change = !methodChanged && increase > 0 && !(exact ? count.first : !conversation.overlap) ? { environmentId: profile.id, platformId: profile.platformId, name: profile.name,
      unread: result.unread, increase, unit, lowerBound: !exact, newMessages: null, basis: exact ? 'count-estimate' : 'conversation-count-estimate', cycleId: cycle.id } : null;
    this.store.transaction(() => {
      if (exact || Object.keys(conversation.ledger).length) this.store.put('baselines', profile.id, { ...(exact ? count.baseline : baseline || { unread: null, unit: 'unknown', checkedAt: null }), platformId: profile.platformId, lastMethod: method || baseline?.lastMethod, conversationCounts: conversation.ledger });
      this.store.put('results', profile.id, saved);
      if (!['success', 'partial', 'busy'].includes(status)) this.store.diagnostic(profile.id, { status, locator: result.diagnostic?.locator || 'official-message-list', candidates: result.diagnostic?.candidates || 0,
        badges: (result.diagnostic?.badges || []).slice(0, 24).map(b => ({ numeric: /^\d+\+?$/.test(b.numeric || '') ? b.numeric : null, excluded: b.excluded === true, matchedRow: b.matchedRow === true, ancestors: (b.ancestors || []).slice(0,5).map(n => ({ tag: ['div','span','li','ul','section','a'].includes(n.tag) ? n.tag : 'other', avatar: n.avatar === true, siblings: Number.isSafeInteger(n.siblings) ? Math.max(0, Math.min(n.siblings,1000)) : 0, knownRow: n.knownRow === true })) })),
        structure: (result.diagnostic?.structure || []).slice(0, 40).map(n => ({ tag: ['iframe', 'button', 'span', 'div', 'a', 'li'].includes(n.tag) ? n.tag : 'other', role: ['tab', 'navigation', 'status'].includes(n.role) ? n.role : null, kind: ['iframe', 'unread', 'badge', 'navigation'].includes(n.kind) ? n.kind : 'unknown', numeric: /^\d+\+?$/.test(n.numeric || '') ? n.numeric : null, label: ['全部消息', '未读消息', '私信', '消息', '未读', '全部'].includes(n.label) ? n.label : null })),
        nodes: (result.diagnostic?.nodes || []).slice(0, 12).map(n => ({ tag: String(n.tag).replace(/[^a-z0-9-]/g, '').slice(0, 30), role: ['tab', 'button', 'navigation'].includes(n.role) ? n.role : null, kind: ['explicit-unread-total', 'unread-tab', 'private-message-navigation'].includes(n.kind) ? n.kind : 'unknown' })) }, now);
      if (change) this.store.recordAlert(change, now);
    });
    if (change) { changes.push(change); cycle.increases[unit] += change.increase; }
    if (['success', 'partial'].includes(status)) cycle.success++; else if (status !== 'busy') cycle.errors++;
  }
  async open(id) {
    const profile = this.accountProfiles().find(p => p.id === id), adapter = this.adapters.get(profile?.platformId);
    if (!adapter) throw new Error('此账号平台暂未支持私信跳转');
    await this.cancelAccount(id);
    if (this.isBusy(id)) throw new Error('此账号正在发布或录制，请完成后查看消息');
    await this.reveal(id, adapter.launchUrl); return this.state();
  }
  diagnostics(id) { return this.store.diagnostics(id); }
  async shutdown() { if (this.closed) return; await this.pause({ persist: false }); this.closed = true; this.store.close(); }
}
module.exports = { MessageService, descriptions };
