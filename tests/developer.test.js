'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { inflateRawSync } = require('node:zlib');
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
const { retainEvidence, evidenceHealth, sampleSignature } = require('../src/developer/evidence');
const { packedReport, unpackReport, displayState } = require('../src/developer/codec');

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
test('shared DOM storage reconstructs exact snapshots, geometry, frame/shadow paths and changing controls without altering old evidence', () => {
  const nodes = Array.from({ length: 600 }, (_, id) => ({ id, tag: 'input',
    selector: 'html > body > '.repeat(40) + `input:nth-of-type(${id + 1})`,
    roots: ['#shadow-host'], attributes: { type: 'checkbox' },
    semantic: { label: `选项 ${id}` }, controlState: { checked: false },
    rect: { x: 20, y: id * 40, width: 120, height: 32 }, enabled: true, visible: true }));
  const snapshots = Array.from({ length: 85 }, (_, j) => ({ id: randomUUID(), time: j,
    frames: [{ key: 'main', url: 'https://example.com/', nodes: nodes.map((n) => ({ ...n,
      rect: { ...n.rect, y: n.rect.y - j * 10 }, controlState: { checked: j > 60 && n.id === 1 } })) },
    { key: 'frame-1', nodes: [nodes[0]] }] }));
  const report = { snapshots, steps: snapshots.map((s) => ({ id: randomUUID(), beforeId: s.id, afterId: s.id })), scripts: [], screenshots: [] };
  const original = JSON.stringify(report), result = retainEvidence(report);
  assert.equal(result.full, false); assert.equal(report.snapshots.length, 85);
  assert.ok(result.bytes < Buffer.byteLength(original) / 5);
  assert.deepEqual(unpackReport(JSON.parse(result.serialized)).snapshots, JSON.parse(original).snapshots);
  assert.equal(report.snapshots[0].frames[0].nodes[1].controlState.checked, false);
  assert.equal(report.snapshots.at(-1).frames[0].nodes[1].controlState.checked, true);
  assert.throws(() => { report.snapshots[0].frames[0].nodes[1].controlState.checked = true; }, TypeError);
  assert.deepEqual(evidenceHealth(report).missingStepSnapshots, []);
});
test('sharing discards unused dictionary entries and rejects broken indices or excessive readable expansion', () => {
  const report = { snapshots: [{ id: 'one', frames: [{ nodes: [{ tag: 'button', selector: '#obsolete' }] }] },
    { id: 'two', frames: [{ nodes: [{ tag: 'button', selector: '#current' }] }] }] };
  assert.equal(packedReport(report).data.domNodes.length, 2);
  report.snapshots.shift(); const packed = packedReport(report).data;
  assert.equal(packed.domNodes.length, 1); assert.equal(packed.domNodes[0].selector, '#current');
  for (const ref of [-1, 5, 0.5, '0']) {
    const invalid = structuredClone(packed); invalid.snapshots[0].frames[0].nodeRefs = [ref];
    assert.throws(() => unpackReport(invalid), /索引无效/);
  }
  const invalidState = structuredClone(packed); invalidState.snapshots[0].frames[0].nodeStates = [{ text: 'overridden' }];
  assert.throws(() => unpackReport(invalidState), /状态无效/);
  const expanded = { schemaVersion: 2, domEncoding: 'node-pool-v1', domNodes: [{ text: 'x'.repeat(2000) }],
    snapshots: [{ frames: [{ nodeRefs: Array(100000).fill(0) }] }] };
  assert.throws(() => unpackReport(expanded), /安全容量/);
});
test('version 1 SQLite rows and shared version 2 rows both survive restart and report deletion', (t) => {
  const { store, report } = fixture(t);
  const legacy = { ...report, id: randomUUID(), snapshots: [{ id: randomUUID(), frames: [{ key: 'main', nodes: [{ tag: 'button', text: '封面' }] }] }] };
  store.db.prepare('INSERT INTO reports VALUES(?,?,?)').run(legacy.id, Date.now(), JSON.stringify(legacy));
  assert.deepEqual(store.get(legacy.id), legacy); store.save(legacy);
  const stored = JSON.parse(store.db.prepare('SELECT data FROM reports WHERE id=?').get(legacy.id).data);
  assert.equal(stored.schemaVersion, 2); assert.equal(stored.domEncoding, 'node-pool-v1');
  assert.deepEqual(store.get(legacy.id), legacy); store.remove(legacy.id);
  assert.ok(!store.list().some((row) => row.id === legacy.id));
});
test('window state sends only the current DOM while keeping all historical IDs and full comparison evidence in the service', () => {
  const node = { tag: 'button', selector: '#cover', enabled: false },
    report = { snapshots: [{ id: 'a', frames: [{ key: 'main', nodes: [node] }] },
      { id: 'b', frames: [{ key: 'main', nodes: [{ ...node, enabled: true }] }] }], steps: [] };
  const visible = displayState({ report, profiles: [] });
  assert.equal(visible.report.snapshots[0].frames[0].nodes, undefined);
  assert.equal(visible.report.snapshots[0].frames[0].nodeCount, 1);
  assert.equal(visible.report.snapshots.at(-1).frames[0].nodes[0].enabled, true);
  assert.equal(report.snapshots[0].frames[0].nodes[0].enabled, false);
  assert.equal(compare(...report.snapshots).changes[0].kind, 'changed');
});
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
test('public creator routes survive repeated redaction while URL credentials, queries and opaque path identifiers do not', () => {
  for (const route of ['home', 'content/manage', 'content/publish', 'content/post/video']) {
    const url = 'https://creator.douyin.com/creator-micro/' + route;
    assert.equal(redact(url), url);
    assert.equal(redact(redact(url)), url);
  }
  const privateURL = 'https://user:credential@creator.example.com/posts/0123456789abcdef0123456789abcdef?token=private-query#secret';
  const safe = redact(privateURL);
  for (const secret of ['user:', 'credential', 'private-query', '#secret', '0123456789abcdef0123456789abcdef']) assert.ok(!safe.includes(secret));
  assert.equal(redact(safe), safe);
  const text = redact('入口 https://creator.douyin.com/creator-micro/content/manage?token=private 下一页 https://example.com/video?account=private token=outside-secret');
  assert.ok(text.includes('/creator-micro/content/manage') && text.includes('https://example.com/video'));
  assert.ok(!text.includes('private') && !text.includes('outside-secret'));
});
test('capacity cleanup preserves over 80 linked action samples, screenshots, script errors and module markers', () => {
  const snapshots = Array.from({ length: 130 }, () => ({ id: randomUUID(), frames: [] }));
  const report = { snapshots, steps: snapshots.slice(0, 120).map((s) => ({ id: randomUUID(), beforeId: s.id, afterId: s.id })),
    scripts: [{ snapshotId: snapshots[120].id }], screenshots: [{ snapshotId: snapshots[121].id }],
    assistance: { segments: [{ snapshotId: snapshots[122].id }] } };
  const pinned = snapshots.slice(0, 123).map((s) => s.id);
  const bytes = Buffer.byteLength(JSON.stringify(report));
  const result = retainEvidence(report, bytes - 100);
  assert.ok(result.removed > 0);
  for (const id of pinned) assert.ok(report.snapshots.some((s) => s.id === id));
  assert.deepEqual(evidenceHealth(report).missingStepSnapshots, []);
});
test('ambient sampling is bounded without evicting the earliest action and capacity exhaustion is explicit', () => {
  const first = { id: randomUUID(), frames: [] }, snapshots = [first, ...Array.from({ length: 100 }, () => ({ id: randomUUID(), frames: [] }))];
  const report = { snapshots, steps: [{ id: randomUUID(), beforeId: first.id }], scripts: [], screenshots: [] };
  retainEvidence(report);
  assert.equal(report.snapshots.length, 18); // first, latest and 16 ambient samples
  assert.equal(report.snapshots[0].id, first.id);
  const result = retainEvidence(report, 1);
  assert.equal(result.full, true);
  assert.equal(report.snapshots.length, 2);
  assert.equal(report.steps[0].beforeId, first.id);
});
test('sampling signatures ignore runtime node IDs and layout jitter but capture control, text and URL changes', () => {
  const a = [{ key: 'main', url: '/before', nodes: [{ id: 1, tag: 'button', text: '发布', enabled: false, rect: { x: 1 } }] }];
  const b = JSON.parse(JSON.stringify(a)); b[0].nodes[0].id = 2; b[0].nodes[0].rect.x = 2;
  assert.equal(sampleSignature(a), sampleSignature(b));
  b[0].nodes[0].enabled = true;
  assert.notEqual(sampleSignature(a), sampleSignature(b));
  b[0].nodes[0].enabled = false; b[0].nodes[0].controlState = { checked: true };
  assert.notEqual(sampleSignature(a), sampleSignature(b));
});
test('exports share detailed action differences and report missing legacy snapshot links explicitly', (t) => {
  const { report } = fixture(t), before = randomUUID(), after = randomUUID();
  const node = { tag: 'input', selector: '#scheduled', roots: [], attributes: { type: 'checkbox' },
    semantic: { label: '定时发布' }, controlState: { checked: false }, text: '', enabled: true };
  report.snapshots = [{ id: before, frames: [{ key: 'main', nodes: [node] }] },
    { id: after, frames: [{ key: 'main', nodes: [{ ...node, controlState: { checked: true } }] }] }];
  report.steps = [{ id: randomUUID(), beforeId: before, afterId: after }, { id: randomUUID(), beforeId: before, afterId: after },
    { id: randomUUID(), beforeId: randomUUID(), afterId: after }];
  const data = reportData(report, {});
  assert.equal(data.differences.length, 1);
  assert.equal(data.steps[0].diff.differenceIndex, 0);
  assert.equal(data.steps[1].diff.differenceIndex, 0);
  assert.equal(data.differences[0].changes[0].after.enabled, true);
  assert.equal(data.differences[0].changes[0].after.controlState.checked, true);
  assert.equal(data.evidenceHealth.missingStepSnapshots.length, 1);
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
test('large DOM exports compress below the upload limit and retain every file byte and central offset', () => {
  const node = JSON.stringify({ tag: 'button', text: '作品发布', role: 'button', visible: true, disabled: false, selector: 'nav button', attributes: { 'aria-label': '作品发布' } }) + '\n';
  const data = Buffer.from(node.repeat(Math.ceil(34 * 1024 * 1024 / Buffer.byteLength(node))));
  const files = [
    { name: 'report.json', data },
    { name: 'report.md', data: Buffer.from('发布问题摘要\n'.repeat(20)) },
    { name: 'report.html', data: Buffer.from('<pre>作品发布</pre>\n'.repeat(20)) },
    { name: 'screenshots/shot.png', data: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]) },
  ];
  const buffer = zip(files);
  assert.ok(data.length > 32 * 1024 * 1024);
  assert.ok(buffer.length < 1024 * 1024, `compressed bytes: ${buffer.length}`);
  let local = 0, central = buffer.readUInt32LE(buffer.length - 6);
  for (const file of files) {
    assert.equal(buffer.readUInt32LE(local), 0x04034b50);
    assert.equal(buffer.readUInt32LE(central), 0x02014b50);
    const method = buffer.readUInt16LE(local + 8), size = buffer.readUInt32LE(local + 18);
    const nameSize = buffer.readUInt16LE(local + 26), body = local + 30 + nameSize;
    assert.equal(method, file.name.endsWith('.png') ? 0 : 8);
    assert.equal(buffer.readUInt16LE(central + 10), method);
    assert.equal(buffer.readUInt32LE(central + 20), size);
    assert.equal(buffer.readUInt32LE(central + 24), file.data.length);
    assert.equal(buffer.readUInt32LE(central + 42), local);
    assert.equal(buffer.subarray(local + 30, body).toString(), file.name);
    const payload = buffer.subarray(body, body + size);
    assert.deepEqual(method === 8 ? inflateRawSync(payload) : payload, file.data);
    local = body + size;
    central += 46 + nameSize;
  }
  assert.equal(central, buffer.length - 22);
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
  f.setTask({ nativeSchedule: { at: '2026-10-14T12:21', timezone: 'Asia/Shanghai' },
    location: { mode: 'specified', label: 'Private personal address' }, cover: { mode: 'image', path: '/private/cover.png' },
    checkpoint: { manualOptionsConfirmed: true } });
  f.service.assistant.refresh();
  assert.equal(f.service.report.assistance.task.options.nativeSchedule.at, '2026-10-14T12:21');
  assert.equal(f.service.report.assistance.task.checkpoint.manualOptionsConfirmed, true);
  assert.ok(!JSON.stringify(f.service.report.assistance.task.options).includes('Private personal address'));
  assert.ok(!JSON.stringify(f.service.report.assistance.task.options).includes('/private/cover.png'));
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
test('task shortcut preserves an ongoing recording and opens a fresh guided form after completion without removing prior evidence', async (t) => {
  const f = assistantFixture(t);
  await f.service.command('assistant-start', { taskId: f.taskId, run: false });
  const report = f.service.report;
  await f.service.command('assistant-select', { taskId: f.taskId });
  assert.equal(f.service.report.id, report.id);
  report.assistance.taskId = randomUUID();
  await assert.rejects(f.service.command('assistant-select', { taskId: f.taskId }), /其他记录/);
  assert.equal(f.service.report.id, report.id);
  report.assistance.taskId = f.taskId;
  await f.service.command('assistant-finish');
  await f.service.command('assistant-select', { taskId: f.taskId });
  assert.equal(f.service.report, null);
  assert.equal(f.service.assistant.preferredTask, f.taskId);
  assert.ok(f.service.store.get(report.id));
  await assert.rejects(f.service.command('assistant-select', { taskId: {} }), /请选择/);
});
test('late and coalesced recorder events get a fresh after snapshot even when the DOM is unchanged', async (t) => {
  const f = assistantFixture(t), s = f.service;
  await s.attach(f.account);
  await s.command('start');
  const time = Date.now();
  s.pageEvent({ type: 'input', time, target: { selector: '#title' } });
  await s.poll();
  const step = s.report.steps.at(-1), after = step.afterId;
  assert.ok(after);
  s.pageEvent({ type: 'input', time: time + 100, target: { selector: '#title' } });
  assert.equal(s.report.steps.at(-1).id, step.id);
  assert.equal(step.afterId, null);
  await s.poll();
  assert.ok(step.afterId && step.afterId !== after);
  assert.equal(step.beforeId, s.report.snapshots.find((n) => n.id === step.beforeId).id);
  s.pageEvent({ type: 'click', time: time + 150, target: { selector: '#submit' } });
  await s.poll();
  assert.ok(s.report.steps.at(-1).afterId);
});
test('continuous input retains original timing and baseline across polls but never merges click, space, roots or pause boundaries', async (t) => {
  const f = assistantFixture(t), s = f.service;
  await s.attach(f.account); await s.command('start');
  const time = Date.now(), target = { selector: '#title', roots: ['#editor'] };
  s.pageEvent({ type: 'input', time, target }); await s.poll();
  const original = s.report.steps.at(-1), baseline = original.beforeId;
  s.pageEvent({ type: 'input', time: time + 1300, target }); await s.poll();
  assert.equal(s.report.steps.at(-1).id, original.id);
  assert.equal(original.time, time); assert.equal(original.lastEventAt, time + 1300);
  assert.equal(original.eventCount, 2); assert.equal(original.beforeId, baseline); assert.ok(original.afterId);
  s.pageEvent({ type: 'topic-space', time: time + 1400, target });
  s.pageEvent({ type: 'input', time: time + 1500, target });
  assert.notEqual(s.report.steps.at(-1).id, original.id);
  const next = s.report.steps.at(-1);
  s.pageEvent({ type: 'input', time: time + 1600, target: { ...target, roots: ['#other-editor'] } });
  assert.notEqual(s.report.steps.at(-1).id, next.id);
  await s.command('pause'); await s.command('resume');
  const previous = s.report.steps.at(-1);
  s.pageEvent({ type: 'input', time: time + 1700, target: { ...target, roots: ['#other-editor'] } });
  assert.notEqual(s.report.steps.at(-1).id, previous.id);
  const count = s.report.steps.length;
  s.pageEvent({ type: 'input', time: time + 1800, target: { selector: '#file', attributes: { type: 'file' } } });
  s.pageEvent({ type: 'scroll', time: time + 1800, target: { selector: '#hidden-frame', visible: false } });
  assert.equal(s.report.steps.length, count);
  s.pageEvent({ type: 'upload', time: time + 1801, target: { selector: '#file', attributes: { type: 'file' }, file: { count: 1 } } });
  assert.equal(s.report.steps.length, count + 1);
});
test('shared JSON and HTML exports remain self-describing, fully reconstructable and scrubbed before pooling', (t) => {
  const { report } = fixture(t), id = randomUUID();
  report.snapshots = [{ id, time: Date.now(), frames: [{ key: 'main', nodes: [{ tag: 'input', id: 1,
    selector: '#title', rect: { x: 1, y: 2 }, value: 'private-input', text: 'user@example.com' }] }] }];
  report.steps = [{ id: randomUUID(), time: Date.now(), type: 'input', eventCount: 3,
    lastEventAt: Date.now(), beforeId: id, afterId: id }];
  const files = filesFor(report, {}), json = files.find((f) => f.name === 'report.json').data.toString(),
    exported = JSON.parse(json), readable = unpackReport(exported);
  assert.equal(exported.schemaVersion, 2); assert.equal(exported.domEncoding, 'node-pool-v1');
  assert.equal(exported.snapshots[0].frames[0].nodeRefs[0], 0);
  assert.equal(readable.snapshots[0].frames[0].nodes[0].id, 1);
  assert.deepEqual(readable.snapshots[0].frames[0].nodes[0].rect, { x: 1, y: 2 });
  assert.ok(!json.includes('private-input') && !json.includes('user@example.com'));
  assert.ok(files.find((f) => f.name === 'report.md').data.toString().includes('frame.nodeStates[j]'));
  assert.ok(files.find((f) => f.name === 'report.md').data.toString().includes('连续操作合并：3 次'));
  assert.ok(files.find((f) => f.name === 'report.html').data.toString().includes('共享元素词典'));
});
test('an oversized new page sample pauses recording without deleting linked earlier evidence or claiming a successful after sample', async (t) => {
  const f = assistantFixture(t), service = f.service;
  await service.attach(f.account);
  await service.command('start');
  const before = service.report.snapshots.at(-1).id;
  service.pageEvent({ type: 'click', time: Date.now(), target: { selector: '#schedule' } });
  service.executeFrame = async () => ({ url: 'https://example.com/', events: [],
    nodes: Array.from({ length: 2000 }, (_, i) => ({ tag: 'div', selector: `#unique-${i} > ` + 'div > '.repeat(600), text: `${i} ` + '页面 '.repeat(1300),
      attributes: { 'aria-label': `${i} ` + '控件 '.repeat(1300) }, id: i })) });
  await service.poll(true);
  assert.equal(service.report.status, 'paused');
  assert.equal(service.report.capacityPaused, true);
  assert.ok(service.report.snapshots.some((s) => s.id === before));
  assert.equal(service.report.steps.at(-1).afterId, null);
  assert.equal(service.report.steps.at(-1).captureIncomplete, 'capacity');
  assert.equal(service.store.get(service.report.id).status, 'paused');
  await assert.rejects(service.command('resume'), /容量上限/);
  await service.command('stop');
  await service.command('preview');
  assert.ok((await service.export('zip')).length > 10);
});

test('task-free recording needs no publisher or plan and uses only the chosen saved environment', async (t) => {
  const { dir } = fixture(t), id = randomUUID(), other = randomUUID(), actions = [], frame = {};
  const wc = { isDestroyed: () => false, mainFrame: { framesInSubtree: [frame] } };
  const service = new DeveloperService({ directory: dir, profiles: () => [{ id, name: '已有账号' }, { id: other }],
    inspectView: (p) => p === id ? wc : null, publisher: () => null,
    prepareView: async (p) => actions.push(['prepare', p]), reveal: async (p) => actions.push(['reveal', p]),
    executeFrame: async () => ({ url: 'https://example.com/', nodes: [], events: [] }) });
  t.after(() => service.close());
  assert.equal(service.state().assistant.workflow, 'record');
  assert.equal(service.state().assistant.tasks.length, 0);
  assert.equal(service.state().assistant.environments.length, 2);
  await service.command('assistant-record', { accountId: id, scope: 'partial', name: '封面与定位模块' });
  assert.deepEqual(actions, [['prepare', id], ['reveal', id]]);
  assert.equal(service.active, id);
  assert.equal(service.report.status, 'recording');
  assert.equal(service.report.assistance.scope, 'partial');
  assert.equal(service.report.assistance.taskId, undefined);
  assert.equal(service.report.assistance.task, undefined);
  assert.equal(service.report.options.screenshots, false);
  await service.trace(id, { phase: 'error', operation: 'unrelated-script' });
  assert.equal(service.report.scripts.length, 0);
  await service.command('assistant-segment', { note: '开始设置封面 token=private' });
  const segment = service.report.assistance.segments[0];
  assert.ok(segment.label.includes('已脱敏') && !segment.label.includes('private'));
  assert.ok(service.report.steps.some((s) => s.id === segment.stepId));
  assert.ok(service.report.snapshots.some((s) => s.id === segment.snapshotId));
  await service.command('assistant-pause');
  const count = service.report.steps.length;
  service.pageEvent({ type: 'click', time: Date.now(), target: { selector: '#ignored' } });
  assert.equal(service.report.steps.length, count);
  await service.command('assistant-resume');
  service.pageEvent({ type: 'click', time: Date.now(), target: { selector: '#cover' } });
  await service.command('assistant-finish');
  assert.equal(service.report.status, 'ended');
  const recorded = service.report.steps.find((s) => s.target?.selector === '#cover');
  assert.ok(recorded.beforeId && recorded.afterId);
  await assert.rejects(service.export('zip'), /先预览/);
  await service.command('preview');
  assert.ok((await service.export('zip')).length > 500);
  const markdown = filesFor(service.report, {}).find((f) => f.name === 'report.md').data.toString();
  assert.ok(markdown.includes('人工操作录制摘要') && markdown.includes('部分模块') && markdown.includes(segment.stepId));
  assert.ok(!markdown.includes('任务参考：undefined'));
  const saved = service.report.id;
  await service.command('assistant-new');
  assert.ok(service.store.get(saved).assistance);
});

test('problem recording also works without a task, labels the failure and manual correction without invoking publishing', async (t) => {
  const f = assistantFixture(t);
  f.setTask(null);
  await f.service.command('assistant-workflow', { workflow: 'diagnostic' });
  await f.service.command('assistant-record', { accountId: f.other, workflow: 'diagnostic', issue: '官方定位搜索变化' });
  await f.service.command('assistant-problem');
  await f.service.command('assistant-manual');
  await f.service.command('assistant-finish');
  assert.deepEqual(f.prepared, [f.other]);
  assert.deepEqual(f.calls, [{ reveal: f.other }, { reveal: f.other }]);
  assert.equal(f.service.report.assistance.kind, 'diagnostic');
  assert.ok(f.service.report.steps.some((s) => s.note?.includes('人工演示正确操作')));
  const md = filesFor(f.service.report, {}).find((f) => f.name === 'report.md').data.toString();
  assert.ok(md.includes('网页问题排查摘要') && md.includes('官方定位搜索变化'));
});

test('standalone recording validates profile and leases before and after opening and refuses overwriting an active recording', async (t) => {
  const f = assistantFixture(t);
  await assert.rejects(f.service.command('assistant-record', { accountId: randomUUID() }), /已有的账号环境/);
  f.service.isLeased = () => true;
  await assert.rejects(f.service.command('assistant-record', { accountId: f.account }), /正在自动执行/);
  assert.equal(f.prepared.length, 0);
  let leased = false;
  f.service.isLeased = () => leased;
  f.service.assistant.prepareView = async () => { leased = true; };
  await assert.rejects(f.service.command('assistant-record', { accountId: f.account }), /刚开始自动执行/);
  assert.equal(f.service.report, null);
  leased = false;
  f.service.assistant.prepareView = async () => {};
  await f.service.command('assistant-record', { accountId: f.account });
  const id = f.service.report.id;
  await assert.rejects(f.service.command('assistant-select', { taskId: f.taskId }), /其他记录/);
  await assert.rejects(f.service.command('assistant-workflow', { workflow: 'diagnostic' }), /结束当前/);
  await assert.rejects(f.service.command('assistant-record', { accountId: f.other }), /已有记录/);
  await f.service.command('assistant-pause');
  leased = true;
  await assert.rejects(f.service.command('assistant-resume'), /先暂停任务/);
  assert.equal(f.service.report.status, 'paused');
  assert.equal(f.service.report.id, id);
  assert.deepEqual(f.calls, [{ reveal: f.account }]);
});
