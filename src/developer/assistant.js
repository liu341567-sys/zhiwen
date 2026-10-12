'use strict';
const { redact, scrub } = require('./data');
const runnable = (task) => !!task &&
  ['pending', 'paused', 'manual', 'failed'].includes(task.status) &&
  !task.checkpoint?.submitIntent;
const statuses = {
  pending: '等待执行', running: '正在执行', paused: '任务已暂停',
  manual: '需要人工处理', failed: '执行失败', unverified: '结果需要核实',
  submitted: '已经提交', review: '正在审核', success: '发布成功', cancelled: '已取消',
};
// A guided workflow over the existing recorder and task engine. It never
// creates accounts, changes task authorization or bypasses submission guards.
class PublishingAssistant {
  constructor(service, publisher, prepareView) {
    this.service = service;
    this.publisher = publisher;
    this.prepareView = prepareView;
    this.preferredTask = null;
    this.mode = 'assistant';
    this.workflow = 'record';
  }
  task(id) {
    if (typeof id !== 'string' || id.length > 100) throw new Error('请选择要排查的发布任务');
    const p = this.publisher();
    if (!p) throw new Error('发布中心暂不可用，请先打开发布中心');
    return p.store.task(id);
  }
  state() {
    const tasks = this.publisher()?.store.tasks() || [];
    return {
      mode: this.mode,
      preferredTask: this.preferredTask,
      workflow: this.workflow,
      environments: this.service.profiles().map((p) => ({ id: p.id, name: p.name,
        platformId: p.platformId, leased: this.service.isLeased(p.id),
        running: !!this.service.inspectView(p.id) && !this.service.inspectView(p.id).isDestroyed() })),
      tasks: tasks.map((t) => ({ id: t.id, accountName: t.accountName,
        videoName: t.video.name, status: t.status, statusLabel: statuses[t.status],
        canRun: runnable(t), accountId: t.accountId })),
    };
  }
  refresh() {
    const s = this.service, a = s.report?.assistance;
    if (!a?.taskId || !['recording', 'paused'].includes(s.report.status)) return false;
    let data;
    try {
      const t = this.task(a.taskId), p = this.publisher();
      const wait = t.status === 'pending' ? p.scheduler.waitInfo(t) : null;
      data = scrub({ platform: t.platformId, status: t.status, plannedAt: t.plannedAt,
        stateLabel: statuses[t.status], reason: t.result?.reason || '',
        wait: wait ? { message: wait.message, retryAt: wait.retryAt } : null,
        checkpoint: { uploaded: !!t.checkpoint.uploaded, filled: !!t.checkpoint.filled,
          submitIntent: !!t.checkpoint.submitIntent, manualOptionsConfirmed: !!t.checkpoint.manualOptionsConfirmed,
          nativeScheduleVerified: !!t.checkpoint.nativeScheduleVerified, preparedMediaReused: !!t.checkpoint.preparedMediaReused },
        options: { nativeSchedule: t.nativeSchedule ? { at: t.nativeSchedule.at || null, timezone: t.nativeSchedule.timezone || null } : null,
          locationMode: t.location?.mode || 'none', coverMode: t.cover?.mode || 'first', autoSubmit: t.autoSubmit === true },
        logs: p.store.logs(t.id).slice(-100).map((l) => ({ time: l.time,
          level: l.level, message: l.message })),
      });
    } catch { data = { status: 'missing', stateLabel: '任务记录已删除', logs: a.task?.logs || [] }; }
    if (JSON.stringify(a.task) === JSON.stringify(data)) return false;
    const changedStatus = a.task?.status !== data.status;
    a.task = data;
    if (changedStatus) {
      a.transitions ||= [];
      a.transitions.push({ time: Date.now(), status: data.status });
      a.transitions = a.transitions.slice(-60);
    }
    s.save();
    return changedStatus;
  }
  async command(command, input) {
    const s = this.service;
    if (command === 'assistant-select') {
      const task = this.task(input.taskId);
      if (['recording', 'paused'].includes(s.report?.status) && s.report.assistance?.taskId !== task.id)
        throw new Error('已有其他记录正在进行，请先结束记录，再排查这个任务');
      if (s.report && !['recording', 'paused'].includes(s.report.status))
        await this.command('assistant-new', {});
      this.preferredTask = task.id;
      this.workflow = 'diagnostic';
      this.mode = 'assistant';
      return s.state();
    }
    if (command === 'assistant-mode') {
      if (!['assistant', 'professional'].includes(input.mode)) throw new Error('模式无效');
      this.mode = input.mode;
      return s.state();
    }
    if (command === 'assistant-workflow') {
      if (!['record', 'diagnostic'].includes(input.workflow)) throw new Error('记录方式无效');
      if (['recording', 'paused'].includes(s.report?.status)) throw new Error('请先结束当前记录');
      this.workflow = input.workflow;
      return s.state();
    }
    if (command === 'assistant-record') {
      if (['recording', 'paused'].includes(s.report?.status)) throw new Error('已有记录正在进行，请先结束并保存');
      if (!['record', 'diagnostic'].includes(input.workflow || 'record')) throw new Error('记录方式无效');
      const profile = s.profiles().find((p) => p.id === input.accountId);
      if (!profile) throw new Error('请选择已有的账号环境');
      if (s.isLeased(profile.id)) throw new Error('此账号正在自动执行任务，请先在任务列表暂停，或关联任务后人工接管');
      await this.prepareView(profile.id);
      if (s.isLeased(profile.id)) throw new Error('此账号刚开始自动执行任务，请先暂停再录制');
      await s.attach(profile.id, { includeText: true, screenshots: false });
      this.workflow = input.workflow || 'record';
      const name = redact(input.name || (this.workflow === 'record' ? '人工操作录制' : '网页问题排查')).slice(0, 120);
      s.report.name = name;
      s.report.assistance = { kind: this.workflow, name,
        scope: input.scope === 'partial' ? 'partial' : 'full',
        issue: redact(input.issue).slice(0, 1000), phase: 'manual', segments: [], transitions: [] };
      await s.command('start');
      await s.command('note', { note: '人工操作记录开始；仅连接已有环境，未创建或执行发布任务。' });
      // Activate recording before returning to the original page so the first
      // human operation is captured. Opening a saved profile does not recreate it.
      try { await s.reveal(profile.id); }
      catch (error) { await s.command('pause'); throw error; }
      return s.state();
    }
    if (command === 'assistant-new') {
      if (['recording', 'paused'].includes(s.report?.status))
        throw new Error('请先结束当前记录');
      await s.pollDone;
      await s.release();
      s.report = null;
      s.active = null;
      s.lastError = null;
      return s.state();
    }
    if (command === 'assistant-start') {
      const t = this.task(input.taskId);
      if (['recording', 'paused'].includes(s.report?.status))
        throw new Error('已有记录正在进行，请先结束并保存');
      if (input.run && !runnable(t))
        throw new Error('这个任务不能直接重试，可选择只记录现场；已经提交的任务请先核实结果');
      if (!s.profiles().some((p) => p.id === t.accountId))
        throw new Error('此任务的账号环境已经删除');
      await this.prepareView(t.accountId);
      await s.attach(t.accountId, { includeText: true, screenshots: false });
      this.preferredTask = t.id;
      this.workflow = 'diagnostic';
      s.report.assistance = { kind: 'diagnostic', taskId: t.id, issue: redact(input.issue).slice(0, 1000),
        phase: 'automatic', transitions: [], task: null };
      await s.command('start');
      this.refresh();
      await s.command('note', { note: input.run ? '用户开始记录并执行原任务，沿用原提交授权。' : '用户开始记录当前现场；未自动执行或提交任务。' });
      if (input.run) {
        if (!runnable(this.task(t.id))) throw new Error('任务状态已经变化，已开始记录但未重新执行');
        await this.publisher().action({ ids: [t.id], action: 'start' });
      }
      this.refresh();
      return s.state();
    }
    if (!s.report?.assistance) throw new Error('请先选择账号环境或任务并开始记录');
    const a = s.report.assistance;
    if (command === 'assistant-finish') {
      if (['recording', 'paused'].includes(s.report.status)) {
        this.refresh();
        await s.command('stop');
      }
      a.phase = 'review';
      s.save();
      return s.state();
    }
    if (command === 'assistant-pause') {
      if (s.report.status !== 'recording') throw new Error('当前没有正在进行的记录');
      await s.command('note', { note: '暂停录制；暂停期间的人工操作不纳入流程。' });
      await s.command('pause');
      return s.state();
    }
    if (command === 'assistant-resume') {
      if (s.report.status !== 'paused') throw new Error('记录未暂停');
      if (s.isLeased(s.active)) throw new Error('此账号正在执行自动任务，请先暂停任务再继续人工录制');
      await s.command('resume');
      await s.command('note', { note: '继续人工操作录制。' });
      return s.state();
    }
    if (s.report.status !== 'recording') throw new Error('记录已结束，请新建记录');
    if (command === 'assistant-segment') {
      const note = redact(input.note).trim().slice(0, 500);
      if (!note) throw new Error('请填写这一步或模块的说明，例如：开始设置封面');
      await s.poll(true);
      await s.command('note', { note: '模块 / 步骤标记：' + note });
      a.segments ||= [];
      a.segments.push({ time: Date.now(), label: note, stepId: s.report.steps.at(-1)?.id,
        snapshotId: s.report.snapshots.at(-1)?.id });
      a.segments = a.segments.slice(-100);
      s.save();
    } else if (command === 'assistant-problem') {
      a.issue = redact(input.issue || a.issue || '用户反馈页面卡住或出现异常').slice(0, 1000);
      await s.command('note', { note: '用户标记问题：' + a.issue });
      this.refresh();
      await s.poll(true);
    } else if (command === 'assistant-manual') {
      if (a.taskId) await this.publisher().action({ ids: [a.taskId], action: 'takeover' });
      else if (s.isLeased(s.active)) throw new Error('此账号正在自动执行任务，请先暂停任务再演示');
      a.phase = 'manual';
      await s.command('note', { note: a.taskId ? '人工演示正确操作开始。已暂停此账号的自动任务，保留当前网页；本段为人工操作。' : '人工演示正确操作开始；保留当前网页，本段为人工操作，未执行自动任务。' });
      await s.reveal(s.active);
      this.refresh();
    } else throw new Error('问题助手操作无效');
    return s.state();
  }
}
module.exports = { PublishingAssistant, runnable, statuses };
