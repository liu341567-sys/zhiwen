'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const options = require('../src/publishing/options');
const { generate } = require('../src/publishing/matching');
const { Scheduler } = require('../src/publishing/scheduler');
const { PublishingService } = require('../src/publishing/service');
const { PublishingStore } = require('../src/publishing/store');
const native = { at: '2026-10-14T12:21', timezone: 'Asia/Shanghai' };
const now = Date.parse('2026-10-12T00:00:00Z');
test('native schedule validates Shanghai minute precision and rejects rollover, expired and legacy boolean configurations', () => {
  assert.deepEqual(options.nativeSchedule(native, now), native);
  assert.equal(options.epoch(native), Date.parse('2026-10-14T04:21:00Z'));
  assert.equal(options.nativeSchedule(null, now), null);
  for (const input of [true, {}, { ...native, timezone: 'UTC' }, { ...native, at: '2026-02-30T12:21' }, { ...native, at: '2026-10-14T24:21' }, { ...native, at: '2026-10-14T12:21:01' }])
    assert.throws(() => options.nativeSchedule(input, now));
  assert.throws(() => options.nativeSchedule(native, options.epoch(native)));
});
test('native batch schedule has independent account clocks and a bounded minute interval', () => {
  const pairs = [{ accountId: 'a' }, { accountId: 'b' }, { accountId: 'a' }, { accountId: 'a' }];
  assert.deepEqual(options.nativePlans(pairs, { ...native, intervalMinutes: 20 }, now).map((p) => p.at),
    ['2026-10-14T12:21', '2026-10-14T12:21', '2026-10-14T12:41', '2026-10-14T13:01']);
  for (const intervalMinutes of [0, -1, 1.2, 1441, '20']) assert.throws(() => options.nativePlans(pairs, { ...native, intervalMinutes }, now));
});
test('location identity preserves full address and query while clearing unused fields', () => {
  assert.deepEqual(options.location({ mode: 'specified', label: ' 示例广场 ', address: ' 东路1号 ', query: '' }), { mode: 'specified', label: '示例广场', address: '东路1号', query: '示例广场' });
  assert.deepEqual(options.location({ mode: 'none', label: 'old', address: 'old' }), { mode: 'none' });
  for (const value of [null, { mode: 'specified' }, { mode: 'specified', label: 'A', address: {} }, { mode: 'specified', label: 'A', query: 'x'.repeat(201) }]) assert.throws(() => options.location(value));
});
test('task matching snapshots official schedule and per-account location; explicit task override wins without changing identity', () => {
  const input = { videoIds: ['v1', 'v2'], accountIds: ['a', 'b'], title: { values: ['Title'] }, topics: { values: ['#Topic'] }, schedule: { mode: 'now' }, nativeSchedule: structuredClone(native),
    locations: { a: { mode: 'specified', label: 'A', address: 'Road A' }, b: { mode: 'specified', label: 'B', address: 'Road B' } }, overrides: { 'v2:a': { nativeSchedule: null, location: { mode: 'none' }, accountId: 'wrong' } } };
  const rows = generate(input, [{ id: 'v1' }, { id: 'v2' }], [{ id: 'a', platformId: 'douyin' }, { id: 'b', platformId: 'douyin' }], () => 0, now);
  assert.equal(rows[1].location.address, 'Road B');
  assert.equal(rows[2].nativeSchedule, null); assert.equal(rows[2].accountId, 'a');
  assert.equal(rows[3].nativeSchedule.at, '2026-10-14T12:31');
  input.locations.b.address = 'changed'; input.nativeSchedule.at = 'changed';
  assert.equal(rows[1].location.address, 'Road B'); assert.equal(rows[0].nativeSchedule.at, native.at);
});
test('official POI account lease blocks only its own account and releases once', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qiye-options-')), store = new PublishingStore(dir);
  const scheduler = new Scheduler({ store, execute: async () => ({ status: 'manual' }) });
  try {
    const release = scheduler.reserveAccount('a');
    assert.equal(scheduler.leased('a'), true); assert.equal(scheduler.leased('b'), false);
    assert.throws(() => scheduler.reserveAccount('a'), /正在执行/);
    release(); release(); assert.equal(scheduler.leased('a'), false);
    const next = scheduler.reserveAccount('a'); next();
    scheduler.stopping = true; assert.throws(() => scheduler.reserveAccount('b'));
  } finally { await scheduler.shutdown(); store.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
test('preview and confirmation validate official time before persistence and preserve exact snapshot on restart', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qiye-options-'));
  const service = new PublishingService({ directory: dir, profiles: () => [{ id: 'a', name: 'A', platformId: 'douyin' }], notify: () => {} });
  t.mock.method(require('../src/publishing/media'), 'validate', async () => {});
  service.scheduler.tick = async () => {};
  const future = { at: new Date(Date.now() + 3 * 86400000 + 8 * 3600000).toISOString().slice(0, 16), timezone: 'Asia/Shanghai' };
  try {
    service.store.putResource('video', { name: 'Clip', path: '/clip.mp4', sha256: 'abc' }, 'v');
    const input = { videoIds: ['v'], accountIds: ['a'], platformIds: ['douyin'], title: { values: ['Title'] }, topics: { values: ['#Topic'] }, schedule: { mode: 'now' }, location: { mode: 'specified', label: 'Demo', address: 'Road', query: 'Demo' }, nativeSchedule: future };
    const preview = service.preview(input);
    const invalid = structuredClone(preview.rows); invalid[0].plannedAt = options.epoch(future);
    await assert.rejects(service.confirm({ ...preview, rows: invalid }), /本地开始时间/);
    assert.equal(service.store.tasks().length, 0);
    await service.confirm({ ...preview, name: 'Native' });
    assert.deepEqual(service.store.tasks()[0].nativeSchedule, future);
    assert.equal(service.store.tasks()[0].location.address, 'Road');
    await service.shutdown();
    const reopened = new PublishingStore(path.join(dir, 'publishing'));
    try { assert.equal(reopened.tasks()[0].accountId, 'a'); assert.deepEqual(reopened.tasks()[0].nativeSchedule, future); } finally { reopened.close(); }
  } finally { if (!service.closing) await service.shutdown(); fs.rmSync(dir, { recursive: true, force: true }); }
});
