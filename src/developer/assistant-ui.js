'use strict';
(() => {
  const $ = (id) => document.getElementById(id), api = window.developerAPI;
  let state, selectedTask, preferred, busy = false, reviewing = false,
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
  async function preparePreview() {
    const report = state.report;
    if (reviewing || (previewRevision === report.revision && previewReport === report.id)) return;
    reviewing = true;
    $('assistant-reviewed').checked = false;
    try {
      const data = await call('preview');
      if (state.report.id !== report.id || state.report.revision !== report.revision) return;
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
    const recording = !!a && ['recording', 'paused'].includes(report.status);
    const review = !!a && !recording;
    $('assistant-setup').hidden = !!a;
    $('assistant-recording').hidden = !recording;
    $('assistant-review').hidden = !review;
    $('assistant-history').hidden = recording;
    $('assistant-finish').hidden = !recording;
    $('assistant-export').hidden = !review;
    $('assistant-another').hidden = !review;
    if (preferred !== state.assistant.preferredTask) {
      preferred = state.assistant.preferredTask; selectedTask = preferred;
    }
    const tasks = state.assistant.tasks;
    if (!tasks.some((t) => t.id === selectedTask)) selectedTask = tasks[0]?.id;
    const select = $('assistant-task');
    // Keep the selector DOM stable during the recording's frequent updates.
    const signature = JSON.stringify(tasks.map((t) => [t.id, t.accountName, t.videoName, t.statusLabel]));
    if (select.dataset.signature !== signature) {
      select.dataset.signature = signature;
      select.replaceChildren(...tasks.map((t) => { const o = node('option', `${t.accountName} · ${t.videoName} · ${t.statusLabel}`); o.value = t.id; return o; }));
    }
    select.value = selectedTask || '';
    const task = tasks.find((t) => t.id === selectedTask);
    $('assistant-start').disabled = busy || !task?.canRun;
    $('assistant-observe').disabled = busy || !task;
    $('assistant-start-help').textContent = !task ? '请先在发布中心创建任务，再从任务旁点击「帮我排查」。'
      : task.canRun ? '执行沿用这个任务原有的发布授权。不会替你增加自动提交授权。'
      : '这个任务当前不能直接重试。可以只记录现场，已提交的任务需要先核实结果。';
    for (const id of ['assistant-problem', 'assistant-manual', 'assistant-reveal', 'assistant-finish', 'assistant-another']) $(id).disabled = busy;
    $('assistant-export').disabled = busy || reviewing || !review ||
      previewReport !== report?.id || previewRevision !== report?.revision ||
      !$('assistant-reviewed').checked || report.screenshots.some((s) => !s.reviewed);
    $('assistant-counts').textContent = a ? `已记录 ${report.steps.length} 个操作 · ${report.snapshots.length} 份页面状态 · ${report.scripts.length} 条脚本事件` : '选择一个任务开始';
    if (a) {
      const taskState = a.task || {};
      const boundTask = tasks.find((t) => t.id === a.taskId);
      $('assistant-current-task').textContent = boundTask ? `正在记录：${boundTask.accountName} · ${boundTask.videoName}` : '任务已删除，已记录的资料仍可保存。';
      $('assistant-progress').textContent = taskState.stateLabel || '正在读取任务状态';
      $('assistant-guidance').textContent = a.phase === 'manual' ? '现在请在原账号网页演示正确的操作，完成后回来结束记录。'
        : taskState.reason || taskState.wait?.message || '你可以等待任务运行。出现问题时点「卡住了」，也可以演示正确操作。';
      $('assistant-summary').replaceChildren(node('p', '问题：' + (a.issue || '未填写，可根据记录分析')),
        node('p', '任务状态：' + (taskState.stateLabel || '未记录')),
        node('p', '包含网页控件、操作过程、脚本执行和最近任务日志。输入内容、密码、Cookie 和本地文件路径已排除。'));
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
    if (!state.reports.length) history.append(node('p', '还没有排查记录。'));
  }
  $('assistant-task').onchange = () => { selectedTask = $('assistant-task').value; render(); };
  $('assistant-reviewed').onchange = () => render(false);
  action('mode-assistant', () => call('assistant-mode', { mode: 'assistant' }));
  action('mode-professional', () => call('assistant-mode', { mode: 'professional' }));
  const start = (run) => call('assistant-start', { taskId: selectedTask, issue: $('assistant-issue').value, run });
  action('assistant-start', () => start(true));
  action('assistant-observe', () => start(false));
  action('assistant-problem', async () => { await call('assistant-problem', { issue: $('assistant-record-note').value || $('assistant-issue').value }); toast('已记下当前现场，可以继续演示或结束记录'); });
  action('assistant-manual', () => call('assistant-manual'));
  action('assistant-reveal', () => call('reveal'));
  action('assistant-finish', () => call('assistant-finish'));
  action('assistant-export', async () => { const result = await call('export', { format: 'zip' }); if (result.saved) toast('资料包已保存，请把 ZIP 上传到与 AI 的对话中'); });
  action('assistant-another', async () => { await call('assistant-new'); $('assistant-issue').value = ''; $('assistant-record-note').value = ''; });
  window.addEventListener('developer-state', (event) => { state = event.detail; render(); });
  call('state').catch((error) => toast(error.message));
})();
