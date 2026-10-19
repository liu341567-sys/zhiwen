'use strict';
// Definitions describe the numbers actually visible on the official page.
// A stock (累计) is never relabelled as traffic earned during a date range.
const definitions = {
  followers: { label: '粉丝总数', unit: '人', scope: 'account', basis: 'douyin:followers:stock', kind: 'stock' },
  works: { label: '作品总数', unit: '个', scope: 'account', basis: 'douyin:works:stock', kind: 'stock' },
  likes: { label: '获赞总数', unit: '次', scope: 'account', basis: 'douyin:likes:stock', kind: 'stock' },
  plays: { label: '播放量', unit: '次', scope: 'work', basis: 'douyin:video-plays:stock', kind: 'stock' },
  workLikes: { label: '点赞量', unit: '次', scope: 'work', basis: 'douyin:video-likes:stock', kind: 'stock' },
  comments: { label: '评论量', unit: '次', scope: 'work', basis: 'douyin:video-comments:stock', kind: 'stock' },
  favorites: { label: '收藏量', unit: '次', scope: 'work', basis: 'douyin:video-favorites:stock', kind: 'stock' },
  shares: { label: '分享量', unit: '次', scope: 'work', basis: 'douyin:video-shares:stock', kind: 'stock' },
  periodPlays: { label: '周期播放量', unit: '次', scope: 'account', basis: 'douyin:account-plays:period', kind: 'period' },
  periodLikes: { label: '周期点赞量', unit: '次', scope: 'account', basis: 'douyin:account-likes:period', kind: 'period' },
  periodComments: { label: '周期评论量', unit: '次', scope: 'account', basis: 'douyin:account-comments:period', kind: 'period' },
  periodFavorites: { label: '周期收藏量', unit: '次', scope: 'account', basis: 'douyin:account-favorites:period', kind: 'period' },
  periodShares: { label: '周期分享量', unit: '次', scope: 'account', basis: 'douyin:account-shares:period', kind: 'period' },
};
const statusLabels = { pending: '待执行', running: '执行中', success: '采集成功', partial: '部分成功', failed: '采集失败', manual: '需要人工处理', cancelled: '已取消', busy: '等待账号空闲', unsupported: '暂未支持', never: '尚未采集' };
function count(raw) {
  const text = String(raw ?? '').trim().replace(/[,，\s]/g, '');
  if (!/^\d+(?:\.\d+)?(?:万|亿|[wWkK])?$/.test(text)) return null;
  const suffix = text.match(/[万亿wWkK]$/)?.[0];
  const value = Number.parseFloat(text) * (suffix === '亿' ? 1e8 : /[万wW]/.test(suffix || '') ? 1e4 : /[kK]/.test(suffix || '') ? 1e3 : 1);
  if (!Number.isSafeInteger(value) || value < 0) return null;
  return { value, precision: suffix ? 'rounded' : 'exact', displayed: text };
}
function metric(key, raw, source, collectedAt, period = 'lifetime') {
  const parsed = count(raw), definition = definitions[key];
  return parsed && definition ? { ...parsed, ...definition, source, collectedAt, officialUpdatedAt: null, period, status: 'available' } : null;
}
function validMetric(key, m) {
  const d = definitions[key];
  if (!d || !m || !Number.isSafeInteger(m.value) || m.value < 0 || !Number.isSafeInteger(m.collectedAt) || !['exact', 'rounded'].includes(m.precision) || m.basis !== d.basis || m.unit !== d.unit) return false;
  if (d.kind === 'stock' ? m.period !== 'lifetime' : !m.period || !Number.isSafeInteger(m.period.start) || !Number.isSafeInteger(m.period.end) || m.period.end < m.period.start || m.period.end > m.collectedAt + 86400000 || m.period.start < 0 || m.period.timezone !== 'Asia/Shanghai') return false;
  try { const u = new URL(m.source); return u.origin === 'https://creator.douyin.com' && ['/creator-micro/home','/creator-micro/content/manage','/creator-micro/data-center/operation'].includes(u.pathname) && !u.search && !u.hash && !u.username && !u.password; } catch { return false; }
}
function filters(input = {}, now = Date.now()) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('数据筛选无效');
  const start = input.start == null ? now - 7 * 86400000 : Number(input.start), end = input.end == null ? now : Number(input.end);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end > now + 86400000 || end - start > 10 * 366 * 86400000) throw new Error('统计时间范围无效');
  const ids = input.ids == null ? null : input.ids;
  if (ids !== null && (!Array.isArray(ids) || ids.length > 1000 || ids.some(id => typeof id !== 'string' || !/^[\w-]{1,160}$/.test(id)))) throw new Error('账号筛选无效');
  const page = input.page == null ? 1 : Number(input.page);
  if (!Number.isInteger(page) || page < 1 || page > 100000) throw new Error('分页无效');
  return { start, end, ids, platformId: typeof input.platformId === 'string' ? input.platformId.slice(0,80) : '', search: typeof input.search === 'string' ? input.search.slice(0,200) : '', status: typeof input.status === 'string' ? input.status.slice(0,30) : '', sort: ['name','followers','growth','time','plays','workLikes','comments','favorites','shares','publishedAt'].includes(input.sort) ? input.sort : 'time', page, pageSize: 50 };
}
function growth(history, key, start, end) {
  const valid = history.map(s => s.metrics?.[key]).filter(m => m?.precision === 'exact' && m.collectedAt <= end).sort((a,b) => a.collectedAt - b.collectedAt);
  const baseline = valid.filter(m => m.collectedAt <= start).at(-1), latest = valid.at(-1);
  if (!baseline || !latest || latest.collectedAt <= start || baseline.basis !== latest.basis || baseline.unit !== latest.unit) return null;
  return { value: latest.value - baseline.value, from: baseline.collectedAt, to: latest.collectedAt, basis: latest.basis, unit: latest.unit, note: '有效快照差；非平台日统计，包含取消关注或作品删除等变化' };
}
function aggregate(rows, key) {
  const values = rows.map(r => r.metrics?.[key]);
  if (!values.length || values.some(m => !m || m.precision !== 'exact') || new Set(values.map(m => m.basis)).size !== 1 || new Set(values.map(m => JSON.stringify(m.period))).size !== 1) return { value: null, available: values.filter(Boolean).length, total: rows.length };
  return { value: values.reduce((sum,m) => sum + m.value, 0), available: values.length, total: rows.length, basis: values[0].basis, unit: values[0].unit };
}
function safeCell(value) { const text = String(value ?? '暂无数据'); return /^[=+\-@\t\r\n]/.test(text) ? `'${text}` : text; }
function csv(rows) { return '\ufeff' + rows.map(row => row.map(v => `"${safeCell(v).replace(/"/g, '""')}"`).join(',')).join('\r\n'); }
module.exports = { definitions, statusLabels, count, metric, validMetric, filters, growth, aggregate, safeCell, csv };
