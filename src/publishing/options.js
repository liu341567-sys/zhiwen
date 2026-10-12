'use strict';
const ZONE = 'Asia/Shanghai';
function nativeSchedule(config, now = Date.now()) {
  if (config === null || config === undefined) return null;
  if (!config || typeof config !== 'object' || config.timezone !== ZONE ||
      typeof config.at !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(config.at))
    throw new Error('官方定时请填写完整日期时间（北京时间）');
  const at = Date.parse(config.at + '+08:00');
  if (!Number.isFinite(at) || new Date(at + 8 * 3600000).toISOString().slice(0, 16) !== config.at || at <= now)
    throw new Error('官方发布时间无效或已过期');
  return { at: config.at, timezone: ZONE };
}
const epoch = (config) => Date.parse(config.at + '+08:00');
function location(config) {
  if (!config || !['none', 'specified'].includes(config.mode)) throw new Error('无效定位配置');
  if (config.mode === 'none') return { mode: 'none' };
  const clean = (value, max) => {
    if (value === undefined) return '';
    if (typeof value !== 'string' || value.length > max) throw new Error('地点信息格式或长度不正确');
    return value.trim();
  };
  const label = clean(config.label, 200), address = clean(config.address, 400), query = clean(config.query, 200) || label;
  if (!label || !query) throw new Error('请填写准确地点名称和搜索词');
  let fallback;
  if (config.fallback !== undefined && config.fallback !== null) {
    if (typeof config.fallback !== 'object' || Array.isArray(config.fallback)) throw new Error('备选地点格式不正确');
    const label = clean(config.fallback.label, 200), address = clean(config.fallback.address, 400), query = clean(config.fallback.query, 200) || label;
    if (label || address || query) {
      if (!label || !address) throw new Error('备选地点请同时填写名称和完整地址');
      fallback = { label, address, query };
    }
  }
  return { mode: 'specified', label, address, query, ...(fallback ? { fallback } : {}) };
}
function nativePlans(pairs, config, now) {
  if (config === null || config === undefined) return pairs.map(() => null);
  if (config.mode === 'cycle') return cyclePlans(pairs, config, now);
  const base = nativeSchedule(config, now), gap = config.intervalMinutes ?? 10, counts = new Map();
  if (!Number.isInteger(gap) || gap < 1 || gap > 1440) throw new Error('官方定时间隔应为 1–1440 分钟');
  return pairs.map((pair) => {
    const count = counts.get(pair.accountId) || 0;
    counts.set(pair.accountId, count + 1);
    const at = epoch(base) + count * gap * 60000;
    return { at: new Date(at + 8 * 3600000).toISOString().slice(0, 16), timezone: ZONE };
  });
}
function cyclePlans(pairs, config, now = Date.now()) {
  if (config.timezone !== ZONE || !['daily', 'weekly'].includes(config.cadence) ||
      typeof config.startDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(config.startDate))
    throw new Error('循环定时请设置日循环或周循环、开始日期及北京时间');
  const start = Date.parse(config.startDate + 'T00:00:00+08:00');
  if (!Number.isFinite(start) || new Date(start + 8 * 3600000).toISOString().slice(0, 10) !== config.startDate)
    throw new Error('循环开始日期无效');
  if (!Array.isArray(config.times) || !config.times.length || config.times.length > 24 ||
      config.times.some((t) => typeof t !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(t)) || new Set(config.times).size !== config.times.length)
    throw new Error('每日发布时间请填写不重复的 HH:mm，每行一个，最多24个');
  const weekdays = config.cadence === 'daily' ? [1, 2, 3, 4, 5, 6, 7] : config.weekdays;
  if (!Array.isArray(weekdays) || !weekdays.length || weekdays.some((d) => !Number.isInteger(d) || d < 1 || d > 7) || new Set(weekdays).size !== weekdays.length)
    throw new Error('周循环请至少选择一个星期，且不能重复');
  const counts = new Map();
  for (const p of pairs) counts.set(p.accountId, (counts.get(p.accountId) || 0) + 1);
  const required = Math.max(0, ...counts.values()), slots = [], times = [...config.times].sort();
  const today = Date.parse(new Date(now + 8 * 3600000).toISOString().slice(0, 10) + 'T00:00:00+08:00');
  for (let day = Math.max(start, today), i = 0; slots.length < required && i < 3660; day += 86400000, i++) {
    const shanghai = new Date(day + 8 * 3600000);
    if (!weekdays.includes(shanghai.getUTCDay() || 7)) continue;
    const date = shanghai.toISOString().slice(0, 10);
    for (const time of times) {
      const slot = { at: `${date}T${time}`, timezone: ZONE };
      if (epoch(slot) > now) slots.push(slot);
      if (slots.length === required) break;
    }
  }
  if (slots.length < required) throw new Error('循环规则无法容纳当前视频，请调整日期及时间');
  const cursors = new Map();
  return pairs.map((p) => {
    const index = cursors.get(p.accountId) || 0; cursors.set(p.accountId, index + 1);
    return { ...slots[index] };
  });
}
module.exports = { ZONE, nativeSchedule, nativePlans, cyclePlans, epoch, location };
