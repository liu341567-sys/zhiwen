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
      tasks: tasks.map((t) => ({ id: t.id, accountName: t.accountName,
        videoName: t.video.name, status: t.status, statusLabel: statuses[t.status],
        canRun: runnable(t), accountId: t.accountId })),
    };
  }
  refresh() {
    const s = this.service, a = s.report?.assistance;
    if (!a || !['recording', 'paused'].includes(s.report.status)) return false;
    let data;
    try {
      const t = this.task(a.taskId), p = this.publisher();
      const wait = t.status === 'pending' ? p.scheduler.waitInfo(t) : null;
      data = scrub({ platform: t.platformId, status: t.status, plannedAt: t.plannedAt,
        stateLabel: statuses[t.status], reason: t.result?.reason || '',
        wait: wait ? { message: wait.message, retryAt: wait.retryAt } : null,
        checkpoint: { uploaded: !!t.checkpoint.uploaded, filled: !!t.checkpoint.filled,
          submitIntent: !!t.checkpoint.submitIntent },
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
      this.mode = 'assistant';
      return s.state();
    }
    if (command === 'assistant-mode') {
      if (!['assistant', 'professional'].includes(input.mode)) throw new Error('模式无效');
      this.mode = input.mode;
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
      s.report.assistance = { taskId: t.id, issue: redact(input.issue).slice(0, 1000),
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
    if (!s.report?.assistance) throw new Error('请先选择任务并开始记录');
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
    if (s.report.status !== 'recording') throw new Error('记录已结束，请新建记录');
    if (command === 'assistant-problem') {
      a.issue = redact(input.issue || a.issue || '用户反馈页面卡住或出现异常').slice(0, 1000);
      await s.command('note', { note: '用户标记问题：' + a.issue });
      this.refresh();
      await s.poll(true);
    } else if (command === 'assistant-manual') {
      await this.publisher().action({ ids: [a.taskId], action: 'takeover' });
      a.phase = 'manual';
      await s.command('note', { note: '人工演示正确操作开始。已暂停此账号的自动任务，保留当前网页；本段为人工操作。' });
      await s.reveal(s.active);
      this.refresh();
    } else throw new Error('问题助手操作无效');
    return s.state();
  }
}
module.exports = { PublishingAssistant, runnable, statuses };
