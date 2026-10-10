'use strict';
const fs = require('node:fs'),
  path = require('node:path'),
  { randomUUID } = require('node:crypto'),
  { DatabaseSync } = require('node:sqlite');
const redact = (value) =>
  String(value ?? '')
    .slice(0, 4000)
    .replace(/(?:[A-Z]:\\|\\\\)[^\r\n<>"']+/gi, '[本地路径]')
    .replace(/\/(?:Users|home|workspace|tmp|var|mnt)\/[^\r\n<>"']+/g, '[本地路径]')
    .replace(
      /(?:bearer\s+|(?:password|passwd|cookie|token|secret|authorization|csrf|密码|令牌)\s*[:=]\s*)[^\s,;<>]+/gi,
      '[已脱敏]',
    )
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[邮箱]')
    .replace(/\b(?:\+?86[- ]?)?1[3-9]\d{9}\b/g, '[手机号]')
    .replace(/\b(?:[a-f0-9]{24,}|[A-Za-z0-9_+/=-]{32,})\b/gi, '[不透明标识]')
    .replace(/https?:\/\/[^\s<>"']+/gi, (value) => {
      try {
        const u = new URL(value);
        return (
          u.origin +
          u.pathname.replace(/[a-f0-9]{24,}|[A-Za-z0-9_-]{32,}/gi, '[标识]')
        );
      } catch {
        return '[网址]';
      }
    });
function scrub(value) {
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .filter(
          ([k]) =>
            ![
              'password',
              'cookie',
              'cookies',
              'token',
              'authorization',
              'value',
              'innerhtml',
              'outerhtml',
              'storage',
              'headers',
              'src',
              'filepath',
            ].includes(k.toLowerCase()),
        )
        .map(([k, v]) => [
          k,
          [
            'id',
            'beforeId',
            'afterId',
            'snapshotId',
            'stepId',
            'taskId',
          ].includes(k) &&
          typeof v === 'string' &&
          /^[0-9a-f-]{36}$/.test(v)
            ? v
            : scrub(v),
        ]),
    );
  return value;
}
// Stable locator paths survive fresh documents, unlike the runtime node IDs.
function compare(before, after) {
  const key = (frame, node) =>
    JSON.stringify([frame.key, node.roots, node.selector]);
  const collect = (s) =>
    new Map(
      (s?.frames || []).flatMap((f) =>
        (f.nodes || []).map((n) => [key(f, n), { frame: f.key, ...n }]),
      ),
    );
  const a = collect(before),
    b = collect(after),
    changes = [];
  const attrs = (n) =>
    JSON.stringify([
      n.tag,
      n.attributes,
      n.text,
      n.visible,
      n.enabled,
      n.clickable,
    ]);
  for (const [k, n] of a) {
    const next = b.get(k);
    if (!next) changes.push({ kind: 'removed', before: n });
    else if (attrs(n) !== attrs(next))
      changes.push({ kind: 'changed', before: n, after: next });
  }
  for (const [k, n] of b)
    if (!a.has(k)) changes.push({ kind: 'added', after: n });
  return {
    beforeId: before?.id,
    afterId: after?.id,
    urlChanged: before?.frames?.[0]?.url !== after?.frames?.[0]?.url,
    changes: changes
      .slice(0, 100)
      .map((c) =>
        Object.fromEntries(
          Object.entries(c).map(([k, v]) => [
            k,
            k === 'kind'
              ? v
              : Object.fromEntries(
                  [
                    'frame',
                    'tag',
                    'selector',
                    'roots',
                    'attributes',
                    'text',
                    'visible',
                    'enabled',
                    'clickable',
                  ].map((a) => [a, v[a]]),
                ),
          ]),
        ),
      ),
    total: changes.length,
    truncated: changes.length > 100,
  };
}
class DeveloperStore {
  constructor(directory) {
    this.directory = directory;
    fs.mkdirSync(directory, { recursive: true });
    this.db = new DatabaseSync(path.join(directory, 'developer.sqlite'));
    this.db.exec(
      'PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS reports(id TEXT PRIMARY KEY,updated INTEGER NOT NULL,data TEXT NOT NULL)',
    );
  }
  list() {
    return this.db
      .prepare(
        "SELECT id,updated,json_extract(data,'$.name') AS name,json_extract(data,'$.status') AS status,json_array_length(data,'$.steps') AS steps,json_array_length(data,'$.snapshots') AS snapshots FROM reports ORDER BY updated DESC",
      )
      .all();
  }
  get(id) {
    if (typeof id !== 'string') throw new Error('报告标识无效');
    const row = this.db.prepare('SELECT data FROM reports WHERE id=?').get(id);
    if (!row) throw new Error('报告不存在');
    return JSON.parse(row.data);
  }
  create(accountId, options = {}) {
    const d = {
      schemaVersion: 1,
      id: randomUUID(),
      accountId,
      name:
        '网页调试 ' +
        new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }),
      createdAt: Date.now(),
      endedAt: null,
      status: 'ready',
      options,
      steps: [],
      snapshots: [],
      scripts: [],
      warnings: [],
      screenshots: [],
    };
    this.save(d);
    return d;
  }
  save(d) {
    if (!d || typeof d.id !== 'string') throw new Error('报告格式无效');
    const str = JSON.stringify(d);
    if (Buffer.byteLength(str) > 24 * 1024 * 1024)
      throw new Error('报告已达 24 MB，请结束并新建录制');
    this.db
      .prepare(
        'INSERT INTO reports VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET updated=excluded.updated,data=excluded.data',
      )
      .run(d.id, Date.now(), str);
  }
  remove(id) {
    this.get(id);
    this.db.prepare('DELETE FROM reports WHERE id=?').run(id);
  }
  recover() {
    for (const row of this.list()) {
      const d = this.get(row.id);
      if (['recording', 'paused'].includes(d.status)) {
        d.status = 'interrupted';
        d.endedAt = Date.now();
        d.warnings.push(
          '软件上次退出时录制未结束，已有资料已保留，未自动恢复网页监听。',
        );
        this.save(d);
      }
    }
  }
  close() {
    this.db.close();
  }
}
module.exports = { DeveloperStore, compare, redact, scrub };
