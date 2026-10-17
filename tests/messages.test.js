'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { MessageStore, config, compareCount } = require('../src/messages/store');
const { MessageService } = require('../src/messages/service');
const { Scheduler } = require('../src/publishing/scheduler');
const douyin = require('../src/messages/douyin');
const sample = (unread, extra = {}) => ({ status: 'success', unread, exact: true, unit: 'messages', ...extra });
const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'qiye-messages-'));
const tick = () => new Promise(r => setImmediate(r));
async function fixture(t, extra = {}) {
  const directory = extra.directory || temp(), notifications = [], releases = [], profiles = [{ id: 'a', name: '账号 A', platformId: 'douyin' }, { id: 'b', name: '账号 B', platformId: 'douyin' }, { id: 'c', name: '知乎', platformId: 'zhihu' }];
  let counts = { a: sample(8), b: sample(3) }, now = 1000000;
  const service = await MessageService.create({ directory, profiles: () => profiles, getView: async id => id, releaseView: id => releases.push(id),
    adapters: [{ ...douyin, read: async id => counts[id] }], notify: changes => notifications.push(changes), now: () => now, ...extra });
  t.after(async () => { await service.shutdown(); if (!extra.directory) fs.rmSync(directory, { recursive: true, force: true }); });
  return { service, profiles, counts, notifications, releases, directory, advance: ms => now += ms };
}
test('monitor configuration rejects unknown keys, unsafe limits and invalid IDs', () => {
  for (const bad of [{ intervalSeconds: 1 }, { concurrency: 10 }, { sound: 1 }, { unknown: true }, { selectedIds: [''] }, { selectedIds: 'all' }]) assert.throws(() => config(bad));
  assert.deepEqual(config({ selectedIds: ['a', 'a'] }).selectedIds, ['a']);
});
test('count baseline: first sample silent; reliable increases are estimates, never exact arrivals', () => {
  const first = compareCount(null, sample(8), 1); assert.equal(first.first, true); assert.equal(first.increase, 0);
  const next = compareCount(first.baseline, sample(11), 2); assert.equal(next.increase, 3); assert.equal(next.newMessages, null);
});
test('count decrease updates baseline without asserting no incoming messages', () => {
  const before = { unread: 8, unit: 'messages' }; const next = compareCount(before, sample(2), 1); assert.equal(next.increase, 0); assert.equal(next.newMessages, null); assert.equal(next.baseline.unread, 2);
});
test('capped counts, missing data and changed units do not create false deltas', () => {
  const before = { unread: 8, unit: 'messages' };
  for (const s of [sample(99, { exact: false }), sample(null), sample(-1)]) { const r = compareCount(before, s, 1); assert.equal(r.baseline, before); assert.equal(r.increase, null); }
  assert.equal(compareCount(before, sample(10, { unit: 'conversations' }), 1).first, true);
});
test('SQLite persists configuration and baselines; transactions roll back; deleted profiles pruned', () => {
  const dir = temp(); let store = new MessageStore(dir); store.settings({ sound: false }); store.put('baselines', 'a', { unread: 8 });
  assert.throws(() => store.transaction(() => { store.put('baselines', 'a', { unread: 99 }); throw Error(); })); store.close();
  store = new MessageStore(dir); assert.equal(store.settings().sound, false); assert.equal(store.get('baselines', 'a').unread, 8); store.prune([]); assert.equal(store.get('baselines', 'a'), null); store.close(); fs.rmSync(dir, { recursive: true, force: true });
});
test('first scan establishes baseline; same unread produces no repeated notification', async t => {
  const f = await fixture(t); await f.service.scan(); await f.service.scan(); assert.equal(f.notifications.length, 0); assert.equal(f.service.state().summary.unread.messages, 11); assert.equal(f.service.state().rows[2].result.status, 'unsupported');
});
test('multiple account changes aggregate once per scan and persist deduplication', async t => {
  const f = await fixture(t); await f.service.scan(); f.counts.a = sample(11); f.counts.b = sample(5); await f.service.scan();
  assert.equal(f.notifications.length, 1); assert.equal(f.notifications[0].length, 2); assert.equal(f.service.state().summary.increases.messages, 5);
  assert.equal(f.service.state().summary.newMessages, null); await f.service.scan(); assert.equal(f.notifications.length, 1);
});
test('errors retain reliable baseline, are never zero and respect automatic backoff', async t => {
  const f = await fixture(t); await f.service.scan(); f.counts.a = { status: 'timeout' }; await f.service.scan();
  const row = f.service.state().rows[0]; assert.equal(row.result.unread, null); assert.equal(row.baseline.unread, 8); assert(row.result.retryAt > 1000000);
  f.counts.a = sample(10); await f.service.scan(); assert.equal(f.service.state().rows[0].result.status, 'timeout');
  await f.service.scan({ force: true }); assert.equal(f.notifications[0][0].increase, 2);
});
test('capped 99+ result does not replace or notify over reliable baseline', async t => {
  const f = await fixture(t); await f.service.scan(); f.counts.a = sample(99, { exact: false }); await f.service.scan();
  assert.equal(f.service.state().rows[0].baseline.unread, 8); assert.equal(f.service.state().summary.unread.messages, 3); assert.equal(f.notifications.length, 0);
});
test('disabled accounts and unsupported platforms are not scanned or included in totals', async t => {
  const f = await fixture(t); f.service.update({ selectedIds: ['b', 'c'] }); await f.service.scan(); assert.equal(f.service.state().summary.monitored, 1); assert.equal(f.service.state().summary.unread.messages, 3); assert.equal(f.service.state().rows[0].result.status, 'disabled');
});
test('different units are never added into a fictitious message total', async t => {
  const f = await fixture(t); f.counts.b = sample(4, { unit: 'conversations' }); await f.service.scan(); assert.deepEqual(f.service.state().summary.unread, { messages: 8, conversations: 4, unknown: 0 });
});
test('publishing-busy account is skipped without acquiring a page or disturbing baseline', async t => {
  const inspected = [], f = await fixture(t, { isBusy: id => id === 'a', getView: async id => { inspected.push(id); return id; } });
  await f.service.scan(); assert.deepEqual(inspected, ['b']); assert.equal(f.service.state().rows[0].result.status, 'busy'); assert.equal(f.service.state().rows[0].baseline, null);
});
test('queue concurrency is bounded; duplicate scans share one in-flight cycle', async t => {
  let active = 0, max = 0, calls = 0;
  const f = await fixture(t, { adapters: [{ ...douyin, read: async () => { active++; calls++; max = Math.max(max, active); await tick(); active--; return sample(1); } }] });
  f.service.update({ concurrency: 1 }); await Promise.all([f.service.scan(), f.service.scan()]); assert.equal(max, 1); assert.equal(calls, 2);
});
test('pause aborts active work, releases leases/pages and drains queued scans', async t => {
  const leases = new Set(); let begun = 0;
  const f = await fixture(t, { reserveAccount: id => { leases.add(id); return () => leases.delete(id); }, adapters: [{ ...douyin, read: async (_, signal) => { begun++; await new Promise(r => signal.addEventListener('abort', r, { once: true })); return sample(1); } }] });
  f.service.update({ concurrency: 1 }); const job = f.service.start(); await tick(); await f.service.pause(); await job;
  assert.equal(begun, 1); assert.equal(leases.size, 0); assert.equal(f.service.active.size, 0); assert.equal(f.service.timer, null); assert.equal(f.service.config.enabled, false);
});
test('removing an environment during a scan does not resurrect its results', async t => {
  let done; const f = await fixture(t, { getView: async id => { if (id === 'a') await new Promise(r => done = r); return id; } });
  const job = f.service.scan(); await tick(); f.profiles.splice(0, 1); done(); await job; assert.equal(f.service.store.get('results', 'a'), null);
});
test('quick jump uses environment ID and exact official list URL', async t => {
  const jumps = [], f = await fixture(t, { reveal: async (...args) => jumps.push(args) }); await f.service.open('b'); assert.deepEqual(jumps, [['b', douyin.launchUrl]]); await assert.rejects(() => f.service.open('c'));
});
test('strict official list URL excludes credentials, peer query strings and lookalike hosts', () => {
  assert(douyin.allowed(douyin.launchUrl));
  for (const u of [douyin.launchUrl + '?peer=123', douyin.launchUrl.replace('creator.douyin.com', 'creator.douyin.com.example.com'), 'http://creator.douyin.com/creator-micro/data/following/chat', 'https://user:password@creator.douyin.com/creator-micro/data/following/chat']) assert.equal(douyin.allowed(u), false);
});
test('restart retains reliable baseline and does not repeat last alert; auto resume opt-in', async t => {
  const dir = temp(); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); const f = await fixture(t, { directory: dir }); await f.service.scan(); f.counts.a = sample(10); await f.service.scan(); await f.service.shutdown();
  const g = await fixture(t, { directory: dir }); g.counts.a = sample(10); g.service.initialize(); assert.equal(g.service.running, false); await g.service.scan(); assert.equal(g.notifications.length, 0);
});
test('diagnostics exclude supplied DOM text, credentials and arbitrary attributes', async t => {
  const f = await fixture(t); f.counts.a = { status: 'unrecognized', diagnostic: { text: 'secret body', cookie: 'secret token', nodes: [{ tag: 'button', role: 'button', kind: 'private-message-navigation', password: 'secret' }] } }; await f.service.scan(); assert(!JSON.stringify(f.service.diagnostics('a')).includes('secret'));
});
test('a shared read lease blocks publishing but never counts as a UI-hiding publishing lease', () => {
  const scheduler = new Scheduler({ store: { tasks: () => [], setting: () => null }, execute: async () => {} });
  const release = scheduler.reserveReadOnly('a'); assert.equal(scheduler.leased('a'), false); assert.throws(() => scheduler.reserveAccount('a'));
  assert.equal(scheduler.waitInfo({ id: 't', accountId: 'a', plannedAt: 0 }).code, 'account-monitoring'); release(); assert.equal(scheduler.waitInfo({ id: 't', accountId: 'a', plannedAt: 0 }).code, 'ready');
});
