'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path');
const { PublishingStore } = require('../src/publishing/store');
const { Scheduler } = require('../src/publishing/scheduler');
const { Diagnostics } = require('../src/publishing/diagnostics');
const { PublishingService } = require('../src/publishing/service');
const flush = () => new Promise((r) => setImmediate(r));
const task = (video, account, now) => ({
  videoId: video,
  video: { name: video, sha256: video },
  accountId: account,
  accountName: account,
  platformId: 'douyin',
  plannedAt: now - 1,
  ordinal: 0,
  minIntervalMs: 600000,
  cover: { mode: 'first' },
  location: { mode: 'none' },
  title: 'private title',
  topics: '#private',
});
async function withQueue(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qiye-diagnostic-test-')),
    store = new PublishingStore(dir),
    now = Date.now();
  let clock = now;
  const scheduler = new Scheduler({
    store,
    now: () => clock,
    execute: async () => ({ status: 'failed' }),
  });
  try {
    await fn({
      store,
      scheduler,
      now,
      advance: (n) => {
        clock += n;
      },
    });
  } finally {
    await scheduler.shutdown();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
test('queue reports schedule, account review, account lease and concurrency without duplicate waiting logs', () =>
  withQueue(async ({ store, scheduler, now }) => {
    store.addBatch('future', [
      { ...task('v', 'a', now), plannedAt: now + 60000 },
    ]);
    const t = store.tasks()[0];
    assert.equal(scheduler.waitInfo(t).code, 'scheduled');
    assert.equal(scheduler.waitInfo(t).retryAt, now + 60000);
    await scheduler.tick();
    await scheduler.tick();
    assert.equal(store.logs(t.id).length, 1);
    const due = { ...t, plannedAt: now - 1 };
    store.addBatch('blocked', [task('b', 'a', now)]);
    const blocked = store.tasks().find((t) => t.videoId === 'b');
    store.setTask(blocked.id, { status: 'manual' });
    assert.deepEqual(scheduler.waitInfo(due).blockingTaskIds, [blocked.id]);
    assert.equal(scheduler.waitInfo(due).code, 'account-review');
    store.setTask(blocked.id, { status: 'cancelled' });
    scheduler.accounts.add('a');
    scheduler.running.set('fake', { accountId: 'a' });
    assert.equal(scheduler.waitInfo(due).code, 'account-busy');
    scheduler.accounts.clear();
    scheduler.running.clear();
    scheduler.concurrency = 1;
    scheduler.running.set('fake', { accountId: 'b' });
    assert.equal(scheduler.waitInfo(due).code, 'concurrency');
    scheduler.running.clear();
    assert.equal(scheduler.waitInfo(due).code, 'ready');
  }));
test('legacy non-submitted attempts no longer delay, but actual and unknown deleted submissions retain spacing', () =>
  withQueue(async ({ store, scheduler, now, advance }) => {
    store.addBatch('old', [task('old', 'a', now), task('new', 'a', now)]);
    const old = store.tasks().find((t) => t.videoId === 'old'),
      next = store.tasks().find((t) => t.videoId === 'new');
    store.setTask(old.id, { status: 'failed' });
    store.setSetting('lastRun:a', { taskId: old.id, at: now });
    assert.equal(scheduler.waitInfo(next).code, 'ready');
    store.setTask(old.id, {
      checkpoint: { submitIntent: true },
      status: 'success',
    });
    assert.equal(scheduler.waitInfo(next).code, 'interval');
    store.removeTasks([old.id]);
    assert.equal(scheduler.waitInfo(next).code, 'interval');
    store.setSetting('lastRun:a', {
      taskId: old.id,
      at: now,
      kind: 'submitted',
    });
    assert.equal(scheduler.waitInfo(next).retryAt, now + 600000);
    advance(600001);
    assert.equal(scheduler.waitInfo(next).code, 'ready');
  }));
test('only actual submit checkpoints create new spacing receipts; pre-submit legacy receipt deletion clears safely', () =>
  withQueue(async ({ store, scheduler, now }) => {
    store.addBatch('go', [task('v', 'a', now)]);
    const t = store.tasks()[0];
    scheduler.execute = async (_task, ctx) => {
      assert.equal(store.setting('lastRun:a'), null);
      ctx.checkpoint({ submitIntent: true });
      return { status: 'submitted' };
    };
    await scheduler.tick();
    await flush();
    await flush();
    assert.equal(store.setting('lastRun:a').kind, 'submitted');
    store.addBatch('failed', [task('f', 'b', now)]);
    const failed = store.tasks().find((t) => t.accountId === 'b');
    store.setTask(failed.id, { status: 'failed' });
    store.setSetting('lastRun:b', { taskId: failed.id, at: now });
    store.removeTasks([failed.id]);
    assert.equal(store.setting('lastRun:b'), null);
  }));
test('local diagnostic snapshots deduplicate, survive restart and omit task content and raw execution messages', () =>
  withQueue(async ({ store, scheduler, now }) => {
    store.addBatch('secret batch', [
      task('secret video', 'secret account', now),
    ]);
    const t = store.tasks()[0];
    const d = new Diagnostics({ store, scheduler });
    scheduler.lastError = '/secret/path';
    try {
      await d.start(t.id);
      await d.capture(t.id);
      assert.equal(d.report(t.id).frames.length, 1);
      d.event(t.id, '填写标题 private title /secret/path', 'warning');
      d.mark(t.id, 'edited-caption');
      assert.throws(() => d.mark(t.id, 'raw secret'));
      const data = JSON.stringify(d.report(t.id));
      for (const secret of [
        'private title',
        '#private',
        'secret video',
        'secret account',
        '/secret/path',
      ])
        assert.ok(!data.includes(secret), secret);
      d.stop(t.id);
      assert.ok(d.report(t.id).endedAt);
      const after = new Diagnostics({ store, scheduler });
      assert.equal(after.state(t.id).active, false);
      assert.equal(after.report(t.id).events.length, 1);
      after.clear(t.id);
      assert.equal(after.report(t.id), null);
      after.close();
    } finally {
      d.close();
    }
  }));
test('stopping or deleting during an outstanding capture cannot resurrect its report or event listeners', () =>
  withQueue(async ({ store, scheduler, now }) => {
    store.addBatch('wait', [task('v', 'a', now)]);
    const t = store.tasks()[0];
    let resolve;
    let cleanups = 0;
    const wc = {
      isDestroyed: () => false,
      executeJavaScriptInIsolatedWorld: (_id, scripts) => {
        if (scripts[0].code.includes('({record:false})')) {
          cleanups++;
          return Promise.resolve({});
        }
        return new Promise((r) => {
          resolve = r;
        });
      },
    };
    const d = new Diagnostics({ store, scheduler, inspectView: () => wc });
    const pending = d.start(t.id);
    await flush();
    d.stop(t.id);
    store.removeTasks([t.id]);
    resolve({ viewport: { width: 1, height: 1 } });
    await assert.rejects(pending, /任务不存在/);
    assert.equal(store.setting(`diagnostic:${t.id}`), null);
    assert.equal(cleanups, 1);
    assert.equal(d.active.size, 0);
    d.close();
  }));
test('diagnostic report storage is bounded and preserves the latest frame', () =>
  withQueue(async ({ store, scheduler, now }) => {
    store.addBatch('limit', [task('v', 'a', now)]);
    const t = store.tasks()[0],
      d = new Diagnostics({ store, scheduler });
    await d.start(t.id);
    const report = d.report(t.id);
    report.frames = Array.from({ length: 300 }, (_, i) => ({
      time: i,
      page: { structural: 'x'.repeat(10000) },
    }));
    d.save(t.id, report);
    const saved = d.report(t.id);
    assert.ok(Buffer.byteLength(JSON.stringify(saved)) <= 2 * 1024 * 1024);
    assert.ok(saved.truncated);
    assert.equal(saved.frames.at(-1).time, 299);
    d.close();
  }));
test('manual verification preserves actual spacing and explicitly unsubmitted verification clears only its own receipt', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qiye-verification-test-')),
    service = new PublishingService({
      directory: dir,
      profiles: () => [],
      getView: async () => {},
      notify: () => {},
    }),
    now = Date.now();
  try {
    service.store.addBatch('manual', [task('v', 'a', now)]);
    const t = service.store.tasks()[0];
    service.store.setTask(t.id, { status: 'manual' });
    await service.action({
      ids: [t.id],
      action: 'resolve',
      confirmed: true,
      reason: 'checked actual platform work',
    });
    assert.equal(service.store.setting('lastRun:a').kind, 'submitted');
    service.store.setTask(t.id, {
      status: 'unverified',
      checkpoint: { submitIntent: true },
    });
    await service.action({
      ids: [t.id],
      action: 'not-submitted',
      confirmed: true,
      reason: 'checked that no work was submitted',
    });
    assert.equal(service.store.setting('lastRun:a'), null);
    service.store.setSetting('lastRun:a', {
      taskId: 'another-task',
      at: now,
      kind: 'submitted',
    });
    service.store.setTask(t.id, {
      status: 'unverified',
      checkpoint: { submitIntent: true },
    });
    await service.action({
      ids: [t.id],
      action: 'not-submitted',
      confirmed: true,
      reason: 'no submission from this task',
    });
    assert.equal(service.store.setting('lastRun:a').taskId, 'another-task');
  } finally {
    await service.shutdown();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test('failed pre-submit attempts must not silently delay a new account task', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qiye-queue-test-'));
  const store = new PublishingStore(dir);
  const now = Date.now();
  let executions = 0;
  const s = new Scheduler({
    store,
    now: () => now,
    execute: async () => {
      executions++;
      return { status: 'failed', reason: 'upload failed before submission' };
    },
  });
  try {
    store.addBatch('first', [task('one', 'a', now)]);
    await s.tick();
    await flush();
    await flush();
    store.addBatch('next', [task('two', 'a', now)]);
    await s.tick();
    await flush();
    await flush();
    assert.equal(executions, 2);
  } finally {
    await s.shutdown();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
