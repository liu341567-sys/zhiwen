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
  const dir = temp(); const f = await fixture(t, { directory: dir }); await f.service.scan(); f.counts.a = sample(10); await f.service.scan(); await f.service.shutdown();
  const g = await fixture(t, { directory: dir }); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); g.counts.a = sample(10); g.service.initialize(); assert.equal(g.service.running, false); await g.service.scan(); assert.equal(g.notifications.length, 0);
});
test('diagnostics exclude supplied DOM text, credentials and arbitrary attributes', async t => {
  const f = await fixture(t); f.counts.a = { status: 'unrecognized', diagnostic: { text: 'secret body', cookie: 'secret token', badges: [{ numeric:'4', excluded:false, matchedRow:true, cookie:'secret', ancestors:[{tag:'div',avatar:true,siblings:2,knownRow:false,text:'secret contact'}] }], nodes: [{ tag: 'button', role: 'button', kind: 'private-message-navigation', password: 'secret' }] } }; await f.service.scan(); assert(!JSON.stringify(f.service.diagnostics('a')).includes('secret'));
});
test('a shared read lease blocks publishing but never counts as a UI-hiding publishing lease', () => {
  const scheduler = new Scheduler({ store: { tasks: () => [], setting: () => null }, execute: async () => {} });
  const release = scheduler.reserveReadOnly('a'); assert.equal(scheduler.leased('a'), false); assert.throws(() => scheduler.reserveAccount('a'));
  assert.equal(scheduler.waitInfo({ id: 't', accountId: 'a', plannedAt: 0 }).code, 'account-monitoring'); release(); assert.equal(scheduler.waitInfo({ id: 't', accountId: 'a', plannedAt: 0 }).code, 'ready');
});
test('SQLite backup is a complete consistent baseline snapshot', () => {
  const dir = temp(), store = new MessageStore(dir), dest = path.join(dir, 'backup.sqlite'); store.put('baselines', 'a', { unread: 7 }); store.backup(dest);
  const { DatabaseSync } = require('node:sqlite'), db = new DatabaseSync(dest); assert.equal(JSON.parse(db.prepare('SELECT data FROM baselines WHERE id=?').get('a').data).unread, 7); db.close(); assert.throws(() => store.backup(dest)); store.close(); fs.rmSync(dir, { recursive: true, force: true });
});
test('successful status with an invalid numeric value is rejected as unrecognized', async t => {
  const f = await fixture(t); f.counts.a = sample(-2); await f.service.scan(); const row = f.service.state().rows[0]; assert.equal(row.result.status, 'unrecognized'); assert.equal(row.result.unread, null); assert.equal(row.baseline, null);
});
test('deselecting an active account aborts only its check and releases its resources', async t => {
  let begun = false;
  const f = await fixture(t, { adapters: [{ ...douyin, read: async (id, signal) => { if (id === 'b') return sample(3); begun = true; await new Promise(r => signal.addEventListener('abort',r,{once:true})); return sample(1); } }] });
  const job = f.service.scan(); await tick(); assert(begun); f.service.update({ selectedIds: ['b'] }); await job; assert.equal(f.service.store.get('baselines','a'),null); assert.equal(f.service.active.size,0); assert.equal(f.service.state().summary.unread.messages,3);
});
test('partial visible conversation counters never overwrite a reliable total baseline', async t => {
  const f = await fixture(t); await f.service.scan(); f.counts.a = { status:'partial', unread:4, exact:false, unit:'unknown', conversations:[{key:'a'.repeat(64),unread:4,exact:true,unit:'unknown'}] }; await f.service.scan();
  const row=f.service.state().rows[0]; assert.equal(row.baseline.unread,8); assert.equal(row.result.unread,4); assert.equal(f.service.state().summary.lowerBounds.unknown,4); assert.equal(f.notifications.length,0);
});
test('identified conversation increases are estimates; newly visible conversations are not new arrivals', async t => {
  const f=await fixture(t); const entry=(key,unread)=>({key:key.repeat(64),unread,exact:true,unit:'unknown'});
  f.counts.a={status:'partial',unread:3,exact:false,unit:'unknown',conversations:[entry('a',3)]}; await f.service.scan();
  f.counts.a={status:'partial',unread:10,exact:false,unit:'unknown',conversations:[entry('a',5),entry('b',5)]}; await f.service.scan(); assert.equal(f.notifications[0][0].increase,2); assert.equal(f.notifications[0][0].lowerBound,true); assert.equal(f.notifications[0][0].newMessages,null);
  assert(!JSON.stringify(f.service.state()).includes('a'.repeat(64)));
});
test('anonymous, capped and duplicate conversation rows cannot create false new-message alerts', () => {
  const { compareConversations }=require('../src/messages/store'); const key='a'.repeat(64), old={[key]:{unread:3,unit:'unknown',checkedAt:1000}};
  const r=compareConversations(old,[{key:null,unread:100,exact:true},{key,unread:99,exact:false},{key,unread:5,exact:true,unit:'unknown'},{key,unread:5,exact:true,unit:'unknown'}],2000);
  assert.equal(r.increases.unknown,2); assert.equal(Object.keys(r.ledger).length,1);
});
test('changing between total and conversation counters silently rebases to avoid duplicate alerts', async t => {
  const f=await fixture(t), key='a'.repeat(64); await f.service.scan();
  f.counts.a={status:'partial',unread:3,exact:false,unit:'messages',conversations:[{key,unread:3,exact:true,unit:'messages'}]}; await f.service.scan();
  f.counts.a={status:'partial',unread:5,exact:false,unit:'messages',conversations:[{key,unread:5,exact:true,unit:'messages'}]}; await f.service.scan(); assert.equal(f.notifications.length,1);
  f.counts.a=sample(10); await f.service.scan(); assert.equal(f.notifications.length,1); assert.equal(f.service.state().rows[0].result.first,true);
  f.counts.a=sample(11); await f.service.scan(); assert.equal(f.notifications.length,2); assert.equal(f.notifications[1][0].increase,1);
});
test('auto-resume requires saved running state AND opt-in, without losing baseline', async t => {
  const dir=temp(), f=await fixture(t,{directory:dir}); f.service.update({autoResume:true}); await f.service.start(); await f.service.shutdown();
  const g=await fixture(t,{directory:dir}); t.after(()=>fs.rmSync(dir,{recursive:true,force:true})); g.service.initialize(); assert.equal(g.service.running,true); await g.service.scanJob; assert.equal(g.notifications.length,0); await g.service.pause();
});
test('per-account selection is atomic across rapid independent updates', async t => {
  const f=await fixture(t); f.service.select('a',false); f.service.select('b',false); assert.deepEqual(f.service.config.selectedIds,[]);
  f.service.select('a',true); assert.deepEqual(f.service.config.selectedIds,['a']); assert.throws(()=>f.service.select('c',true));
});
test('legacy custom environment adapter association never mutates original profile data', async t => {
  const raw=[{id:'legacy',name:'旧账号',platformId:null,startUrl:'https://www.douyin.com',lastUrl:'https://creator.douyin.com/creator-micro/home'}], before=JSON.stringify(raw);
  const f=await fixture(t,{profiles:()=>raw}); f.service.assignPlatform('legacy','douyin'); assert.equal(f.service.state().rows[0].supported,true); assert.equal(JSON.stringify(raw),before);
  assert.equal(f.service.state().rows[0].platformId,'douyin'); f.service.assignPlatform('legacy',null); assert.equal(f.service.state().rows[0].supported,false); assert.equal(JSON.stringify(raw),before);
});

// Only service timers are controlled; PQueue and async page work retain their
// real lifecycle, so advancing a deadline also exercises coalescing/cleanup.
function monitorClock() {
  let now = 1000000;
  const timers = new Map();
  return {
    now: () => now,
    setTimer(fn, delay) { const timer = { at: now + delay, unref() {} }; timers.set(timer, fn); return timer; },
    clearTimer(timer) { timers.delete(timer); },
    async advance(ms) {
      now += ms;
      for (let fired = 0; fired < 100; fired++) {
        const due = [...timers.keys()].sort((a,b) => a.at-b.at).find(t => t.at <= now);
        if (!due) return;
        const fn = timers.get(due); timers.delete(due); fn(); await tick(); await tick();
      }
      throw new Error('Unbounded timer catch-up');
    },
    pending: () => [...timers.keys()].map(t => t.at)
  };
}
async function timedFixture(t, extra = {}) {
  const clock = monitorClock(), f = await fixture(t, { now:clock.now, setTimer:clock.setTimer, clearTimer:clock.clearTimer, ...extra });
  f.service.update({ intervalSeconds:30 }); return { ...f, clock };
}
test('manual refreshes preserve the automatic 30-second deadline and the due cycle still runs', async t => {
  let calls=0; const f=await timedFixture(t,{getView:async id=>{calls++;return id;}});
  await f.service.start(); const due=f.service.nextAt;
  await f.clock.advance(10000); await f.service.scan({force:true});
  await f.clock.advance(10000); await f.service.scan({force:true});
  assert.equal(f.service.nextAt,due); assert.deepEqual(f.clock.pending(),[due]);
  const before=calls; await f.clock.advance(10000); assert.equal(calls,before+2); assert.equal(f.service.nextAt,due+30000);
});
test('repeated manual failures never multiply automatic backoff; a success clears it', async t => {
  const f=await timedFixture(t); f.counts.a={status:'timeout'};
  await f.service.scan(); const before=f.service.state().rows[0].result;
  assert.equal(before.failures,1); assert.equal(before.retryAt,f.clock.now()+60000);
  for(let i=0;i<12;i++){await f.clock.advance(1000);await f.service.scan({force:true});}
  const after=f.service.state().rows[0].result; assert.equal(after.failures,1); assert.equal(after.retryAt,before.retryAt);
  f.counts.a=sample(9); await f.service.scan({force:true}); assert.equal(f.service.state().rows[0].result.retryAt,null); assert.equal(f.service.state().rows[0].result.failures,0);
});
test('manual-only failures do not create automatic deferral while monitoring is stopped', async t => {
  const f=await timedFixture(t); f.counts.a={status:'unrecognized'};
  for(let i=0;i<10;i++)await f.service.scan({force:true});
  assert.equal(f.service.state().rows[0].result.failures,0); assert.equal(f.service.state().rows[0].result.retryAt,null); assert.equal(f.service.nextAt,null); assert.deepEqual(f.clock.pending(),[]);
});
test('notification and selection changes leave the deadline fixed; only frequency changes reset it', async t => {
  const f=await timedFixture(t); await f.service.start(); const due=f.service.nextAt;
  await f.clock.advance(10000); f.service.update({sound:false,concurrency:1}); f.service.select('a',false);
  assert.equal(f.service.nextAt,due); await f.service.start(); assert.equal(f.service.nextAt,due);
  f.service.update({intervalSeconds:60}); assert.equal(f.service.nextAt,f.clock.now()+60000);
  await f.service.pause(); assert.equal(f.service.nextAt,null); assert.deepEqual(f.clock.pending(),[]);
});
test('a manual refresh crossing the deadline is followed by one due cycle without overlapping pages', async t => {
  let release, block=false, active=0, max=0, calls=0;
  const f=await timedFixture(t,{adapters:[{...douyin,read:async id=>{calls++;active++;max=Math.max(max,active);if(block&&id==='a')await new Promise(r=>release=r);active--;return sample(1);}}]});
  f.service.update({selectedIds:['a']}); await f.service.start(); const due=f.service.nextAt;
  await f.clock.advance(20000); block=true; const refresh=f.service.scan({force:true}); await tick();
  await f.clock.advance(25000); assert.equal(f.service.nextAt,due); assert.equal(calls,2);
  block=false; release(); await refresh; await f.clock.advance(0);
  assert.equal(calls,3); assert.equal(max,1); assert.equal(f.service.nextAt,due+30000);
});
test('late timers after sleep run once and advance past missed ticks instead of queuing a burst', async t => {
  let calls=0;const f=await timedFixture(t,{getView:async id=>{calls++;return id;}});await f.service.start();
  await f.clock.advance(20*60000+5000);assert.equal(calls,4);assert(f.service.nextAt>f.clock.now());assert(f.service.nextAt<=f.clock.now()+30000);assert.equal(f.clock.pending().length,1);
});
test('automatic backoff remains account-specific and does not slow healthy accounts', async t => {
  const seen=[],f=await timedFixture(t,{getView:async id=>{seen.push(id);return id;}});f.counts.a={status:'timeout'};
  await f.service.start(); // Explicit start is a user check, not an automatic failure.
  await f.clock.advance(30000);const row=f.service.state().rows[0].result;assert.equal(row.failures,1);
  await f.clock.advance(30000);assert.equal(seen.filter(id=>id==='a').length,2);assert.equal(seen.filter(id=>id==='b').length,3);assert.equal(f.service.nextAt,f.clock.now()+30000);
  await f.clock.advance(30000);assert.equal(seen.filter(id=>id==='a').length,3);
});
test('legacy hour-long manual backoff is ignored without losing baseline; new-policy backoff survives restart', async t => {
  const dir=temp(),f=await timedFixture(t,{directory:dir});await f.service.scan();
  f.service.store.put('results','a',{platformId:'douyin',status:'timeout',unread:null,failures:10,retryAt:f.clock.now()+3600000});
  assert.equal(f.service.state().rows[0].result.retryAt,null);f.counts.a=sample(9);await f.service.scan();assert.equal(f.service.state().rows[0].baseline.unread,9);
  f.counts.a={status:'timeout'};await f.service.scan();const due=f.service.state().rows[0].result.retryAt;await f.service.shutdown();
  const g=await timedFixture(t,{directory:dir});t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));await g.service.scan();assert.equal(g.service.state().rows[0].result.retryAt,due);assert.equal(g.service.state().rows[0].baseline.unread,9);
});
