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
  return { mode: 'specified', label, address, query };
}
function nativePlans(pairs, config, now) {
  if (config === null || config === undefined) return pairs.map(() => null);
  const base = nativeSchedule(config, now), gap = config.intervalMinutes ?? 10, counts = new Map();
  if (!Number.isInteger(gap) || gap < 1 || gap > 1440) throw new Error('官方定时间隔应为 1–1440 分钟');
  return pairs.map((pair) => {
    const count = counts.get(pair.accountId) || 0;
    counts.set(pair.accountId, count + 1);
    const at = epoch(base) + count * gap * 60000;
    return { at: new Date(at + 8 * 3600000).toISOString().slice(0, 16), timezone: ZONE };
  });
}
module.exports = { ZONE, nativeSchedule, nativePlans, epoch, location };
