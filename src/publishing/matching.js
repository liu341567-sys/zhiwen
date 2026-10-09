'use strict';
const { randomInt } = require('node:crypto');
const shuffle = (items, random = (n) => randomInt(n)) => {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = random(i + 1);
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
};
function distribute(videoIds, accountIds, options = {}, random) {
  if (!videoIds.length || !accountIds.length)
    throw new Error('请选择视频和账号');
  if (
    new Set(videoIds).size !== videoIds.length ||
    new Set(accountIds).size !== accountIds.length
  )
    throw new Error('视频或账号不能重复选择');
  const pairs = [];
  const add = (videoId, accountId) =>
    pairs.push({ videoId, accountId, key: `${videoId}:${accountId}` });
  switch (options.mode || 'all') {
    case 'all':
      for (const video of videoIds)
        for (const account of accountIds) add(video, account);
      break;
    case 'sequence':
      videoIds.forEach((video, i) =>
        add(video, accountIds[i % accountIds.length]),
      );
      break;
    case 'random': {
      const available = shuffle(videoIds, random);
      if (options.quotas && Object.keys(options.quotas).length) {
        let offset = 0;
        for (const account of accountIds) {
          const amount = options.quotas[account] || 0;
          if (!Number.isInteger(amount) || amount < 0)
            throw new Error('随机分配数量必须为非负整数');
          if (offset + amount > available.length)
            throw new Error('账号数量配额总和超过素材数量');
          for (const video of available.slice(offset, offset + amount))
            add(video, account);
          offset += amount;
        }
        if (offset !== available.length)
          throw new Error('账号数量配额总和必须等于素材数量');
      } else
        available.forEach((video, i) =>
          add(video, accountIds[i % accountIds.length]),
        );
      break;
    }
    case 'manual':
      for (const video of videoIds)
        for (const account of options.manual?.[video] || []) {
          if (!accountIds.includes(account))
            throw new Error('手动分配包含未选择的账号');
          if (
            pairs.some(
              (pair) => pair.videoId === video && pair.accountId === account,
            )
          )
            throw new Error('手动分配不能重复');
          add(video, account);
        }
      if (
        videoIds.some((video) => !pairs.some((pair) => pair.videoId === video))
      )
        throw new Error('每条视频至少需要一个发布账号');
      break;
    default:
      throw new Error('不支持的分发模式');
  }
  if (pairs.length > 10000) throw new Error('单批次最多生成 10000 条任务');
  return pairs;
}
function assign(pairs, config, field, random) {
  const c = config || {},
    mode = c.mode || 'reuse',
    values = (c.values || [])
      .filter((v) => typeof v === 'string' && v.trim())
      .map((v) => v.trim());
  if (!['fixed', 'reuse', 'sequence', 'random'].includes(mode))
    throw new Error('无效的文案匹配模式');
  if (!['video', 'task'].includes(c.scope || 'video'))
    throw new Error('无效的匹配范围');
  const assigned = new Map();
  let index = 0,
    round = [];
  return pairs.map((pair) => {
    const locked = c.locks?.[pair.key] ?? c.locks?.[pair.videoId];
    if (locked !== undefined) {
      if (typeof locked !== 'string') throw new Error('锁定内容必须是文本');
      return { value: locked, locked: true };
    }
    const key = c.scope === 'task' ? pair.key : pair.videoId;
    if (!assigned.has(key)) {
      if (!values.length && field === 'title')
        throw new Error('请填写标题，或为每条视频设置固定标题');
      let value = '';
      if (mode === 'fixed') value = values[index] || '';
      else if (mode === 'reuse') value = values[0] || '';
      else if (mode === 'sequence') value = values[index % values.length] || '';
      else {
        if (!round.length) round = shuffle(values, random);
        value = round.shift() || '';
      }
      if (!value && field === 'title')
        throw new Error('单个固定模式需要为每个匹配项配置标题');
      assigned.set(key, value);
      index++;
    }
    return { value: assigned.get(key), locked: mode === 'fixed' };
  });
}
function times(pairs, config = {}, now = Date.now()) {
  const interval = config.intervalMinutes ?? 10;
  if (!Number.isFinite(interval) || interval < 1 || interval > 1440)
    throw new Error('账号最小间隔应为 1–1440 分钟');
  const gap = interval * 60000,
    last = new Map();
  if ((config.mode || 'now') === 'now')
    return pairs.map((pair) => {
      const time = Math.max(now, (last.get(pair.accountId) || now - gap) + gap);
      last.set(pair.accountId, time);
      return time;
    });
  if (config.mode === 'at') {
    const start = Date.parse(config.at);
    if (!Number.isFinite(start) || start < now - 60000)
      throw new Error('指定执行时间必须有效且不早于当前时间');
    return pairs.map((pair) => {
      const time = Math.max(
        start,
        (last.get(pair.accountId) || start - gap) + gap,
      );
      last.set(pair.accountId, time);
      return time;
    });
  }
  if (config.mode !== 'windows') throw new Error('无效的发布时间模式');
  if (!Array.isArray(config.windows) || !config.windows.length)
    throw new Error('请设置每天允许执行的时段');
  const toMinute = (text) => {
    if (!/^\d\d:\d\d$/.test(text)) throw new Error('时段格式应为 HH:mm');
    const [h, m] = text.split(':').map(Number);
    if (h > 23 || m > 59) throw new Error('无效的时段');
    return h * 60 + m;
  };
  const windows = config.windows
    .map((w) => {
      const start = toMinute(w.start),
        end = toMinute(w.end),
        quota = w.quota ?? 2;
      if (end <= start || !Number.isInteger(quota) || quota < 1 || quota > 100)
        throw new Error('时段结束应晚于开始，每账号时段配额应为 1–100');
      return { start, end, quota };
    })
    .sort((a, b) => a.start - b.start);
  if (windows.some((w, i) => i && w.start < windows[i - 1].end))
    throw new Error('发布时段不能重叠');
  const counts = new Map(),
    plan = [];
  for (const pair of pairs) {
    let found = null;
    const earliest = Math.max(
      now,
      (last.get(pair.accountId) || now - gap) + gap,
    );
    for (let day = 0; day < 366 && found === null; day++) {
      const date = new Date(earliest);
      date.setHours(0, 0, 0, 0);
      date.setDate(date.getDate() + day);
      for (const [i, w] of windows.entries()) {
        const start = new Date(date);
        start.setMinutes(w.start);
        const end = new Date(date);
        end.setMinutes(w.end);
        const key = `${pair.accountId}:${date.toISOString()}:${i}`,
          count = counts.get(key) || 0;
        const time = Math.max(start.getTime(), earliest);
        if (count < w.quota && time < end.getTime()) {
          found = time;
          counts.set(key, count + 1);
          break;
        }
      }
    }
    if (found === null)
      throw new Error('一年内无法容纳当前发布任务，请增加时段或配额');
    last.set(pair.accountId, found);
    plan.push(found);
  }
  return plan;
}
function generate(input, videos, accounts, random, now = Date.now()) {
  const pairs = distribute(
    input.videoIds,
    input.accountIds,
    input.distribution,
    random,
  );
  if (input.previewOrder) {
    const order = new Map(input.previewOrder.map((key, i) => [key, i]));
    pairs.sort((a, b) => (order.get(a.key) ?? 1e9) - (order.get(b.key) ?? 1e9));
  }
  const titles = assign(pairs, input.title, 'title', random),
    topics = assign(pairs, input.topics, 'topics', random),
    plan = times(pairs, input.schedule, now);
  return pairs.map((pair, index) => {
    const video = videos.find((v) => v.id === pair.videoId),
      account = accounts.find((a) => a.id === pair.accountId);
    if (!video || !account) throw new Error('素材或环境已被删除，请重新选择');
    const override = input.overrides?.[pair.key] || {};
    return {
      ...pair,
      platformId: account.platformId,
      video: structuredClone(video),
      accountName: account.name,
      title: titles[index].value,
      topics: topics[index].value,
      titleLocked: titles[index].locked,
      topicsLocked: topics[index].locked,
      cover: structuredClone(
        override.cover ||
          input.covers?.[pair.key] ||
          input.covers?.[pair.videoId] ||
          input.cover || { mode: 'first' },
      ),
      location: structuredClone(
        override.location ||
          input.locations?.[pair.key] ||
          input.locations?.[pair.videoId] ||
          input.location || { mode: 'none' },
      ),
      nativeSchedule: input.nativeSchedule || null,
      minIntervalMs: (input.schedule?.intervalMinutes ?? 10) * 60000,
      plannedAt: Number.isFinite(override.plannedAt)
        ? override.plannedAt
        : plan[index],
      ordinal: index,
      cancelled: override.cancelled === true,
      autoSubmit:
        typeof override.autoSubmit === 'boolean'
          ? override.autoSubmit
          : input.autoSubmit === true,
      locked: override.locked === true,
    };
  });
}
module.exports = { shuffle, distribute, assign, times, generate };
