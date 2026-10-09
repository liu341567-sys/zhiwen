'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const STATUSES = [
  'pending',
  'running',
  'paused',
  'manual',
  'submitted',
  'review',
  'success',
  'failed',
  'unverified',
  'cancelled',
];
class PublishingStore {
  constructor(directory) {
    fs.mkdirSync(directory, { recursive: true });
    this.directory = directory;
    this.file = path.join(directory, 'publishing.sqlite');
    this.db = new DatabaseSync(this.file);
    if (this.db.prepare('PRAGMA user_version').get().user_version > 1) {
      this.db.close();
      throw new Error('发布数据库来自更高版本，请使用原软件版本');
    }
    this.db
      .exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS schema_version(version INTEGER NOT NULL);
      INSERT INTO schema_version SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM schema_version);
      CREATE TABLE IF NOT EXISTS resources(id TEXT PRIMARY KEY,kind TEXT NOT NULL,data TEXT NOT NULL,created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS drafts(id TEXT PRIMARY KEY,data TEXT NOT NULL,updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS batches(id TEXT PRIMARY KEY,name TEXT NOT NULL,created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY,batch_id TEXT NOT NULL REFERENCES batches(id),account_id TEXT NOT NULL,
        platform_id TEXT NOT NULL,status TEXT NOT NULL,planned_at INTEGER NOT NULL,ordinal INTEGER NOT NULL,snapshot TEXT NOT NULL,
        checkpoint TEXT NOT NULL DEFAULT '{}',attempts INTEGER NOT NULL DEFAULT 0,result TEXT,updated_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS tasks_due ON tasks(status,planned_at,ordinal);
      CREATE TABLE IF NOT EXISTS logs(id INTEGER PRIMARY KEY AUTOINCREMENT,task_id TEXT NOT NULL REFERENCES tasks(id),time INTEGER NOT NULL,level TEXT NOT NULL,message TEXT NOT NULL);
      PRAGMA user_version=1;`);
    if (
      this.db.prepare('SELECT version FROM schema_version').get().version !== 1
    )
      throw new Error('发布数据库版本不受当前软件支持，请使用原版本并保留数据');
  }
  transaction(action) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = action();
      this.db.exec('COMMIT');
      return result;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }
  list(kind) {
    return this.db
      .prepare(
        'SELECT id,kind,data,created_at FROM resources WHERE kind=? ORDER BY created_at,id',
      )
      .all(kind)
      .map((r) => ({
        ...JSON.parse(r.data),
        id: r.id,
        kind: r.kind,
        createdAt: r.created_at,
      }));
  }
  resource(id, kind) {
    if (typeof id !== 'string' || !id || typeof kind !== 'string' || !kind)
      throw new Error('请选择有效的素材或封面资源');
    const r = this.db
      .prepare('SELECT * FROM resources WHERE id=? AND kind=?')
      .get(id, kind);
    if (!r) throw new Error('资源不存在');
    return { ...JSON.parse(r.data), id: r.id, kind: r.kind };
  }
  putResource(kind, data, id = randomUUID()) {
    this.db
      .prepare(
        'INSERT INTO resources VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data',
      )
      .run(id, kind, JSON.stringify(data), Date.now());
    return this.resource(id, kind);
  }
  removeResource(id) {
    return this.db.prepare('DELETE FROM resources WHERE id=?').run(id).changes;
  }
  saveDraft(data, id = 'current') {
    this.db
      .prepare(
        'INSERT INTO drafts VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at',
      )
      .run(id, JSON.stringify(data), Date.now());
    return id;
  }
  draft(id) {
    const r = this.db.prepare('SELECT * FROM drafts WHERE id=?').get(id);
    return r
      ? { id: r.id, data: JSON.parse(r.data), updatedAt: r.updated_at }
      : null;
  }
  drafts() {
    return this.db
      .prepare('SELECT * FROM drafts ORDER BY updated_at DESC')
      .all()
      .map((r) => ({
        id: r.id,
        data: JSON.parse(r.data),
        updatedAt: r.updated_at,
      }));
  }
  removeDraft(id) {
    this.db.prepare('DELETE FROM drafts WHERE id=?').run(id);
  }
  setting(key, fallback = null) {
    const r = this.db.prepare('SELECT data FROM settings WHERE key=?').get(key);
    return r ? JSON.parse(r.data) : fallback;
  }
  setSetting(key, data) {
    this.db
      .prepare(
        'INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET data=excluded.data',
      )
      .run(key, JSON.stringify(data));
  }
  tasks() {
    return this.db
      .prepare('SELECT * FROM tasks ORDER BY planned_at,ordinal,id')
      .all()
      .map((r) => this.decode(r));
  }
  decode(r) {
    return {
      ...JSON.parse(r.snapshot),
      id: r.id,
      batchId: r.batch_id,
      status: r.status,
      plannedAt: r.planned_at,
      ordinal: r.ordinal,
      checkpoint: JSON.parse(r.checkpoint),
      attempts: r.attempts,
      result: r.result ? JSON.parse(r.result) : null,
      updatedAt: r.updated_at,
    };
  }
  task(id) {
    const r = this.db.prepare('SELECT * FROM tasks WHERE id=?').get(id);
    if (!r) throw new Error('任务不存在');
    return this.decode(r);
  }
  addBatch(name, tasks, { clearDrafts = false } = {}) {
    return this.transaction(() => {
      const id = randomUUID();
      this.db
        .prepare('INSERT INTO batches VALUES(?,?,?)')
        .run(id, name, Date.now());
      for (const t of tasks)
        this.db
          .prepare(
            'INSERT INTO tasks(id,batch_id,account_id,platform_id,status,planned_at,ordinal,snapshot,updated_at) VALUES(?,?,?,?,?,?,?,?,?)',
          )
          .run(
            randomUUID(),
            id,
            t.accountId,
            t.platformId,
            t.cancelled ? 'cancelled' : 'pending',
            t.plannedAt,
            t.ordinal,
            JSON.stringify(t),
            Date.now(),
          );
      if (clearDrafts) this.clearDrafts();
      return id;
    });
  }
  setTask(id, patch) {
    const t = this.task(id);
    if (patch.status && !STATUSES.includes(patch.status))
      throw new Error('无效任务状态');
    this.db
      .prepare(
        'UPDATE tasks SET status=?,checkpoint=?,attempts=?,result=?,updated_at=? WHERE id=?',
      )
      .run(
        patch.status || t.status,
        JSON.stringify(patch.checkpoint || t.checkpoint),
        patch.attempts ?? t.attempts,
        JSON.stringify(
          Object.hasOwn(patch, 'result') ? patch.result : t.result,
        ),
        Date.now(),
        id,
      );
    return this.task(id);
  }
  log(id, message, level = 'info') {
    this.db
      .prepare('INSERT INTO logs(task_id,time,level,message) VALUES(?,?,?,?)')
      .run(id, Date.now(), level, String(message).slice(0, 2000));
    this.db
      .prepare(
        'DELETE FROM logs WHERE task_id=? AND id NOT IN (SELECT id FROM logs WHERE task_id=? ORDER BY id DESC LIMIT 1000)',
      )
      .run(id, id);
  }
  logs(id) {
    this.task(id);
    return this.db
      .prepare('SELECT * FROM logs WHERE task_id=? ORDER BY id DESC LIMIT 1000')
      .all(id)
      .reverse();
  }
  batches() {
    return this.db
      .prepare('SELECT * FROM batches ORDER BY created_at DESC')
      .all();
  }
  removeTasks(ids) {
    return this.transaction(() => {
      const tasks = ids.map((id) => this.task(id));
      const history = this.setting('deletedPublicationKeys', {});
      for (const t of tasks) {
        if (
          ['running', 'submitted', 'review', 'unverified'].includes(t.status) ||
          (t.checkpoint.submitIntent && t.status !== 'success')
        )
          throw new Error(
            '执行中任务请先暂停；已提交或结果待核实的任务请先核实结果',
          );
        if (t.status === 'success')
          history[`${t.accountId}:${t.video.sha256}`] = true;
      }
      this.setSetting('deletedPublicationKeys', history);
      for (const id of ids) {
        this.db.prepare('DELETE FROM logs WHERE task_id=?').run(id);
        this.db.prepare('DELETE FROM tasks WHERE id=?').run(id);
      }
      this.db.exec(
        'DELETE FROM batches WHERE NOT EXISTS (SELECT 1 FROM tasks WHERE tasks.batch_id=batches.id)',
      );
      return { removed: tasks.length };
    });
  }
  clearDrafts() {
    this.db.exec('DELETE FROM drafts');
    const ui = this.setting('ui', { page: 'video', scroll: {} });
    this.setSetting('ui', { ...ui, step: 0 });
  }
  recover(now = Date.now()) {
    this.transaction(() => {
      for (const t of this.tasks()) {
        if (['running', 'submitted'].includes(t.status)) {
          const unsure =
            t.checkpoint.submitIntent === true || t.status === 'submitted';
          this.setTask(t.id, {
            status: unsure ? 'unverified' : 'paused',
            result: {
              reason: unsure
                ? '程序退出前的提交结果不明确，需要核实，禁止自动重复提交'
                : '程序中断，任务已保留，请检查后继续',
            },
          });
          this.log(t.id, '重启恢复：保留任务快照，未自动重新提交', 'warning');
        } else if (t.status === 'pending' && t.plannedAt < now - 300000) {
          this.setTask(t.id, {
            status: 'paused',
            result: { reason: '已错过计划执行时间，请确认后继续' },
          });
          this.log(t.id, '错过执行时间，暂停等待确认', 'warning');
        }
      }
    });
  }
  backup(destination) {
    this.db.exec('PRAGMA wal_checkpoint(FULL)');
    const quoted = destination.replaceAll("'", "''");
    this.db.exec(`VACUUM INTO '${quoted}'`);
  }
  close() {
    this.db.close();
  }
}
module.exports = { PublishingStore, STATUSES };
