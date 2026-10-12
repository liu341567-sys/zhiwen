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
    const invalid = structuredClone(preview.rows); invalid[0].nativeSchedule = { ...future, at: '2020-01-01T10:00' };
    await assert.rejects(service.confirm({ ...preview, rows: invalid }), /已过期/);
    assert.equal(service.store.tasks().length, 0);
    const omitted = structuredClone(preview.rows); delete omitted[0].nativeSchedule;
    await service.confirm({ ...preview, rows: omitted, name: 'Native' });
    assert.deepEqual(service.store.tasks()[0].nativeSchedule, future);
    assert.equal(service.store.tasks()[0].location.address, 'Road');
    await service.shutdown();
    const reopened = new PublishingStore(path.join(dir, 'publishing'));
    try { assert.equal(reopened.tasks()[0].accountId, 'a'); assert.deepEqual(reopened.tasks()[0].nativeSchedule, future); } finally { reopened.close(); }
  } finally { if (!service.closing) await service.shutdown(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('official daily recurrence assigns chronological slots independently per account without duplicating videos', () => {
  const pairs = [{accountId:'a'}, {accountId:'b'}, {accountId:'a'}, {accountId:'a'}, {accountId:'b'}];
  const cycle = {mode:'cycle', cadence:'daily', startDate:'2026-10-12', times:['18:00','09:00'], timezone:options.ZONE};
  const plan = options.nativePlans(pairs, cycle, now);
  assert.deepEqual(plan.map(p => p.at), ['2026-10-12T09:00','2026-10-12T09:00','2026-10-12T18:00','2026-10-13T09:00','2026-10-12T18:00']);
  assert.deepEqual(cycle.times, ['18:00','09:00']);
  assert.equal(options.nativePlans([{accountId:'a'}], cycle, Date.parse('2026-10-12T10:00:00+08:00'))[0].at, '2026-10-12T18:00');
});
test('official weekly recurrence rolls over month and year and skips past dates with Shanghai weekday semantics', () => {
  const cycle = {mode:'cycle', cadence:'weekly', startDate:'2026-12-30', times:['10:15'], weekdays:[1,3], timezone:options.ZONE};
  const plan = options.nativePlans(Array.from({length:4},()=>({accountId:'a'})),cycle,now);
  assert.deepEqual(plan.map(p=>p.at), ['2026-12-30T10:15','2027-01-04T10:15','2027-01-06T10:15','2027-01-11T10:15']);
  const oldStart = {...cycle,startDate:'2026-01-01'};
  assert.equal(options.nativePlans([{accountId:'a'}],oldStart,now)[0].at,'2026-10-12T10:15');
});
test('official recurrence rejects invalid dates, times, duplicate slots, empty weekdays and unsupported modes', () => {
  const good = {mode:'cycle',cadence:'weekly',startDate:'2026-10-14',times:['10:15'],weekdays:[1,3],timezone:options.ZONE};
  for (const patch of [{startDate:'2026-02-30'},{startDate:'invalid'}, {times:[]},{times:['24:00']},{times:['09:0']},{times:['09:00','09:00']},{weekdays:[]},{weekdays:[0]},{weekdays:[8]},{weekdays:[1,1]},{cadence:'monthly'},{timezone:'UTC'}])
    assert.throws(()=>options.nativePlans([{accountId:'a'}],{...good,...patch},now));
});
test('fallback location identities are bounded, exact and detached from original configuration', () => {
  const c={mode:'specified',label:'A',address:'Road A',fallback:{label:' B ',address:' Road B '}};
  const clean=options.location(c);assert.deepEqual(clean.fallback,{label:'B',address:'Road B',query:'B'});
  c.fallback.address='changed';assert.equal(clean.fallback.address,'Road B');
  assert.equal(options.location({...c,fallback:{label:'',address:''}}).fallback,undefined);
  for (const fallback of ['B',[],{label:'B'},{address:'Road'}, {label:'B',address:{}},{label:'B',address:'x'.repeat(401)}]) assert.throws(()=>options.location({...c,fallback}));
});
test('new task previews retire local timers and Cartesian distribution, while existing task snapshots keep their execution dates', async (t) => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'qiye-simple-options-'));
  const service=new PublishingService({directory:dir,profiles:()=>[{id:'a',platformId:'douyin',name:'A'},{id:'b',platformId:'douyin',name:'B'}],notify:()=>{}});
  t.mock.method(require('../src/publishing/media'),'validate',async()=>{});service.scheduler.tick=async()=>{};
  try {
    service.store.putResource('video',{name:'V1',path:'/v1',sha256:'v1'},'v1');service.store.putResource('video',{name:'V2',path:'/v2',sha256:'v2'},'v2');
    const input={videoIds:['v1','v2'],accountIds:['a','b'],platformIds:['douyin'],distribution:{mode:'sequence'},title:{values:['Title']},topics:{values:['#Topic']},schedule:{mode:'at',at:'2028-01-01T10:00'},overrides:{'v1:a':{plannedAt:Date.now()+86400000}}};
    const before=Date.now(),preview=service.preview(input);assert.equal(preview.rows.length,2);
    assert.ok(preview.rows.every(row=>row.plannedAt>=before && row.plannedAt<=Date.now()));
    for(const mode of ['all','random','manual']) assert.throws(()=>service.preview({...input,distribution:{mode}}),/请选择一个视频/);
    assert.throws(()=>service.preview({...input,distribution:{mode:'single'}}),/只选择一个账号/);
    assert.equal(service.preview({...input,accountIds:['a'],distribution:{mode:'single'}}).rows.length,2);
    preview.rows.forEach(row=>row.plannedAt=Date.now()+86400000);
    await service.confirm({...preview,name:'Immediate'});
    assert.ok(service.store.tasks().every(task=>task.plannedAt<=Date.now()));
    const future=Date.now()+86400000;service.store.addBatch('Legacy',[{...service.store.tasks()[0],plannedAt:future}]);
    assert.ok(service.store.tasks().some(task=>task.plannedAt===future));
    await assert.rejects(service.dispatch('location-search',{accountId:'a'}),/不支持/);
  } finally {await service.shutdown();fs.rmSync(dir,{recursive:true,force:true});}
});
test('confirmed recurrence and fallback identities survive restart as concrete immutable task snapshots', async (t) => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'qiye-cycle-snapshot-'));
  const service=new PublishingService({directory:dir,profiles:()=>[{id:'a',platformId:'douyin',name:'A'}],notify:()=>{}});
  t.mock.method(require('../src/publishing/media'),'validate',async()=>{});service.scheduler.tick=async()=>{};
  try {
    for(const id of ['v1','v2']) service.store.putResource('video',{name:id,path:'/'+id,sha256:id},id);
    const startDate=new Date(Date.now()+3*86400000+8*3600000).toISOString().slice(0,10);
    const input={videoIds:['v1','v2'],accountIds:['a'],platformIds:['douyin'],distribution:{mode:'single'},title:{values:['Title']},topics:{values:['#Topic']},nativeSchedule:{mode:'cycle',cadence:'daily',startDate,times:['09:00'],timezone:options.ZONE},location:{mode:'specified',label:'A',address:'Road A',fallback:{label:'B',address:'Road B'}}};
    const preview=service.preview(input);const dates=preview.rows.map(row=>row.nativeSchedule.at);assert.notEqual(dates[0],dates[1]);
    await service.confirm({...preview,name:'Cycle'});input.location.fallback.address='changed';input.nativeSchedule.times=['22:00'];
    await service.shutdown();const reopened=new PublishingStore(path.join(dir,'publishing'));
    try {assert.deepEqual(reopened.tasks().map(task=>task.nativeSchedule.at),dates);assert.ok(reopened.tasks().every(task=>task.location.fallback.address==='Road B'));} finally {reopened.close();}
  } finally {if(!service.closing)await service.shutdown();fs.rmSync(dir,{recursive:true,force:true});}
});
