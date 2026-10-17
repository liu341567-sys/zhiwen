'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const defaults = () => ({ intervalSeconds: 120, concurrency: 2, sound: true, systemNotifications: true,
  autoResume: false, enabled: false, selectedIds: null });
function config(input, previous = defaults()) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('监测设置无效');
  const next = { ...previous };
  for (const key of Object.keys(input)) {
    if (!Object.hasOwn(defaults(), key)) throw new Error('不支持的监测设置');
    const value = input[key];
    if (['sound', 'systemNotifications', 'autoResume', 'enabled'].includes(key)) {
      if (typeof value !== 'boolean') throw new Error('监测开关无效');
    } else if (key === 'intervalSeconds') {
      if (!Number.isInteger(value) || value < 30 || value > 3600) throw new Error('巡检间隔须为 30–3600 秒');
    } else if (key === 'concurrency') {
      if (!Number.isInteger(value) || value < 1 || value > 4) throw new Error('同时巡检数量须为 1–4');
    } else if (value !== null && (!Array.isArray(value) || value.length > 500 || value.some(id => typeof id !== 'string' || !id || id.length > 160))) {
      throw new Error('监测账号选择无效');
    }
    next[key] = key === 'selectedIds' && value ? [...new Set(value)] : value;
  }
  return next;
}

class MessageStore {
  constructor(directory) {
    fs.mkdirSync(directory, { recursive: true });
    this.db = new DatabaseSync(path.join(directory, 'messages.sqlite'));
    if (this.db.prepare('PRAGMA user_version').get().user_version > 1) { this.db.close(); throw new Error('私信数据库来自更高版本'); }
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS baselines(id TEXT PRIMARY KEY,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS results(id TEXT PRIMARY KEY,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS alerts(id INTEGER PRIMARY KEY AUTOINCREMENT,data TEXT NOT NULL,created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS diagnostics(id INTEGER PRIMARY KEY AUTOINCREMENT,environment_id TEXT NOT NULL,data TEXT NOT NULL,created_at INTEGER NOT NULL);
      PRAGMA user_version=1;`);
  }
  get(table, id, fallback = null) {
    if (!['settings', 'baselines', 'results'].includes(table)) throw new Error('监测记录类型无效');
    const row = this.db.prepare(`SELECT data FROM ${table} WHERE ${table === 'settings' ? 'key' : 'id'}=?`).get(id);
    return row ? JSON.parse(row.data) : fallback;
  }
  put(table, id, data) {
    if (!['settings', 'baselines', 'results'].includes(table)) throw new Error('监测记录类型无效');
    const key = table === 'settings' ? 'key' : 'id';
    this.db.prepare(`INSERT INTO ${table} VALUES(?,?) ON CONFLICT(${key}) DO UPDATE SET data=excluded.data`).run(id, JSON.stringify(data));
  }
  settings(input) {
    const previous = config(this.get('settings', 'monitor', {}));
    if (input === undefined) return previous;
    const next = config(input, previous); this.put('settings', 'monitor', next); return next;
  }
  transaction(action) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = action(); this.db.exec('COMMIT'); return value; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  diagnostic(id, data, now) {
    this.db.prepare('INSERT INTO diagnostics(environment_id,data,created_at) VALUES(?,?,?)').run(id, JSON.stringify(data), now);
    this.db.exec('DELETE FROM diagnostics WHERE id NOT IN (SELECT id FROM diagnostics ORDER BY id DESC LIMIT 200)');
  }
  diagnostics(id) {
    return this.db.prepare('SELECT data,created_at FROM diagnostics WHERE environment_id=? ORDER BY id DESC LIMIT 12').all(id)
      .map(row => ({ ...JSON.parse(row.data), time: row.created_at }));
  }
  recordAlert(data, now) {
    this.db.prepare('INSERT INTO alerts(data,created_at) VALUES(?,?)').run(JSON.stringify(data), now);
    this.db.exec('DELETE FROM alerts WHERE id NOT IN (SELECT id FROM alerts ORDER BY id DESC LIMIT 100)');
  }
  alerts() { return this.db.prepare('SELECT id,data,created_at FROM alerts ORDER BY id DESC LIMIT 20').all().map(row => ({ id: row.id, ...JSON.parse(row.data), time: row.created_at })); }
  prune(ids) {
    const valid = new Set(ids);
    for (const table of ['baselines', 'results']) for (const row of this.db.prepare(`SELECT id FROM ${table}`).all())
      if (!valid.has(row.id)) this.db.prepare(`DELETE FROM ${table} WHERE id=?`).run(row.id);
    for (const row of this.db.prepare('SELECT DISTINCT environment_id FROM diagnostics').all())
      if (!valid.has(row.environment_id)) this.db.prepare('DELETE FROM diagnostics WHERE environment_id=?').run(row.environment_id);
  }
  backup(destination) {
    this.db.exec('PRAGMA wal_checkpoint(FULL)');
    this.db.prepare('VACUUM INTO ?').run(destination);
  }
  close() { this.db.close(); }
}

// A badge delta never proves how many messages arrived: reads on another device
// can hide arrivals. Failed/capped samples never replace the reliable baseline.
function compareCount(previous, sample, now) {
  if (!Number.isSafeInteger(sample.unread) || sample.unread < 0 || sample.unread > 1000000 || sample.exact === false)
    return { baseline: previous, increase: null, newMessages: null, first: !previous, basis: 'unverified' };
  const comparable = previous && previous.unit === sample.unit;
  return { baseline: { unread: sample.unread, unit: sample.unit, checkedAt: now },
    increase: comparable ? Math.max(0, sample.unread - previous.unread) : 0,
    newMessages: null, first: !comparable, basis: 'count-estimate' };
}
module.exports = { MessageStore, defaults, config, compareCount };
