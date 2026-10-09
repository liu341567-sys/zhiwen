'use strict';
const { test } = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path');
const {
  distribute,
  assign,
  times,
  generate,
} = require('../src/publishing/matching');
const { PublishingStore } = require('../src/publishing/store'),
  { Scheduler } = require('../src/publishing/scheduler'),
  { PublishingService } = require('../src/publishing/service');
const temporary = () =>
  fs.mkdtempSync(path.join(os.tmpdir(), 'qiye-publishing-'));
const tick = () => new Promise((resolve) => setImmediate(resolve));
const snapshot = (video, account, i = 0) => ({
  videoId: video,
  video: { name: video, sha256: video, path: '/tmp/' + video },
  accountId: account,
  accountName: account,
  platformId: 'douyin',
  title: 'Original',
  topics: '#One #Two',
  cover: { mode: 'first' },
  location: { mode: 'none' },
  plannedAt: Date.now() - 10,
  ordinal: i,
});
test('all, sequence, random quotas and manual distribution preserve exact environment identity', () => {
  assert.equal(distribute(['v1', 'v2'], ['a1', 'a2']).length, 4);
  assert.deepEqual(
    distribute(['v1', 'v2', 'v3'], ['a1', 'a2'], { mode: 'sequence' }).map(
      (t) => t.accountId,
    ),
    ['a1', 'a2', 'a1'],
  );
  const random = distribute(
    ['v1', 'v2', 'v3'],
    ['a1', 'a2'],
    { mode: 'random', quotas: { a1: 1, a2: 2 } },
    () => 0,
  );
  assert.equal(new Set(random.map((t) => t.videoId)).size, 3);
  assert.equal(random.filter((t) => t.accountId === 'a2').length, 2);
  assert.deepEqual(
    distribute(['v1'], ['a1', 'a2'], {
      mode: 'manual',
      manual: { v1: ['a2'] },
    }).map((t) => t.key),
    ['v1:a2'],
  );
  assert.throws(() =>
    distribute(['v1'], ['a1'], { mode: 'manual', manual: { v1: ['wrong'] } }),
  );
  assert.throws(() =>
    distribute(['v1'], ['a1'], { mode: 'random', quotas: { a1: 0 } }),
  );
  assert.throws(() => distribute(['v1', 'v1'], ['a1']));
});
test('independent title/topic modes, shuffled rounds, scopes and locks keep whole groups intact', () => {
  const pairs = distribute(['v1', 'v2', 'v3', 'v4'], ['a', 'b']);
  const video = assign(
    pairs,
    { mode: 'sequence', scope: 'video', values: ['A', 'B'] },
    'title',
  );
  assert.deepEqual(
    video.map((v) => v.value),
    ['A', 'A', 'B', 'B', 'A', 'A', 'B', 'B'],
  );
  const random = assign(
    pairs,
    {
      mode: 'random',
      scope: 'task',
      values: ['#AI #运营', '#营销 #创业', '#增长'],
      locks: { 'v1:a': '锁定' },
    },
    'topics',
    () => 0,
  );
  assert.equal(random[0].value, '锁定');
  assert.equal(random[0].locked, true);
  assert.equal(new Set(random.slice(1, 4).map((v) => v.value)).size, 3);
  assert.equal(new Set(random.slice(4, 7).map((v) => v.value)).size, 3);
  assert.throws(() => assign(pairs, { mode: 'fixed', values: ['A'] }, 'title'));
});
test('schedules use per-account minimum spacing, daily window quotas and reject invalid rules', () => {
  const now = new Date(2026, 9, 9, 8).getTime(),
    pairs = distribute(['v1', 'v2', 'v3'], ['a', 'b']);
  const at = times(
    pairs,
    {
      mode: 'at',
      at: new Date(now + 3600000).toISOString(),
      intervalMinutes: 10,
    },
    now,
  );
  assert.equal(at[1], at[0]);
  assert.equal(at[2] - at[0], 600000);
  const plan = times(
    pairs,
    {
      mode: 'windows',
      intervalMinutes: 10,
      windows: [{ start: '09:00', end: '10:00', quota: 2 }],
    },
    now,
  );
  assert.equal(new Date(plan[0]).getHours(), 9);
  assert.equal(new Date(plan[4]).getDate(), 10);
  assert.throws(() =>
    times(
      pairs,
      { mode: 'windows', windows: [{ start: '09:00', end: '08:00' }] },
      now,
    ),
  );
  assert.throws(() =>
    times(
      pairs,
      {
        mode: 'windows',
        windows: [
          { start: '09:00', end: '12:00' },
          { start: '11:00', end: '13:00' },
        ],
      },
      now,
    ),
  );
});
test('confirmed snapshots survive resource edits, database restart, backup and recovery without changing accounts', () => {
  const dir = temporary();
  let store = new PublishingStore(dir);
  const video = store.putResource(
    'video',
    { name: 'first', path: '/tmp/video' },
    'v',
  );
  const batch = store.addBatch('batch', [
    snapshot('v', 'a'),
    snapshot('v2', 'b', 1),
  ]);
  let tasks = store.tasks();
  store.putResource('video', { name: 'modified', path: '/tmp/new' }, video.id);
  assert.equal(tasks[0].video.name, 'v');
  store.setTask(tasks[0].id, { status: 'running' });
  store.setTask(tasks[1].id, {
    status: 'running',
    checkpoint: { submitIntent: true },
  });
  const backup = path.join(dir, 'copy.sqlite');
  store.backup(backup);
  assert.ok(fs.statSync(backup).size);
  store.close();
  store = new PublishingStore(dir);
  store.recover();
  tasks = store.tasks();
  assert.equal(tasks[0].status, 'paused');
  assert.equal(tasks[1].status, 'unverified');
  assert.equal(tasks[0].accountId, 'a');
  assert.equal(tasks[0].title, 'Original');
  assert.equal(tasks[0].batchId, batch);
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
test('batch insert rolls back completely on invalid rows and future schemas are preserved', () => {
  const dir = temporary(),
    store = new PublishingStore(dir);
  assert.throws(() =>
    store.addBatch('bad', [
      snapshot('v', 'a'),
      { ...snapshot('v2', 'b'), accountId: undefined },
    ]),
  );
  assert.equal(store.batches().length, 0);
  assert.equal(store.tasks().length, 0);
  store.db.exec('PRAGMA user_version=20');
  store.close();
  assert.throws(() => new PublishingStore(dir), /更高版本/);
  const { DatabaseSync } = require('node:sqlite'),
    db = new DatabaseSync(path.join(dir, 'publishing.sqlite'));
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 20);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
test('scheduler permits two distinct accounts but never concurrent work in the same environment', async () => {
  const dir = temporary(),
    store = new PublishingStore(dir);
  store.addBatch('batch', [
    snapshot('v1', 'a', 0),
    snapshot('v2', 'a', 1),
    snapshot('v3', 'b', 2),
    snapshot('v4', 'c', 3),
  ]);
  const pending = [],
    active = new Set(),
    seen = [];
  const scheduler = new Scheduler({
    store,
    concurrency: 2,
    execute: async (t) => {
      assert.ok(!active.has(t.accountId));
      active.add(t.accountId);
      seen.push(t.accountId);
      await new Promise((r) =>
        pending.push(() => {
          active.delete(t.accountId);
          r();
        }),
      );
      return { status: 'success' };
    },
  });
  await scheduler.tick();
  await tick();
  assert.deepEqual(seen, ['a', 'b']);
  assert.equal(scheduler.leased('a'), true);
  pending.splice(0).forEach((r) => r());
  await tick();
  await scheduler.tick();
  await tick();
  assert.deepEqual(seen, ['a', 'b', 'a', 'c']);
  pending.splice(0).forEach((r) => r());
  await tick();
  await scheduler.shutdown();
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
test('post-submit interruption becomes unverified and cannot retry; only that account is blocked', async () => {
  const dir = temporary(),
    store = new PublishingStore(dir);
  store.addBatch('batch', [
    snapshot('v1', 'a', 0),
    snapshot('v2', 'a', 1),
    snapshot('v3', 'b', 2),
  ]);
  const scheduler = new Scheduler({
    store,
    execute: async (t, c) => {
      if (t.accountId === 'a') {
        c.checkpoint({ submitIntent: true });
        throw new Error('Lost response');
      }
      return { status: 'success' };
    },
  });
  await scheduler.tick();
  await tick();
  await tick();
  const unsure = store.tasks().find((t) => t.videoId === 'v1');
  assert.equal(unsure.status, 'unverified');
  await assert.rejects(() => scheduler.resume(unsure.id));
  await scheduler.tick();
  assert.equal(store.tasks().find((t) => t.videoId === 'v2').status, 'pending');
  assert.equal(
    store.tasks().find((t) => t.accountId === 'b').status,
    'success',
  );
  await scheduler.shutdown();
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
test('takeover aborts before submission and releases the environment, preserving task context', async () => {
  const dir = temporary(),
    store = new PublishingStore(dir);
  store.addBatch('batch', [snapshot('v1', 'a')]);
  const scheduler = new Scheduler({
    store,
    execute: async (t, c) => {
      c.checkpoint({ uploaded: true });
      await new Promise((_r, reject) =>
        c.signal.addEventListener('abort', () => reject(new Error('stopped')), {
          once: true,
        }),
      );
      return { status: 'success' };
    },
  });
  await scheduler.tick();
  await tick();
  await scheduler.takeover('a');
  const task = store.tasks()[0];
  assert.equal(task.status, 'paused');
  assert.equal(task.checkpoint.uploaded, true);
  assert.equal(scheduler.leased('a'), false);
  await scheduler.shutdown();
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
test('local account association does not mutate original profiles; authorizing cannot rewrite confirmed snapshots', async () => {
  const dir = temporary(),
    profiles = [{ id: 'a', name: 'legacy', platformId: null }],
    before = JSON.stringify(profiles);
  const service = new PublishingService({
    directory: dir,
    profiles: () => profiles,
    getView: async () => {},
    takeover: async () => {},
    notify: () => {},
  });
  service.bindAccount('a', 'douyin');
  assert.equal(service.accounts()[0].platformId, 'douyin');
  assert.equal(JSON.stringify(profiles), before);
  service.store.addBatch('batch', [
    { ...snapshot('v1', 'a'), autoSubmit: false },
  ]);
  const task = service.store.tasks()[0];
  service.store.setTask(task.id, {
    status: 'manual',
    checkpoint: { uploaded: true },
  });
  service.scheduler.tick = async () => {};
  await service.action({
    ids: [task.id],
    action: 'authorize',
    confirmed: true,
  });
  assert.equal(service.store.task(task.id).autoSubmit, false);
  assert.equal(
    service.store.task(task.id).checkpoint.submissionAuthorized,
    true,
  );
  await service.shutdown();
  fs.rmSync(dir, { recursive: true, force: true });
});
test('missing or modified video files are detected before task execution', async () => {
  const media = require('../src/publishing/media'),
    dir = temporary(),
    file = path.join(dir, 'sample.mp4');
  fs.writeFileSync(file, 'original');
  const stat = fs.statSync(file),
    video = {
      path: file,
      name: 'sample',
      bytes: stat.size,
      mtime: stat.mtimeMs,
      sha256: await media.digest(file),
    };
  assert.equal(await media.validate(video), true);
  fs.writeFileSync(file, 'changed!');
  await assert.rejects(() => media.validate(video), /发生变化/);
  fs.unlinkSync(file);
  await assert.rejects(() => media.validate(video), /不存在/);
  fs.rmSync(dir, { recursive: true, force: true });
});
test('stalled browser operations can be aborted without dropping task context', async () => {
  const { Page } = require('../src/publishing/adapters/page'),
    abort = new AbortController(),
    page = new Page({ isDestroyed: () => false }, abort.signal);
  const pending = page.awaitOperation(new Promise(() => {}));
  abort.abort();
  await assert.rejects(() => pending, /暂停/);
});
test('actual delayed execution enforces account spacing after submission, not only planned timestamps', async () => {
  const dir = temporary(),
    store = new PublishingStore(dir);
  let now = Date.now();
  store.addBatch('batch', [
    { ...snapshot('v1', 'a', 0), minIntervalMs: 60000 },
    { ...snapshot('v2', 'a', 1), minIntervalMs: 60000 },
  ]);
  const scheduler = new Scheduler({
    store,
    now: () => now,
    execute: async (t, c) => {
      now += 120000;
      c.checkpoint({ submitIntent: true });
      return { status: 'submitted' };
    },
  });
  await scheduler.tick();
  await tick();
  await tick();
  assert.equal(store.tasks().filter((t) => t.status === 'submitted').length, 1);
  await scheduler.tick();
  assert.equal(scheduler.running.size, 0);
  now += 60000;
  await scheduler.tick();
  await tick();
  await tick();
  assert.equal(store.tasks().filter((t) => t.status === 'submitted').length, 2);
  await scheduler.shutdown();
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
test('registering a future video adapter reuses the matching engine and canonical platform metadata', async () => {
  const dir = temporary(),
    service = new PublishingService({
      directory: dir,
      profiles: () => [
        { id: 'red-account', name: 'red', platformId: 'xiaohongshu' },
      ],
      getView: async () => {},
      takeover: async () => {},
      notify: () => {},
    });
  service.adapters.set('xiaohongshu', {
    descriptor: {
      id: 'xiaohongshu',
      name: '小红书',
      enabled: true,
      capabilities: { video: true },
    },
  });
  service.store.putResource('video', { name: 'clip', sha256: 'abc' }, 'video');
  const snapshot = service.snapshot();
  assert.equal(
    snapshot.platforms.filter((p) => p.id === 'xiaohongshu').length,
    1,
  );
  assert.ok(
    snapshot.platforms
      .find((p) => p.id === 'xiaohongshu')
      .iconResource.endsWith('xiaohongshu.svg'),
  );
  const preview = service.preview({
    platformIds: ['xiaohongshu'],
    videoIds: ['video'],
    accountIds: ['red-account'],
    title: { mode: 'reuse', values: ['Title'] },
    topics: { mode: 'reuse', values: ['#话题组'] },
    distribution: { mode: 'all' },
    schedule: { mode: 'now', intervalMinutes: 10 },
    cover: { mode: 'first' },
    location: { mode: 'none' },
  });
  assert.equal(preview.rows[0].platformId, 'xiaohongshu');
  assert.equal(preview.rows[0].accountId, 'red-account');
  await service.shutdown();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('preview regeneration preserves manual caption locks, task order and locked options without trusting account overrides', () => {
  const input = {
    videoIds: ['v'],
    accountIds: ['a', 'b'],
    distribution: { mode: 'all' },
    title: { mode: 'reuse', values: ['changed'], locks: { 'v:a': 'saved' } },
    topics: { mode: 'reuse', values: ['#all'], locks: {} },
    schedule: { mode: 'now' },
    previewOrder: ['v:b', 'v:a'],
    overrides: {
      'v:a': {
        locked: true,
        plannedAt: 123,
        autoSubmit: false,
        cover: { mode: 'frame', seconds: 2 },
        location: { mode: 'none' },
        accountId: 'wrong',
        platformId: 'wrong',
      },
    },
  };
  const rows = generate(
    input,
    [{ id: 'v' }],
    [
      { id: 'a', platformId: 'douyin', name: 'A' },
      { id: 'b', platformId: 'douyin', name: 'B' },
    ],
    () => 0,
    100,
  );
  assert.deepEqual(
    rows.map((r) => r.key),
    ['v:b', 'v:a'],
  );
  assert.equal(rows[0].title, 'changed');
  assert.equal(rows[1].title, 'saved');
  assert.equal(rows[1].locked, true);
  assert.equal(rows[1].plannedAt, 123);
  assert.equal(rows[1].accountId, 'a');
  assert.equal(rows[1].platformId, 'douyin');
  assert.deepEqual(rows[1].cover, { mode: 'frame', seconds: 2 });
});

test('manual review and staged confirmations do not exhaust the failed-task retry limit', async () => {
  const dir = temporary(),
    store = new PublishingStore(dir);
  store.addBatch('review', [snapshot('v', 'a')]);
  const task = store.tasks()[0];
  const scheduler = new Scheduler({
    store,
    execute: async () => ({ status: 'manual', reason: 'Review' }),
  });
  store.setTask(task.id, { status: 'manual', attempts: 6 });
  await scheduler.resume(task.id);
  await Promise.all([...scheduler.running.values()].map((r) => r.job));
  assert.equal(store.task(task.id).status, 'manual');
  store.setTask(task.id, { status: 'failed', attempts: 5 });
  await assert.rejects(() => scheduler.resume(task.id), /5 次/);
  store.setTask(task.id, {
    status: 'manual',
    checkpoint: { submitIntent: true },
  });
  await assert.rejects(() => scheduler.resume(task.id), /核实/);
  await scheduler.shutdown();
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('missing image cover produces actionable validation before preview and confirmation; successful batch atomically clears all wizard drafts', async (t) => {
  const dir = temporary(),
    service = new PublishingService({
      directory: dir,
      profiles: () => [{ id: 'a', name: 'a', platformId: 'douyin' }],
      notify: () => {},
    });
  t.mock.method(require('../src/publishing/media'), 'validate', async () => {});
  service.scheduler.tick = async () => {};
  try {
    service.store.putResource(
      'video',
      { name: 'clip', path: '/local/clip.mp4', sha256: 'clip' },
      'v',
    );
    const config = {
      videoIds: ['v'],
      platformIds: ['douyin'],
      accountIds: ['a'],
      title: { values: ['A'] },
      topics: { values: ['#AI'] },
      cover: { mode: 'first' },
      location: { mode: 'none' },
      schedule: {
        mode: 'at',
        at: new Date(Date.now() + 3600000).toISOString(),
      },
    };
    for (const id of [undefined, '', {}])
      assert.throws(
        () => service.preview({ ...config, cover: { mode: 'image', id } }),
        /选择或导入具体封面/,
      );
    assert.throws(
      () => service.store.resource(undefined, 'image'),
      /有效的素材或封面/,
    );
    const p = service.preview(config);
    service.saveDraft({ input: config, step: 4, previewId: p.previewId });
    service.store.setSetting('ui', { page: 'video', step: 4, scroll: {} });
    const invalid = structuredClone(p.rows);
    invalid[0].cover = { mode: 'image' };
    await assert.rejects(
      service.confirm({ ...p, rows: invalid }),
      /选择或导入具体封面/,
    );
    assert.equal(service.store.tasks().length, 0);
    assert.equal(service.store.drafts().length, 2);
    const result = await service.confirm({ ...p, name: 'valid' });
    assert.equal(service.store.tasks()[0].batchId, result.batchId);
    assert.equal(service.store.drafts().length, 0);
    assert.equal(service.store.setting('ui').step, 0);
  } finally {
    await service.shutdown();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('record deletion is atomic, keeps files and snapshots, protects active/uncertain tasks, and persists duplicate publication protection', async () => {
  const dir = temporary(),
    service = new PublishingService({
      directory: dir,
      profiles: () => [{ id: 'a', name: 'a', platformId: 'douyin' }],
      notify: () => {},
    });
  try {
    const file = path.join(dir, 'original.mp4');
    fs.writeFileSync(file, 'original');
    const ids = ['video', 'image', 'title', 'topics', 'location'].map(
      (kind) =>
        service.store.putResource(kind, {
          path: file,
          value: 'text',
          name: kind,
        }).id,
    );
    service.store.addBatch('records', [
      snapshot('v', 'a'),
      snapshot('v2', 'a', 1),
    ]);
    const [first, second] = service.store.tasks();
    service.store.log(first.id, 'trace');
    service.store.setTask(second.id, {
      status: 'unverified',
      checkpoint: { submitIntent: true },
    });
    assert.throws(
      () => service.removeTasks({ ids: [first.id], confirmed: false }),
      /确认/,
    );
    assert.throws(
      () =>
        service.removeTasks({ ids: [first.id, second.id], confirmed: true }),
      /核实/,
    );
    assert.equal(service.store.tasks().length, 2);
    assert.equal(service.store.logs(first.id).length, 1);
    service.scheduler.running.set(first.id, {});
    assert.throws(
      () => service.removeTasks({ ids: [first.id], confirmed: true }),
      /先暂停/,
    );
    service.scheduler.running.delete(first.id);
    service.removeResources(ids);
    assert.ok(fs.existsSync(file));
    assert.equal(service.store.tasks()[0].video.name, first.video.name);
    service.store.setTask(second.id, { status: 'success' });
    assert.equal(
      service.removeTasks({ ids: [first.id, second.id], confirmed: true })
        .removed,
      2,
    );
    assert.equal(service.store.tasks().length, 0);
    assert.equal(service.store.batches().length, 0);
    assert.equal(
      service.store.db.prepare('SELECT count(*) AS n FROM logs').get().n,
      0,
    );
    assert.equal(service.store.setting('deletedPublicationKeys')['a:v2'], true);
    assert.ok(fs.existsSync(file));
    const reopen = new PublishingStore(service.directory);
    assert.equal(reopen.setting('deletedPublicationKeys')['a:v2'], true);
    reopen.close();
  } finally {
    await service.shutdown();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('deleting successful records does not silently allow duplicate confirmation; clearing draft does not touch tasks/resources', async (t) => {
  const dir = temporary(),
    service = new PublishingService({
      directory: dir,
      profiles: () => [{ id: 'a', name: 'a', platformId: 'douyin' }],
      notify: () => {},
    });
  t.mock.method(require('../src/publishing/media'), 'validate', async () => {});
  service.scheduler.tick = async () => {};
  try {
    service.store.putResource('video', { name: 'clip', sha256: 'v' }, 'v');
    service.store.addBatch('old', [snapshot('v', 'a')]);
    const task = service.store.tasks()[0];
    service.store.setTask(task.id, { status: 'success' });
    service.removeTasks({ ids: [task.id], confirmed: true });
    const config = {
      videoIds: ['v'],
      accountIds: ['a'],
      platformIds: ['douyin'],
      title: { values: ['A'] },
      topics: { values: [] },
    };
    const p = service.preview(config);
    await assert.rejects(service.confirm(p), /相同视频任务/);
    await service.confirm({ ...p, allowDuplicates: true });
    service.saveDraft({ input: config, step: 3 });
    await service.dispatch('draft-clear');
    assert.equal(service.store.drafts().length, 0);
    assert.equal(service.store.list('video').length, 1);
    assert.equal(service.store.tasks().length, 1);
    assert.throws(() => service.removeResources([{}]), /无效/);
  } finally {
    await service.shutdown();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
