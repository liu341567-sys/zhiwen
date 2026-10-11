'use strict';
(() => {
  const $ = (id) => document.getElementById(id), api = window.developerAPI;
  let state, selectedTask = '', selectedEnvironment = '', preferred, busy = false, reviewing = false,
    previewRevision = null, previewReport = null, timer;
  const node = (tag, text) => { const n = document.createElement(tag); if (text !== undefined) n.textContent = text; return n; };
  const toast = (message) => { $('toast').textContent = message; $('toast').hidden = false;
    clearTimeout(timer); timer = setTimeout(() => $('toast').hidden = true, 4500); };
  async function call(command, input) {
    const result = await api.command(command, input);
    if (result?.profiles) { state = result; render(); }
    return result;
  }
  function action(id, fn) {
    $(id).onclick = async () => {
      if (busy) return;
      busy = true; render();
      try { await fn(); } catch (error) { toast((error.message || String(error)).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')); }
      finally { busy = false; await call('state'); }
    };
  }
  function options(id, rows, value) {
    const select = $(id), signature = JSON.stringify(rows);
    if (select.dataset.signature !== signature) {
      select.dataset.signature = signature;
      select.replaceChildren(...rows.map(([id, text]) => { const o = node('option', text); o.value = id; return o; }));
    }
    select.value = value;
  }
  async function preparePreview() {
    const report = state.report;
    if (reviewing || (previewRevision === report.revision && previewReport === report.id)) return;
    reviewing = true;
    $('assistant-reviewed').checked = false;
    try {
      const data = await call('preview');
      if (state.report?.id !== report.id || state.report.revision !== report.revision) return;
      previewRevision = report.revision; previewReport = report.id;
      $('assistant-preview').textContent = JSON.stringify(data, null, 2);
    } catch (error) { toast(error.message); }
    finally { reviewing = false; render(false); }
  }
  function render(prepare = true) {
    if (!state) return;
    const simple = state.assistant.mode === 'assistant';
    document.body.classList.toggle('assistant-mode', simple);
    $('mode-assistant').classList.toggle('primary', simple);
    $('mode-professional').classList.toggle('primary', !simple);
    const report = state.report, a = report?.assistance;
    const recording = !!a && ['recording', 'paused'].includes(report.status), paused = report?.status === 'paused';
    const review = !!a && !recording, diagnostic = state.assistant.workflow === 'diagnostic';
    $('assistant-setup').hidden = !!a;
    $('assistant-recording').hidden = !recording;
    $('assistant-review').hidden = !review;
    $('assistant-history').hidden = recording;
    $('assistant-finish').hidden = !recording;
    $('assistant-export').hidden = !review;
    $('assistant-another').hidden = !review;
    $('assistant-task-fields').hidden = !diagnostic;
    $('assistant-issue-fields').hidden = !diagnostic;
    $('assistant-record-fields').hidden = diagnostic;
    $('workflow-record').classList.toggle('primary', !diagnostic);
    $('workflow-diagnostic').classList.toggle('primary', diagnostic);
    $('workflow-record').setAttribute('aria-pressed', String(!diagnostic));
    $('workflow-diagnostic').setAttribute('aria-pressed', String(diagnostic));
    $('assistant-setup-title').textContent = diagnostic ? '记录问题现场，再演示正确操作' : '选择账号，录制完整流程或部分模块';
    if (preferred !== state.assistant.preferredTask) {
      preferred = state.assistant.preferredTask; selectedTask = preferred || '';
    }
    const tasks = state.assistant.tasks, environments = state.assistant.environments;
    if (!tasks.some((t) => t.id === selectedTask)) selectedTask = '';
    if (!environments.some((p) => p.id === selectedEnvironment)) selectedEnvironment = environments[0]?.id || '';
    const task = diagnostic ? tasks.find((t) => t.id === selectedTask) : null;
    options('assistant-task', [['', '不关联任务 · 直接记录当前网页问题'], ...tasks.map((t) => [t.id, `${t.accountName} · ${t.videoName} · ${t.statusLabel}`])], selectedTask);
    options('assistant-environment', environments.map((p) => [p.id, `${p.name || '账号环境'} · ${p.leased ? '自动任务执行中' : p.running ? '已打开' : '将打开原环境'}`]), task?.accountId || selectedEnvironment);
    $('assistant-environment').disabled = busy || !!task;
    const environment = environments.find((p) => p.id === selectedEnvironment);
    $('assistant-start').disabled = busy || !task?.canRun;
    $('assistant-observe').disabled = busy || (!task && (!environment || environment.leased));
    $('assistant-observe').textContent = task ? '开始记录当前现场（不运行任务）' : '开始录制，去网页操作';
    $('assistant-run-options').hidden = !task;
    $('assistant-start-help').textContent = task ? '仅记录当前现场，不自动开始或重试任务。点击「演示正确操作」后暂停该账号自动任务并返回原网页。'
      : !environment ? '请先在「环境」中创建一个账号环境；不需要创建发布计划。'
      : environment.leased ? '此账号正在自动执行任务。请先暂停任务，或在「排查问题」中关联该任务并人工接管。'
      : '会连接这个账号的原网页并保留登录状态。你自行操作网页，工具只记录，不点击或提交作品。';
    for (const id of ['workflow-record', 'workflow-diagnostic', 'assistant-reveal', 'assistant-finish', 'assistant-another']) $(id).disabled = busy;
    for (const id of ['assistant-problem', 'assistant-manual', 'assistant-segment', 'assistant-pause']) $(id).disabled = busy || paused;
    $('assistant-pause').hidden = paused;
    $('assistant-resume').hidden = !paused;
    $('assistant-resume').disabled = busy;
    $('assistant-export').disabled = busy || reviewing || !review ||
      previewReport !== report?.id || previewRevision !== report?.revision ||
      !$('assistant-reviewed').checked || report.screenshots.some((s) => !s.reviewed);
    $('assistant-counts').textContent = a ? `已记录 ${report.steps.length} 个操作 · ${report.snapshots.length} 份页面状态` : '选择已有账号即可开始，不需要发布任务';
    if (a) {
      const taskState = a.task || {}, boundTask = tasks.find((t) => t.id === a.taskId);
      $('assistant-current-task').textContent = a.taskId
        ? boundTask ? `${boundTask.accountName} · ${boundTask.videoName}` : '任务已删除，已记录的资料仍可保存。'
        : `${a.name || report.name} · ${a.scope === 'partial' ? '部分模块' : '完整流程'} · 直接记录原账号网页`;
      $('assistant-progress').textContent = paused ? '已暂停录制，点击继续后再操作' : a.taskId ? taskState.stateLabel || '正在读取任务状态' : '录制已开始，请在账号网页操作';
      $('assistant-guidance').textContent = paused ? '暂停期间的操作不会进入记录；已录制内容会保留。'
        : a.phase === 'manual' ? '请在原账号网页演示操作。可随时回来标记模块、记下问题或暂停；完成后结束记录。'
        : taskState.reason || taskState.wait?.message || '出现问题时点「记下问题现场」，再点「演示正确操作」。不会自动重试任务。';
      $('assistant-record-help').textContent = a.taskId ? '「演示正确操作」会暂停该账号自动任务并保留网页。结束记录只停止录制，不改变任务状态。'
        : '无需发布任务。只录某个模块时，先在网页进入该模块再开始；也可暂停跳过无关操作。结束记录不关闭账号网页。';
      const description = a.taskId ? `任务状态：${taskState.stateLabel || '未记录'}` : `录制范围：${a.scope === 'partial' ? '部分模块' : '完整流程'}；模块标记 ${(a.segments || []).length} 个。`;
      $('assistant-summary').replaceChildren(node('p', '用途：' + (a.kind === 'record' ? '人工操作录制' : '问题现场与正确操作演示')),
        node('p', '说明：' + (a.issue || a.name || '未填写，可根据记录分析')), node('p', description),
        node('p', '包含网页控件、定位信息、操作前后变化与步骤说明；关联任务时附带该任务日志。输入值、密码、Cookie 和本地路径已排除。'));
      // Do not replace stable timeline nodes on every 900 ms page sample.
      const timeline = $('assistant-timeline'), signature = JSON.stringify(report.steps.map((s) => [s.id, s.note, s.type]));
      if (timeline.dataset.signature !== signature) {
        timeline.dataset.signature = signature;
        const labels = { click: '点击', input: '输入（内容不记录）', change: '选择 / 修改', file: '选择文件（路径不记录）', scroll: '滚动', navigation: '页面跳转', note: '说明' };
        timeline.replaceChildren(...report.steps.slice(-80).map((s) => node('li', `${new Date(s.time).toLocaleTimeString()} · ${s.note || labels[s.type] || s.type}${s.note ? '' : ' · ' + (s.target?.text || s.target?.attributes?.placeholder || s.target?.tag || '网页控件')}`)));
      }
      const shots = $('assistant-shots'); shots.replaceChildren();
      for (const shot of report.screenshots) {
        const card = node('section'), image = node('img'); image.src = shot.data; image.className = 'shot'; image.alt = '需要审阅的脱敏截图';
        const yes = node('button', shot.reviewed ? '已确认可分享' : '确认此截图可分享');
        yes.disabled = busy || shot.reviewed; yes.onclick = () => call('review-shot', { id: shot.id }).catch((e) => toast(e.message));
        const remove = node('button', '删除这张截图'); remove.onclick = () => call('delete-shot', { id: shot.id }).catch((e) => toast(e.message));
        card.append(image, yes, remove); shots.append(card);
      }
      if (review && prepare) preparePreview();
    }
    const history = $('assistant-history-list'); history.replaceChildren();
    for (const r of state.reports.slice(0, 5)) {
      const row = node('div'); row.className = 'history-row';
      const load = node('button', '打开记录'); load.disabled = busy || recording;
      load.onclick = async () => { try { await call('load', { id: r.id }); if (!state.report.assistance) await call('assistant-mode', { mode: 'professional' }); } catch (error) { toast(error.message); } };
      row.append(node('span', r.name), load); history.append(row);
    }
    if (!state.reports.length) history.append(node('p', '还没有录制或问题记录。'));
  }
  $('assistant-task').onchange = () => { selectedTask = $('assistant-task').value; render(); };
  $('assistant-environment').onchange = () => { selectedEnvironment = $('assistant-environment').value; render(); };
  $('assistant-reviewed').onchange = () => render(false);
  action('mode-assistant', () => call('assistant-mode', { mode: 'assistant' }));
  action('mode-professional', () => call('assistant-mode', { mode: 'professional' }));
  action('workflow-record', () => call('assistant-workflow', { workflow: 'record' }));
  action('workflow-diagnostic', () => call('assistant-workflow', { workflow: 'diagnostic' }));
  const start = (run) => {
    const workflow = state.assistant.workflow;
    if (workflow === 'diagnostic' && selectedTask) return call('assistant-start', { taskId: selectedTask, issue: $('assistant-issue').value, run });
    return call('assistant-record', { accountId: selectedEnvironment, workflow, scope: $('assistant-scope').value,
      name: $('assistant-name').value, issue: workflow === 'diagnostic' ? $('assistant-issue').value : '' });
  };
  action('assistant-start', () => start(true));
  action('assistant-observe', () => start(false));
  action('assistant-pause', () => call('assistant-pause'));
  action('assistant-resume', () => call('assistant-resume'));
  action('assistant-segment', async () => { await call('assistant-segment', { note: $('assistant-record-note').value }); $('assistant-record-note').value = ''; toast('已标记步骤，继续在原网页操作即可'); });
  action('assistant-problem', async () => { await call('assistant-problem', { issue: $('assistant-record-note').value || $('assistant-issue').value }); toast('已记下当前现场，可以继续演示或结束记录'); });
  action('assistant-manual', () => call('assistant-manual'));
  action('assistant-reveal', () => call('reveal'));
  action('assistant-finish', () => call('assistant-finish'));
  action('assistant-export', async () => { const result = await call('export', { format: 'zip' }); if (result.saved) toast('资料包已保存，请把 ZIP 上传到与 AI 的对话中'); });
  action('assistant-another', async () => { await call('assistant-new'); for (const id of ['assistant-issue', 'assistant-record-note', 'assistant-name']) $(id).value = ''; });
  window.addEventListener('developer-state', (event) => { state = event.detail; render(); });
  call('state').catch((error) => toast(error.message));
})();
