'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { ProfileStore, normalizeUrl, partitionFor } = require('../src/profile-store');

function temporaryStore(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qiye-store-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return { directory, store: new ProfileStore(directory) };
}

test('each new environment has a new persistent identity', (t) => {
  const { store } = temporaryStore(t);
  const first = store.create({});
  const second = store.create({});
  assert.notEqual(first.id, second.id);
  assert.ok(first.name);
  assert.ok(second.name);
  assert.notEqual(first.name, second.name);
  assert.equal(first.startUrl, 'https://www.douyin.com/');
  assert.equal(partitionFor(first.id), `persist:account-${first.id}`);
  assert.notEqual(partitionFor(first.id), partitionFor(second.id));
});

test('saving, closing and reopening retains the environment identity and metadata', (t) => {
  const { directory, store } = temporaryStore(t);
  const profile = store.create({ name: '抖音 · 运营一号', notes: '下午发布', startUrl: 'https://www.douyin.com/' });
  store.open(profile.id);
  store.activate(profile.id);
  store.close(profile.id);
  const restored = new ProfileStore(directory);
  assert.equal(restored.get(profile.id).name, '抖音 · 运营一号');
  assert.equal(restored.get(profile.id).notes, '下午发布');
  assert.equal(restored.getState().openIds.includes(profile.id), false);
  restored.open(profile.id);
  assert.equal(restored.getState().openIds.includes(profile.id), true);
  assert.equal(partitionFor(restored.get(profile.id).id), partitionFor(profile.id));
});

test('several environments can remain open and switching never rewrites another profile', (t) => {
  const { store } = temporaryStore(t);
  const first = store.create({ name: '账号 A' });
  const second = store.create({ name: '账号 B' });
  store.open(first.id);
  store.open(second.id);
  store.open(first.id);
  assert.deepEqual(new Set(store.getState().openIds), new Set([first.id, second.id]));
  store.activate(second.id);
  assert.equal(store.getState().activeId, second.id);
  const before = JSON.stringify(store.get(second.id));
  store.close(first.id);
  assert.equal(JSON.stringify(store.get(second.id)), before);
  assert.equal(store.getState().activeId, second.id);
});

test('renaming an environment retains its storage partition and saved URL', (t) => {
  const { directory, store } = temporaryStore(t);
  const profile = store.create({ name: '旧名称', notes: '', startUrl: 'https://example.com/' });
  store.touchUrl(profile.id, 'https://example.com/creator?tab=videos');
  store.update(profile.id, { name: '新名称', notes: '账号备注' });
  const saved = new ProfileStore(directory).get(profile.id);
  assert.equal(saved.id, profile.id);
  assert.equal(saved.name, '新名称');
  assert.equal(saved.notes, '账号备注');
  assert.equal(partitionFor(saved.id), partitionFor(profile.id));
  assert.ok(JSON.stringify(saved).includes('https://example.com/creator?tab=videos'));
});

test('deleting an open environment persists removal without deleting its peers', (t) => {
  const { directory, store } = temporaryStore(t);
  const first = store.create({ name: '删除账号' });
  const second = store.create({ name: '保留账号' });
  store.open(first.id);
  store.open(second.id);
  store.remove(first.id);
  const restored = new ProfileStore(directory);
  assert.deepEqual(restored.getState().profiles.map((profile) => profile.id), [second.id]);
  assert.equal(restored.getState().openIds.includes(first.id), false);
  assert.equal(restored.get(second.id).name, '保留账号');
  assert.throws(() => restored.open(first.id));
});

test('unknown environment IDs cannot mutate metadata or create phantom environments', (t) => {
  const { store } = temporaryStore(t);
  const existing = store.create({ name: '保留' });
  const before = JSON.stringify(store.getState());
  const unknown = '7f4655f7-5680-4f6d-9767-f6e97024976d';
  for (const operation of [
    () => store.open(unknown),
    () => store.close(unknown),
    () => store.activate(unknown),
    () => store.update(unknown, { name: '无效' }),
    () => store.remove(unknown),
    () => store.touchUrl(unknown, 'https://example.com/'),
  ]) assert.throws(operation);
  assert.equal(JSON.stringify(store.getState()), before);
  assert.equal(store.get(existing.id).name, '保留');
});

test('invalid URLs are rejected before a profile is persisted', (t) => {
  const { store } = temporaryStore(t);
  for (const url of ['javascript:alert(1)', 'file:///tmp/account.txt', 'data:text/html,hello', 'about:blank', 'ftp://example.com/', 'https://user:password@example.com/']) {
    assert.throws(() => normalizeUrl(url), url);
    assert.throws(() => store.create({ name: '无效网址', startUrl: url }), url);
  }
  assert.equal(store.getState().profiles.length, 0);
  assert.equal(normalizeUrl('https://www.douyin.com'), 'https://www.douyin.com/');
  assert.equal(normalizeUrl('http://127.0.0.1:3210/'), 'http://127.0.0.1:3210/');
});

test('an invalid edit leaves the existing environment and saved data intact', (t) => {
  const { directory, store } = temporaryStore(t);
  const profile = store.create({ name: '原名称', notes: '保留备注' });
  const before = JSON.stringify(store.getState());
  assert.throws(() => store.update(profile.id, { name: '不应保存', startUrl: 'file:///tmp/account.txt' }));
  assert.throws(() => store.touchUrl(profile.id, 'javascript:alert(1)'));
  assert.equal(JSON.stringify(store.getState()), before);
  assert.equal(JSON.stringify(new ProfileStore(directory).getState()), before);
});

test('unsafe IDs cannot be used as partition names or file paths', () => {
  for (const id of ['', '../other-profile', 'persist:other', 'a/b', null]) {
    assert.throws(() => partitionFor(id));
  }
});

test('oversized metadata is rejected or bounded without affecting peers', (t) => {
  const { store } = temporaryStore(t);
  const peer = store.create({ name: '正常账号', notes: '保持原样' });
  const oversized = '长'.repeat(100_000);
  let created;
  try {
    created = store.create({ name: oversized, notes: oversized });
  } catch (error) {
    assert.ok(error instanceof Error);
  }
  if (created) {
    assert.ok(created.name.length < oversized.length);
    assert.ok(created.notes.length < oversized.length);
  }
  assert.equal(store.get(peer.id).notes, '保持原样');
});

test('corrupt saved configuration is refused and preserved for recovery', (t) => {
  const { directory, store } = temporaryStore(t);
  store.create({ name: '恢复账号' });
  const configPath = path.join(directory, 'profiles.json');
  assert.equal(fs.existsSync(configPath), true);
  const broken = '{"profiles": [ incomplete';
  fs.writeFileSync(configPath, broken);
  assert.throws(() => new ProfileStore(directory));
  assert.equal(fs.readFileSync(configPath, 'utf8'), broken);
});
