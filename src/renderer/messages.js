'use strict';
(() => {
  const root = document.getElementById('messages-module'), api = window.messagesAPI;
  let state, busy = false, timer, loading = false, again = false, initialized = false, presets = [];
  const nodes = new Map(), $ = id => document.getElementById(`messages-${id}`);
  const text = (node, value) => { value = String(value); if (node.textContent !== value) node.textContent = value; };
  const time = value => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—';
  const unit = value => value === 'messages' ? '条' : value === 'conversations' ? '个会话' : '（官网计数）';
  const units = values => Object.entries(values || {}).filter(([,n]) => n > 0).map(([u,n]) => `${n}${unit(u)}`).join(' / ') || '0';
  const feedback = (message, type = 'success') => window.publishingNotify?.(message, type);
  root.innerHTML = `<header class="messages-heading"><div><h1>私信汇总</h1><p>同一账号会话，只读巡检官方列表；消息处理仍在官网完成。</p></div><div class="messages-heading-actions"><span class="messages-local">本地监测</span><button id="messages-backup" class="button button-secondary" type="button">备份数据</button></div></header>
    <section class="messages-controls" aria-label="私信监测控制"><div class="messages-buttons"><button id="messages-start" class="button button-primary" type="button">开始实时监测</button><button id="messages-pause" class="button button-secondary" type="button">暂停监测</button><button id="messages-scan" class="button button-secondary" type="button">立即巡检</button><span id="messages-status" role="status">正在读取设置…</span></div>
    <div class="messages-options"><label>巡检间隔 <select id="messages-interval"><option value="30">30 秒</option><option value="60">1 分钟</option><option value="120">2 分钟</option><option value="300">5 分钟</option><option value="600">10 分钟</option><option value="1800">30 分钟</option><option value="3600">1 小时</option></select></label><label>并发账号 <select id="messages-concurrency"><option>1</option><option>2</option><option>3</option><option>4</option></select></label><label><input id="messages-sound" type="checkbox">提示音（系统音量）</label><label><input id="messages-system" type="checkbox">Windows 通知</label><label><input id="messages-resume" type="checkbox">重启后继续监测</label></div>
    <p id="messages-cycle" class="messages-muted"></p></section>
    <div id="messages-stats" class="messages-stats"></div>
    <div class="messages-notice">首次巡检建立基线，不提醒既有未读。优先读取官网明确总数；只有会话旁的数字时，统计已加载会话的下界。“数量增加”是估算，不能证明准确新增条数。未确认列表完整时不会当作总数；无法识别及 99+ 等上限计数不会当作零。抖音入口已确认，计数识别仍需实际账号核验；其他平台待适配。</div>
    <section class="messages-accounts" aria-label="账号私信列表"><div class="messages-filters"><input id="messages-search" type="search" placeholder="搜索账号名称" aria-label="搜索账号名称"><select id="messages-platform" aria-label="筛选平台"><option value="">全部平台</option></select><select id="messages-filter" aria-label="筛选状态"><option value="all">全部状态</option><option value="unread">存在未读</option><option value="error">巡检异常</option><option value="monitored">正在监测的账号</option><option value="unsupported">暂未支持</option></select><select id="messages-sort" aria-label="排序"><option value="order">原账号顺序</option><option value="unread">未读优先</option><option value="name">账号名称</option><option value="time">最近检测</option></select><button id="messages-all" class="button button-secondary" type="button">监测全部支持账号</button><button id="messages-none" class="text-button" type="button">取消全部</button></div>
    <div class="messages-table-scroll"><table class="messages-table"><thead><tr><th>监测</th><th>平台 / 账号</th><th>当前未读</th><th>本次变化（估算）</th><th>最近检测</th><th>状态</th><th>操作</th></tr></thead><tbody id="messages-rows"></tbody></table><p id="messages-empty" class="messages-empty" hidden>没有符合条件的账号。请先在“我的环境”创建抖音预设环境，或调整筛选条件。自定义网址不会自动推断平台。</p></div></section>
    <details class="messages-history"><summary>最近的未读变化提醒</summary><div id="messages-alerts"></div></details>
    <p class="messages-muted">电脑需保持开机、联网，栖页需持续运行。巡检不会发送、回复或点击会话；“查看消息”会在对应账号中打开官方私信列表。关闭监测会释放后台页面。</p>
    <dialog id="messages-details" class="modal messages-details"><div class="messages-details-heading"><h2>巡检状态与脱敏诊断</h2><button id="messages-details-close" class="icon-button" aria-label="关闭诊断">×</button></div><p id="messages-details-description"></p><pre id="messages-diagnostic"></pre><div class="modal-actions"><button id="messages-export" class="button button-primary">导出诊断</button></div></dialog>`;
  const labels = ['已纳入监测', '本次读取成功', '存在未读的账号', '当前未读合计', '本次新增 / 数量变化', '巡检异常账号'];
  for (const label of labels) { const card = document.createElement('div'); card.innerHTML = '<span></span><strong></strong><small></small>'; text(card.children[0], label); $('stats').append(card); }
  let diagnosticId;
  $('backup').onclick = () => run('backup').then(r => { if (r?.saved) feedback('私信监测数据已备份'); });
  $('details-close').onclick = () => $('details').close();
  $('export').onclick = () => run('export', diagnosticId).then(r => { if (r?.saved) feedback('脱敏诊断已保存到本地'); });
  async function run(command, input) {
    try { const value = await api.command(command, input); if (value?.rows) { state = value; render(); } return value; }
    catch (error) { feedback(error.message || '私信操作失败', 'error'); return null; }
  }
  async function refresh() {
    if (loading) { again = true; return; } loading = true;
    try { const value = await api.command('state'); state = value; render(); }
    catch { text($('status'), '监测服务尚未就绪，请稍后重试'); }
    finally { loading = false; if (again) { again = false; schedule(); } }
  }
  function schedule() { clearTimeout(timer); timer = setTimeout(refresh, 80); }
  for (const name of ['start', 'pause', 'scan']) $(name).onclick = async () => { if (busy && name !== 'pause') return; busy = true; await run(name); busy = false; };
  const settings = (name, key, convert) => $(name).addEventListener('change', () => run('settings', { [key]: convert($(name)) }));
  settings('interval', 'intervalSeconds', n => Number(n.value)); settings('concurrency', 'concurrency', n => Number(n.value));
  settings('sound', 'sound', n => n.checked); settings('system', 'systemNotifications', n => n.checked); settings('resume', 'autoResume', n => n.checked);
  $('all').onclick = () => run('settings', { selectedIds: null }); $('none').onclick = () => run('settings', { selectedIds: [] });
  const filters = ['search', 'platform', 'filter', 'sort'];
  for (const id of filters) $(id).addEventListener(id === 'search' ? 'input' : 'change', () => { try { localStorage.setItem('qiye-messages-filters', JSON.stringify(Object.fromEntries(filters.map(id => [id, $(id).value])))); } catch {} renderRows(); });
  function createRow(row) {
    const tr = document.createElement('tr'); tr.dataset.environmentId = row.id;
    tr.innerHTML = '<td><input type="checkbox"></td><td><div class="messages-account"><span class="messages-logo"></span><div><strong></strong><small></small></div></div></td><td></td><td></td><td></td><td><span class="messages-state"></span><small></small></td><td><div class="messages-row-actions"><button class="text-button">查看消息</button><button class="text-button">重新巡检</button><button class="text-button">详情</button></div></td>';
    const cells = tr.children, checkbox = cells[0].firstElementChild;
    checkbox.setAttribute('aria-label', `监测 ${row.name}`);
    checkbox.onchange = () => { const ids = new Set(state.rows.filter(r => r.monitored).map(r => r.id)); if (checkbox.checked) ids.add(row.id); else ids.delete(row.id); run('settings', { selectedIds: [...ids] }); };
    const buttons = cells[6].querySelectorAll('button');
    buttons[0].onclick = () => run('open', row.id); buttons[1].onclick = () => run('scan', { ids: [row.id] });
    buttons[2].onclick = async () => { const data = await run('diagnostics', row.id); if (!data) return; diagnosticId = row.id;
      text($('details-description'), state.rows.find(r => r.id === row.id)?.description || ''); text($('diagnostic'), JSON.stringify(data, null, 2)); $('details').showModal(); };
    return tr;
  }
  function renderRows() {
    if (!state) return;
    const q = $('search').value.trim().toLocaleLowerCase(), platform = $('platform').value, filter = $('filter').value;
    const errors = row => row.monitored && !['success', 'partial', 'busy', 'paused'].includes(row.result.status);
    const visible = state.rows.filter(row => (!q || row.name.toLocaleLowerCase().includes(q)) && (!platform || row.platformId === platform)
      && (filter === 'all' || filter === 'unread' && row.result.unread > 0 || filter === 'error' && errors(row) || filter === 'monitored' && row.monitored || filter === 'unsupported' && !row.supported));
    const sort = $('sort').value;
    if (sort !== 'order') visible.sort((a,b) => sort === 'name' ? a.name.localeCompare(b.name, 'zh-CN') : sort === 'unread' ? (b.result.unread ?? -1) - (a.result.unread ?? -1) : (b.result.checkedAt || 0) - (a.result.checkedAt || 0));
    for (const row of state.rows) {
      let tr = nodes.get(row.id); if (!tr) { tr = createRow(row); nodes.set(row.id, tr); }
      tr.hidden = !visible.some(r => r.id === row.id); tr.classList.toggle('has-unread', row.result.unread > 0);
      const c = tr.children, preset = presets.find(p => p.id === row.platformId), logo = c[1].querySelector('.messages-logo');
      if (logo.dataset.platform !== (row.platformId || 'custom')) { logo.dataset.platform = row.platformId || 'custom'; if (preset) { const img = document.createElement('img'); img.src = preset.iconResource; img.alt = ''; img.draggable = false; logo.replaceChildren(img); } else text(logo, '环'); }
      c[0].firstElementChild.checked = row.monitored; c[0].firstElementChild.disabled = !row.supported; c[0].firstElementChild.setAttribute('aria-label', `监测 ${row.name}`);
      text(c[1].querySelector('strong'), row.name); text(c[1].querySelector('small'), preset?.displayName || '自定义环境');
      text(c[2], row.result.unread === null || row.result.unread === undefined ? '待核实' : `${row.result.exact ? '' : '至少 '}${row.result.unread}${unit(row.result.unit)}`);
      c[2].title = row.baseline ? `上次可靠基线：${row.baseline.unread}${unit(row.baseline.unit)}，${time(row.baseline.checkedAt)}；不代表当前数量` : '';
      text(c[3], row.result.first ? '首次基线' : row.result.increase === null || row.result.increase === undefined ? '待核实' : row.result.increase > 0 ? `计数 +${row.result.increase}（估算）` : '未观察到增加');
      text(c[4], time(row.result.checkedAt));
      text(c[5].firstElementChild, row.checking ? '正在巡检' : row.result.status === 'partial' ? '已加载会话 / 总数待核实' : row.result.status === 'success' ? '已读取' : row.result.status === 'busy' ? '等待空闲' : row.result.status === 'unsupported' ? '暂未支持' : row.result.status === 'disabled' ? '未监测' : row.result.status === 'paused' ? '尚未巡检' : row.result.status === 'login_required' ? '需要登录' : row.result.status === 'verification' ? '需要验证' : '待核实');
      c[5].title = (row.description || '') + (row.result.visibleConversations ? `；已识别 ${row.result.visibleConversations} 个已加载会话` : ''); text(c[5].lastElementChild, row.result.retryAt > Date.now() ? `重试：${time(row.result.retryAt)}` : '');
      const buttons = c[6].querySelectorAll('button'); buttons[0].disabled = !row.supported || row.checking; buttons[1].disabled = !row.monitored || state.checking;
    }
    const valid = new Set(state.rows.map(r => r.id)); for (const [id, node] of nodes) if (!valid.has(id)) { node.remove(); nodes.delete(id); }
    const body = $('rows'); let previous = null;
    // Stable environment IDs; retain both row and icon nodes during polling.
    for (const row of visible) { const tr = nodes.get(row.id), expected = previous ? previous.nextSibling : body.firstChild; if (expected !== tr) body.insertBefore(tr, expected); previous = tr; }
    for (const [id, tr] of nodes) if (!tr.parentNode) body.append(tr);
    $('empty').hidden = visible.length !== 0;
  }
  function render() {
    if (!state) return;
    $('start').disabled = state.running || state.checking; $('pause').disabled = !state.running && !state.checking; $('scan').disabled = state.checking;
    text($('status'), state.checking ? `巡检中 ${state.cycle?.done || 0} / ${state.cycle?.total || 0}` : state.running ? '持续监测中' : '已暂停');
    text($('cycle'), `纳入监测 ${state.summary.monitored} 个账号 · 最近完成：${time(state.cycle?.completedAt)}${state.nextAt ? ' · 下次巡检：' + time(state.nextAt) : ''}`);
    if (document.activeElement !== $('interval')) $('interval').value = state.config.intervalSeconds;
    if (document.activeElement !== $('concurrency')) $('concurrency').value = state.config.concurrency;
    $('sound').checked = state.config.sound; $('system').checked = state.config.systemNotifications; $('resume').checked = state.config.autoResume;
    const combined = Object.fromEntries(Object.keys(state.summary.unread).map(u => [u, state.summary.unread[u] + (state.summary.lowerBounds?.[u] || 0)]));
    const incomplete = state.summary.monitored > state.summary.reliableAccounts;
    const knownPositive = Object.values(combined).some(n => n > 0);
    const values = [state.summary.monitored, state.summary.success, state.summary.observedAccounts && (!incomplete || knownPositive) ? `${incomplete ? '至少 ' : ''}${state.summary.unreadAccounts}` : '待核实', state.summary.observedAccounts && (!incomplete || knownPositive) ? `${incomplete ? '至少 ' : ''}${units(combined)}` : '待核实', '待核实', state.summary.anomalies];
    [...$('stats').children].forEach((c,i) => { text(c.children[1], values[i]); text(c.children[2], i === 3 ? `完整计数 ${state.summary.reliableAccounts} 个；部分计数 ${state.summary.partialAccounts} 个，完整总数待核实` : i === 4 ? `未读计数增加：${units(state.summary.increases)}（估算）` : ''); });
    const platform = $('platform'), current = platform.value;
    for (const id of new Set(state.rows.map(r => r.platformId).filter(Boolean))) {
      let option = [...platform.options].find(o => o.value === id);
      if (!option) { option = document.createElement('option'); option.value = id; platform.append(option); }
      text(option, presets.find(p => p.id === id)?.displayName || id);
    }
    platform.value = current;
    if (!initialized) {
      initialized = true;
      try { const saved = JSON.parse(localStorage.getItem('qiye-messages-filters')); for (const id of filters) if (typeof saved?.[id] === 'string') $(id).value = saved[id]; } catch {}
    }
    const alerts = $('alerts'); alerts.replaceChildren();
    for (const alert of state.alerts) { const p = document.createElement('p'); p.textContent = `${time(alert.time)} · ${alert.name} · 计数增加 ${alert.increase}${unit(alert.unit)}，当前${alert.lowerBound ? '至少' : ''} ${alert.unread}${unit(alert.unit)}（估算）`; alerts.append(p); }
    if (!state.alerts.length) text(alerts, '尚无未读计数增加提醒。首次基线不会产生提醒。');
    renderRows();
  }
  api?.onChanged(schedule); window.addEventListener('messages:visible', refresh);
  window.browserAPI?.onState(schedule);
  window.browserAPI?.getState().then(s => { presets = s.platformPresets || []; if (state) render(); });
})();
