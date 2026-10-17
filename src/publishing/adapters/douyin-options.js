'use strict';
const { randomUUID } = require('node:crypto');
const config = require('../options');
const fail = (message) => { throw Object.assign(new Error(message), { manual: true }); };
// This function runs in the original account page. It exposes only option
// state/candidates, never authentication or private storage.
function probe(input = {}) {
  input ||= {};
  if (input.action === 'cleanup') {
    if (input.owner && globalThis.__qiyeOptionOwner !== input.owner) return { released: false };
    globalThis.__qiyePOIWatch?.observer.disconnect(); delete globalThis.__qiyePOIWatch;
    if (globalThis.__qiyePOIGuard) {
      for (const type of ['click', 'input', 'change']) document.removeEventListener(type, globalThis.__qiyePOIGuard.listener, true);
      delete globalThis.__qiyePOIGuard;
    }
    document.querySelectorAll('[data-qiye-poi-root],[data-qiye-poi-input],[data-qiye-option]').forEach((e) => { e.removeAttribute('data-qiye-poi-root'); e.removeAttribute('data-qiye-poi-input'); e.removeAttribute('data-qiye-option'); });
    delete globalThis.__qiyeOptionOwner;
    return { released: true };
  }
  if (location.protocol !== 'https:' || location.hostname !== 'creator.douyin.com' ||
      location.pathname !== '/creator-micro/content/post/video') return { unavailable: true };
  if (input.action === 'begin') {
    globalThis.__qiyePOIWatch?.observer.disconnect(); delete globalThis.__qiyePOIWatch;
    globalThis.__qiyeOptionOwner = input.owner;
  }
  const visible = (e) => { const r = e?.getBoundingClientRect(); return !!r && r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden' && getComputedStyle(e).display !== 'none'; };
  const normal = (v) => String(v || '').replace(/\s+/g, ' ').trim();
  const labels = [...document.querySelectorAll('label')].filter((e) => visible(e) && normal(e.textContent) === '定时发布');
  const toggle = labels.length === 1 ? labels[0] : null, checkbox = toggle?.querySelector('input[type=checkbox],input[type=radio]');
  const fields = [...document.querySelectorAll('input[placeholder="日期和时间"]')].filter(visible);
  const field = fields.length === 1 ? fields[0] : null;
  const parts = (field?.value || '').trim().match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})[ T](\d{1,2}):(\d{2})(?::00)?$/);
  const fieldTime = parts ? `${parts[1]}-${parts[2].padStart(2, '0')}-${parts[3].padStart(2, '0')} ${parts[4].padStart(2, '0')}:${parts[5]}` : '';
  const popups = [...document.querySelectorAll('.semi-datepicker-month-grid')].filter(visible);
  const popup = popups.length === 1 ? popups[0] : null;
  const date = normal(popup?.querySelector('.semi-datepicker-switch-date')?.textContent),
    time = normal(popup?.querySelector('.semi-datepicker-switch-time')?.textContent);
  const nav = normal(popup?.querySelector('.semi-datepicker-navigation')?.textContent).match(/(\d{4})年\s*(\d{1,2})月/);
  const policy = document.body.innerText.match(/支持\s*(\d+)\s*小时后及\s*(\d+)\s*天内的定时发布/);
  const mark = (e, name) => { document.querySelectorAll(`[data-qiye-option="${name}"]`).forEach((n) => n.removeAttribute('data-qiye-option')); if (e) e.setAttribute('data-qiye-option', name); };
  mark(toggle, 'scheduled'); mark(field, 'datetime');
  if (input.action === 'day') {
    const days = [...(popup?.querySelectorAll('.semi-datepicker-day') || [])].filter((e) => visible(e) && normal(e.textContent) === String(input.day) && !e.classList.contains('semi-datepicker-day-disabled'));
    mark(days.length === 1 ? days[0] : null, 'day');
  }
  if (input.action === 'month') {
    const buttons = [...(popup?.querySelectorAll('button') || [])].filter((e) => visible(e) && !e.disabled && e.querySelector(input.direction === 'left' ? '.semi-icons-chevron_left' : '.semi-icons-chevron_right'));
    mark(buttons.length === 1 ? buttons[0] : null, 'month');
  }
  if (input.action === 'clock') mark(popup?.querySelector('.semi-datepicker-switch-time'), 'clock');
  if (input.action === 'wheel') {
    const wheels = [...document.querySelectorAll(`.semi-scrolllist-item-wheel.undefined-list-${input.kind}`)].filter(visible);
    const wheel = wheels.length === 1 ? wheels[0] : null, outer = wheel?.querySelector('.semi-scrolllist-list-outer');
    const r = outer?.getBoundingClientRect();
    const rows = [...(wheel?.querySelectorAll('li') || [])].filter((e) => normal(e.textContent).replace(/[时分]/g, '') === String(input.number).padStart(2, '0') && !/disabled/.test(e.className))
      .map((e) => ({ e, distance: Math.abs(e.getBoundingClientRect().y + e.getBoundingClientRect().height / 2 - (r?.y + r?.height / 2)) })).sort((a, b) => a.distance - b.distance);
    mark(rows.length && Number.isFinite(rows[0].distance) && (!rows[1] || rows[1].distance - rows[0].distance > 1) ? rows[0].e : null, 'wheel');
  }
  const roots = [...document.querySelectorAll('.semi-select-filterable.semi-select-no-arrow')].filter((e) => visible(e) && e.querySelector('.semi-select-selection-text'));
  const root = roots.length === 1 ? roots[0] : null;
  document.querySelectorAll('[data-qiye-poi-root]').forEach((e) => { if (e !== root) e.removeAttribute('data-qiye-poi-root'); });
  if (root) root.setAttribute('data-qiye-poi-root', 'true');
  // The recording opens the selection text, not its clear icon or adjacent
  // location-type menu. Keep that exact target separate from the search input.
  const openers = [...(root?.querySelectorAll('.semi-select-selection-text') || [])].filter(visible);
  mark(openers.length === 1 ? openers[0] : null, 'poi-open');
  document.querySelectorAll('[data-qiye-poi-input]').forEach((e) => e.removeAttribute('data-qiye-poi-input'));
  const inputs = [...(root?.querySelectorAll('input:not([type=hidden])') || [])]
    .filter((e) => visible(e) && !e.disabled && !e.readOnly);
  const search = inputs.length === 1 ? inputs[0] : null;
  if (search) search.setAttribute('data-qiye-poi-input', 'true');
  const candidates = [...document.querySelectorAll('[role=option]')].filter(visible).map((e) => ({
    e, name: normal(e.querySelector('[class^="name-"],[class*=" name-"]')?.textContent),
    address: normal(e.querySelector('[class^="address-"],[class*=" address-"]')?.textContent),
  })).filter((c) => c.name && c.address);
  if (input.action === 'watch') {
    globalThis.__qiyePOIWatch?.observer.disconnect();
    const watch = { token: input.token, version: 0, changedAt: Date.now() };
    watch.observer = new MutationObserver((records) => {
      if (records.some((r) => r.target.parentElement?.closest('[role=option],.semi-select-option-list') ||
          (r.target.nodeType === 1 && r.target.closest?.('[role=option],.semi-select-option-list,.semi-select-dropdown')) ||
          [...r.addedNodes, ...r.removedNodes].some((n) => n.nodeType === 1 && (n.matches?.('[role=option]') || n.querySelector?.('[role=option]'))))) {
        watch.version++; watch.changedAt = Date.now();
      }
    });
    watch.observer.observe(document.body, { subtree: true, childList: true, characterData: true,
      attributes: true, attributeFilter: ['hidden', 'aria-busy', 'aria-selected', 'style', 'class'] });
    globalThis.__qiyePOIWatch = watch;
  }
  if (input.action === 'pick-poi') {
    const matches = candidates.filter((c) => c.name === input.name && (!input.address || c.address === input.address));
    mark(matches.length === 1 ? matches[0].e : null, 'poi');
  }
  if (input.action === 'guard-poi') {
    if (globalThis.__qiyePOIGuard) for (const type of ['click', 'input', 'change']) document.removeEventListener(type, globalThis.__qiyePOIGuard.listener, true);
    const guard = { root, name: input.name, address: input.address, dirty: false };
    guard.listener = (event) => { const e = event.target?.nodeType === 1 ? event.target : event.target?.parentElement;
      if (root?.contains(e) || e?.closest('[role=option]')?.querySelector('[class^="address-"],[class*=" address-"]')) guard.dirty = true;
    };
    for (const type of ['click', 'input', 'change']) document.addEventListener(type, guard.listener, true);
    globalThis.__qiyePOIGuard = guard;
  }
  const watch = globalThis.__qiyePOIWatch;
  const guard = globalThis.__qiyePOIGuard;
  return { unavailable: false, scheduled: !!checkbox?.checked, toggle: !!toggle && !checkbox?.disabled,
    field: !!field, fieldEditable: !!field && !field.readOnly && !field.disabled, fieldValue: field?.value || '', fieldTime, date, time,
    month: nav ? `${nav[1]}-${nav[2].padStart(2, '0')}` : null,
    policy: policy ? { hours: Number(policy[1]), days: Number(policy[2]) } : null,
    marked: !!document.querySelector(`[data-qiye-option="${input.action === 'pick-poi' ? 'poi' : input.action === 'wheel' ? 'wheel' : input.action}"]`),
    poiRoot: !!root, poiInput: !!search, query: search?.value || '',
    selected: normal(root?.querySelector('.semi-select-selection-text')?.textContent),
    poiGuard: guard ? { name: guard.name, address: guard.address, valid: !guard.dirty && guard.root === root } : null,
    candidates: candidates.map(({ name, address }) => ({ name, address })),
    watch: watch ? { token: watch.token, version: watch.version, quietMs: Date.now() - watch.changedAt } : null,
    loading: [...document.querySelectorAll('.semi-select-dropdown .semi-spin-spinning')].some(visible) };
}
const read = (page, input) => page.evaluate(probe, input);
const until = (page, predicate, input, timeout = 15000) => page.wait(new Function('input', `const s=(${probe.toString()})(input);return (${predicate})(s,input)?s:false;`), input, timeout);
async function schedule(page, requested, context) {
  page.optionsOwner = randomUUID(); await read(page, { action: 'begin', owner: page.optionsOwner });
  const expected = config.nativeSchedule(requested), display = expected.at.replace('T', ' ');
  let s = await read(page);
  if (s.unavailable || !s.toggle) fail('官方定时控件未唯一识别或当前账号不可用');
  if (!s.scheduled) await page.click({ selector: '[data-qiye-option="scheduled"]' });
  s = await until(page, (s) => s.scheduled && s.field);
  if (!s.policy) fail('未识别当前账号的官方定时时间范围，未提交');
  const target = config.epoch(expected), now = Date.now();
  if (target < now + s.policy.hours * 3600000 || target > now + s.policy.days * 86400000)
    fail(`官方定时超出此账号范围：${s.policy.hours}小时后至${s.policy.days}天内`);
  const stableValue = async () => {
    const after = Date.now() + 800;
    return until(page, (s, input) => Date.now() >= input.after && !s.month && s.scheduled && s.fieldTime === input.display,
      { display, after }, 2500);
  };
  if (!s.month && s.fieldTime === display) {
    await stableValue();
    context.log(`官方定时已核对原页面时间：${display}（北京时间）`);
    context.checkpoint({ nativeScheduleVerified: expected }); return expected;
  }
  if (s.fieldEditable) {
    context.log('官方定时：按录制中的可编辑输入框填写，等待失焦提交及回读');
    await page.fill('[data-qiye-option="datetime"]', display);
    await page.key('Tab'); await page.key('Escape');
    try {
      await stableValue();
      context.log(`官方定时已输入并回读：${display}（北京时间）`);
      context.checkpoint({ nativeScheduleVerified: expected }); return expected;
    } catch (error) {
      page.check();
      context.log('官方日期输入未保留目标值，改用日历及时间控件核对设置');
    }
  }
  await page.click({ selector: '[data-qiye-option="datetime"]' });
  s = await until(page, (s) => !!s.month && !!s.date);
  const month = expected.at.slice(0, 7);
  for (let i = 0; s.month !== month && i < 2; i++) {
    s = await read(page, { action: 'month', direction: s.month > month ? 'left' : 'right' }); if (!s.marked) fail('官方日历月份切换按钮不可用');
    const previous = s.month;
    await page.click({ selector: '[data-qiye-option="month"]' });
    s = await until(page, (s, input) => !!s.month && s.month !== input.previous, { previous });
  }
  if (s.month !== month) fail('官方日历无法定位目标月份');
  s = await read(page, { action: 'day', day: Number(expected.at.slice(8, 10)) });
  if (!s.marked) fail('目标日期被平台禁用或存在多个候选');
  await page.click({ selector: '[data-qiye-option="day"]' });
  await until(page, (s, input) => s.date === input.date, { date: expected.at.slice(0, 10) });
  await read(page, { action: 'clock' }); await page.click({ selector: '[data-qiye-option="clock"]' });
  for (const [kind, number] of [['hour', Number(expected.at.slice(11, 13))], ['minute', Number(expected.at.slice(14, 16))]]) {
    s = await read(page, { action: 'wheel', kind, number });
    if (!s.marked) fail('官方时间选项被禁用或无法唯一定位');
    await page.click({ selector: '[data-qiye-option="wheel"]' });
    await until(page, (s, input) => input.kind === 'hour' ? Number(s.time.split(':')[0]) === input.number : Number(s.time.split(':')[1]) === input.number, { kind, number });
  }
  await until(page, (s, input) => `${s.date} ${s.time}` === input.display, { display });
  await page.key('Escape');
  s = await until(page, (s, input) => !s.month && s.scheduled && s.fieldTime === input.display, { display });
  context.log(`官方定时已设置并回读：${display}（北京时间）`);
  context.checkpoint({ nativeScheduleVerified: expected });
  return expected;
}
async function search(page, query, context = {}) {
  let currentStage = '检查原网页';
  const stage = (name) => { currentStage = name; context.stage?.(name); context.log?.(`官方位置查询：${name}`); };
  try {
  page.optionsOwner = randomUUID(); await read(page, { action: 'begin', owner: page.optionsOwner });
  let s = await read(page);
  if (s.unavailable || !s.poiRoot) fail('上传后的发布页未识别到唯一位置控件，请人工接管检查原网页');
  stage('打开官方搜索框');
  if (!s.poiInput) await page.click({ selector: '[data-qiye-option="poi-open"]' }, { hover: false });
  else context.log?.('官方位置搜索框已可编辑，保留当前展开状态');
  await until(page, (s) => s.poiInput);
  s = await read(page);
  if (s.query === query && s.candidates.length && !s.loading) {
    const token = randomUUID(); await read(page, { action: 'watch', token });
    stage('核对当前搜索词的官方已显示候选');
    s = await until(page, (s, input) => s.query === input.query && s.candidates.length > 0 && s.watch?.token === input.token && s.watch.quietMs >= 800 && !s.loading, { query, token }, 20000);
    return s.candidates;
  }
  stage('清空旧搜索结果');
  const baseline = randomUUID();
  await read(page, { action: 'watch', token: baseline });
  await page.fill('[data-qiye-poi-input]', '');
  await until(page, (s, input) => s.query === '' && s.watch?.token === input.token && s.watch.quietMs >= 800 && !s.loading, { token: baseline }, 20000);
  const token = randomUUID();
  await read(page, { action: 'watch', token });
  stage('填写搜索词并等待官方候选');
  await page.fill('[data-qiye-poi-input]', query);
  await page.key('ArrowRight');
  s = await until(page, (s, input) => s.query === input.query && s.watch?.token === input.token && s.watch.version > 0 && s.watch.quietMs >= 800 && !s.loading, { query, token }, 20000);
  return s.candidates;
  } catch (error) {
    page.check();
    let details = '';
    try { const s = await read(page); details = `；路径 ${new URL(page.wc.getURL()).pathname}，搜索框${s.poiInput ? '有' : '无'}，候选 ${s.candidates?.length || 0} 个，加载${s.loading ? '中' : '未显示进行中'}`; } catch {}
    fail(`位置查询在“${currentStage}”未完成：${error.message}${details}`);
  }
}
async function setLocation(page, requested, context) {
  const configured = config.location(requested);
  const targets = [{ ...configured, source: 'primary' }, ...(configured.fallback ? [{ ...configured.fallback, mode: 'specified', source: 'fallback' }] : [])];
  let chosen, expected;
  const normalize = (v) => String(v || '').replace(/\s+/g, ' ').trim();
  for (const target of targets) {
    context.log(`后台搜索${target.source === 'primary' ? '固定' : '备选'}地点，核对名称及完整地址`);
    const candidates = await search(page, target.query, context);
    const matches = candidates.filter((c) => normalize(c.name) === normalize(target.label) && (!target.address || normalize(c.address) === normalize(target.address)));
    if (matches.length === 1) { chosen = matches[0]; expected = target; break; }
    context.log(`${target.source === 'primary' ? '固定' : '备选'}地点未唯一匹配（准确候选 ${matches.length} 个），未选择其他地点`, 'warning');
  }
  if (!chosen) fail('固定地点及已配置备选地点未唯一匹配名称和准确地址，请人工接管选择并核实地点；未提交作品');
  const s = await read(page, { action: 'pick-poi', name: chosen.name, address: chosen.address });
  if (!s.marked) fail('地点候选已变化，请重新搜索');
  await page.click({ selector: '[data-qiye-option="poi"]' });
  await until(page, (s, input) => s.selected === input.name && !s.candidates.length, { name: chosen.name });
  await read(page, { action: 'guard-poi', name: chosen.name, address: chosen.address });
  const verified = { mode: 'specified', label: chosen.name, address: chosen.address, query: expected.query, source: expected.source };
  context.log(`官方位置已选择并回读（${expected.source === 'primary' ? '固定' : '备选'}）：${chosen.name} · ${chosen.address}`);
  context.checkpoint({ locationVerified: verified });
  return verified;
}
async function verify(page, native, poi) {
  const s = await read(page);
  if (s.unavailable) fail('提交前平台选项页面已变化');
  if (native && (!s.scheduled || s.fieldTime !== native.at.replace('T', ' ') || config.epoch(native) <= Date.now()))
    fail('提交前官方定时已变化或过期，未提交');
  if (poi && (s.selected !== poi.label || !s.poiGuard?.valid || s.poiGuard.name !== poi.label || s.poiGuard.address !== poi.address)) fail('提交前官方位置发生变化或无法核实地址，未提交');
}
async function cleanup(page) {
  if (!page.optionsOwner || page.wc.isDestroyed()) return;
  let timer;
  try { await Promise.race([page.wc.executeJavaScriptInIsolatedWorld(2002, [{ code: `(${probe.toString()})(${JSON.stringify({ action: 'cleanup', owner: page.optionsOwner })})` }]),
    new Promise((resolve) => { timer = setTimeout(resolve, 1500); })]); } finally { clearTimeout(timer); }
}
module.exports = { probe, read, search, schedule, setLocation, verify, cleanup };
