'use strict';
const { randomUUID } = require('node:crypto');
const media = require('./media');
const { DouyinLiveEditor } = require('./adapters/douyin-live');

const field = (input, max, label, optional = true) => {
  if (typeof input !== 'string' || input.length > max)
    throw new Error(`${label}格式不正确或内容过长`);
  const result = input.trim();
  if (!optional && !result) throw new Error(`请填写${label}`);
  return result;
};
const liveKey = (entry) => JSON.stringify([entry.accountId, entry.videoId, entry.title, entry.topics]);
const unfinished = (task) => !['cancelled', 'success', 'submitted', 'review'].includes(task.status);

// The editable local form is not an executable task. A confirmed task is created
// only from the latest read-back-verified, already uploaded original account page.
class Workbench {
  constructor(service, Editor = DouyinLiveEditor) {
    this.service = service;
    this.Editor = Editor;
    this.sessions = new Map();
    this.revisions = new Map();
    this.errors = new Map();
    this.closed = false;
    this.confirming = false;
    this.runningOps = 0;
    this.pending = [];
    this.monitoring = 0;
    this.monitor = setInterval(() => this.refresh(), 500);
    this.monitor.unref?.();
  }
  saved() {
    return this.service.store.setting('workbench', null) || {
      entries: [], name: '', batchId: null, authorizedAt: null, updatedAt: null,
    };
  }
  state() {
    const data = this.saved();
    return {
      ...data,
      entries: data.entries.map((entry) => {
        const session = this.sessions.get(entry.id);
        const live = session && session.accountId === entry.accountId && session.videoId === entry.videoId
          ? structuredClone(session.state)
          : { phase: this.errors.has(entry.id) ? 'manual' : 'idle', revision: this.revisions.get(entry.id) || 0, verifiedRevision: null, candidates: [], error: this.errors.get(entry.id) || '' };
        return { ...entry, live };
      }),
    };
  }
  normalize(input = {}) {
    if (!input || typeof input !== 'object' || !Array.isArray(input.entries) || input.entries.length > 200)
      throw new Error('发布表单无效，第一期最多选择 200 个账号');
    const ids = new Set(), accounts = new Set();
    const entries = input.entries.map((row) => {
      if (!row || typeof row !== 'object') throw new Error('发布表单内容无效');
      const id = field(row.id, 160, '条目标识', false);
      const accountId = field(row.accountId, 160, '账号标识', false);
      if (ids.has(id)) throw new Error('发布条目标识重复，请重新添加');
      if (accounts.has(accountId)) throw new Error('实时发布第一期每个账号只能选择一个视频，请完成本次发布后再添加下一条');
      ids.add(id); accounts.add(accountId);
      return {
        id, accountId,
        videoId: field(row.videoId ?? '', 160, '视频标识'),
        title: field(row.title ?? '', 1000, '作品标题'),
        // A trailing space commits an official hashtag. Preserve it here.
        topics: (() => {
          const topics = row.topics ?? '';
          if (typeof topics !== 'string' || topics.length > 1000) throw new Error('话题格式不正确或内容过长');
          return topics;
        })(),
        locked: row.locked === true,
      };
    });
    return { entries, name: field(input.name ?? '', 100, '批次名称') };
  }
  editable() {
    if (this.closed) throw new Error('发布工作台已关闭');
    if (this.confirming) throw new Error('正在核验并确认发布，请稍候');
  }
  save(input) {
    this.editable();
    const draft = this.normalize(input);
    const old = this.saved();
    const previous = new Map(old.entries.map((entry) => [entry.id, entry]));
    for (const original of old.entries.filter(row => row.taskId)) {
      const entry = draft.entries.find(row => row.id === original.id);
      if (!entry || liveKey(entry) !== liveKey(original)) throw new Error('已正式确认的发布内容已锁定，请新建一批修改');
      entry.taskId = original.taskId;
    }
    for (const entry of draft.entries) {
      if (!this.revisions.has(entry.id) || !previous.has(entry.id) || liveKey(previous.get(entry.id)) !== liveKey(entry))
        this.revisions.set(entry.id, (this.revisions.get(entry.id) || 0) + 1);
      const session = this.sessions.get(entry.id);
      if (session && session.lastKey !== liveKey(entry))
        session.state = { ...session.state, phase: session.abort.signal.aborted ? 'manual' : session.job ? 'syncing' : 'idle', verifiedRevision: null, candidates: [], error: '' };
    }
    const data = { ...draft, batchId: old.batchId || null, authorizedAt: old.authorizedAt || null, updatedAt: Date.now() };
    this.service.store.setSetting('workbench', data);
    this.service.changed();
    return this.state();
  }
  async sync(input) {
    this.save(input);
    const entries = this.saved().entries;
    // Removing an account or replacing its video is an explicit form operation.
    // Release only that owned editor; all other account sessions stay intact.
    for (const [id, session] of this.sessions) {
      const entry = entries.find((row) => row.id === id);
      if (!entry || entry.accountId !== session.accountId || entry.videoId !== session.videoId)
        await this.closeSession(id, true);
    }
    const ordered = [...entries].sort((a, b) => Number(b.id === input.activeEntryId) - Number(a.id === input.activeEntryId));
    for (const entry of ordered) if (entry.videoId && !entry.taskId) {
      try { this.schedule(entry); } catch (error) {
        this.errors.set(entry.id, error.message);
        const session = this.sessions.get(entry.id);
        if (session) session.state = { ...session.state, phase: 'manual', error: error.message, candidates: [], verifiedRevision: null };
        this.service.changed();
      }
    }
    this.activeEntryId = input.activeEntryId;
    return this.state();
  }
  schedule(entry) {
    if (this.closed || entry.taskId) return;
    const account = this.service.accounts().find((row) => row.id === entry.accountId && row.platformId === 'douyin');
    if (!account) throw new Error('请选择已关联抖音的原账号环境');
    if (this.service.store.tasks().some((task) => task.accountId === entry.accountId && ['manual', 'unverified'].includes(task.status)))
      throw new Error(`${account.name}：该账号有需要人工处理或结果待核实的任务，请先处理，避免覆盖原页面`);
    const video = this.service.store.resource(entry.videoId, 'video');
    this.errors.delete(entry.id);
    let session = this.sessions.get(entry.id);
    if (!session) {
      const abort = new AbortController();
      session = {
        id: entry.id, accountId: entry.accountId, videoId: entry.videoId,
        token: randomUUID(), abort, editor: null, release: null, job: null,
        desired: null, lastKey: null, prepared: false, logs: [], checkpoint: {}, pending: false,
        state: { phase: 'idle', revision: 0, verifiedRevision: null, candidates: [], error: '' },
      };
      this.sessions.set(entry.id, session);
    }
    if (session.abort.signal.aborted) return;
    const revision = this.revisions.get(entry.id) || 1;
    session.desired = { ...structuredClone(entry), revision };
    if (session.job || session.pending || (session.lastKey === liveKey(entry) && ['ready', 'syncing'].includes(session.state.phase))) return;
    session.pending = true;
    session.pendingVideo = video;
    session.state = { ...session.state, phase: 'queued', revision, verifiedRevision: null, error: '' };
    this.pending.push(session);
    this.pump();
  }
  pump() {
    if (this.closed || this.confirming) return;
    while (this.pending.length && this.runningOps < this.service.scheduler.concurrency) {
      const session = this.pending.shift();
      session.pending = false;
      if (this.sessions.get(session.id) !== session || session.abort.signal.aborted) continue;
      this.start(session, session.pendingVideo);
    }
  }
  start(session, video) {
    this.runningOps++;
    const job = this.run(session, video).catch((error) => {
      if (session.abort.signal.aborted || this.sessions.get(session.id) !== session) return;
      session.state = { ...session.state, phase: error.manual ? 'manual' : 'error', error: error.message, verifiedRevision: null, candidates: [] };
      this.log(session, error.message, 'error');
      this.service.notify(`${this.service.accounts().find((row) => row.id === session.accountId)?.name || '账号'}：${error.message}`, 'warning');
    }).finally(() => {
      session.job = null;
      this.runningOps--;
      this.service.changed();
      const desired = this.saved().entries.find((row) => row.id === session.id);
      if (!this.closed && !desired?.taskId && !session.abort.signal.aborted && desired && this.sessions.get(session.id) === session && session.lastKey !== liveKey(desired) && !['manual', 'error'].includes(session.state.phase))
        this.schedule(desired);
      this.pump();
    });
    session.job = job;
    this.service.changed();
  }
  log(session, message, level = 'info') {
    session.logs.push({ time: Date.now(), message: String(message).slice(0, 2000), level });
    if (session.logs.length > 200) session.logs.shift();
    session.state.lastLog = String(message).slice(0, 500);
    this.service.changed();
  }
  async run(session, video) {
    if (!session.release) session.release = this.service.scheduler.reserveAccount(session.accountId);
    if (!session.editor) {
      session.editor = new this.Editor({
        accountId: session.accountId, token: session.token, signal: session.abort.signal,
        getView: (id) => this.service.getView(id, session.abort.signal),
        checkpoint: (patch) => { Object.assign(session.checkpoint, patch); },
        log: (message, level) => this.log(session, message, level),
        trace: (event) => this.service.traceWorkbench(session.accountId, event),
      });
    }
    if (!session.prepared) {
      session.state = { ...session.state, phase: 'uploading', error: '', revision: session.desired.revision, verifiedRevision: null };
      this.service.changed();
      await media.validate(video);
      await session.editor.prepare(video, { resume: session.resume === true });
      session.prepared = true;
      session.resume = false;
    }
    while (!session.abort.signal.aborted) {
      const desired = { ...session.desired };
      session.state = { ...session.state, phase: 'syncing', error: '', revision: desired.revision, verifiedRevision: null };
      this.service.changed();
      const actual = await session.editor.sync({ title: desired.title, topics: desired.topics, revision: desired.revision });
      if (session.abort.signal.aborted || this.sessions.get(session.id) !== session) return;
      if (desired.revision !== session.desired.revision) continue;
      session.lastKey = liveKey(desired);
      this.applyActual(session, actual, desired);
      return;
    }
  }
  applyActual(session, actual = {}, desired = session.desired) {
    const verified = actual.verified === true && actual.canSubmit !== false && !actual.pendingTopics && actual.revision === desired.revision && !!desired.title;
    const before = JSON.stringify(session.state);
    session.state = {
      ...session.state, ...actual,
      phase: actual.login || actual.challenge || actual.error ? 'manual' : verified ? 'ready' : 'syncing',
      revision: desired.revision,
      verifiedRevision: verified ? desired.revision : null,
      candidates: Array.isArray(actual.candidates) ? actual.candidates.slice(0, 100) : [],
      candidateRevision: actual.candidateRevision ?? desired.revision,
      error: actual.error || (actual.login ? '账号需要重新登录' : actual.challenge ? '平台需要安全验证' : ''),
    };
    if (before !== JSON.stringify(session.state)) this.service.changed();
  }
  refresh() {
    if (this.closed || this.confirming) return;
    const now = Date.now();
    const sessions = [...this.sessions.values()].sort((a, b) => Number(b.id === this.activeEntryId) - Number(a.id === this.activeEntryId));
    for (const session of sessions) {
      if (this.monitoring >= Math.min(this.service.scheduler.concurrency, 2)) break;
      if (this.saved().entries.find(e => e.id === session.id)?.taskId || !session.editor || session.job || session.pending || session.inspectJob || session.abort.signal.aborted || !['ready', 'syncing'].includes(session.state.phase)) continue;
      if (now - (session.refreshedAt || 0) < (session.id === this.activeEntryId || session.state.candidates.length ? 500 : 3000)) continue;
      const revision = session.desired.revision;
      session.refreshedAt = now;
      this.monitoring++;
      session.inspectJob = Promise.resolve(session.editor.inspect()).then((actual) => {
        if (this.closed || session.abort.signal.aborted || this.saved().entries.find(e => e.id === session.id)?.taskId || this.sessions.get(session.id) !== session || session.job || this.revisions.get(session.id) !== revision) return;
        this.applyActual(session, actual);
      }).catch((error) => {
        if (!session.abort.signal.aborted && this.sessions.get(session.id) === session) {
          session.state = { ...session.state, phase: 'manual', error: error.message, verifiedRevision: null, candidates: [] };
          this.service.changed();
        }
      }).finally(() => { session.inspectJob = null; this.monitoring--; });
    }
  }
  async pick({ id, candidateId, revision } = {}) {
    this.editable();
    const session = this.sessions.get(id);
    if (!session?.editor || session.job) throw new Error('页面正在同步，请稍后选择官方候选');
    if (revision !== session.state.candidateRevision || session.state.revision !== session.desired.revision)
      throw new Error('官方候选已经变化，请等待当前搜索结果');
    const desiredRevision = session.desired.revision;
    session.job = Promise.resolve(session.editor.pick({ id: candidateId, revision: desiredRevision, candidateRevision: revision })).then((actual) => {
      if (session.abort.signal.aborted || this.sessions.get(id) !== session) return;
      if (this.revisions.get(id) !== desiredRevision)
        throw new Error('文案已更新，已丢弃过期的候选选择结果，请等待最新同步');
      if (typeof actual.topics === 'string') {
        const data = this.saved();
        const entry = data.entries.find((row) => row.id === id);
        if (!entry) return;
        entry.topics = actual.topics;
        data.updatedAt = Date.now();
        this.service.store.setSetting('workbench', data);
        session.desired.topics = actual.topics;
        session.lastKey = liveKey(session.desired);
      }
      this.applyActual(session, actual);
    }).finally(() => {
      session.job = null; this.service.changed();
      const entry = this.saved().entries.find((row) => row.id === id);
      if (entry && this.revisions.get(id) !== desiredRevision) this.schedule(entry);
    });
    await session.job;
    return this.state();
  }
  async retry({ id } = {}) {
    this.editable();
    const entry = this.saved().entries.find((row) => row.id === id);
    if (!entry) throw new Error('发布条目不存在');
    const session = this.sessions.get(id);
    if (session?.job) throw new Error('页面仍在处理，请稍候');
    if (session) {
      session.lastKey = null; session.state.phase = 'idle';
      if (session.abort.signal.aborted) {
        session.abort = new AbortController();
        session.editor = null;
        session.prepared = false;
        session.resume = true;
      }
    }
    this.schedule(entry);
    return this.state();
  }
  async takeover({ id, entryId } = {}) {
    id ||= entryId;
    const entry = this.saved().entries.find((row) => row.id === id);
    if (!entry) throw new Error('发布条目不存在');
    if (entry.taskId) {
      await this.service.scheduler.takeover(entry.accountId);
      await this.service.takeoverView(entry.accountId);
      return this.state();
    }
    const session = this.sessions.get(id);
    if (session) {
      session.abort.abort();
      await session.job?.catch(() => {});
      await Promise.resolve(session.editor?.close()).catch(() => {});
      session.release?.(); session.release = null;
      // Keep the editor proof until retry creates a fresh connection. Explicit
      // manual takeover suspends synchronization rather than fighting the user.
      session.state = { ...session.state, phase: 'manual', error: '已转为人工操作，完成后点击重新检查', verifiedRevision: null };
    }
    await this.service.scheduler.takeover(entry.accountId);
    await this.service.takeoverView(entry.accountId);
    this.service.changed();
    return this.state();
  }
  async publish({ confirmed, entryIds } = {}) {
    this.editable();
    if (confirmed !== true) throw new Error('请明确确认正式发布');
    const draft = this.saved();
    const entries = entryIds === undefined ? draft.entries.filter(e => !e.taskId) : (() => {
      if (!Array.isArray(entryIds) || !entryIds.length || new Set(entryIds).size !== entryIds.length) throw new Error('请选择要正式发布的账号');
      const selected = draft.entries.filter((entry) => entryIds.includes(entry.id));
      if (selected.length !== entryIds.length) throw new Error('发布账号选择已经变化');
      if (selected.some(e => e.taskId)) throw new Error('所选账号已经正式确认，请勿重复发布');
      return selected;
    })();
    if (!entries.length) throw new Error('请先添加尚未正式确认的账号和视频');
    this.confirming = true;
    try {
      const rows = [], sessions = [], now = Date.now();
      for (const [ordinal, entry] of entries.entries()) {
        const account = this.service.accounts().find((row) => row.id === entry.accountId && row.platformId === 'douyin');
        if (!account || !entry.videoId || !entry.title) throw new Error('请为每个发布账号选择视频并填写标题');
        const session = this.sessions.get(entry.id);
        if (!session?.editor || session.job || session.abort.signal.aborted || session.lastKey !== liveKey(entry) || session.state.phase !== 'ready' || session.state.verifiedRevision !== this.revisions.get(entry.id))
          throw new Error(`${account.name}：官网页面尚未完成当前内容同步，请先完成填写或处理异常`);
        let actual;
        try {
          actual = await session.editor.inspect();
          if (!actual.verified || actual.revision !== session.state.verifiedRevision || actual.canSubmit === false)
            throw new Error('官网页面状态发生变化，请重新检查后再发布');
        } catch (error) {
          session.state = { ...session.state, phase: 'manual', error: error.message, verifiedRevision: null };
          this.service.changed();
          throw new Error(`${account.name}：${error.message}`);
        }
        const video = this.service.store.resource(entry.videoId, 'video');
        const previous = this.service.store.tasks().find(t => t.accountId === entry.accountId && t.video.sha256 === video.sha256 && !['cancelled','failed'].includes(t.status));
        if (previous || this.service.store.setting('deletedPublicationKeys', {})[`${entry.accountId}:${video.sha256}`]) throw new Error(`${account.name}：此视频已有发布任务或提交记录，请核实后使用新的视频`);
        await media.validate(video);
        rows.push({
          key: entry.id, workbenchEntryId: entry.id, workflow: 'workbench',
          liveOwner: session.token, liveRevision: session.state.verifiedRevision,
          videoId: video.id, video: structuredClone(video), accountId: account.id,
          accountName: account.name, platformId: 'douyin', title: entry.title,
          topics: entry.topics, cover: { mode: 'first' }, location: { mode: 'none' },
          nativeSchedule: null, autoSubmit: true, plannedAt: now, minIntervalMs: 0, ordinal,
        });
        sessions.push(session);
      }
      let data;
      this.service.store.transaction(() => {
        const batchId = this.service.store.addBatch(draft.name || '实时视频发布', rows, { transaction: false });
        const tasks = this.service.store.tasks().filter((task) => task.batchId === batchId);
        const ids = new Map(tasks.map((task) => [task.workbenchEntryId, task.id]));
        for (const session of sessions) {
          const taskId = ids.get(session.id);
          this.service.store.setTask(taskId, { checkpoint: { ...session.checkpoint, uploaded: true, filled: true, workbenchPrepared: true, submissionAuthorized: true } });
          this.service.store.log(taskId, '用户正式确认发布；视频与文案已经在原账号官网填写，执行阶段仅核验并提交');
          for (const log of session.logs) this.service.store.log(taskId, log.message, log.level);
        }
        data = { ...draft, entries: draft.entries.map((entry) => ({ ...entry, ...(ids.has(entry.id) ? { taskId: ids.get(entry.id) } : {}) })), batchId, authorizedAt: now, updatedAt: now };
        this.service.store.setSetting('workbench', data);
      });
      for (const session of sessions) {
        session.state.phase = 'publishing';
        session.release?.(); session.release = null;
      }
      this.service.changed();
      await this.service.scheduler.tick();
      return this.state();
    } finally {
      this.confirming = false;
      this.pump();
    }
  }
  async submit(task, context) {
    let session = this.sessions.get(task.workbenchEntryId);
    if (task.checkpoint.submitIntent) return { status: 'unverified', reason: '该任务已到达提交边界，请核实官网结果，禁止重复发布' };
    try {
      if (!session?.editor || session.editor.closed || session.abort.signal.aborted) {
        const abort = new AbortController();
        session = { id: task.workbenchEntryId, accountId: task.accountId, videoId: task.videoId,
          token: task.liveOwner, abort, editor: null, release: null, logs: [], checkpoint: { ...task.checkpoint },
          state: { phase: 'publishing', revision: task.liveRevision, verifiedRevision: task.liveRevision, candidates: [] } };
        session.editor = new this.Editor({ accountId: task.accountId, token: task.liveOwner,
          signal: AbortSignal.any([abort.signal, context.signal]), getView: id => this.service.getView(id, context.signal),
          log: context.log, trace: event => this.service.traceWorkbench(task.accountId, event), checkpoint: context.checkpoint });
        this.sessions.set(session.id, session);
        await session.editor.reconnectPrepared(task);
      }
      if (session.token !== task.liveOwner || task.liveRevision !== session.state.verifiedRevision)
        return { status: 'manual', reason: '原账号实时编辑页面已变化，请重新检查，未重新上传或填写' };
      const result = await session.editor.submit(task, context);
      session.state = { ...session.state, phase: result.status === 'submitted' || result.status === 'success' ? 'submitted' : 'manual', error: result.status === 'submitted' || result.status === 'success' ? '' : result.reason };
      this.service.changed();
      return result;
    } finally {
      await Promise.resolve(session.editor?.close()).catch(() => {});
      session.editor = null;
    }
  }
  async closeSession(id, discard = false) {
    const session = this.sessions.get(id);
    if (!session) return;
    session.abort.abort();
    await session.job?.catch(() => {});
    await session.inspectJob?.catch(() => {});
    try {
      if (discard && session.editor) await session.editor.discard();
    } finally {
      await Promise.resolve(session.editor?.close()).catch(() => {});
      session.release?.(); session.release = null;
      this.sessions.delete(id);
      this.pending = this.pending.filter((pending) => pending !== session);
    }
  }
  async clear({ confirmed = false } = {}) {
    if (this.confirming) throw new Error('正在确认发布，请稍候');
    const data = this.saved();
    if (this.service.store.tasks().some((task) => data.entries.some(e => e.taskId === task.id) && unfinished(task)))
      throw new Error('当前批次仍有未完成任务，请先完成或取消；结果待核实的任务请先核实');
    if (this.sessions.size && confirmed !== true) throw new Error('请确认放弃尚未发布的官网编辑内容');
    for (const id of [...this.sessions.keys()]) await this.closeSession(id, !data.entries.find(e => e.id === id)?.taskId);
    this.revisions.clear();
    this.errors.clear();
    this.service.store.setSetting('workbench', { entries: [], name: '', batchId: null, authorizedAt: null, updatedAt: Date.now() });
    this.service.changed();
    return this.state();
  }
  async shutdown() {
    this.closed = true;
    clearInterval(this.monitor);
    for (const id of [...this.sessions.keys()]) await this.closeSession(id);
  }
}
module.exports = { Workbench };
