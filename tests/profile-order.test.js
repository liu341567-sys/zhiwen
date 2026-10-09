'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { ProfileStore, partitionFor } = require('../src/profile-store');

function temporaryStore(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qiye-order-store-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return { directory, store: new ProfileStore(directory) };
}

function assertOrder(store, expectedIds, original) {
  const state = store.getState();
  assert.deepEqual(state.profiles.map(profile => profile.id), expectedIds);
  assert.deepEqual(state, { ...original, profiles: expectedIds.map(id => original.profiles.find(profile => profile.id === id)) });
}

test('moving environments upward, downward and to the end persists only profile order', (t) => {
  const { directory, store } = temporaryStore(t);
  const a = store.create({ name: '账号 A', platformId: 'douyin', notes: '保留 A 备注' });
  const b = store.create({ name: '账号 B', platformId: 'zhihu', notes: '保留 B 备注' });
  const c = store.create({ name: '账号 C', startUrl: 'https://example.com/', notes: '保留 C 备注' });
  store.open(c.id);
  store.open(a.id);
  store.touchUrl(a.id, 'https://creator.douyin.com/creator-micro/home');
  const original = store.getState();
  store.move(c.id, a.id);
  assertOrder(store, [c.id, a.id, b.id], original);
  assertOrder(new ProfileStore(directory), [c.id, a.id, b.id], original);
  store.move(c.id, b.id);
  assertOrder(store, [a.id, c.id, b.id], original);
  store.move(a.id);
  assertOrder(store, [c.id, b.id, a.id], original);
  assertOrder(new ProfileStore(directory), [c.id, b.id, a.id], original);
  for (const profile of original.profiles) {
    assert.equal(partitionFor(store.get(profile.id).id), partitionFor(profile.id));
  }
});

test('dropping onto itself or into the existing position does not save or change state', (t) => {
  const { directory, store } = temporaryStore(t);
  const a = store.create({ name: '账号 A' });
  const b = store.create({ name: '账号 B' });
  const original = store.getState();
  const manifest = fs.readFileSync(store.file, 'utf8');
  const save = store.save.bind(store);
  let saves = 0;
  store.save = () => { saves += 1; save(); };
  store.move(a.id, a.id);
  store.move(a.id, b.id);
  store.move(b.id, null);
  store.move(b.id, undefined);
  assert.equal(saves, 0);
  assert.deepEqual(store.getState(), original);
  assert.equal(fs.readFileSync(store.file, 'utf8'), manifest);
  assert.deepEqual(new ProfileStore(directory).getState(), original);
});

test('invalid or missing source and target IDs reject a move without any persistence change', (t) => {
  const { directory, store } = temporaryStore(t);
  const a = store.create({ name: '保留账号' });
  const b = store.create({ name: '保留另一账号' });
  store.open(a.id);
  store.open(b.id);
  const original = store.getState();
  const manifest = fs.readFileSync(store.file, 'utf8');
  const unknown = '7f4655f7-5680-4f6d-9767-f6e97024976d';
  for (const invalid of [unknown, '', '../other-profile', 'persist:other', null, false, 0, [], {}]) {
    assert.throws(() => store.move(invalid, b.id));
    if (invalid !== null) assert.throws(() => store.move(a.id, invalid));
    assert.deepEqual(store.getState(), original);
    assert.equal(fs.readFileSync(store.file, 'utf8'), manifest);
    assert.deepEqual(new ProfileStore(directory).getState(), original);
  }
  assert.throws(() => store.move(unknown, unknown));
  assert.deepEqual(store.getState(), original);
});

test('an empty environment list refuses unknown moves and never creates a manifest', (t) => {
  const { directory, store } = temporaryStore(t);
  const original = store.getState();
  const unknown = '7f4655f7-5680-4f6d-9767-f6e97024976d';
  assert.throws(() => store.move(unknown));
  assert.throws(() => store.move(unknown, unknown));
  assert.deepEqual(store.getState(), original);
  assert.equal(fs.existsSync(path.join(directory, 'profiles.json')), false);
});

test('a failed order save restores the previous in-memory order and reports the failure', (t) => {
  const { directory, store } = temporaryStore(t);
  const a = store.create({ name: '账号 A' });
  const b = store.create({ name: '账号 B' });
  const original = store.getState();
  const manifest = fs.readFileSync(store.file, 'utf8');
  const failure = new Error('模拟无法保存排序');
  store.save = () => { throw failure; };
  assert.throws(() => store.move(b.id, a.id), error => error === failure);
  assert.deepEqual(store.getState(), original);
  assert.equal(fs.readFileSync(store.file, 'utf8'), manifest);
  assert.deepEqual(new ProfileStore(directory).getState(), original);
});

test('a move uses the current list and preserves an environment created after drag-start', (t) => {
  const { directory, store } = temporaryStore(t);
  const a = store.create({ name: '拖动账号' });
  const b = store.create({ name: '目标账号' });
  const c = store.create({ name: '中间账号' });
  // The UI only submits source and insertion target IDs, never an old list.
  const drag = { id: a.id, beforeId: c.id };
  const added = store.create({ name: '拖动期间新增', platformId: 'douyin' });
  const original = store.getState();
  store.move(drag.id, drag.beforeId);
  assertOrder(store, [b.id, a.id, c.id, added.id], original);
  assertOrder(new ProfileStore(directory), [b.id, a.id, c.id, added.id], original);
});

test('a deleted drag source or insertion target cannot revive or remove other profiles', (t) => {
  const { directory, store } = temporaryStore(t);
  const a = store.create({ name: '拖动账号' });
  const b = store.create({ name: '删除目标' });
  const c = store.create({ name: '保留账号' });
  store.remove(b.id);
  const original = store.getState();
  const manifest = fs.readFileSync(store.file, 'utf8');
  assert.throws(() => store.move(a.id, b.id));
  assert.throws(() => store.move(b.id, c.id));
  assert.deepEqual(store.getState(), original);
  assert.equal(fs.readFileSync(store.file, 'utf8'), manifest);
  assert.deepEqual(new ProfileStore(directory).getState(), original);
});

test('reordering old manifests retains opaque metadata and subsequent updates still address the same environment', (t) => {
  const { directory, store } = temporaryStore(t);
  const a = store.create({ name: '旧账号 A', startUrl: 'https://example.com/' });
  const b = store.create({ name: '旧账号 B' });
  const saved = store.getState();
  saved.profiles[0].startUrl = 'https://example.com';
  saved.profiles[0].platformId = { future: '保留平台元数据' };
  saved.profiles[0].extension = { nested: ['保留扩展数据'] };
  saved.extension = { manifest: '保留清单字段' };
  fs.writeFileSync(store.file, `${JSON.stringify(saved, null, 2)}\n`);
  const restored = new ProfileStore(directory);
  restored.move(b.id, a.id);
  assertOrder(restored, [b.id, a.id], saved);
  assertOrder(new ProfileStore(directory), [b.id, a.id], saved);
  restored.update(a.id, { name: '旧账号 A 改名' });
  restored.touchUrl(a.id, 'https://example.com/account');
  assert.deepEqual(restored.get(b.id), b);
  assert.deepEqual(restored.get(a.id), { ...saved.profiles[0], name: '旧账号 A 改名', lastUrl: 'https://example.com/account' });
  assert.deepEqual(restored.getState().profiles.map(profile => profile.id), [b.id, a.id]);
  assert.equal(restored.getState().version, 1);
});
