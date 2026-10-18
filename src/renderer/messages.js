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
  root.innerHTML = `<header class="messages-heading"><div><h1>私信汇总</h1><p>勾选账号，开启监测。有未读时，点击“查看消息”到官网处理。</p></div></header>
    <section class="messages-controls" aria-label="私信监测控制"><div class="messages-buttons"><button id="messages-start" class="button button-primary" type="button">开始监测</button><button id="messages-pause" class="button button-secondary" type="button" hidden>暂停监测</button><button id="messages-scan" class="button button-secondary" type="button">刷新一次</button><span id="messages-status" role="status">正在读取账号…</span></div><p id="messages-cycle" class="messages-muted"></p></section>
    <p id="messages-coverage" class="messages-notice" role="status" hidden>有账号仍停留在对话中。官网可能将该对话的新消息自动标为已读，未读巡检不能保证提醒。处理完私信后，请先退出当前对话，再继续监测。</p>
    <div id="messages-stats" class="messages-stats"></div>
    <section class="messages-accounts" aria-label="账号私信列表"><div class="messages-filters"><input id="messages-search" type="search" placeholder="搜索账号" aria-label="搜索账号名称"><select id="messages-filter" aria-label="筛选状态"><option value="all">全部账号</option><option value="unread">只看有未读</option><option value="error">需要处理</option><option value="monitored">已勾选</option><option value="unsupported">暂未支持</option></select></div>
    <div class="messages-table-scroll"><table class="messages-table"><thead><tr><th>监测</th><th>账号</th><th>未读</th><th>本次变化（估算）</th><th>最近检测</th><th>状态</th><th>操作</th></tr></thead><tbody id="messages-rows"></tbody></table><p id="messages-empty" class="messages-empty" hidden>没有找到账号。请调整筛选，或先在“我的环境”添加账号。</p></div></section>
    <p class="messages-muted messages-help">只查看未读角标，不打开具体会话。首次监测不提醒旧消息；只有已加载的会话时显示“至少”，不能识别时显示“未能识别”，不会误报为 0。当前支持抖音。</p>
    <details class="messages-advanced"><summary>更多设置与使用说明</summary><div class="messages-options"><label>检查频率 <select id="messages-interval"><option value="30">30 秒</option><option value="60">1 分钟</option><option value="120">2 分钟</option><option value="300">5 分钟</option><option value="600">10 分钟</option><option value="1800">30 分钟</option><option value="3600">1 小时</option></select></label><label>同时检查账号数 <select id="messages-concurrency"><option>1</option><option>2</option><option>3</option><option>4</option></select></label><label><input id="messages-sound" type="checkbox">提示音</label><label><input id="messages-system" type="checkbox">Windows 通知</label><label><input id="messages-resume" type="checkbox">下次启动继续监测</label></div>
    <div class="messages-options"><select id="messages-platform" aria-label="筛选平台"><option value="">全部平台</option></select><select id="messages-sort" aria-label="排序"><option value="order">原账号顺序</option><option value="unread">未读优先</option><option value="name">账号名称</option><option value="time">最近检测</option></select><button id="messages-all" class="text-button" type="button">勾选全部抖音账号</button><button id="messages-none" class="text-button" type="button">取消全部</button><button id="messages-backup" class="text-button" type="button">备份监测数据</button></div>
    <p class="messages-muted">电脑需保持开机、联网，栖页需持续运行。没有平台标识的旧环境，可在账号行点击“这是抖音账号”加入监测，不改变原环境配置。新消息提醒来自可靠计数的变化估算；无法取得稳定会话标识时，仅展示已发现的未读数量，不推断新增。</p>
    <details class="messages-history"><summary>查看最近提醒</summary><div id="messages-alerts"></div></details></details>
    <dialog id="messages-details" class="modal messages-details"><div class="messages-details-heading"><h2>账号检查详情</h2><button id="messages-details-close" class="icon-button" aria-label="关闭诊断">×</button></div><p id="messages-details-description"></p><p class="messages-muted">仍然无法识别？点击“保存诊断文件”，把保存的 JSON 文件发给我排查。</p><details><summary>查看技术信息</summary><pre id="messages-diagnostic"></pre></details><div class="modal-actions"><button id="messages-export" class="button button-primary">保存诊断文件</button></div></dialog>`;
  const labels = ['已勾选账号', '发现未读的账号', '需要处理的账号'];
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
    tr.innerHTML = '<td><input type="checkbox"></td><td><div class="messages-account"><span class="messages-logo"></span><div><strong></strong><small></small></div></div></td><td></td><td></td><td></td><td><span class="messages-state"></span><small></small></td><td><div class="messages-row-actions"><button class="text-button">查看消息</button><details class="messages-row-more"><summary aria-label="更多账号操作">更多</summary><div><button class="text-button">重新检查</button><button class="text-button">检查详情 / 诊断</button><button class="text-button messages-platform-link">取消抖音关联</button></div></details></div></td>';
    const cells = tr.children, checkbox = cells[0].firstElementChild;
    checkbox.setAttribute('aria-label', `监测 ${row.name}`);
    checkbox.onchange = () => run('select', { id: row.id, selected: checkbox.checked });
    const buttons = cells[6].querySelectorAll('button');
    buttons[0].onclick = () => { const current = state.rows.find(r => r.id === row.id); return current?.customEnvironment && !current.supported ? run('platform', { id: row.id, platformId: 'douyin' }) : run('open', row.id); }; buttons[1].onclick = () => run('scan', { ids: [row.id] });
    buttons[3].title = '仅设置私信巡检平台，不修改原环境网址、平台绑定或左侧图标';
    buttons[3].onclick = () => run('platform', { id: row.id, platformId: state.rows.find(r => r.id === row.id)?.platformId ? null : 'douyin' });
    buttons[2].onclick = async () => { const data = await run('diagnostics', row.id); if (!data) return; diagnosticId = row.id;
      text($('details-description'), state.rows.find(r => r.id === row.id)?.description || ''); text($('diagnostic'), JSON.stringify(data, null, 2)); $('details').showModal(); };
    return tr;
  }
  function renderRows() {
    if (!state) return;
    const q = $('search').value.trim().toLocaleLowerCase(), platform = $('platform').value, filter = $('filter').value;
    const errors = row => row.monitored && (row.result.activeConversation || !['success', 'partial', 'busy', 'paused'].includes(row.result.status));
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
      text(c[2], row.result.unread === null || row.result.unread === undefined ? (row.result.status === 'unrecognized' ? '未能识别' : '—') : `${row.result.exact ? '' : '至少 '}${row.result.unread}${unit(row.result.unit)}`);
      c[2].title = row.baseline ? `上次可靠基线：${row.baseline.unread}${unit(row.baseline.unit)}，${time(row.baseline.checkedAt)}；不代表当前数量` : '';
      text(c[3], row.result.first ? '首次基线' : row.result.increase === null || row.result.increase === undefined ? '待核实' : row.result.increase > 0 ? `计数 +${row.result.increase}（估算）` : '未观察到增加');
      text(c[4], time(row.result.checkedAt));
      text(c[5].firstElementChild, row.checking ? '正在巡检' : row.result.activeConversation ? '对话打开 · 监测受限' : row.result.status === 'partial' ? '已发现会话未读' : row.result.status === 'success' ? '已读取' : row.result.status === 'busy' ? '等待空闲' : row.result.status === 'unsupported' ? '暂未支持' : row.result.status === 'disabled' ? '未监测' : row.result.status === 'paused' ? '等待检查' : row.result.status === 'login_required' ? '需要登录' : row.result.status === 'verification' ? '需要验证' : '请查看详情');
      c[5].title = (row.description || '') + (row.result.visibleConversations ? `；已识别 ${row.result.visibleConversations} 个已加载会话` : ''); text(c[5].lastElementChild, row.result.retryAt > Date.now() ? `异常账号重试：${time(row.result.retryAt)}` : '');
      const buttons = c[6].querySelectorAll('button'); buttons[0].disabled = (!row.supported && !row.customEnvironment) || row.checking; text(buttons[0], row.customEnvironment && !row.supported ? '这是抖音账号' : '查看消息'); buttons[1].disabled = !row.monitored || state.checking; buttons[3].hidden = !row.customEnvironment || !row.platformId; text(buttons[3], '取消抖音关联');
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
    $('start').hidden = state.running || state.checking; $('pause').hidden = !state.running && !state.checking; $('start').disabled = state.running || state.checking || !state.summary.monitored; $('pause').disabled = !state.running && !state.checking; $('scan').disabled = state.checking;
    text($('status'), !state.summary.monitored ? '先勾选要监测的抖音账号' : state.checking ? `检查中 ${state.cycle?.done || 0} / ${state.cycle?.total || 0}` : state.running ? '持续监测中' : '已暂停');
    const recent = state.cycle?.completedAt ? `最近更新 ${time(state.cycle.completedAt)}` : state.checking ? '正在检查账号' : '默认勾选抖音账号，点击“开始监测”即可。';
    const next = !state.nextAt ? '' : state.checking && state.nextAt <= Date.now() ? '自动巡检已到期，当前检查结束后立即执行' : `下次自动巡检 ${time(state.nextAt)}`;
    text($('cycle'), [recent, next].filter(Boolean).join(' · '));
    if (document.activeElement !== $('interval')) $('interval').value = state.config.intervalSeconds;
    if (document.activeElement !== $('concurrency')) $('concurrency').value = state.config.concurrency;
    $('sound').checked = state.config.sound; $('system').checked = state.config.systemNotifications; $('resume').checked = state.config.autoResume;
    const needsAttention = state.rows.filter(r => r.monitored && (r.result.activeConversation || !['success','partial','paused','busy'].includes(r.result.status))).length;
    $('coverage').hidden = !state.rows.some(r => r.monitored && r.result.activeConversation);
    const values = [state.summary.monitored, state.summary.observedAccounts ? state.summary.unreadAccounts : '—', needsAttention];
    [...$('stats').children].forEach((c,i) => { text(c.children[1], values[i]); text(c.children[2], i === 1 ? '按已读取的会话统计' : i === 2 && needsAttention ? '登录或检查详情后重试' : ''); });
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
