'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { definitions, validMetric, growth } = require('./model');
const defaults = () => ({ intervalSeconds: 1800, concurrency: 2, selectedIds: null, platformOverrides: {}, enabled: false, autoResume: false });
function config(input, previous = defaults()) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('采集设置无效');
  const result = { ...previous };
  for (const [key,value] of Object.entries(input)) {
    if (!Object.hasOwn(defaults(), key)) throw new Error('不支持的采集设置');
    if (['enabled','autoResume'].includes(key) && typeof value !== 'boolean') throw new Error('采集开关无效');
    if (key === 'intervalSeconds' && (!Number.isInteger(value) || value < 300 || value > 86400)) throw new Error('采集间隔须为 5 分钟至 24 小时');
    if (key === 'concurrency' && (!Number.isInteger(value) || value < 1 || value > 4)) throw new Error('采集并发须为 1–4');
    if (key === 'selectedIds' && value !== null && (!Array.isArray(value) || value.length > 1000 || value.some(id => typeof id !== 'string' || !/^[\w-]{1,160}$/.test(id)))) throw new Error('采集账号无效');
    if (key === 'platformOverrides' && (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > 1000 || Object.entries(value).some(([id,p]) => !/^[\w-]{1,160}$/.test(id) || p !== 'douyin'))) throw new Error('采集平台无效');
    result[key] = key === 'selectedIds' && value ? [...new Set(value)] : value;
  }
  return result;
}
class AnalyticsStore {
  constructor(directory) {
    fs.mkdirSync(directory, { recursive: true }); this.db = new DatabaseSync(path.join(directory, 'analytics.sqlite'));
    if (this.db.prepare('PRAGMA user_version').get().user_version > 1) { this.db.close(); throw new Error('运营数据库来自更高版本'); }
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS definitions(key TEXT PRIMARY KEY,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS accounts(id TEXT PRIMARY KEY,platform TEXT NOT NULL,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS snapshots(id INTEGER PRIMARY KEY,environment TEXT NOT NULL,work TEXT NOT NULL DEFAULT '',at INTEGER NOT NULL,data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS snapshot_lookup ON snapshots(environment,work,at);
      CREATE TABLE IF NOT EXISTS works(environment TEXT NOT NULL,id TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(environment,id));
      CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY,environment TEXT NOT NULL,at INTEGER NOT NULL,data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS task_lookup ON tasks(environment,at);
      PRAGMA user_version=1;`);
    for (const [key,value] of Object.entries(definitions)) this.db.prepare('INSERT OR REPLACE INTO definitions VALUES(?,?)').run(key,JSON.stringify(value));
    for (const t of this.tasks()) if (['pending','running','busy'].includes(t.status)) this.task({ ...t, status: 'manual', reason: '上次运行中断，请重新检查账号后重试', endedAt: Date.now() });
  }
  settings(input) { const old = config(JSON.parse(this.db.prepare("SELECT data FROM settings WHERE key='collector'").get()?.data || '{}')); if (input === undefined) return old; const next = config(input, old); this.db.prepare("INSERT OR REPLACE INTO settings VALUES('collector',?)").run(JSON.stringify(next)); return next; }
  transaction(action) { this.db.exec('BEGIN IMMEDIATE'); try { const result = action(); this.db.exec('COMMIT'); return result; } catch(e) { this.db.exec('ROLLBACK'); throw e; } }
  task(t) { this.db.prepare('INSERT OR REPLACE INTO tasks VALUES(?,?,?,?)').run(t.id,t.environmentId,t.createdAt,JSON.stringify(t)); return t; }
  tasks() { return this.db.prepare('SELECT data FROM tasks ORDER BY at DESC,id DESC LIMIT 10000').all().map(r=>JSON.parse(r.data)); }
  account(id) { const row = this.db.prepare('SELECT data FROM accounts WHERE id=?').get(id); return row ? JSON.parse(row.data) : null; }
  history(id, work = '', end = Number.MAX_SAFE_INTEGER) { return this.db.prepare('SELECT at,data FROM snapshots WHERE environment=? AND work=? AND at<=? ORDER BY at,id').all(id,work,end).map(r=>({at:r.at,...JSON.parse(r.data)})); }
  works() { return this.db.prepare('SELECT data FROM works').all().map(r=>JSON.parse(r.data)); }
  save(profile, sample, task, at) {
    // Reject malformed adapter data before touching any historical record.
    const normalize = (data, scope) => Object.fromEntries(Object.entries(data || {}).filter(([key,m]) => definitions[key]?.scope === scope && validMetric(key,m)));
    const metrics = normalize(sample.metrics, 'account'), works = (sample.works || []).slice(0,500).filter(w=>/^\d{6,30}$/.test(w.id) && typeof w.title === 'string' && w.title.length <= 500);
    return this.transaction(() => {
      const previous = this.account(profile.id);
      const record = { environmentId: profile.id, platformId: profile.platformId, name: profile.name, metrics: { ...(previous?.metrics || {}), ...metrics }, checkedAt: at, status: sample.status, reason: sample.reason || '', lastSuccessAt: Object.keys(metrics).length || works.length ? at : previous?.lastSuccessAt || null, workCoverage: sample.workCoverage || 'unknown', diagnostic: sample.diagnostic || null };
      this.db.prepare('INSERT OR REPLACE INTO accounts VALUES(?,?,?)').run(profile.id,profile.platformId,JSON.stringify(record));
      if (Object.keys(metrics).length) this.db.prepare('INSERT INTO snapshots(environment,at,data) VALUES(?,?,?)').run(profile.id,at,JSON.stringify({metrics}));
      for (const w of works) {
        const wm = normalize(w.metrics,'work'), old = this.db.prepare('SELECT data FROM works WHERE environment=? AND id=?').get(profile.id,w.id);
        const prior = old ? JSON.parse(old.data) : {};
        const work = { ...prior, environmentId:profile.id, platformId:profile.platformId, id:w.id,title:w.title, url:`https://www.douyin.com/video/${w.id}`, publishedAt: Number.isSafeInteger(w.publishedAt) ? w.publishedAt : prior.publishedAt || null, metrics:{...(prior.metrics || {}),...wm}, checkedAt:at, status:Object.keys(wm).length ? 'success' : 'partial', source:'https://creator.douyin.com/creator-micro/content/manage', localMaterialId:prior.localMaterialId || null,publishingTaskId:prior.publishingTaskId || null };
        this.db.prepare('INSERT OR REPLACE INTO works VALUES(?,?,?)').run(profile.id,w.id,JSON.stringify(work));
        if (Object.keys(wm).length) this.db.prepare('INSERT INTO snapshots(environment,work,at,data) VALUES(?,?,?,?)').run(profile.id,w.id,at,JSON.stringify({metrics:wm}));
      }
      this.task({...task,status:sample.status,endedAt:at,reason:sample.reason || '',metricCount:Object.keys(metrics).length + works.reduce((n,w)=>n+Object.keys(normalize(w.metrics,'work')).length,0),workCount:works.length});
      return record;
    });
  }
  rows(profiles, f) {
    return profiles.filter(p=>(!f.ids || f.ids.includes(p.id)) && (!f.platformId || p.platformId===f.platformId) && (!f.search || p.name.toLocaleLowerCase().includes(f.search.toLocaleLowerCase()))).map(p=>{
      const stored = this.account(p.id), metrics = {};
      const latest = (key,at) => { const row=this.db.prepare("SELECT json_extract(data,?) AS metric FROM snapshots WHERE environment=? AND work='' AND at<=? AND json_type(data,?)='object' ORDER BY at DESC,id DESC LIMIT 1").get('$.metrics.'+key,p.id,at,'$.metrics.'+key); return row?JSON.parse(row.metric):null; };
      for (const key of Object.keys(definitions).filter(k=>definitions[k].scope==='account')) {
        let m;
        if(definitions[key].kind==='period'){
          const prefix='$.metrics.'+key,row=this.db.prepare("SELECT json_extract(data,?) AS metric FROM snapshots WHERE environment=? AND work='' AND json_extract(data,?)=? AND json_extract(data,?)=? ORDER BY at DESC,id DESC LIMIT 1").get(prefix,p.id,prefix+'.period.start',f.start,prefix+'.period.end',f.end);m=row?JSON.parse(row.metric):null;
        }else m=stored?.checkedAt<=f.end?stored.metrics?.[key]:latest(key,f.end);
        if(m)metrics[key]=m;
      }
      const history=[];for(const key of ['followers','works']){const before=latest(key,f.start),after=metrics[key];if(before)history.push({metrics:{[key]:before}});if(after)history.push({metrics:{[key]:after}});}
      return { ...stored, id:p.id, environmentId:p.id, name:p.name, platformId:p.platformId || null, supported:p.platformId === 'douyin', status:p.platformId !== 'douyin' ? 'unsupported' : stored?.status || 'never', metrics, growth:growth(history,'followers',f.start,f.end), worksChange:growth(history,'works',f.start,f.end) };
    }).filter(r=>!f.status || r.status===f.status).sort((a,b)=>f.sort==='name' ? a.name.localeCompare(b.name,'zh') : f.sort==='growth' ? (b.growth?.value ?? -Infinity)-(a.growth?.value ?? -Infinity) : f.sort==='followers' ? (b.metrics.followers?.value ?? -1)-(a.metrics.followers?.value ?? -1) : (b.checkedAt || 0)-(a.checkedAt || 0));
  }
  backup(destination) { if (fs.existsSync(destination)) throw new Error('请使用新的备份文件名'); this.db.prepare('VACUUM INTO ?').run(destination); }
  deleteTasks(ids) { return this.transaction(()=>{ for (const t of this.tasks()) if(ids.includes(t.id)) { if(['pending','running','busy'].includes(t.status))throw new Error('请先取消正在执行的采集任务');this.db.prepare('DELETE FROM tasks WHERE id=?').run(t.id); } }); }
  close() { this.db.close(); }
}
module.exports = { AnalyticsStore, config, defaults };
