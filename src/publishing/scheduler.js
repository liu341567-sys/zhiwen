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
    this.concurrency =
      Number.isInteger(concurrency) && concurrency >= 1 && concurrency <= 6
        ? concurrency
        : 2;
    this.waiting = new Map();
    this.queueIndex = new WeakMap();
    this.lastTickAt = null;
    this.lastError = null;
    this.trace = () => {};
    this.now = now;
    this.running = new Map();
    this.accounts = new Set();
    this.stopping = false;
    this.timer = null;
  }
  start() {
    if (this.timer || this.stopping) return this.tick();
    this.timer = setInterval(
      () =>
        this.tick().catch((e) => {
          this.lastError = e.message;
          this.changed();
          this.notify(`任务队列异常：${e.message}`, 'error');
        }),
      1000,
    );
    this.timer.unref?.();
    return this.tick();
  }
  leased(id) {
    return this.accounts.has(id);
  }
  runtime() {
    return {
      timerActive: !!this.timer && !this.stopping,
      stopping: this.stopping,
      lastTickAt: this.lastTickAt,
      lastError: this.lastError,
      concurrency: this.concurrency,
      running: this.running.size,
    };
  }
  waitInfo(task, tasks = this.store.tasks()) {
    const reason = (code, message, retryAt = null, blockingTaskIds = []) => ({
      code,
      message,
      retryAt,
      blockingTaskIds,
    });
    if (this.stopping)
      return reason('stopping', '调度器正在退出，请重新启动软件');
    if (!Number.isFinite(task.plannedAt))
      return reason('invalid-plan', '计划时间无效，请检查任务配置');
    if (task.plannedAt > this.now())
      return reason('scheduled', '等待计划开始时间', task.plannedAt);
    let index = this.queueIndex.get(tasks);
    if (!index) {
      index = { byId: new Map(), blocked: new Map() };
      for (const row of tasks) {
        index.byId.set(row.id, row);
        if (['manual', 'unverified'].includes(row.status)) {
          if (!index.blocked.has(row.accountId))
            index.blocked.set(row.accountId, []);
          index.blocked.get(row.accountId).push(row);
        }
      }
      this.queueIndex.set(tasks, index);
    }
    const blocked = index.blocked.get(task.accountId) || [];
    if (blocked.length)
      return reason(
        'account-review',
        '同账号有需要人工处理或结果待核实的任务，请先处理',
        null,
        blocked.map((t) => t.id),
      );
    if (this.accounts.has(task.accountId))
      return reason(
        'account-busy',
        '此账号正在执行另一条任务',
        null,
        [...this.running.keys()].filter(
          (id) => this.running.get(id).accountId === task.accountId,
        ),
      );
    if (this.running.size >= this.concurrency)
      return reason('concurrency', '等待空闲的并发执行位置');
    const last = this.store.setting(`lastRun:${task.accountId}`);
    const previous = last && index.byId.get(last.taskId);
    // Old versions counted every attempt, even failures before submission.
    // Ignore only a proven non-submitted attempt. Preserve an unknown legacy
    // receipt when its source was removed, to avoid bypassing real spacing.
    const submitted =
      last &&
      (last.kind === 'submitted' ||
        (!last.kind &&
          (!previous ||
            previous.checkpoint.submitIntent ||
            ['success', 'submitted', 'review', 'unverified'].includes(
              previous.status,
            ))));
    const retryAt = last && last.at + (task.minIntervalMs || 0);
    if (submitted && last.taskId !== task.id && this.now() < retryAt)
      return reason(
        'interval',
        last.kind === 'submitted'
          ? '等待账号最小发布间隔'
          : '等待账号操作间隔（旧版记录）',
        retryAt,
      );
    return reason('ready', '已满足执行条件，等待调度检查');
  }
  async tick() {
    this.lastTickAt = this.now();
    this.lastError = null;
    if (this.stopping) return;
    const tasks = this.store.tasks();
    const pendingIds = new Set(
      tasks.filter((t) => t.status === 'pending').map((t) => t.id),
    );
    for (const id of this.waiting.keys())
      if (!pendingIds.has(id)) this.waiting.delete(id);
    for (const task of tasks.filter((t) => t.status === 'pending')) {
      const wait = this.waitInfo(task, tasks);
      if (wait.code !== 'ready') {
        const key = JSON.stringify(wait);
        if (this.waiting.get(task.id) !== key) {
          this.waiting.set(task.id, key);
          this.store.log(
            task.id,
            `调度等待：${wait.message}${wait.retryAt ? '；预计可执行时间 ' + new Date(wait.retryAt).toISOString() : ''}${wait.blockingTaskIds.length ? '；阻塞任务 ' + wait.blockingTaskIds.join('、') : ''}`,
            'info',
          );
          this.changed();
        }
        continue;
      }
      this.waiting.delete(task.id);
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
                  kind: 'submitted',
                });
              const t = this.store.task(task.id);
              this.store.setTask(task.id, {
                checkpoint: { ...t.checkpoint, ...patch },
              });
            },
            log: (message, level) => {
              this.store.log(task.id, message, level);
              this.trace(task.id, message, level);
            },
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
          this.trace(task.id, error.message, 'error');
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
    this.timer = null;
    for (const r of this.running.values()) r.abort.abort();
    await Promise.allSettled([...this.running.values()].map((r) => r.job));
  }
}
module.exports = { Scheduler };
