'use strict';
const path = require('node:path'),
  { randomUUID } = require('node:crypto');
const { DeveloperStore, compare, redact, scrub } = require('./data'),
  { pageTool } = require('./page'),
  { reportData, filesFor, zip } = require('./report');
const { PublishingAssistant } = require('./assistant');
class DeveloperService {
  constructor({
    directory,
    profiles,
    inspectView,
    reveal,
    isLeased = () => false,
    changed = () => {},
    technical = {},
    executeFrame,
    publisher = () => null,
    prepareView = async () => {},
  }) {
    this.store = new DeveloperStore(path.join(directory, 'developer-tools'));
    this.store.recover();
    this.profiles = profiles;
    this.inspectView = inspectView;
    this.reveal = reveal;
    this.isLeased = isLeased;
    this.changed = changed;
    this.technical = technical;
    this.executeFrame = executeFrame;
    this.assistant = new PublishingAssistant(this, publisher, prepareView);
    this.active = null;
    this.report = null;
    this.live = false;
    this.busy = false;
    this.closed = false;
    this.queue = Promise.resolve();
    this.lastSample = null;
    this.lastError = null;
    this.screenshotEnabled = false;
    this.inspecting = false;
    this.timer = setInterval(() => {
      if (
        this.live ||
        ['recording'].includes(this.report?.status) ||
        this.inspecting ||
        this.pendingErrorCapture
      )
        this.poll().catch((e) => {
          this.lastError = redact(e.message);
          if (
            !this.inspectView(this.active) ||
            this.inspectView(this.active).isDestroyed()
          ) {
            this.live = false;
            this.inspecting = false;
            this.pendingErrorCapture = null;
            if (this.report?.status === 'recording') {
              this.report.status = 'interrupted';
              this.warn('原环境已关闭，已停止监听；资料保留。');
              this.save();
            }
          }
          this.changed();
        });
    }, 900);
    this.timer.unref?.();
  }
  serial(fn) {
    const p = this.queue.then(() => {
      if (this.closed) throw new Error('开发者工具已关闭');
      return fn();
    });
    this.queue = p.catch(() => {});
    return p;
  }
  frames() {
    const wc = this.view();
    const frames = wc.mainFrame?.framesInSubtree || [wc.mainFrame];
    return frames.filter((f) => f && !f.isDestroyed?.()).slice(0, 24);
  }
  view() {
    if (!this.active) throw new Error('请先选择已打开的环境');
    const wc = this.inspectView(this.active);
    if (!wc || wc.isDestroyed())
      throw new Error('原环境已关闭，请在账号环境管理中重新打开');
    return wc;
  }
  async call(frame, input) {
    let timer;
    try {
      return await Promise.race([
        this.executeFrame(
          frame,
          `(${pageTool.toString()})(${JSON.stringify({ ...this.report?.options, ...input })})`,
        ),
        new Promise((_r, reject) => {
          timer = setTimeout(
            () => reject(new Error('网页分析超时；未导航或重建环境')),
            2500,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  async release() {
    await this.captureDone;
    if (!this.active) return;
    try {
      await Promise.allSettled(
        this.frames().map((f) => this.call(f, { action: 'stop' })),
      );
    } catch {}
    this.live = false;
    this.inspecting = false;
    this.pendingErrorCapture = null;
  }
  state() {
    return {
      profiles: this.profiles()
        .filter(
          (p) =>
            !!this.inspectView(p.id) && !this.inspectView(p.id).isDestroyed(),
        )
        .map((p) => ({
          id: p.id,
          name: p.name,
          platformId: p.platformId,
          leased: this.isLeased(p.id),
        })),
      active: this.active,
      report: this.report,
      live: this.live,
      inspecting: this.inspecting,
      busy: this.busy,
      lastError: this.lastError,
      reports: this.store.list(),
      technical: this.technical,
      assistant: this.assistant.state(),
    };
  }
  save() {
    if (!this.report) return;
    this.report.revision = (this.report.revision || 0) + 1;
    while (Buffer.byteLength(JSON.stringify(this.report)) > 22 * 1024 * 1024) {
      if (this.report.snapshots.length > 1) this.report.snapshots.shift();
      else if (this.report.screenshots.length > 1)
        this.report.screenshots.shift();
      else throw new Error('资料已达到大小上限，请结束并新建录制');
      this.warn('资料超过大小限额，最旧快照或截图已移除，请及时导出。');
    }
    this.store.save(this.report);
    this.changed();
  }
  options(input = {}) {
    if (!input || typeof input !== 'object') throw new Error('隐私配置无效');
    const exclude = input.exclude || [];
    if (
      !Array.isArray(exclude) ||
      exclude.length > 20 ||
      exclude.some((v) => typeof v !== 'string' || v.length > 300)
    )
      throw new Error('最多配置 20 个排除选择器');
    return {
      includeText: input.includeText !== false,
      exclude,
      screenshots: input.screenshots === true,
    };
  }
  async attach(id, options = {}) {
    if (['recording', 'paused'].includes(this.report?.status))
      throw new Error('请先结束当前录制再切换环境');
    if (
      !this.profiles().some((p) => p.id === id) ||
      !this.inspectView(id) ||
      this.inspectView(id).isDestroyed()
    )
      throw new Error('仅能连接已经打开的原环境');
    await this.pollDone;
    await this.release();
    this.active = id;
    this.report = this.store.create(id, this.options(options));
    this.screenshotEnabled = this.report.options.screenshots;
    this.lastSample = null;
    this.lastError = null;
    await this.poll(true);
    return this.state();
  }
  async poll(force = false) {
    if (this.busy && force) await this.pollDone;
    if (this.closed || this.busy || !this.active) return this.state();
    this.busy = true;
    let completed;
    this.pollDone = new Promise((r) => (completed = r));
    const reportId = this.report.id;
    try {
      force = this.assistant.refresh() || force;
      const frames = this.frames(),
        result = await Promise.all(
          frames.map(async (f, i) => {
            try {
              const data = scrub(
                await this.call(f, {
                  action: 'snapshot',
                  limit: Math.min(
                    1200,
                    Math.max(100, Math.floor(2400 / frames.length)),
                  ),
                  record: this.report.status === 'recording',
                  inspect: this.inspecting,
                }),
              );
              return {
                key: i ? 'frame-' + i : 'main',
                context: i
                  ? 'unprivileged-page-world; sampled-events'
                  : 'private-isolated-preload',
                ...data,
                events: data.events || [],
                selected: data.selected,
              };
            } catch (error) {
              return {
                key: i ? 'frame-' + i : 'main',
                unavailable: true,
                reason: '框架暂不可访问或正在跳转',
                nodes: [],
                events: [],
              };
            }
          }),
        );
      if (this.closed || this.report?.id !== reportId) return;
      for (const f of result) {
        for (const event of f.events) this.pageEvent(event, f.key);
        if (f.selected) {
          this.report.selected = { frame: f.key, ...f.selected };
          this.inspecting = false;
          await this.configure();
          this.save();
        }
      }
      const signature = JSON.stringify(
        result.map((f) => ({
          ...f,
          time: 0,
          dirty: false,
          events: [],
          selected: null,
        })),
      );
      if (force || signature !== this.lastSample) {
        const snap = {
          id: randomUUID(),
          time: Date.now(),
          frames: result.map(({ events, selected, dirty, ...f }) => f),
        };
        const prev = this.report.snapshots.at(-1);
        this.report.snapshots.push(snap);
        const pending = this.report.steps.filter((s) => !s.afterId);
        for (const s of pending) {
          s.afterId = snap.id;
          s.diff = compare(
            this.report.snapshots.find((v) => v.id === s.beforeId),
            snap,
          );
        }
        if (prev) snap.diff = compare(prev, snap);
        this.lastSample = signature;
        if (this.report.snapshots.length > 80) {
          this.report.snapshots.shift();
          this.warn(
            '已达 80 份结构快照上限，最旧快照被移除；步骤仍保留时间和定位信息。',
          );
        }
        if (
          this.screenshotEnabled &&
          ['recording'].includes(this.report.status) &&
          this.report.screenshots.length < 20 &&
          !this.isLeased(this.active)
        )
          await this.capture(snap.id, pending.at(-1)?.id);
        this.save();
      }
      if (this.pendingErrorCapture && !this.isLeased(this.active)) {
        const pending = this.pendingErrorCapture;
        this.pendingErrorCapture = null;
        if (pending.reportId === reportId) {
          const item = this.report.scripts.find(
            (s) => s.id === pending.scriptId,
          );
          if (item) {
            await this.capture(item.snapshotId, item.id);
            if (!this.closed && this.report?.id === reportId) this.save();
          }
        }
      }
      return this.state();
    } finally {
      this.busy = false;
      completed();
    }
  }
  warn(message) {
    if (!this.report.warnings.includes(message))
      this.report.warnings.push(message);
    this.report.warnings = this.report.warnings.slice(-30);
  }
  pageEvent(event, frame = 'main') {
    if (
      this.closed ||
      this.report?.status !== 'recording' ||
      !event ||
      ![
        'click',
        'input',
        'change',
        'select',
        'upload',
        'scroll',
        'topic-space',
      ].includes(event.type)
    )
      return;
    if (!event.target || event.target.sensitive) return;
    if (JSON.stringify(event).length > 50000) return;
    const safe = scrub(event);
    delete safe.note;
    const last = this.report.steps.at(-1);
    if (
      last &&
      ['input', 'scroll'].includes(safe.type) &&
      last.type === safe.type &&
      last.frame === frame &&
      last.target?.selector === safe.target?.selector &&
      safe.time - last.time < 500
    ) {
      last.time = safe.time;
      last.target = safe.target;
    } else {
      if (this.report.steps.length >= 600) {
        this.warn('已达 600 步上限，录制已自动暂停。');
        this.report.status = 'paused';
        this.configure().catch(() => {});
      } else
        this.report.steps.push({
          id: randomUUID(),
          ...safe,
          frame,
          beforeId: this.report.snapshots.at(-1)?.id,
          afterId: null,
          note: '',
          inputRedacted: true,
        });
    }
    this.save();
  }
  navigation(id, url) {
    if (id !== this.active || this.report?.status !== 'recording') return;
    this.report.steps.push({
      id: randomUUID(),
      time: Date.now(),
      type: 'navigation',
      url: redact(url),
      frame: 'main',
      beforeId: this.report.snapshots.at(-1)?.id,
      note: '',
      afterId: null,
    });
    if (this.report.steps.length > 600) {
      this.report.steps.pop();
      this.report.status = 'paused';
    }
    this.save();
    this.poll(true).catch(() => {});
  }
  documentReady(id) {
    if (this.closed || this.suspended || id !== this.active || !this.report)
      return;
    if (this.report.status === 'recording' || this.inspecting || this.live)
      this.configure()
        .then(() => this.poll())
        .catch(() => {});
  }
  async configure() {
    return Promise.allSettled(
      this.frames().map((f) =>
        this.call(f, {
          action: 'configure',
          record: this.report.status === 'recording',
          inspect: this.inspecting,
        }),
      ),
    );
  }
  async capture(snapshotId, stepId) {
    if (this.capturing) return null;
    const wc = this.view();
    if (!this.report.options.screenshots)
      throw new Error('请先主动开启脱敏截图');
    if (this.isLeased(this.active))
      throw new Error('自动任务运行时暂不遮盖页面，请暂停任务后截图');
    if (this.report.screenshots.length >= 20)
      throw new Error('每份报告最多 20 张截图，请先删除旧截图');
    this.capturing = true;
    let completeCapture;
    this.captureDone = new Promise((resolve) => {
      completeCapture = resolve;
    });
    const currentReport = this.report;
    let timer;
    try {
      const mask = await this.call(wc.mainFrame, {
        action: 'mask',
        token: randomUUID(),
      });
      if (!mask?.masked || !mask.token)
        throw new Error('无法确认截图遮盖，未保存图像');
      const image = await Promise.race([
        wc.capturePage(undefined, { stayHidden: true, stayAwake: true }),
        new Promise((_r, reject) => {
          timer = setTimeout(
            () => reject(new Error('原网页截图超时；已释放脱敏遮盖')),
            1500,
          );
        }),
      ]);
      if (image.isEmpty()) throw new Error('原网页没有可用画面');
      const status = await this.call(wc.mainFrame, {
        action: 'mask-status',
        token: mask.token,
      });
      if (!status?.valid)
        throw new Error(
          '截图期间页面跳转、变化或滚动，未保存图像；请稳定页面后重试',
        );
      const png = image
        .resize({ width: Math.min(1280, image.getSize().width) })
        .toPNG();
      if (png.length > 750000)
        throw new Error('截图超过安全大小限制，请缩小窗口后重试');
      const s = {
        id: randomUUID(),
        time: Date.now(),
        snapshotId,
        stepId,
        reviewed: false,
        data: 'data:image/png;base64,' + png.toString('base64'),
      };
      if (this.closed || this.suspended || this.report !== currentReport)
        return null;
      this.report.screenshots.push(s);
      return s;
    } catch (error) {
      this.warn(redact(error.message));
      return null;
    } finally {
      clearTimeout(timer);
      await this.call(wc.mainFrame, { action: 'unmask' }).catch(() => {});
      this.capturing = false;
      completeCapture();
    }
  }
  async trace(accountId, event) {
    if (
      this.closed ||
      this.suspended ||
      this.active !== accountId ||
      !this.report
    )
      return;
    if (this.report.assistance && event.taskId &&
        event.taskId !== this.report.assistance.taskId) return;
    if (this.report.assistance && this.report.status !== 'recording') return;
    const safe = scrub(event);
    if (JSON.stringify(safe).length > 40000) return;
    const item = { id: randomUUID(), time: Date.now(), ...safe };
    const currentId = this.report.id;
    this.report.scripts.push(item);
    this.report.scripts = this.report.scripts.slice(-500);
    this.save();
    // Sampling every readiness poll would compete with the publishing engine.
    // Keep all step timings, but capture structure only at meaningful boundaries.
    if (
      event.phase === 'error' ||
      (event.phase === 'end' &&
        [
          'navigation',
          'DOM.setFileInputFiles',
          'Input.dispatchMouseEvent',
          'Input.insertText',
        ].includes(event.operation))
    ) {
      try {
        await this.poll(true);
        if (this.closed || this.report?.id !== currentId) return;
        item.snapshotId = this.report.snapshots.at(-1)?.id;
        if (this.screenshotEnabled && event.phase === 'error') {
          if (this.isLeased(this.active))
            this.pendingErrorCapture = {
              reportId: currentId,
              scriptId: item.id,
            };
          else await this.capture(item.snapshotId, item.id);
        }
        this.save();
      } catch {}
    }
  }
  async command(command, input = {}) {
    if (this.closed) throw new Error('开发者工具已关闭');
    if (command.startsWith('assistant-')) return this.assistant.command(command, input);
    if (
      !['state', 'attach', 'load', 'delete-report'].includes(command) &&
      !this.report
    )
      throw new Error('请先连接环境或加载报告');
    // A background sample must finish before a destructive report mutation.
    if (
      ['load', 'delete-report', 'delete-snapshot', 'stop', 'options'].includes(
        command,
      )
    )
      await this.pollDone;
    switch (command) {
      case 'state':
        return this.state();
      case 'attach':
        return this.attach(input.id, input.options);
      case 'refresh':
        return this.poll(true);
      case 'live':
        this.live = !!input.enabled;
        return this.state();
      case 'options':
        await this.pollDone;
        this.report.options = this.options(input);
        this.screenshotEnabled = this.report.options.screenshots;
        await this.configure();
        this.save();
        return this.state();
      case 'reveal':
        await this.reveal(this.active);
        return this.state();
      case 'inspect':
        if (this.isLeased(this.active))
          throw new Error('请先暂停自动任务，避免检查模式拦截脚本点击');
        this.inspecting = !!input.enabled;
        if (this.inspecting) await this.reveal(this.active);
        await this.configure();
        return this.state();
      case 'validate':
      case 'highlight': {
        if (command === 'highlight' && this.isLeased(this.active))
          throw new Error('请先暂停自动任务再高亮元素');
        if (
          typeof input.selector !== 'string' ||
          input.selector.length > 1500 ||
          !['css', 'xpath'].includes(input.kind || 'css')
        )
          throw new Error('定位器格式无效');
        const key = input.frame || 'main',
          index = key === 'main' ? 0 : Number(key.replace('frame-', '')),
          frame = this.frames()[index];
        if (!frame) throw new Error('目标框架已变化，请刷新分析');
        return this.call(frame, {
          action: command,
          locator: {
            selector: input.selector,
            roots: input.roots || [],
            kind: input.kind || 'css',
          },
        });
      }
      case 'start':
        if (['recording', 'paused'].includes(this.report?.status))
          throw new Error('当前已有录制');
        this.report.status = 'recording';
        this.report.endedAt = null;
        await this.poll(true);
        await this.configure();
        this.save();
        return this.state();
      case 'pause':
        this.report.status = 'paused';
        await this.configure();
        this.save();
        return this.state();
      case 'resume':
        if (!['paused', 'interrupted', 'ended'].includes(this.report?.status))
          throw new Error('录制未暂停');
        this.report.status = 'recording';
        await this.configure();
        this.save();
        return this.state();
      case 'stop':
        await this.poll(true);
        this.report.status = 'ended';
        this.report.endedAt = Date.now();
        await this.release();
        this.save();
        return this.state();
      case 'snapshot':
        await this.poll(true);
        return this.state();
      case 'screenshot':
        await this.capture(this.report.snapshots.at(-1)?.id);
        this.save();
        return this.state();
      case 'note': {
        const text = redact(input.note);
        if (text.length > 1000) throw new Error('备注过长');
        if (input.id) {
          const row = this.report.steps.find((s) => s.id === input.id);
          if (!row) throw new Error('步骤不存在');
          row.note = text;
        } else
          this.report.steps.push({
            id: randomUUID(),
            time: Date.now(),
            type: 'note',
            note: text,
            beforeId: this.report.snapshots.at(-1)?.id,
          });
        this.save();
        return this.state();
      }
      case 'delete-step':
        this.report.steps = this.report.steps.filter((s) => s.id !== input.id);
        this.save();
        return this.state();
      case 'review-shot': {
        const s = this.report.screenshots.find((s) => s.id === input.id);
        if (!s) throw new Error('截图不存在');
        s.reviewed = true;
        this.save();
        return this.state();
      }
      case 'delete-shot':
        this.report.screenshots = this.report.screenshots.filter(
          (s) => s.id !== input.id,
        );
        this.save();
        return this.state();
      case 'delete-snapshot':
        this.report.snapshots = this.report.snapshots.filter(
          (s) => s.id !== input.id,
        );
        this.report.screenshots = this.report.screenshots.filter(
          (s) => s.snapshotId !== input.id,
        );
        this.save();
        return this.state();
      case 'compare': {
        const all = this.report.snapshots;
        return compare(
          all.find((s) => s.id === input.before),
          all.find((s) => s.id === input.after),
        );
      }
      case 'historical': {
        const old = this.store.get(input.id);
        const difference = compare(
          old.snapshots.at(-1),
          this.report.snapshots.at(-1),
        );
        difference.locatorChecks = [];
        const grouped = new Map();
        for (const step of old.steps.slice(0, 60)) {
          if (!step.target?.selector) continue;
          const frame = step.frame || 'main';
          if (!grouped.has(frame)) grouped.set(frame, []);
          grouped.get(frame).push({
            ...step.target.locators?.[0],
            selector:
              step.target.locators?.[0]?.selector || step.target.selector,
            roots: step.target.roots || [],
            stepId: step.id,
          });
        }
        for (const [key, locators] of grouped) {
          const frame =
            this.frames()[
              key === 'main' ? 0 : Number(key.replace('frame-', ''))
            ];
          if (frame)
            difference.locatorChecks.push(
              ...(
                await this.call(frame, { action: 'validate-many', locators })
              ).map((c) => ({ frame: key, ...c })),
            );
          else
            difference.locatorChecks.push(
              ...locators.map((locator) => ({
                frame: key,
                locator,
                count: 0,
                error: '原框架不存在，请重新确认 frame 路径',
              })),
            );
        }
        return difference;
      }
      case 'load':
        if (['recording', 'paused'].includes(this.report?.status))
          throw new Error('请先结束当前录制');
        await this.pollDone;
        await this.release();
        this.report = this.store.get(input.id);
        this.active = this.report.accountId;
        this.screenshotEnabled = this.report.options.screenshots;
        this.lastSample = null;
        return this.state();
      case 'new':
        if (['recording', 'paused'].includes(this.report?.status))
          throw new Error('请先结束当前录制');
        return this.attach(this.active, this.report.options);
      case 'delete-report':
        if (this.report?.id === input.id) {
          await this.release();
          this.report = null;
          this.active = null;
        }
        this.store.remove(input.id);
        return this.state();
      case 'preview':
        if (!this.report) throw new Error('请先连接环境或加载报告');
        this.report.reviewedRevision = this.report.revision;
        this.store.save(this.report);
        return reportData(this.report, this.technical);
      default:
        throw new Error('未知的开发者工具操作');
    }
  }
  async export(format) {
    if (!this.report) throw new Error('请先创建或加载报告');
    if (this.report.status === 'recording')
      throw new Error('请先结束录制再导出');
    if (!['json', 'html', 'md', 'zip'].includes(format))
      throw new Error('格式无效');
    if (this.report.reviewedRevision !== this.report.revision)
      throw new Error('请先预览当前资料并检查脱敏结果，再导出');
    const files = filesFor(this.report, this.technical);
    return format === 'zip'
      ? zip(files)
      : files.find((f) => f.name === 'report.' + format).data;
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.timer);
    if (['recording', 'paused'].includes(this.report?.status)) {
      this.report.status = 'interrupted';
      this.report.endedAt = Date.now();
      this.save();
    }
    await this.pollDone;
    await this.release();
    await this.queue;
    this.store.close();
  }
}
module.exports = { DeveloperService };
