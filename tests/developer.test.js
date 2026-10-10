'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const {
  DeveloperStore,
  redact,
  scrub,
  compare,
} = require('../src/developer/data');
const { filesFor, reportData, zip } = require('../src/developer/report');
const { DeveloperService } = require('../src/developer/service');
const { Page } = require('../src/publishing/adapters/page');
const { PublishingService } = require('../src/publishing/service');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qiye-developer-unit-'));
  const store = new DeveloperStore(dir);
  t.after(() => store.close());
  return {
    dir,
    store,
    report: store.create(randomUUID(), { exclude: [], includeText: true }),
  };
}
test('report redaction removes nested credentials, DOM HTML, values, URLs and Windows paths but preserves graph IDs', () => {
  const id = randomUUID();
  const d = scrub({
    id,
    beforeId: id,
    stepId: id,
    password: 'p',
    cookies: ['p'],
    nested: {
      outerHTML: '<script>secret</script>',
      innerHTML: 'private',
      value: 'personal',
      headers: { a: 'secret' },
      filePath: 'D:\\secret.mp4',
    },
    text: '13812345678 user@example.com token=short-secret https://user:pass@creator.example.com/post?token=raw#private',
    reason: 'Cannot read C:\\Users\\Alice\\Secret.mp4',
  });
  assert.equal(d.id, id);
  assert.equal(d.beforeId, id);
  assert.equal(d.stepId, id);
  for (const secret of [
    'short-secret',
    '13812345678',
    'user@example',
    'token=raw',
    'user:pass',
    'Alice',
    '<script>',
  ])
    assert.ok(!JSON.stringify(d).includes(secret));
  assert.deepEqual(d.nested, {});
  assert.ok(!redact('missing /home/Alice/private.mp4').includes('Alice'));
  assert.equal(
    redact('https://example.com/path?x=private#secret'),
    'https://example.com/path',
  );
});
test('independent SQLite report store recovers interrupted recording without starting listeners and deletions persist', (t) => {
  const { dir, store, report } = fixture(t);
  report.status = 'recording';
  report.steps.push({ id: randomUUID(), type: 'click' });
  store.save(report);
  store.recover();
  const recovered = store.get(report.id);
  assert.equal(recovered.status, 'interrupted');
  assert.equal(recovered.steps.length, 1);
  const second = new DeveloperStore(dir);
  t.after(() => second.close());
  assert.equal(second.get(report.id).status, 'interrupted');
  assert.equal(second.list()[0].steps, 1);
  second.remove(report.id);
  assert.equal(store.list().length, 0);
  assert.throws(() => store.get(report.id), /不存在/);
});
test('DOM comparison distinguishes frame and shadow root and detects disabled, removed and newly appearing controls', () => {
  const n = {
    tag: 'button',
    selector: '#submit',
    roots: [],
    attributes: {},
    text: '发布',
    enabled: false,
    visible: true,
  };
  const before = {
    id: randomUUID(),
    frames: [
      { key: 'main', url: '/before', nodes: [n] },
      { key: 'frame-1', nodes: [{ ...n, roots: ['#host'] }] },
    ],
  };
  const after = {
    id: randomUUID(),
    frames: [
      {
        key: 'main',
        url: '/after',
        nodes: [
          { ...n, enabled: true },
          { ...n, selector: '#new' },
        ],
      },
    ],
  };
  const d = compare(before, after);
  assert.equal(d.total, 3);
  assert.equal(d.urlChanged, true);
  assert.deepEqual(
    d.changes.map((c) => c.kind),
    ['changed', 'removed', 'added'],
  );
  assert.equal(d.changes[1].before.frame, 'frame-1');
});
test('HTML report escapes page text and JSON preserves snapshot associations without exposing environment identifiers', (t) => {
  const { report } = fixture(t);
  const snapshot = randomUUID();
  report.steps.push({
    id: randomUUID(),
    type: 'click',
    time: Date.now(),
    beforeId: snapshot,
    note: '<script>alert(1)</script>',
  });
  report.snapshots.push({ id: snapshot, time: Date.now(), frames: [] });
  const d = reportData(report, { applicationVersion: 'test' });
  assert.equal(d.steps[0].beforeId, snapshot);
  assert.equal(d.accountId, undefined);
  const imageId = randomUUID();
  report.screenshots.push({
    id: imageId,
    snapshotId: snapshot,
    reviewed: true,
    data: 'data:image/png;base64,aGVsbG8=',
  });
  assert.equal(
    reportData(report, {}).screenshots[0].file,
    'screenshots/' + imageId + '.png',
  );
  const files = filesFor(report, { applicationVersion: 'test' });
  const html = files.find((f) => f.name === 'report.html').data.toString();
  assert.ok(!html.includes('<script>alert(1)</script>'));
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(html.includes("default-src 'none'"));
});
test('unreviewed screenshots block every report export and invalid image payloads cannot become HTML attributes', (t) => {
  const { report } = fixture(t);
  report.screenshots.push({
    id: randomUUID(),
    reviewed: false,
    data: 'data:image/png;base64,aGVsbG8=',
  });
  assert.throws(() => filesFor(report, {}), /确认所有截图/);
  report.screenshots[0].reviewed = true;
  report.screenshots[0].data = 'x" onerror="alert(1)';
  assert.throws(() => filesFor(report, {}), /截图格式/);
});
test('ZIP central directory and CRC allow standard readers to recover all report files', (t) => {
  const { dir, report } = fixture(t);
  const files = filesFor(report, {});
  const buffer = zip(files);
  assert.equal(buffer.readUInt32LE(buffer.length - 22), 0x06054b50);
  assert.equal(buffer.readUInt16LE(buffer.length - 12), 3);
  assert.throws(
    () => zip([{ name: '../profile.json', data: Buffer.from('secret') }]),
    /不安全/,
  );
  // Python on Linux; Windows CI validates the same CRC with built-in .NET ZipArchive in the native runner.
  if (process.platform !== 'win32') {
    const file = path.join(dir, 'report.zip');
    fs.writeFileSync(file, buffer);
    execFileSync('python3', [
      '-c',
      'import zipfile,sys; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; assert len(z.namelist())==3; assert z.read("report.json").startswith(b"{")',
      file,
    ]);
  }
});
test('service uses existing views only, isolates event streams, and requires a fresh review after mutation', async (t) => {
  const { dir } = fixture(t);
  const account = randomUUID(),
    other = randomUUID();
  let released = 0;
  const frame = {};
  const wc = {
    isDestroyed: () => false,
    mainFrame: { framesInSubtree: [frame] },
  };
  const service = new DeveloperService({
    directory: dir,
    profiles: () => [{ id: account }],
    inspectView: (id) => (id === account ? wc : null),
    reveal: async () => {},
    executeFrame: async (_f, code) => {
      if (code.includes('"action":"stop"')) released++;
      return {
        url: 'https://example.com/',
        title: '发布',
        readyState: 'complete',
        nodes: [],
        events: [],
      };
    },
  });
  t.after(() => service.close());
  await assert.rejects(service.command('start'), /先连接/);
  await assert.rejects(service.attach(other), /已经打开/);
  await service.attach(account);
  await service.command('start');
  service.pageEvent({
    type: 'input',
    time: Date.now(),
    target: { selector: '#title', value: 'private' },
  });
  service.pageEvent({
    type: 'input',
    time: Date.now(),
    target: { selector: '#password', sensitive: true },
  });
  await service.trace(other, { phase: 'error', reason: 'other account' });
  assert.equal(service.report.steps.length, 1);
  assert.equal(service.report.scripts.length, 0);
  await service.command('stop');
  assert.ok(released > 0);
  await assert.rejects(service.export('json'), /先预览/);
  await service.command('preview');
  assert.equal(
    JSON.parse((await service.export('json')).toString()).steps.length,
    1,
  );
  await service.command('note', { note: 'manual note' });
  await assert.rejects(service.export('json'), /先预览/);
});
test('optional tracing errors cannot alter successful browser operations or hide an original operation error', async () => {
  const page = new Page(
    { isDestroyed: () => false },
    new AbortController().signal,
    () => {},
    () => {
      throw new Error('diagnostic failure');
    },
  );
  assert.equal(
    await page.awaitOperation(Promise.resolve('original result')),
    'original result',
  );
  await assert.rejects(
    page.awaitOperation(Promise.reject(new Error('original failure'))),
    /original failure/,
  );
});
test('publishing monitoring tolerates late logs after a task was deleted', async t => {
  const { dir } = fixture(t);
  const service = new PublishingService({ directory: dir, profiles: () => [], getView: async () => null, inspectView: () => null, notify: () => {}, onDeveloperTrace: () => { throw new Error('optional monitor failure'); } });
  t.after(() => service.shutdown());
  assert.doesNotThrow(() => service.scheduler.trace(randomUUID(), 'late page log', 'info'));
});
test('closing a tool waits for a masked capture before removing its overlays', async (t) => {
  const { dir } = fixture(t);
  const id = randomUUID(),
    calls = [];
  let finish;
  const frame = {};
  const image = {
    isEmpty: () => false,
    getSize: () => ({ width: 20 }),
    resize() {
      return this;
    },
    toPNG: () => Buffer.from('masked'),
  };
  const wc = {
    isDestroyed: () => false,
    mainFrame: { framesInSubtree: [frame] },
    capturePage: () =>
      new Promise((resolve) => {
        finish = () => resolve(image);
      }),
  };
  const service = new DeveloperService({
    directory: dir,
    profiles: () => [{ id }],
    inspectView: () => wc,
    reveal: async () => {},
    executeFrame: async (_frame, code) => {
      const action = JSON.parse(
        code.slice(code.lastIndexOf(')(') + 2, -1),
      ).action;
      calls.push(action);
      if (action === 'mask') return { masked: true, token: 'fixture-token' };
      if (action === 'mask-status') return { valid: true };
      return { nodes: [], events: [] };
    },
  });
  t.after(() => service.close());
  await service.attach(id, { screenshots: true });
  const capturing = service.capture();
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(finish);
  const closing = service.release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.at(-1), 'mask');
  finish();
  await capturing;
  await closing;
  assert.deepEqual(calls.slice(-3), ['mask-status', 'unmask', 'stop']);
});
test('navigation or mutation during capture discards image bytes before encoding or persistence', async (t) => {
  const { dir } = fixture(t);
  const id = randomUUID(),
    frame = {};
  const wc = {
    isDestroyed: () => false,
    mainFrame: { framesInSubtree: [frame] },
    capturePage: async () => ({
      isEmpty: () => false,
      resize() {
        throw new Error('raw frame must not be encoded');
      },
    }),
  };
  const service = new DeveloperService({
    directory: dir,
    profiles: () => [{ id }],
    inspectView: () => wc,
    reveal: async () => {},
    executeFrame: async (_frame, code) => {
      const input = JSON.parse(code.slice(code.lastIndexOf(')(') + 2, -1));
      if (input.action === 'mask')
        return { masked: true, token: 'old-document' };
      if (input.action === 'mask-status') return { valid: false };
      return { nodes: [], events: [] };
    },
  });
  t.after(() => service.close());
  await service.attach(id, { screenshots: true });
  assert.equal(await service.capture(), null);
  assert.equal(service.report.screenshots.length, 0);
  assert.ok(service.report.warnings.some((w) => w.includes('未保存图像')));
});

function assistantFixture(t) {
  const { dir } = fixture(t), account = randomUUID(), other = randomUUID(), taskId = randomUUID();
  let task = { id: taskId, accountId: account, accountName: '测试账号', video: { name: '测试视频' },
    platformId: 'douyin', status: 'paused', plannedAt: Date.now(), checkpoint: {} };
  let calls = [], prepared = [], logs = [{ time: Date.now(), level: 'warning', message: '入口超时 token=private C:\\Users\\Alice\\video.mp4' }];
  const frame = {}, wc = { isDestroyed: () => false, mainFrame: { framesInSubtree: [frame] } };
  const publisher = {
    store: { tasks: () => task ? [task] : [], task: (id) => { if (!task || id !== taskId) throw new Error('不存在'); return task; }, logs: () => logs },
    scheduler: { waitInfo: () => ({ message: '等待计划时间', retryAt: Date.now() + 1000 }) },
    action: async (input) => { calls.push(input); if (input.action === 'start') task = { ...task, status: 'pending' }; if (input.action === 'takeover') task = { ...task, status: 'paused' }; },
  };
  const service = new DeveloperService({ directory: dir, profiles: () => [{ id: account }, { id: other }],
    inspectView: (id) => [account, other].includes(id) ? wc : null, reveal: async (id) => calls.push({ reveal: id }),
    publisher: () => publisher, prepareView: async (id) => prepared.push(id),
    executeFrame: async () => ({ url: 'https://example.com/', title: '作品发布', readyState: 'complete', nodes: [], events: [] }) });
  t.after(() => service.close());
  return { service, account, other, taskId, calls, prepared, setTask: (patch) => task = patch ? { ...task, ...patch } : null };
}
test('guided recording binds the original account, captures historical redacted logs and uses existing task execution without granting submission', async (t) => {
  const f = assistantFixture(t);
  await f.service.command('assistant-start', { taskId: f.taskId, run: true, issue: '进不了发布页' });
  assert.equal(f.service.active, f.account);
  assert.deepEqual(f.prepared, [f.account]);
  assert.deepEqual(f.calls, [{ ids: [f.taskId], action: 'start' }]);
  assert.equal(f.service.report.options.screenshots, false);
  const json = JSON.stringify(f.service.report);
  assert.ok(!json.includes('Alice') && !json.includes('token=private'));
  assert.equal(f.service.report.assistance.taskId, f.taskId);
  await f.service.trace(f.other, { taskId: f.taskId, phase: 'error' });
  await f.service.trace(f.account, { taskId: randomUUID(), phase: 'error' });
  assert.equal(f.service.report.scripts.length, 0);
});
test('guided observation cannot retry submitted tasks and manual demonstration pauses through the original engine before revealing the exact account', async (t) => {
  const f = assistantFixture(t);
  f.setTask({ checkpoint: { submitIntent: true }, status: 'unverified' });
  await assert.rejects(f.service.command('assistant-start', { taskId: f.taskId, run: true }), /不能直接重试/);
  assert.equal(f.prepared.length, 0);
  await f.service.command('assistant-start', { taskId: f.taskId, run: false });
  assert.equal(f.calls.length, 0);
  await f.service.command('assistant-manual');
  assert.deepEqual(f.calls, [{ ids: [f.taskId], action: 'takeover' }, { reveal: f.account }]);
  assert.equal(f.service.report.assistance.phase, 'manual');
  assert.equal(f.service.report.assistance.task.checkpoint.submitIntent, true);
  assert.ok(f.service.report.steps.some((s) => s.note?.includes('人工演示')));
});
test('guided finalization freezes the evidence, keeps task state, requires review and permits another problem without deleting prior reports', async (t) => {
  const f = assistantFixture(t);
  await f.service.command('assistant-start', { taskId: f.taskId, run: false });
  await assert.rejects(f.service.command('assistant-new'), /先结束/);
  await f.service.command('assistant-problem', { issue: '等待上传' });
  f.setTask({ status: 'failed', result: { reason: '按钮失效' } });
  await f.service.command('assistant-finish');
  assert.equal(f.service.report.status, 'ended');
  assert.equal(f.service.report.assistance.task.status, 'failed');
  assert.equal(f.calls.length, 0);
  const id = f.service.report.id, revision = f.service.report.revision;
  await f.service.trace(f.account, { taskId: f.taskId, phase: 'end' });
  assert.equal(f.service.report.revision, revision);
  await assert.rejects(f.service.export('zip'), /先预览/);
  await f.service.command('preview');
  assert.ok((await f.service.export('zip')).length > 1000);
  const md = filesFor(f.service.report, {}).find((f) => f.name === 'report.md').data.toString();
  assert.ok(md.includes('发布问题摘要') && md.includes('按钮失效'));
  await f.service.command('assistant-new');
  assert.equal(f.service.report, null);
  assert.equal(f.service.active, null);
  assert.ok(f.service.store.get(id).assistance);
});
test('a deleted task can still finish and export its captured evidence without recreating the task or account', async (t) => {
  const f = assistantFixture(t);
  await f.service.command('assistant-start', { taskId: f.taskId, run: false });
  f.setTask(null);
  await f.service.command('assistant-finish');
  assert.equal(f.service.report.assistance.task.status, 'missing');
  await f.service.command('preview');
  assert.ok((await f.service.export('json')).length > 10);
  assert.equal(f.calls.length, 0);
});
