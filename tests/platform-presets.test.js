'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const presets = require('../src/platform-presets.json');
const { ProfileStore, partitionFor } = require('../src/profile-store');

// These are the supplied creator-center destinations, including full paths
// and the encoded Zhihu return parameter; public homepages are not substitutes.
const destinations = {
  douyin: 'https://creator.douyin.com/',
  xiaohongshu: 'https://creator.xiaohongshu.com/login',
  'weixin-channels': 'https://channels.weixin.qq.com/login.html',
  kuaishou: 'https://cp.kuaishou.com/profile',
  'weixin-official': 'https://mp.weixin.qq.com/',
  toutiao: 'https://mp.toutiao.com/profile_v4/index',
  baijiahao: 'https://baijiahao.baidu.com/builder/theme/bjh/login',
  sohu: 'https://mp.sohu.com/mpfe/v4/login',
  zhihu: 'https://www.zhihu.com/signin?next=%2F',
};

function temporaryStore(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qiye-platform-store-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return { directory, store: new ProfileStore(directory) };
}

test('the nine presets retain their complete supplied creator-center URLs', () => {
  assert.equal(presets.length, 9);
  assert.deepEqual(presets.map(({ id }) => id), Object.keys(destinations));
  for (const preset of presets) {
    assert.equal(preset.launchUrl, destinations[preset.id]);
    assert.match(preset.iconResource, new RegExp(`^\\.\\./assets/platforms/${preset.id}\\.(png|svg|webp|ico)$`));
    assert.ok(fs.existsSync(path.resolve(__dirname, '../src/renderer', preset.iconResource)), 'Every preset icon must be bundled locally');
    assert.equal(typeof preset.displayName, 'string');
    assert.ok(preset.displayName);
  }
});

for (const [platformId, launchUrl] of Object.entries(destinations)) {
  test(`${platformId} creates a persisted association with its exact destination`, (t) => {
    const { directory, store } = temporaryStore(t);
    const profile = store.create({
      platformId,
      name: '自定义账号名称',
      notes: '保留账号备注',
      startUrl: 'https://example.com/unrelated',
    });
    assert.equal(profile.platformId, platformId);
    assert.equal(profile.startUrl, launchUrl);
    assert.equal(profile.lastUrl, launchUrl);
    assert.equal(profile.name, '自定义账号名称');
    assert.equal(profile.notes, '保留账号备注');
    assert.deepEqual(new ProfileStore(directory).get(profile.id), profile);
    assert.equal(new ProfileStore(directory).getState().version, 1);
  });
}

test('the same platform in separate environments keeps distinct UUIDs and partitions across reopening', (t) => {
  const { directory, store } = temporaryStore(t);
  const first = store.create({ platformId: 'zhihu', name: '知乎主账号' });
  const second = store.create({ platformId: 'zhihu', name: '知乎副账号' });
  assert.notEqual(first.id, second.id);
  assert.notEqual(partitionFor(first.id), partitionFor(second.id));
  store.open(first.id);
  store.open(second.id);
  store.touchUrl(first.id, 'https://www.zhihu.com/creator');
  store.close(first.id);
  const restored = new ProfileStore(directory);
  assert.equal(restored.get(first.id).platformId, 'zhihu');
  assert.equal(restored.get(first.id).startUrl, destinations.zhihu);
  assert.equal(restored.get(first.id).lastUrl, 'https://www.zhihu.com/creator');
  assert.equal(restored.get(second.id).lastUrl, destinations.zhihu);
  restored.open(first.id);
  assert.deepEqual(new Set(restored.getState().openIds), new Set([first.id, second.id]));
  assert.equal(restored.getState().activeId, first.id);
  assert.equal(partitionFor(restored.get(first.id).id), partitionFor(first.id));
});

test('renaming a platform environment retains its association and last visited page', (t) => {
  const { directory, store } = temporaryStore(t);
  const profile = store.create({ platformId: 'douyin', name: '旧名称' });
  store.touchUrl(profile.id, 'https://creator.douyin.com/creator-micro/home');
  const before = store.get(profile.id);
  store.update(profile.id, { name: '新名称', notes: '改备注' });
  assert.deepEqual(new ProfileStore(directory).get(profile.id), { ...before, name: '新名称', notes: '改备注' });
});

test('changing a created platform or launch destination is rejected atomically', (t) => {
  const { directory, store } = temporaryStore(t);
  const profile = store.create({ platformId: 'douyin', name: '账号一' });
  const peer = store.create({ platformId: 'douyin', name: '账号二' });
  store.touchUrl(profile.id, 'https://creator.douyin.com/creator-micro/home');
  store.open(profile.id);
  store.open(peer.id);
  const before = store.getState();
  const file = path.join(directory, 'profiles.json');
  const manifest = fs.readFileSync(file, 'utf8');
  for (const input of [
    { platformId: 'zhihu' },
    { startUrl: destinations.zhihu },
    { platformId: 'zhihu', startUrl: destinations.zhihu },
    { platformId: 'douyin', startUrl: 'https://example.com/wrong' },
  ]) {
    assert.throws(() => store.update(profile.id, { name: '不应改名', notes: '不应改备注', color: '#ca7181', ...input }), /不可修改启动网址或平台/);
    assert.deepEqual(store.getState(), before);
    assert.equal(fs.readFileSync(file, 'utf8'), manifest);
    assert.deepEqual(new ProfileStore(directory).getState(), before);
  }
});

test('a created preset cannot be cleared or switched to custom URL mode', (t) => {
  const { directory, store } = temporaryStore(t);
  const profile = store.create({ platformId: 'zhihu' });
  store.touchUrl(profile.id, 'https://www.zhihu.com/creator');
  const before = store.getState();
  for (const platformId of [null, '']) {
    assert.throws(() => store.update(profile.id, { platformId, startUrl: 'example.com/custom', name: '不应改名' }), /不可修改/);
    assert.deepEqual(store.getState(), before);
    assert.deepEqual(new ProfileStore(directory).getState(), before);
  }
});

test('clearing only the association is also refused while normal navigation remains allowed', (t) => {
  const { store } = temporaryStore(t);
  const profile = store.create({ platformId: 'weixin-channels' });
  store.touchUrl(profile.id, 'https://channels.weixin.qq.com/platform');
  const before = store.get(profile.id);
  assert.throws(() => store.update(profile.id, { platformId: null }), /不可修改/);
  assert.deepEqual(store.get(profile.id), before);
  store.touchUrl(profile.id, 'https://channels.weixin.qq.com/platform/account');
  assert.deepEqual(store.get(profile.id), { ...before, lastUrl: 'https://channels.weixin.qq.com/platform/account' });
  assert.equal(partitionFor(store.get(profile.id).id), partitionFor(profile.id));
});

test('custom environments retain legacy defaults and do not infer a platform from a matching URL', (t) => {
  const { directory, store } = temporaryStore(t);
  for (const platformId of [undefined, null, '']) {
    const profile = store.create({ platformId });
    assert.equal(Object.hasOwn(profile, 'platformId'), false);
    assert.equal(profile.startUrl, 'https://www.douyin.com/');
    assert.equal(profile.lastUrl, profile.startUrl);
    assert.equal(Object.hasOwn(profile, 'iconResource'), false);
  }
  for (const startUrl of Object.values(destinations)) {
    const profile = store.create({ startUrl, name: '沿用自定义环境名称' });
    assert.equal(Object.hasOwn(profile, 'platformId'), false);
    assert.equal(profile.name, '沿用自定义环境名称');
    assert.equal(profile.startUrl, startUrl);
    assert.equal(Object.hasOwn(new ProfileStore(directory).get(profile.id), 'platformId'), false);
  }
});

test('unchanged launch settings may be resent without normalizing saved values', (t) => {
  const { directory, store } = temporaryStore(t);
  const profile = store.create({ platformId: 'douyin' });
  const updated = store.update(profile.id, { platformId: 'douyin', startUrl: destinations.douyin, name: '正常改名', notes: '正常备注' });
  assert.deepEqual(updated, { ...profile, name: '正常改名', notes: '正常备注' });
  assert.throws(() => store.update(profile.id, { startUrl: 'https://creator.douyin.com' }), /不可修改/);
  assert.deepEqual(new ProfileStore(directory).get(profile.id), updated);
  const custom = store.create({ startUrl: destinations.zhihu });
  const renamed = store.update(custom.id, { platformId: undefined, startUrl: custom.startUrl, name: '自定义仍可改名' });
  assert.equal(Object.hasOwn(renamed, 'platformId'), false);
  assert.equal(renamed.startUrl, destinations.zhihu);
  for (const platformId of ['zhihu', null, '']) {
    assert.throws(() => store.update(custom.id, { platformId }), /不可修改/);
  }
});

test('invalid incoming platform values reject creation and edits without changing saved metadata', (t) => {
  const { directory, store } = temporaryStore(t);
  const profile = store.create({ platformId: 'zhihu', name: '保留原账号', notes: '保留备注' });
  const before = store.getState();
  const file = path.join(directory, 'profiles.json');
  const manifest = fs.readFileSync(file, 'utf8');
  for (const platformId of ['unknown', 'ZHihu', ' zhihu ', '__proto__', 'constructor', false, 0, [], {}, NaN]) {
    assert.throws(() => store.create({ platformId, name: '不应创建' }), /有效的平台/);
    assert.throws(() => store.update(profile.id, { platformId, name: '不应重命名', startUrl: destinations.douyin }), /不可修改/);
    assert.deepEqual(store.getState(), before);
    assert.equal(fs.readFileSync(file, 'utf8'), manifest);
  }
  assert.throws(() => store.update(profile.id, { platformId: null, startUrl: 'javascript:alert(1)' }));
  assert.deepEqual(store.getState(), before);
  assert.equal(fs.readFileSync(file, 'utf8'), manifest);
});

test('unknown optional platform metadata loads without rewriting or being erased by another environment save', (t) => {
  const { directory, store } = temporaryStore(t);
  const legacy = store.create({ name: '保留旧账号', notes: '旧备注', startUrl: destinations.zhihu });
  const peer = store.create({ name: '另一个账号' });
  const file = path.join(directory, 'profiles.json');
  for (const platformId of ['future-platform', 15, false, { id: 'future-platform' }, null, '']) {
    const saved = store.getState();
    saved.profiles[0].platformId = platformId;
    const manifest = `${JSON.stringify(saved, null, 2)}\n`;
    fs.writeFileSync(file, manifest);
    const restored = new ProfileStore(directory);
    assert.equal(fs.readFileSync(file, 'utf8'), manifest);
    assert.deepEqual(restored.get(legacy.id), { ...legacy, platformId });
    restored.update(peer.id, { notes: '只修改另一个环境' });
    assert.deepEqual(new ProfileStore(directory).get(legacy.id), { ...legacy, platformId });
    restored.update(legacy.id, { name: '未知平台也能改名' });
    assert.deepEqual(restored.get(legacy.id), { ...legacy, platformId, name: '未知平台也能改名' });
    const before = restored.getState();
    assert.throws(() => restored.update(legacy.id, { platformId: 'zhihu', name: '不应改名' }), /不可修改/);
    assert.deepEqual(restored.getState(), before);
    assert.equal(new ProfileStore(directory).getState().version, 1);
  }
});

test('old manifests without platform metadata retain names, complete URLs and unknown extension fields', (t) => {
  const { directory, store } = temporaryStore(t);
  const profile = store.create({ name: '旧知乎环境', notes: '不要改名', startUrl: destinations.zhihu });
  const saved = store.getState();
  saved.profiles[0].oldExtension = { value: '保留原字段' };
  const file = path.join(directory, 'profiles.json');
  const manifest = `${JSON.stringify(saved, null, 2)}\n`;
  fs.writeFileSync(file, manifest);
  const restored = new ProfileStore(directory);
  assert.equal(fs.readFileSync(file, 'utf8'), manifest);
  assert.deepEqual(restored.get(profile.id), saved.profiles[0]);
  assert.equal(Object.hasOwn(restored.get(profile.id), 'platformId'), false);
  restored.open(profile.id);
  restored.close(profile.id);
  assert.deepEqual(new ProfileStore(directory).get(profile.id), saved.profiles[0]);
});
