'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { DouyinLiveEditor, normalize } = require('../src/publishing/adapters/douyin-live');

function editorFixture() {
  const events = [];
  const state = {
    owned: true, ready: true, publishReady: true, submitReady: true,
    titleSelector: '[title]', editorSelector: '[caption]', titleText: '示例标题', editorText: '#示例话题 ',
    maxLength: 1000, titleMaxLength: 30, candidates: [], candidateRevision: 1,
    url: 'https://creator.douyin.com/creator-micro/content/post/video',
  };
  const editor = new DouyinLiveEditor({
    getView: async () => { throw new Error('must reuse connected page'); },
    accountId: 'account-1', token: 'live-owner-1', checkpoint: value => events.push(['checkpoint', value]),
  });
  editor.video = { path: 'C:\\videos\\example.mp4', sha256: 'one' };
  editor.uploadStarted = true;
  editor.latestRevision = editor.appliedRevision = 1;
  editor.desired = { title: '示例标题', topics: '#示例话题 ' };
  editor._read = async () => ({ ...state, candidates: state.candidates.map(c => ({ ...c })) });
  editor.page = {
    signal: editor.signal,
    wc: { getURL: () => state.url, isDestroyed: () => false, executeJavaScriptInIsolatedWorld: async () => {} },
    evaluate: async (_fn, input) => input?.action === 'pick' ? { target: '[data-chosen]' } : { selector: 'button', text: '发布' },
    click: async target => events.push(['click', target]),
    wait: async () => ({ submitted: true }),
    fill: async () => { throw new Error('submit must not refill'); },
    upload: async () => { throw new Error('submit must not upload'); },
    check: () => {},
    detach: () => events.push(['detach']),
  };
  const snapshot = { video: { ...editor.video }, liveOwner: editor.token, autoSubmit: true, ...editor.desired };
  return { editor, state, events, snapshot };
}

test('live final authorization only persists submit boundary and submits already verified official page', async () => {
  const { editor, events, snapshot } = editorFixture();
  const result = await editor.submit(snapshot);
  assert.equal(result.status, 'submitted');
  assert.equal(events.length, 3);
  assert.equal(events[0][0], 'checkpoint');
  assert.equal(events[0][1].submitIntent, true);
  assert.equal(events[1][0], 'click');
  assert.equal(events[2][0], 'detach');
});

test('live submit refuses altered caption, account owner, video proof and pending official suggestions', async t => {
  for (const [label, mutate] of [
    ['caption', f => { f.state.editorText = '#其他话题'; }],
    ['owner', f => { f.state.owned = false; }],
    ['video', f => { f.snapshot.video.sha256 = 'different'; }],
    ['token', f => { f.snapshot.liveOwner = 'other-owner'; }],
    ['pending candidate', f => { f.state.pendingTopics = true; }],
    ['newer unsynchronized revision', f => { f.editor.latestRevision++; }],
  ]) await t.test(label, async () => {
    const fixture = editorFixture();
    mutate(fixture);
    const result = await fixture.editor.submit(fixture.snapshot);
    assert.equal(result.status, 'manual');
    assert.deepEqual(fixture.events, [['detach']]);
  });
});

test('uncertain native submit acknowledgement is retained and never retried', async () => {
  const { editor, snapshot, events } = editorFixture();
  editor.page.click = async () => { events.push(['click']); throw new Error('native acknowledgement timeout'); };
  assert.equal((await editor.submit(snapshot)).status, 'unverified');
  await assert.rejects(editor.submit(snapshot), /连接已关闭/);
  assert.equal(events.filter(([type]) => type === 'click').length, 1);
  assert.equal(events.filter(([type]) => type === 'checkpoint').length, 1);
});

test('failed submit-boundary persistence never sends a publish click', async () => {
  const { editor, snapshot, events } = editorFixture();
  await assert.rejects(editor.submit(snapshot, { checkpoint: () => { throw new Error('disk write failed'); } }), /disk write failed/);
  assert.deepEqual(events, [['detach']]);
  assert.equal(editor.submissionIntent, false);
});

test('latest live edit supersedes an in-flight older revision before another field can be written', async () => {
  const { editor, state } = editorFixture();
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const writes = [];
  editor.page.fill = async (selector, value) => {
    writes.push([selector, value]);
    if (value === '旧标题') { entered(); await gate; }
    if (selector === '[title]') state.titleText = value;
    else state.editorText = value;
  };
  const first = editor.sync({ title: '旧标题', topics: '', revision: 2 });
  await started;
  const latest = editor.sync({ title: '新标题', topics: '', revision: 3 });
  release();
  assert.equal((await first).stale, true);
  const result = await latest;
  assert.equal(result.verified, true);
  assert.equal(result.title, '新标题');
  assert.equal(result.revision, 3);
  assert.deepEqual(writes, [['[title]', '旧标题'], ['[title]', '新标题'], ['[caption]', '']]);
});

test('outdated official topic token cannot click a different candidate', async () => {
  const { editor, state, events } = editorFixture();
  state.candidates = [{ id: 'topic-new', label: '#新候选' }];
  await assert.rejects(editor.pick({ id: 'topic-old', revision: 1, candidateRevision: 1 }), /候选已更新/);
  await assert.rejects(editor.pick({ id: 'topic-new', revision: 0, candidateRevision: 1 }), /文案已变化/);
  await assert.rejects(editor.pick({ id: 'topic-new', revision: 1, candidateRevision: 0 }), /候选已更新/);
  assert.deepEqual(events, []);
});

test('live readback normalizes official hashtag inline spacing without confusing different topic names', () => {
  assert.equal(normalize('标题\u200b#话题一#话题二 '), normalize('标题 #话题一 #话题二'));
  assert.notEqual(normalize('#话题一'), normalize('#话题二'));
});
