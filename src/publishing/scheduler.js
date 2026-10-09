'use strict';
class Scheduler {
  constructor({
    store,
    execute,
    notify = () => {},
    changed = () => {},
    concurrency = 2,
    now = () => Date.now(),
  }) {
    this.store = store;
    this.execute = execute;
    this.notify = notify;
    this.changed = changed;
    this.concurrency = concurrency;
    this.now = now;
    this.running = new Map();
    this.accounts = new Set();
    this.stopping = false;
    this.timer = null;
  }
  start() {
    this.timer = setInterval(
      () =>
        this.tick().catch((e) =>
          this.notify(`任务队列异常：${e.message}`, 'error'),
        ),
      1000,
    );
    this.timer.unref?.();
    return this.tick();
  }
  leased(id) {
    return this.accounts.has(id);
  }
  async tick() {
    if (this.stopping) return;
    const blocked = new Set(
      this.store
        .tasks()
        .filter((t) => ['manual', 'unverified'].includes(t.status))
        .map((t) => t.accountId),
    );
    for (const task of this.store
      .tasks()
      .filter((t) => t.status === 'pending' && t.plannedAt <= this.now())) {
      if (this.running.size >= this.concurrency) break;
      if (this.accounts.has(task.accountId) || blocked.has(task.accountId))
        continue;
      const last = this.store.setting(`lastRun:${task.accountId}`);
      if (
        last &&
        last.taskId !== task.id &&
        this.now() < last.at + (task.minIntervalMs || 0)
      )
        continue;
      this.store.setSetting(`lastRun:${task.accountId}`, {
        taskId: task.id,
        at: this.now(),
      });
      const abort = new AbortController();
      this.accounts.add(task.accountId);
      this.store.setTask(task.id, {
        status: 'running',
        attempts: task.attempts + 1,
        result: null,
      });
      this.store.log(task.id, '取得环境独占执行权，开始检查');
      const job = Promise.resolve()
        .then(() =>
          this.execute(this.store.task(task.id), {
            signal: abort.signal,
            checkpoint: (patch) => {
              if (patch.submitIntent)
                this.store.setSetting(`lastRun:${task.accountId}`, {
                  taskId: task.id,
                  at: this.now(),
                });
              const t = this.store.task(task.id);
              this.store.setTask(task.id, {
                checkpoint: { ...t.checkpoint, ...patch },
              });
            },
            log: (message, level) => this.store.log(task.id, message, level),
          }),
        )
        .then((result) => {
          const current = this.store.task(task.id);
          if (abort.signal.aborted) {
            this.store.setTask(task.id, {
              status: current.checkpoint.submitIntent ? 'unverified' : 'paused',
              result: { reason: '执行已停止，请检查后继续' },
            });
          } else {
            this.store.setTask(task.id, { status: result.status, result });
            this.store.log(
              task.id,
              result.reason || `执行结果：${result.status}`,
              result.status === 'success' ? 'info' : 'warning',
            );
            if (['manual', 'failed', 'unverified'].includes(result.status))
              this.notify(
                `${task.accountName}：${result.reason || '任务需要检查'}`,
                'warning',
              );
          }
        })
        .catch((error) => {
          const current = this.store.task(task.id),
            status = current.checkpoint.submitIntent
              ? 'unverified'
              : abort.signal.aborted
                ? 'paused'
                : error.manual
                  ? 'manual'
                  : 'failed';
          this.store.setTask(task.id, {
            status,
            result: { reason: error.message },
          });
          this.store.log(task.id, error.message, 'error');
          this.notify(`${task.accountName}：${error.message}`, 'error');
        })
        .finally(() => {
          this.accounts.delete(task.accountId);
          this.running.delete(task.id);
          this.changed();
        });
      this.running.set(task.id, { job, abort, accountId: task.accountId });
      this.changed();
    }
  }
  async stopTask(id, status = 'paused') {
    const current = this.store.task(id);
    if (
      ['success', 'review', 'submitted', 'unverified'].includes(current.status)
    )
      throw new Error('该任务已经提交或结果待核实，不能自动取消或重复提交');
    const active = this.running.get(id);
    if (active) {
      active.abort.abort();
      await active.job;
    }
    const after = this.store.task(id);
    if (after.checkpoint.submitIntent)
      throw new Error('提交边界已到达，结果需人工核实，不能直接重复执行');
    this.store.setTask(id, {
      status,
      result: { reason: status === 'cancelled' ? '用户取消' : '用户暂停' },
    });
    this.store.log(
      id,
      status === 'cancelled' ? '用户取消任务' : '用户暂停任务',
      'warning',
    );
  }
  async resume(id) {
    const task = this.store.task(id);
    if (
      !['paused', 'manual', 'failed'].includes(task.status) ||
      task.checkpoint.submitIntent
    )
      throw new Error('此状态不能直接重试，请先核实提交结果');
    if (task.status === 'failed' && task.attempts >= 5)
      throw new Error('已执行 5 次，请检查配置后创建新任务');
    this.store.setTask(id, { status: 'pending', result: null });
    this.store.log(id, '用户确认继续 / 重试');
    await this.tick();
  }
  async takeover(accountId) {
    for (const t of this.store
      .tasks()
      .filter(
        (t) =>
          t.accountId === accountId &&
          ['pending', 'running'].includes(t.status),
      ))
      await this.stopTask(t.id);
  }
  async shutdown() {
    this.stopping = true;
    clearInterval(this.timer);
    for (const r of this.running.values()) r.abort.abort();
    await Promise.allSettled([...this.running.values()].map((r) => r.job));
  }
}
module.exports = { Scheduler };
