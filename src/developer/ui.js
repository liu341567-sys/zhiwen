'use strict';
(() => {
  const api = window.developerAPI,
    $ = (id) => document.getElementById(id),
    e = (tag, text, cls) => {
      const n = document.createElement(tag);
      if (text !== undefined) n.textContent = String(text);
      if (cls) n.className = cls;
      return n;
    };
  let state,
    page = 'structure',
    selection = null,
    search = '',
    updating = false,
    queued = false,
    toastTimer,
    diff = null;
  const time = (t) =>
    t ? new Date(t).toLocaleTimeString('zh-CN', { hour12: false }) : '—';
  const button = (label, fn, cls) => {
    const b = e('button', label, cls);
    b.type = 'button';
    b.onclick = () => Promise.resolve().then(fn).catch(fail);
    return b;
  };
  const fail = (error) => notify(error.message || String(error));
  function notify(message) {
    $('toast').textContent = message;
    $('toast').hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => ($('toast').hidden = true), 3200);
  }
  async function cmd(name, input) {
    const result = await api.command(name, input);
    if (result?.profiles) {
      state = result;
      render();
    }
    return result;
  }
  async function update() {
    if (updating) {
      queued = true;
      return;
    }
    updating = true;
    try {
      state = await api.command('state');
      render();
    } catch (error) {
      fail(error);
    } finally {
      updating = false;
      if (queued) {
        queued = false;
        setTimeout(update, 100);
      }
    }
  }
  const json = (value) => e('pre', JSON.stringify(value, null, 2));
  function details(value) {
    const stepId = value?.id;
    selection = value;
    $('detail-body').replaceChildren();
    if (!value) return;
    if (value.target) value = { ...value, ...value.target };
    $('detail-body').append(
      e('h3', value.tag ? `<${value.tag}> 元素` : '步骤详情'),
      json(value),
    );
    if (value.unstableAttributes?.length)
      $('detail-body').append(
        e(
          'p',
          '不稳定属性：' +
            value.unstableAttributes.join('、') +
            '。优先使用语义属性或验证过的结构路径。',
          'warning',
        ),
      );
    if (value.selector) {
      if (value.semantic)
        $('detail-body').append(
          button('复制 Role / Label 建议', () =>
            cmd('copy', {
              text: JSON.stringify({
                frame: value.frame || 'main',
                roots: value.roots || [],
                ...value.semantic,
              }),
            }),
          ),
        );
      for (const locator of value.locators || [
        { kind: 'css', selector: value.selector },
      ])
        $('detail-body').append(
          button('复制 CSS', () =>
            cmd('copy', {
              text: JSON.stringify({
                frame: value.frame || 'main',
                roots: value.roots || [],
                ...locator,
              }),
            }),
          ),
          button('验证 ' + locator.count + ' 个匹配', async () => {
            const r = await cmd('validate', {
              ...locator,
              roots: value.roots || [],
              frame: value.frame || 'main',
            });
            notify(
              '当前匹配 ' + r.count + ' 个' + (r.error ? ' · ' + r.error : ''),
            );
          }),
        );
      if (value.xpath)
        $('detail-body').append(
          button('复制 XPath', () =>
            cmd('copy', {
              text: JSON.stringify({
                kind: 'xpath',
                selector: value.xpath,
                frame: value.frame || 'main',
              }),
            }),
          ),
        );
      $('detail-body').append(
        button('重新高亮', () =>
          cmd('highlight', {
            selector: value.selector,
            kind: 'css',
            frame: value.frame || 'main',
            roots: value.roots || [],
          }),
        ),
      );
    }
    if (stepId && state.report?.steps.some((s) => s.id === stepId)) {
      const area = e('textarea');
      area.value = value.note || '';
      area.placeholder = '步骤目的、需要等待的状态（不要填写凭据）';
      $('detail-body').append(
        area,
        button('保存步骤说明', () =>
          cmd('note', { id: stepId, note: area.value }),
        ),
        button(
          '删除此步骤',
          () =>
            confirm('删除此操作步骤？保留其他录制内容。', () =>
              cmd('delete-step', { id: stepId }),
            ),
          'danger',
        ),
      );
    }
    document.querySelector('.layout').classList.remove('detail-collapsed');
  }
  async function confirm(text, fn) {
    $('confirmation-text').textContent = text;
    $('confirmation').showModal();
    return new Promise((resolve) => {
      const close = () => {
        $('confirmation').close();
        resolve();
      };
      $('confirmation-cancel').onclick = close;
      $('confirmation-ok').onclick = async () => {
        try {
          await fn();
          close();
        } catch (error) {
          fail(error);
        }
      };
    });
  }
  function table(headers, rows) {
    const t = e('table'),
      head = e('thead'),
      tr = e('tr');
    for (const h of headers) tr.append(e('th', h));
    head.append(tr);
    t.append(head);
    const body = e('tbody');
    for (const row of rows) {
      const tr = e('tr');
      for (const v of row) {
        const td = e('td');
        if (v instanceof Node) td.append(v);
        else td.textContent = String(v ?? '');
        tr.append(td);
      }
      body.append(tr);
    }
    t.append(body);
    return t;
  }
  const snapshot = () => state?.report?.snapshots.at(-1);
  function render() {
    if (!state) return;
    const savedScroll = $('workspace').scrollTop,
      focused = document.activeElement.id,
      drafts = new Map(
        [...document.querySelectorAll('input[id],textarea[id],select[id]')]
          .filter((n) => !['environment', 'live'].includes(n.id))
          .map((n) => [n.id, { value: n.value, selection: n.selectionStart }]),
      );
    requestAnimationFrame(() => {
      $('workspace').scrollTop = savedScroll;
      for (const [id, d] of drafts) {
        const node = $(id);
        if (node) {
          node.value = d.value;
          if (id === focused) {
            node.focus({ preventScroll: true });
            try {
              node.setSelectionRange(d.selection, d.selection);
            } catch {}
          }
        }
      }
    });
    const selectedEnv = $('environment').value || state.active;
    const options = state.profiles.map((p) => {
      const o = e('option', p.name + (p.leased ? ' · 自动任务中' : ''));
      o.value = p.id;
      return o;
    });
    $('environment').replaceChildren(...options);
    if (options.some((o) => o.value === selectedEnv))
      $('environment').value = selectedEnv;
    $('record-status').textContent =
      {
        ready: '已连接',
        recording: '录制中',
        paused: '已暂停',
        ended: '录制完成',
        interrupted: '上次录制已中断',
      }[state.report?.status] || '未连接';
    const f = snapshot()?.frames?.[0];
    $('page-info').textContent = f
      ? `${f.title || ''} · ${f.url || ''} · ${f.readyState || ''}`
      : '连接已打开的原环境，保留原登录状态';
    const connected = !!state.report;
    for (const id of ['reveal', 'new', 'refresh', 'live', 'start'])
      $(id).disabled = !connected;
    $('start').disabled =
      !connected || ['recording', 'paused'].includes(state.report.status);
    $('pause').disabled = state.report?.status !== 'recording';
    $('resume').disabled = !['paused', 'interrupted', 'ended'].includes(
      state.report?.status,
    );
    $('stop').disabled = !['recording', 'paused'].includes(
      state.report?.status,
    );
    $('attach').disabled =
      state.profiles.length === 0 ||
      ['recording', 'paused'].includes(state.report?.status);
    $('live').checked = state.live;
    for (const b of document.querySelectorAll('[data-page]'))
      b.classList.toggle('active', b.dataset.page === page);
    const a = $('actions'),
      w = $('workspace');
    a.replaceChildren();
    w.replaceChildren();
    if (!connected && page !== 'reports') {
      w.append(
        e('p', '请在账号环境管理中打开需要调试的环境，然后连接。', 'empty'),
      );
      return;
    }
    if (state.lastError) w.append(e('p', state.lastError, 'warning'));
    if (page === 'structure') {
      const input = e('input');
      input.id = 'tools-search';
      input.placeholder = '搜索文本、标签、ID、Class、Role';
      input.value = search;
      input.oninput = () => {
        search = input.value;
        renderNodes(w);
      };
      a.append(
        input,
        button('保存结构快照', () => cmd('snapshot')),
        e('span', `已保存 ${state.report.snapshots.length} 份快照`, 'muted'),
      );
      renderNodes(w);
    } else if (page === 'inspect') {
      a.append(
        button(
          state.inspecting ? '关闭检查模式' : '开启元素检查',
          () => cmd('inspect', { enabled: !state.inspecting }),
          'primary',
        ),
      );
      w.append(
        e(
          'p',
          '开启后在原网页移动鼠标高亮，点击选取元素。该次选取不会触发网页按钮；选取后检查模式自动关闭。',
        ),
      );
      const selector = e('textarea');
      selector.id = 'tools-selector';
      selector.placeholder =
        '输入 CSS Selector 或 XPath，验证当前框架中的匹配数量';
      const kind = e('select');
      kind.id = 'tools-kind';
      for (const k of ['css', 'xpath']) {
        const o = e('option', k.toUpperCase());
        o.value = k;
        kind.append(o);
      }
      const frame = e('select');
      frame.id = 'tools-frame';
      for (const f of snapshot()?.frames || []) {
        const o = e('option', f.key + (f.unavailable ? ' · 暂不可访问' : ''));
        o.value = f.key;
        frame.append(o);
      }
      w.append(
        selector,
        kind,
        frame,
        button('验证定位器', async () =>
          details(
            await cmd('validate', {
              selector: selector.value,
              kind: kind.value,
              frame: frame.value,
            }),
          ),
        ),
        e(
          'p',
          'Shadow DOM 目标请从元素详情复制含 roots 的定位信息。跨框架按 frame 分别验证；未开放的根不会绕过。',
        ),
      );
      if (state.report.selected) details(state.report.selected);
    } else if (page === 'record') {
      const note = e('input');
      note.id = 'tools-note';
      note.placeholder = '添加当前步骤目的或关键状态备注';
      a.append(
        note,
        button('添加备注', () => cmd('note', { note: note.value })),
        button('录制补充片段', () => cmd('resume')),
      );
      w.append(
        table(
          ['步骤 / 时间', '操作', '目标 / 框架', '前后变化', '详情'],
          state.report.steps.map((s, i) => [
            `${i + 1} · ${time(s.time)}`,
            s.type,
            (s.target?.tag || '') +
              ' ' +
              (s.target?.text || s.url || s.note || '') +
              ' / ' +
              (s.frame || 'main'),
            s.diff ? `${s.diff.total} 处` : '待后续快照',
            button('详情 / 编辑', () => details(s)),
          ]),
        ),
      );
      w.append(
        e(
          'p',
          '删除无关步骤后可继续录制补充片段；新步骤保留真实时间顺序。输入值和文件路径均不记录。',
        ),
      );
    } else if (page === 'changes') {
      const before = e('select'),
        after = e('select');
      for (const s of state.report.snapshots) {
        for (const sel of [before, after]) {
          const o = e('option', time(s.time) + ' · ' + s.id.slice(0, 8));
          o.value = s.id;
          sel.append(o);
        }
      }
      after.value = snapshot()?.id || '';
      before.value = state.report.snapshots.at(-2)?.id || snapshot()?.id || '';
      a.append(
        before,
        after,
        button('对比快照', async () => {
          diff = await cmd('compare', {
            before: before.value,
            after: after.value,
          });
          renderDiff(w);
        }),
        button('删除前快照', () =>
          confirm('删除此结构快照及关联截图？', () =>
            cmd('delete-snapshot', { id: before.value }),
          ),
        ),
      );
      if (diff) renderDiff(w);
      else
        w.append(
          e('p', '保存至少两份快照后对比新增、移除、属性与可见状态变化。'),
        );
      const history = e('select');
      for (const r of state.reports.filter((r) => r.id !== state.report.id)) {
        const o = e('option', r.name);
        o.value = r.id;
        history.append(o);
      }
      w.append(
        e('h3', '与历史流程对比'),
        history,
        button('对比历史最后快照', async () => {
          diff = await cmd('historical', { id: history.value });
          renderDiff(w);
        }),
      );
      const row = e('section', undefined, 'card');
      row.append(e('h3', '截图对照'));
      for (const s of state.report.screenshots.slice(-2)) {
        const img = e('img', undefined, 'shot');
        img.src = s.data;
        img.alt = '脱敏截图 ' + time(s.time);
        row.append(e('p', time(s.time)), img);
      }
      w.append(row);
    } else if (page === 'scripts') {
      a.append(
        button('刷新执行监控', async () => {
          const tasks = await cmd('task-state');
          renderTasks(w, tasks);
        }),
        button('保存异常页面快照', () => cmd('snapshot')),
      );
      w.append(
        e(
          'p',
          '发布引擎共用原环境与任务 ID。操作开始、完成、耗时、失败原因和定位器记录在下方；任务暂停 / 继续 / 取消沿用现有提交保护。',
        ),
      );
      w.append(
        table(
          ['时间', '任务 / 操作', '阶段 / 耗时', '定位 / 错误', '详情'],
          state.report.scripts.map((s) => [
            time(s.time),
            (s.taskId || '').slice(0, 8) + ' / ' + s.operation,
            s.phase + ' / ' + (s.durationMs || 0) + ' ms',
            s.message || s.reason || JSON.stringify(s.locator || {}),
            button('定位差异', () => details(s)),
          ]),
        ),
      );
      const comparison = e('details');
      comparison.append(
        e('summary', '人工流程与脚本定位对照'),
        table(
          ['人工步骤 / 目标', '脚本使用次数', '最近结果 / 定位差异'],
          state.report.steps
            .filter((s) => s.target?.selector)
            .map((s) => {
              const selectors = new Set([
                s.target.selector,
                ...(s.target.locators || []).map((l) => l.selector),
              ]);
              const matches = state.report.scripts.filter((r) =>
                selectors.has(r.locator?.selector),
              );
              const last = matches.at(-1);
              return [
                s.note || s.target.text || s.target.selector,
                matches.length,
                last
                  ? last.phase + ' · ' + (last.reason || last.operation)
                  : '脚本未使用相同定位器，请结合语义和页面状态核对',
              ];
            }),
        ),
      );
      w.append(comparison);
    } else if (page === 'reports') renderReports(a, w);
  }
  function renderNodes(w) {
    w.querySelector('#nodes')?.remove();
    const list = e('div');
    list.id = 'nodes';
    for (const f of snapshot()?.frames || []) {
      list.append(e('h3', f.key + ' · ' + (f.url || '框架暂不可访问')));
      if (f.truncated)
        list.append(
          e(
            'p',
            '快照已达到采样范围上限。请使用搜索或排除无关区域。',
            'warning',
          ),
        );
      for (const n of f.nodes || []) {
        if (
          search &&
          !JSON.stringify([n.text, n.tag, n.attributes])
            .toLowerCase()
            .includes(search.toLowerCase())
        )
          continue;
        const b = button('', () => details({ ...n, frame: f.key }), 'node');
        b.style.paddingLeft = Math.min(n.depth * 10, 70) + 'px';
        b.append(
          e('span', '<' + n.tag + '>', 'tag'),
          e('span', n.text || n.attributes.id || n.attributes.role || ''),
          e(
            'small',
            `${n.visible ? '可见' : '隐藏'} · ${n.enabled ? '启用' : '禁用'}${n.shadow ? ' · ' + n.shadow : ''}`,
          ),
        );
        list.append(b);
      }
    }
    w.append(list);
  }
  function renderDiff(w) {
    w.replaceChildren(
      e(
        'p',
        `总计 ${diff.total} 处变化${diff.urlChanged ? '，网址发生变化' : ''}${diff.truncated ? '（仅显示前 100 处）' : ''}`,
      ),
      table(
        ['变化', '元素 / 路径', '详情'],
        diff.changes.map((c) => [
          c.kind,
          (c.after || c.before).tag + ' ' + (c.after || c.before).selector,
          button('前后属性', () => details(c)),
        ]),
      ),
    );
    if (diff.locatorChecks)
      w.append(
        e('h3', '历史步骤定位器核对'),
        table(
          ['原步骤 / 框架', '定位器', '当前匹配 / 提示'],
          diff.locatorChecks.map((c) => [
            c.locator.stepId?.slice(0, 8) + ' / ' + c.frame,
            c.locator.selector,
            `${c.count} 个${c.error ? ' · ' + c.error : c.count === 0 ? ' · 目标失效或页面尚未就绪' : c.count > 1 ? ' · 目标不唯一' : ' · 可定位（仍需核对语义）'}`,
          ]),
        ),
      );
  }
  function renderTasks(w, tasks) {
    const old = w.querySelector('#tasks');
    old?.remove();
    const box = e('section', undefined, 'card');
    box.id = 'tasks';
    box.append(
      e('h3', '当前环境任务'),
      table(
        ['任务', '状态 / 等待', '操作'],
        tasks.map((t) => {
          const actions = e('div', undefined, 'row');
          for (const [label, action] of [
            ['暂停', 'pause'],
            ['继续', 'start'],
            ['终止', 'cancel'],
          ])
            actions.append(
              button(label, () =>
                action === 'cancel'
                  ? confirm(
                      '终止此调试任务？提交结果不明确时仍需人工核实。',
                      () => cmd('task-action', { id: t.id, action }),
                    )
                  : cmd('task-action', { id: t.id, action }),
              ),
            );
          return [
            t.id.slice(0, 8),
            t.status + ' ' + (t.queue?.message || t.reason),
            actions,
          ];
        }),
      ),
    );
    w.prepend(box);
  }
  function renderReports(a, w) {
    a.append(
      button('预览导出资料', async () => {
        const d = await cmd('preview');
        details(d);
        notify('已显示当前资料，请检查文本与截图后再导出。');
      }),
    );
    for (const format of ['json', 'html', 'md', 'zip'])
      a.append(
        button(
          '导出 ' + format.toUpperCase(),
          async () => {
            const r = await cmd('export', { format });
            if (r.saved) notify('已保存到你选择的本地文件。');
          },
          format === 'zip' ? 'primary' : '',
        ),
      );
    if (state.report) {
      const card = e('section', undefined, 'card');
      card.append(e('h3', '隐私与录制配置'));
      const text = e('input');
      text.type = 'checkbox';
      text.checked = state.report.options.includeText !== false;
      const label = e('label', '保留脱敏后的页面文本（输入值始终排除）');
      label.prepend(text);
      const shot = e('input');
      shot.type = 'checkbox';
      shot.checked = state.report.options.screenshots;
      const label2 = e(
        'label',
        '主动开启严格脱敏截图（输入区、媒体和非白名单文本遮盖）',
      );
      label2.prepend(shot);
      const exclude = e('textarea');
      exclude.id = 'tools-exclude';
      exclude.placeholder =
        '额外排除的 CSS 选择器，每行一个，例如 .account-name';
      exclude.value = (state.report.options.exclude || []).join('\n');
      card.append(
        label,
        e('br'),
        label2,
        exclude,
        button('保存隐私配置', () =>
          cmd('options', {
            includeText: text.checked,
            screenshots: shot.checked,
            exclude: exclude.value
              .split('\n')
              .map((s) => s.trim())
              .filter(Boolean),
          }),
        ),
        button('保存当前脱敏截图', () => cmd('screenshot')),
      );
      w.append(card);
      for (const s of state.report.screenshots) {
        const c = e('section', undefined, 'card'),
          img = e('img', undefined, 'shot');
        img.src = s.data;
        img.alt = '待审阅脱敏截图';
        c.append(
          e('h3', time(s.time) + (s.reviewed ? ' · 已确认' : ' · 待确认')),
          img,
          button('确认此截图可导出', () => cmd('review-shot', { id: s.id })),
          button('删除截图', () => cmd('delete-shot', { id: s.id }), 'danger'),
        );
        w.append(c);
      }
      for (const warning of state.report.warnings)
        w.append(e('p', warning, 'warning'));
    }
    w.append(
      e('h3', '本地报告'),
      table(
        ['名称 / 更新时间', '状态 / 步骤', '操作'],
        state.reports.map((r) => {
          const actions = e('div', undefined, 'row');
          actions.append(
            button('加载', () => cmd('load', { id: r.id })),
            button(
              '删除',
              () =>
                confirm(
                  '删除此本地报告及其截图？不会删除账号、视频或平台作品。',
                  () => cmd('delete-report', { id: r.id }),
                ),
              'danger',
            ),
          );
          return [
            r.name + ' · ' + new Date(r.updated).toLocaleString('zh-CN'),
            r.status + ' / ' + r.steps,
            actions,
          ];
        }),
      ),
    );
  }
  for (const b of document.querySelectorAll('[data-page]'))
    b.onclick = () => {
      page = b.dataset.page;
      render();
    };
  for (const name of [
    'start',
    'pause',
    'resume',
    'stop',
    'new',
    'refresh',
    'reveal',
  ])
    $(name).onclick = () => cmd(name).catch(fail);
  $('attach').onclick = () =>
    cmd('attach', { id: $('environment').value }).catch(fail);
  $('live').onchange = () =>
    cmd('live', { enabled: $('live').checked }).catch(fail);
  $('detail-toggle').onclick = () =>
    document.querySelector('.layout').classList.toggle('detail-collapsed');
  api.onChanged(() => {
    clearTimeout(window.__developerRefresh);
    window.__developerRefresh = setTimeout(update, 150);
  });
  update();
})();
