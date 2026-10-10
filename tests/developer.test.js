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
  assert.deepEqual(calls.slice(-2), ['unmask', 'stop']);
});
