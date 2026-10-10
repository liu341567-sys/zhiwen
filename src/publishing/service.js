'use strict';
const fs = require('node:fs'),
  path = require('node:path'),
  { randomUUID } = require('node:crypto');
const { PublishingStore } = require('./store'),
  matching = require('./matching'),
  media = require('./media'),
  { Scheduler } = require('./scheduler');
const douyin = require('./adapters/douyin');
const presets = require('../platform-presets.json');
const clone = (v) => structuredClone(v);
const text = (v, max = 1000) => {
  if (typeof v !== 'string' || v.length > max)
    throw new Error('文本格式或长度不正确');
  return v.trim();
};
class PublishingService {
  constructor({
    directory,
    profiles,
    getView,
    takeover,
    inspectView,
    notify,
    changed = () => {},
  }) {
    this.directory = path.join(directory, 'publishing');
    this.cache = path.join(this.directory, 'cache');
    this.store = new PublishingStore(this.directory);
    this.profiles = profiles;
    this.getView = getView;
    this.takeoverView = takeover;
    this.notify = notify;
    this.changed = changed;
    this.importing = false;
    this.adapters = new Map(
      [douyin].map((adapter) => [adapter.descriptor.id, adapter]),
    );
    this.store.recover();
    this.scheduler = new Scheduler({
      store: this.store,
      concurrency: this.store.setting('concurrency', 2),
      changed,
      notify: (m, t) => {
        notify(m, t);
        changed();
      },
      execute: async (task, context) => {
        const account = this.accounts().find(
          (a) => a.id === task.accountId && a.platformId === task.platformId,
        );
        if (!account) throw new Error('原账号环境已删除或平台绑定不可用');
        const adapter = this.adapters.get(task.platformId);
        if (!adapter) throw new Error('当前平台没有执行适配器');
        changed();
        const result = await adapter.execute(task, context, {
          getView: (id) => getView(id, context.signal),
          validate: media.validate,
          accountStatus: (id, status) =>
            this.store.setSetting(`account:${id}`, {
              status,
              checkedAt: Date.now(),
            }),
        });
        setImmediate(changed);
        return result;
      },
    });
    const { Diagnostics } = require('./diagnostics');
    this.diagnostics = new Diagnostics({
      store: this.store,
      scheduler: this.scheduler,
      inspectView,
      changed,
    });
    this.scheduler.trace = (id, message, level) =>
      this.diagnostics.event(id, message, level);
  }
  accounts() {
    const bindings = this.store.setting('accountBindings', {});
    return this.profiles().map((p) => ({
      ...p,
      platformId: p.platformId || bindings[p.id] || null,
      login: (() => {
        const login = this.store.setting(`account:${p.id}`, {
          status: 'unknown',
          checkedAt: null,
        });
        return login.checkedAt && Date.now() - login.checkedAt > 300000
          ? { ...login, status: 'unknown' }
          : login;
      })(),
    }));
  }
  snapshot() {
    const thumbnails = this.store.list('video').map((v) => {
      let thumbnailData = '';
      try {
        thumbnailData =
          'data:image/jpeg;base64,' +
          fs.readFileSync(v.thumbnail).toString('base64');
      } catch {}
      return {
        ...v,
        thumbnailData,
        mediaUrl: `qiye-media://local/video/${v.id}`,
      };
    });
    const tasks = this.store.tasks();
    return {
      videos: thumbnails,
      library: this.store.list('title').concat(this.store.list('topics')),
      covers: this.store.list('image'),
      locations: this.store.list('location'),
      drafts: [
        this.store.draft('current'),
        this.store.draft(
          `preview:${this.store.draft('current')?.data.previewId || ''}`,
        ),
      ].filter(Boolean),
      tasks: tasks.map((t) => ({
        ...t,
        queue:
          t.status === 'pending' ? this.scheduler.waitInfo(t, tasks) : null,
        diagnosticActive: this.diagnostics.active.has(t.id),
      })),
      scheduler: this.scheduler.runtime(),
      batches: this.store.batches(),
      accounts: this.accounts(),
      concurrency: this.scheduler.concurrency,
      platforms: [
        ...[...this.adapters.values()].map((adapter) => adapter.descriptor),
        ...['xiaohongshu', 'kuaishou', 'weixin-channels']
          .filter((id) => !this.adapters.has(id))
          .map((id) => ({
            id,
            name: presets.find((p) => p.id === id).displayName,
            enabled: false,
          })),
      ].map((platform) => ({
        ...platform,
        iconResource:
          presets.find((p) => p.id === platform.id)?.iconResource ||
          '../assets/qiye.png',
      })),
      ui: this.store.setting('ui', { page: 'video', step: 0, scroll: {} }),
    };
  }
  async importFiles(files) {
    if (this.importing) throw new Error('已有素材正在导入，请稍候');
    if (
      !Array.isArray(files) ||
      files.length > 500 ||
      files.some((f) => typeof f !== 'string' || !path.isAbsolute(f))
    )
      throw new Error('请选择最多 500 个本地视频文件');
    this.importing = true;
    const added = [],
      duplicates = [],
      errors = [];
    try {
      for (const file of files) {
        try {
          const video = await media.inspect(file, this.cache);
          const old = this.store
            .list('video')
            .find((v) => v.sha256 === video.sha256);
          if (old) {
            duplicates.push(path.basename(file));
            await fs.promises.unlink(video.thumbnail).catch(() => {});
            continue;
          }
          this.store.putResource('video', video, video.id);
          added.push(video.id);
          this.changed();
        } catch (e) {
          errors.push({ name: path.basename(file), reason: e.message });
        }
      }
    } finally {
      this.importing = false;
      this.changed();
    }
    return { added, duplicates, errors };
  }
  async addCover(file) {
    const real = await fs.promises.realpath(file),
      stat = await fs.promises.stat(real);
    if (
      !stat.isFile() ||
      !['.jpg', '.jpeg', '.png', '.webp'].includes(
        path.extname(real).toLowerCase(),
      ) ||
      stat.size > 20 * 1024 * 1024
    )
      throw new Error('封面应为不超过 20 MB 的 JPG / PNG / WebP 图片');
    return this.store.putResource('image', {
      path: real,
      name: path.basename(real),
      bytes: stat.size,
    });
  }
  bindAccount(id, platformId) {
    if (!this.profiles().some((p) => p.id === id && !p.platformId))
      throw new Error('只能关联尚未设置平台的现有环境');
    if (platformId !== null && !this.adapters.has(platformId))
      throw new Error('平台暂未开放');
    const map = this.store.setting('accountBindings', {});
    if (platformId) map[id] = platformId;
    else delete map[id];
    this.store.setSetting('accountBindings', map);
    this.changed();
  }
  resources(kind, lines, group = '') {
    if (
      !['title', 'topics', 'location'].includes(kind) ||
      !Array.isArray(lines) ||
      lines.length > 5000
    )
      throw new Error('无效的资源导入');
    group = text(group, 100);
    const old = this.store.list(kind),
      seen = new Set(old.map((v) => v.value)),
      added = [],
      duplicates = [];
    for (const value of lines.map((v) => text(v, 1000)).filter(Boolean)) {
      if (seen.has(value)) {
        duplicates.push(value);
        continue;
      }
      seen.add(value);
      added.push(
        this.store.putResource(kind, {
          value,
          group,
          order: old.length + added.length,
        }),
      );
    }
    this.changed();
    return { added, duplicates };
  }
  editResource(input) {
    const r = this.store.resource(input.id, input.kind);
    if (input.kind === 'video') {
      r.group = text(input.group || '', 100);
    } else if (['title', 'topics', 'location'].includes(input.kind)) {
      r.value = text(input.value);
      if (
        this.store
          .list(input.kind)
          .some((other) => other.id !== r.id && other.value === r.value)
      )
        throw new Error('此内容已在资源库中');
      if (!r.value) throw new Error('资源内容不能为空');
      r.group = text(input.group || '', 100);
      if (Number.isInteger(input.order) && input.order >= 0)
        r.order = input.order;
    } else throw new Error('此资源不可编辑');
    this.store.putResource(input.kind, r, input.id);
    this.changed();
  }
  removeResources(ids) {
    if (
      !Array.isArray(ids) ||
      !ids.length ||
      ids.length > 5000 ||
      ids.some((id) => typeof id !== 'string' || !id)
    )
      throw new Error('无效的资源选择');
    const removed = this.store.transaction(() => {
      let count = 0;
      for (const id of new Set(ids)) count += this.store.removeResource(id);
      return count;
    });
    this.changed();
    return { removed };
  }
  removeTasks({ ids, confirmed }) {
    if (confirmed !== true) throw new Error('请确认删除本地任务及日志');
    if (
      !Array.isArray(ids) ||
      !ids.length ||
      ids.length > 10000 ||
      ids.some((id) => typeof id !== 'string' || !id)
    )
      throw new Error('请先选择有效任务');
    if (ids.some((id) => this.scheduler.running.has(id)))
      throw new Error('执行中任务请先暂停，再删除记录');
    const result = this.store.removeTasks([...new Set(ids)]);
    for (const id of new Set(ids))
      if (this.diagnostics.active.has(id)) this.diagnostics.stop(id);
    this.changed();
    return result;
  }
  validateCover(cover) {
    if (!['first', 'frame', 'image'].includes(cover?.mode))
      throw new Error('无效封面模式');
    if (cover.mode === 'image') {
      if (typeof cover.id !== 'string' || !cover.id)
        throw new Error(
          '已选择本地图片封面，请选择或导入具体封面图片；也可以改用平台默认首帧',
        );
      this.store.resource(cover.id, 'image');
    }
    if (
      cover.mode === 'frame' &&
      (!Number.isFinite(Number(cover.seconds ?? 0)) ||
        Number(cover.seconds ?? 0) < 0)
    )
      throw new Error('指定封面帧时间必须为非负数');
  }
  validateInput(input) {
    if (
      !input ||
      typeof input !== 'object' ||
      JSON.stringify(input).length > 32e6
    )
      throw new Error('发布配置过大或无效');
    if (
      !Array.isArray(input.platformIds) ||
      !input.platformIds.length ||
      input.platformIds.some((id) => !this.adapters.has(id)) ||
      new Set(input.platformIds).size !== input.platformIds.length
    )
      throw new Error('第一期仅支持抖音视频发布');
    if (
      !Array.isArray(input.videoIds) ||
      !Array.isArray(input.accountIds) ||
      input.videoIds.length > 500 ||
      input.accountIds.length > 200
    )
      throw new Error('素材或账号选择无效');
    const accounts = this.accounts();
    if (
      input.accountIds.some(
        (id) =>
          !accounts.some(
            (a) => a.id === id && input.platformIds.includes(a.platformId),
          ),
      )
    )
      throw new Error('请选择已关联抖音的原账号环境');
    for (const key of ['title', 'topics']) {
      const c = input[key];
      if (!c || !Array.isArray(c.values) || c.values.length > 5000)
        throw new Error('请设置标题与话题匹配');
      c.values.forEach((v) => text(v));
      for (const v of Object.values(c.locks || {})) text(v);
    }
    return clone(input);
  }
  preview(input) {
    input = this.validateInput(input);
    const rows = matching.generate(
      input,
      this.store.list('video'),
      this.accounts(),
    );
    rows
      .filter((row) => !row.cancelled)
      .forEach((row) => this.validateCover(row.cover));
    const previewId = randomUUID();
    this.store.saveDraft(
      { input, rows, createdAt: Date.now() },
      `preview:${previewId}`,
    );
    return { previewId, rows };
  }
  saveDraft(input) {
    if (!input || JSON.stringify(input).length > 32e6)
      throw new Error('草稿过大');
    this.store.saveDraft(clone(input));
    this.changed();
    return { saved: true };
  }
  async confirm({ previewId, rows, name, allowDuplicates = false }) {
    const draft = this.store.draft(`preview:${previewId}`);
    if (!draft) throw new Error('预览已过期，请重新生成');
    if (!Array.isArray(rows) || rows.length !== draft.data.rows.length)
      throw new Error('任务数量发生变化，请重新预览');
    const existing = this.store
      .tasks()
      .filter((t) => !['cancelled', 'failed'].includes(t.status));
    const deletedPublications = this.store.setting(
      'deletedPublicationKeys',
      {},
    );
    const keys = new Set(),
      validated = new Set(),
      final = [];
    for (const [i, row] of rows.entries()) {
      const original = draft.data.rows.find((t) => t.key === row.key);
      if (!original || keys.has(row.key)) throw new Error('任务关系无效或重复');
      keys.add(row.key);
      const account = this.accounts().find(
        (a) =>
          a.id === original.accountId && a.platformId === original.platformId,
      );
      if (!account) throw new Error('原账号环境不可用');
      const video = this.store.resource(original.videoId, 'video');
      if (!validated.has(video.id)) {
        await media.validate(video);
        validated.add(video.id);
      }
      const t = {
        ...original,
        title: text(row.title),
        topics: text(row.topics),
        plannedAt: row.plannedAt,
        ordinal: i,
        cover: clone(row.cover),
        location: clone(row.location),
        locked: row.locked === true,
        cancelled: row.cancelled === true,
        autoSubmit: row.autoSubmit === true,
        video: clone(video),
      };
      if (!t.title && !t.cancelled) throw new Error('任务标题不能为空');
      if (!Number.isFinite(t.plannedAt) || t.plannedAt < Date.now() - 300000)
        throw new Error('计划时间已过，请重新配置');
      this.validateCover(t.cover);
      if (t.cover.mode === 'frame')
        t.cover = {
          mode: 'image',
          ...this.store.putResource('image', {
            path: await media.frame(
              video,
              Number(t.cover.seconds ?? 0),
              this.cache,
            ),
            name: `${video.name}指定帧封面`,
          }),
        };
      if (t.cover.mode === 'image') {
        const cover = this.store.resource(t.cover.id, 'image');
        await fs.promises.access(cover.path, fs.constants.R_OK);
        t.cover = { mode: 'image', ...cover };
      }
      if (!['none', 'specified'].includes(t.location?.mode))
        throw new Error('无效定位配置');
      if (t.location.mode === 'specified') {
        t.location.label = text(t.location.label, 200);
        if (!t.location.label) throw new Error('指定位置不能为空');
      }
      if (
        !t.cancelled &&
        !allowDuplicates &&
        (deletedPublications[`${t.accountId}:${t.video.sha256}`] ||
          existing.some(
            (old) =>
              old.accountId === t.accountId &&
              old.video.sha256 === t.video.sha256,
          ))
      )
        throw new Error(
          `检测到同账号已有相同视频任务：${account.name}。请核实后勾选允许重复`,
        );
      final.push(t);
    }
    if (final.every((t) => t.cancelled))
      throw new Error('至少保留一条发布任务');
    const id = this.store.addBatch(text(name || '视频发布批次', 100), final, {
      clearDrafts: true,
    });
    this.changed();
    await this.scheduler.tick();
    return { batchId: id };
  }
  async action({ ids, action, confirmed = false, reason = '' }) {
    if (!Array.isArray(ids) || ids.length > 10000)
      throw new Error('无效的任务选择');
    try {
      for (const id of ids) {
        const task = this.store.task(id);
        if (['pause', 'cancel'].includes(action))
          await this.scheduler.stopTask(
            id,
            action === 'cancel' ? 'cancelled' : 'paused',
          );
        else if (['start', 'resume', 'retry'].includes(action)) {
          if (task.status === 'pending') {
            await this.scheduler.tick();
          } else await this.scheduler.resume(id);
        } else if (action === 'takeover') {
          await this.scheduler.takeover(task.accountId);
          await this.takeoverView(task.accountId);
        } else if (action === 'manual-options') {
          if (task.status !== 'manual' || !confirmed)
            throw new Error('请确认已在平台完成封面 / 定位 / 平台定时设置');
          this.store.setTask(id, {
            checkpoint: { ...task.checkpoint, manualOptionsConfirmed: true },
          });
          await this.scheduler.resume(id);
        } else if (action === 'authorize') {
          if (task.status !== 'manual' || !confirmed)
            throw new Error('请明确授权此任务提交');
          this.store.setTask(id, {
            checkpoint: { ...task.checkpoint, submissionAuthorized: true },
          });
          this.store.log(id, '用户审阅后单独授权此任务自动提交');
          await this.scheduler.resume(id);
        } else if (action === 'resolve') {
          if (
            !['unverified', 'submitted', 'review', 'manual'].includes(
              task.status,
            ) ||
            !confirmed ||
            !text(reason, 1000)
          )
            throw new Error('请在平台核实结果并填写核实说明');
          this.store.setTask(id, {
            status: 'success',
            result: {
              reason: text(reason),
              verifiedBy: 'user',
              verifiedAt: Date.now(),
              url: (text(reason).match(/https:\/\/[^\s]+/) || [])[0] || null,
            },
          });
          this.store.log(id, `用户核实发布成功：${reason}`);
          if (!task.checkpoint.submitIntent)
            this.store.setSetting(`lastRun:${task.accountId}`, {
              taskId: id,
              at: Date.now(),
              kind: 'submitted',
            });
        } else if (action === 'not-submitted') {
          if (task.status !== 'unverified' || !confirmed || !text(reason))
            throw new Error('必须核实未提交并填写说明，才允许再次执行');
          this.store.setTask(id, {
            status: 'paused',
            checkpoint: {},
            result: { reason: text(reason) },
          });
          this.store.log(
            id,
            `用户核实未提交，允许再次执行：${reason}`,
            'warning',
          );
          if (this.store.setting(`lastRun:${task.accountId}`)?.taskId === id)
            this.store.setSetting(`lastRun:${task.accountId}`, null);
        } else throw new Error('不支持的任务操作');
      }
    } finally {
      this.changed();
    }
    return { done: true };
  }
  setUI(ui) {
    if (
      !ui ||
      typeof ui.page !== 'string' ||
      ui.page.length > 30 ||
      !Number.isInteger(ui.step) ||
      ui.step < 0 ||
      ui.step > 4 ||
      JSON.stringify(ui).length > 20000
    )
      throw new Error('无效的发布界面状态');
    this.store.setSetting('ui', ui);
  }
  setConcurrency(n) {
    if (!Number.isInteger(n) || n < 1 || n > 6)
      throw new Error('并发环境数应为 1–6');
    this.scheduler.concurrency = n;
    this.store.setSetting('concurrency', n);
    this.changed();
  }
  async dispatch(command, input) {
    switch (command) {
      case 'diagnostic-state':
        return this.diagnostics.state(input);
      case 'diagnostic-start':
        return this.diagnostics.start(input);
      case 'diagnostic-stop':
        return this.diagnostics.stop(input);
      case 'diagnostic-mark':
        this.diagnostics.mark(input.id, input.step);
        return this.diagnostics.state(input.id);
      case 'diagnostic-clear':
        this.diagnostics.clear(input);
        return { cleared: true };
      case 'state':
        return this.snapshot();
      case 'import':
        return this.importFiles(input);
      case 'resource-add':
        return this.resources(input.kind, input.lines, input.group);
      case 'resource-edit':
        return this.editResource(input);
      case 'resource-remove':
        return this.removeResources(input);
      case 'task-remove':
        return this.removeTasks(input);
      case 'draft-clear':
        this.store.transaction(() => this.store.clearDrafts());
        this.changed();
        return { cleared: true };
      case 'bind':
        return this.bindAccount(input.id, input.platformId);
      case 'preview':
        return this.preview(input);
      case 'draft':
        return this.saveDraft(input);
      case 'confirm':
        return this.confirm(input);
      case 'tasks':
        return this.action(input);
      case 'logs':
        return this.store.logs(input);
      case 'ui':
        return this.setUI(input);
      case 'concurrency':
        return this.setConcurrency(input);
      default:
        throw new Error('不支持的发布操作');
    }
  }
  async shutdown() {
    this.diagnostics.close();
    await this.scheduler.shutdown();
    this.store.close();
  }
}
module.exports = { PublishingService };
