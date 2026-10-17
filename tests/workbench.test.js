'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PublishingService } = require('../src/publishing/service');
const media = require('../src/publishing/media');
const turn = () => new Promise((resolve) => setImmediate(resolve));
async function settled(service) {
  for (let i = 0; i < 30; i++) {
    const jobs = [...service.workbench.sessions.values()].map((session) => session.job).filter(Boolean);
    if (!jobs.length) return;
    await Promise.allSettled(jobs); await turn();
  }
  throw new Error('workbench did not settle');
}
function create(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qiye-workbench-'));
  const calls = [], editors = [], profiles = [
    { id: 'a', name: 'Account A', platformId: 'douyin' },
    { id: 'b', name: 'Account B', platformId: 'douyin' },
  ];
  class Editor {
    constructor(input) { this.input = input; this.revision = 0; this.verified = true; this.canSubmit = true; editors.push(this); }
    async prepare(video, options) { calls.push(['upload', this.input.accountId, video.id, options?.resume]); }
    async sync(input) {
      calls.push(['sync', this.input.accountId, structuredClone(input)]);
      if (this.block) await this.block(input);
      this.revision = input.revision; this.title = input.title; this.topics = input.topics;
      return this.inspect();
    }
    async inspect() { return { ready: true, verified: this.verified, canSubmit: this.canSubmit, revision: this.revision, title: this.title, topics: this.topics, candidates: this.candidates || [], candidateRevision: this.revision }; }
    async pick({ id, revision }) {
      calls.push(['pick', this.input.accountId, id, revision]);
      this.topics = '#Official '; this.verified = true; this.candidates = [];
      return this.inspect();
    }
    async submit(task, context) {
      calls.push(['submit', this.input.accountId, task.title]);
      context.checkpoint({ submitIntent: true });
      if (this.failSubmit) throw new Error('response lost after click');
      return { status: 'submitted', reason: 'official confirmation' };
    }
    async discard() { calls.push(['discard', this.input.accountId]); }
    async close() { calls.push(['close', this.input.accountId]); }
  }
  const service = new PublishingService({ directory, profiles: () => profiles, getView: async () => {}, takeover: async (id) => calls.push(['takeover', id]), notify: () => {} });
  service.workbench.Editor = Editor;
  for (const id of ['v1', 'v2']) service.store.putResource('video', { name: id + '.mp4', path: '/local/' + id + '.mp4', sha256: id, bytes: 100 }, id);
  t.mock.method(media, 'validate', async () => true);
  t.after(async () => { await service.shutdown(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { service, calls, editors, profiles, directory };
}
const entry = (id = 'one', accountId = 'a', videoId = 'v1') => ({ id, accountId, videoId, title: 'Original title', topics: '#One ', locked: false });

test('live drafts retain trailing topic space and original profile identity, prohibit two videos in one live account, and create no tasks', async (t) => {
  const { service, profiles } = create(t);
  const before = structuredClone(profiles);
  service.workbench.save({ entries: [entry()], name: 'Draft' });
  assert.equal(service.workbench.state().entries[0].topics, '#One ');
  assert.equal(service.workbench.state().batchId, null);
  assert.equal(service.store.tasks().length, 0);
  assert.throws(() => service.workbench.save({ entries: [entry(), entry('two', 'a', 'v2')] }), /每个账号只能选择一个视频/);
  assert.deepEqual(profiles, before);
});

test('video uploads and native captions sync before final confirmation; confirmation only submits already verified pages', async (t) => {
  const { service, calls } = create(t);
  await service.dispatch('workbench-sync', { entries: [entry(), entry('two', 'b', 'v2')] });
  await settled(service);
  assert.equal(service.store.tasks().length, 0);
  assert.equal(calls.filter((call) => call[0] === 'upload').length, 2);
  assert.equal(calls.filter((call) => call[0] === 'sync').length, 2);
  assert.equal(calls.filter((call) => call[0] === 'submit').length, 0);
  assert.equal(service.scheduler.leased('a'), true);
  assert.equal(service.scheduler.leased('b'), true);
  assert.ok(service.snapshot().workbench.entries.every((row) => row.live.phase === 'ready' && row.live.revision === row.live.verifiedRevision));
  await assert.rejects(service.dispatch('workbench-publish', {}), /明确确认/);
  await service.dispatch('workbench-publish', { confirmed: true });
  await Promise.all([...service.scheduler.running.values()].map((running) => running.job));
  const tasks = service.store.tasks();
  assert.equal(tasks.length, 2);
  assert.ok(tasks.every((task) => task.status === 'submitted' && task.checkpoint.submitIntent));
  assert.equal(calls.filter((call) => call[0] === 'upload').length, 2);
  assert.equal(calls.filter((call) => call[0] === 'sync').length, 2);
  assert.equal(calls.filter((call) => call[0] === 'submit').length, 2);
  assert.equal(tasks.find((task) => task.accountId === 'a').videoId, 'v1');
  assert.equal(tasks.find((task) => task.accountId === 'b').videoId, 'v2');
  assert.throws(() => service.workbench.save({ entries: [entry()] }), /正式确认/);
  await assert.rejects(service.action({ ids: [tasks[0].id], action: 'authorize', confirmed: true }), /正式发布按钮/);
});

test('edits during synchronization coalesce into the newest revision without another upload', async (t) => {
  const { service, calls, editors } = create(t);
  await service.workbench.sync({ entries: [entry()] }); await settled(service);
  let release, block;
  block = new Promise((resolve) => { release = resolve; });
  let first = true;
  editors[0].block = async () => { if (first) { first = false; await block; } };
  await service.workbench.sync({ entries: [{ ...entry(), title: 'Intermediate' }] });
  await turn();
  await service.workbench.sync({ entries: [{ ...entry(), title: 'Newest' }] });
  await assert.rejects(service.workbench.publish({ confirmed: true }), /尚未完成当前内容同步/);
  release(); await settled(service);
  const state = service.workbench.state().entries[0];
  assert.equal(state.title, 'Newest');
  assert.equal(state.live.title, 'Newest');
  assert.equal(state.live.revision, state.live.verifiedRevision);
  assert.equal(calls.filter((call) => call[0] === 'upload').length, 1);
  assert.equal(service.store.tasks().length, 0);
});

test('official topic candidates stay unsubmitted until a current-revision native choice is confirmed', async (t) => {
  const { service, editors, calls } = create(t);
  await service.workbench.sync({ entries: [entry()] }); await settled(service);
  editors[0].verified = false;
  editors[0].candidates = [{ id: 'official-one', label: 'Official topic', kind: 'topic' }];
  await service.workbench.sync({ entries: [{ ...entry(), topics: '#Off' }] }); await settled(service);
  const live = service.workbench.state().entries[0].live;
  assert.equal(live.phase, 'syncing');
  assert.equal(live.candidates.length, 1);
  await assert.rejects(service.workbench.publish({ confirmed: true }), /尚未完成当前内容同步/);
  await assert.rejects(service.workbench.pick({ id: 'one', candidateId: 'official-one', revision: live.candidateRevision - 1 }), /候选已经变化/);
  await service.workbench.pick({ id: 'one', candidateId: 'official-one', revision: live.candidateRevision });
  assert.equal(service.workbench.state().entries[0].topics, '#Official ');
  assert.equal(service.workbench.state().entries[0].live.phase, 'ready');
  assert.equal(calls.filter((call) => call[0] === 'pick').length, 1);
  assert.equal(calls.filter((call) => call[0] === 'submit').length, 0);
});

test('official page drift is checked again at final confirmation, before any task or submit exists', async (t) => {
  const { service, editors, calls } = create(t);
  await service.workbench.sync({ entries: [entry()] }); await settled(service);
  editors[0].verified = false;
  await assert.rejects(service.workbench.publish({ confirmed: true }), /官网页面状态发生变化/);
  assert.equal(service.store.tasks().length, 0);
  assert.equal(service.workbench.state().batchId, null);
  assert.equal(calls.filter((call) => call[0] === 'submit').length, 0);
});

test('uncertain submit blocks retries for that account while another account still submits', async (t) => {
  const { service, editors, calls } = create(t);
  await service.workbench.sync({ entries: [entry(), entry('two', 'b', 'v2')] }); await settled(service);
  editors[0].failSubmit = true;
  await service.workbench.publish({ confirmed: true });
  await Promise.all([...service.scheduler.running.values()].map((running) => running.job));
  const failed = service.store.tasks().find((task) => task.accountId === 'a');
  assert.equal(failed.status, 'unverified');
  assert.equal(service.store.tasks().find((task) => task.accountId === 'b').status, 'submitted');
  await assert.rejects(service.scheduler.resume(failed.id), /核实/);
  assert.equal(calls.filter((call) => call[0] === 'submit').length, 2);
  await assert.rejects(service.workbench.clear({ confirmed: true }), /结果待核实/);
});

test('explicit video replacement discards only its owned editor and preserves the other account page', async (t) => {
  const { service, calls } = create(t);
  await service.workbench.sync({ entries: [entry(), entry('two', 'b', 'v2')] }); await settled(service);
  await service.workbench.sync({ entries: [entry('one', 'a', 'v2'), entry('two', 'b', 'v2')] }); await settled(service);
  assert.equal(calls.filter((call) => call[0] === 'discard' && call[1] === 'a').length, 1);
  assert.equal(calls.filter((call) => call[0] === 'discard' && call[1] === 'b').length, 0);
  assert.equal(calls.filter((call) => call[0] === 'upload' && call[1] === 'a').length, 2);
  assert.equal(calls.filter((call) => call[0] === 'upload' && call[1] === 'b').length, 1);
});

test('manual takeover releases the account lease and explicit retry reconnects to its existing upload', async (t) => {
  const { service, calls } = create(t);
  await service.workbench.sync({ entries: [entry()] }); await settled(service);
  await service.workbench.takeover({ id: 'one' });
  assert.equal(service.scheduler.leased('a'), false);
  assert.equal(service.workbench.state().entries[0].live.phase, 'manual');
  await service.workbench.retry({ id: 'one' }); await settled(service);
  assert.equal(calls.filter((call) => call[0] === 'upload').length, 2);
  assert.equal(calls.filter((call) => call[0] === 'upload')[1][3], true);
  assert.equal(service.workbench.state().entries[0].live.phase, 'ready');
  assert.equal(service.scheduler.leased('a'), true);
});

test('clearing an unsubmitted workbench requires confirmation and frees original account resources', async (t) => {
  const { service, calls } = create(t);
  await service.workbench.sync({ entries: [entry()] }); await settled(service);
  await assert.rejects(service.workbench.clear(), /确认放弃/);
  await service.workbench.clear({ confirmed: true });
  assert.equal(service.scheduler.leased('a'), false);
  assert.equal(service.workbench.state().entries.length, 0);
  assert.equal(calls.filter((call) => call[0] === 'discard').length, 1);
  assert.equal(service.store.tasks().length, 0);
});

test('persisted drafts reload as unsynchronized and cannot pretend the previous process still owns a live page', async (t) => {
  const { service } = create(t);
  const input = { entries: [entry()] };
  service.workbench.save(input);
  service.workbench.revisions.clear();
  await service.workbench.sync(input); await settled(service);
  assert.equal(service.workbench.state().entries[0].live.phase, 'ready');
  assert.equal(service.workbench.state().entries[0].live.verifiedRevision, 1);
});

test('partial confirmation freezes only selected accounts while the remaining live draft can be corrected and submitted independently', async (t) => {
  const { service, calls } = create(t);
  const a = entry(), b = entry('two', 'b', 'v2');
  await service.workbench.sync({ entries: [a, b] }); await settled(service);
  await service.workbench.publish({ confirmed: true, entryIds: ['one'] });
  await Promise.all([...service.scheduler.running.values()].map(row => row.job));
  const confirmed = service.store.tasks()[0];
  await assert.rejects(service.workbench.sync({ entries: [{ ...a, title: 'Forbidden change' }, b] }), /已锁定/);
  await service.workbench.sync({ entries: [a, { ...b, title: 'Corrected B' }] }); await settled(service);
  assert.equal(service.workbench.state().entries[1].live.title, 'Corrected B');
  assert.deepEqual(service.store.task(confirmed.id), confirmed);
  await service.workbench.publish({ confirmed: true, entryIds: ['two'] });
  await Promise.all([...service.scheduler.running.values()].map(row => row.job));
  assert.equal(service.store.tasks().length, 2);
  assert.equal(calls.filter(row => row[0] === 'upload').length, 2);
  assert.deepEqual(calls.filter(row => row[0] === 'submit').map(row => row[2]), ['Original title', 'Corrected B']);
});

test('taking over an account suspends automatic field writes until explicit live retry', async (t) => {
  const { service, calls } = create(t);
  await service.workbench.sync({ entries: [entry()] }); await settled(service);
  await service.workbench.takeover({ id: 'one' });
  const writes = calls.filter(row => row[0] === 'sync').length;
  await service.workbench.sync({ entries: [{ ...entry(), title: 'Edited during manual mode' }] }); await settled(service);
  assert.equal(calls.filter(row => row[0] === 'sync').length, writes);
  assert.equal(service.scheduler.leased('a'), false);
  await service.workbench.retry({ id: 'one' }); await settled(service);
  assert.equal(service.workbench.state().entries[0].live.title, 'Edited during manual mode');
});
