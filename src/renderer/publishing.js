'use strict';
(() => {
  const api = window.publishingAPI,
    root = document.getElementById('publishing-module');
  const E = (tag, cls, value) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (value !== undefined) e.textContent = String(value);
    return e;
  };
  const names = {
    video: '视频发布',
    image: '图文发布',
    article: '文章发布',
    tasks: '任务列表',
    history: '发布记录',
    materials: '视频素材库',
    library: '标题与话题库',
  };
  const statuses = {
    pending: '待执行',
    running: '执行中',
    paused: '已暂停',
    manual: '需要人工处理',
    submitted: '已提交',
    review: '审核中',
    success: '发布成功',
    failed: '发布失败',
    unverified: '结果待核实',
    cancelled: '已取消',
  };
  const iconFor = (id) =>
    data?.platforms.find((p) => p.id === id)?.iconResource ||
    '../assets/qiye.png';
  let updateTaskRows = null;
  let data = null,
    page = 'video',
    step = 0,
    ready = false,
    refreshJob = null,
    refreshTimer,
    draftTimer,
    preview = null,
    filters = {},
    selected = new Set(),
    scroll = {};
  const freshInput = () => ({
    videoIds: [],
    platformIds: ['douyin'],
    accountIds: [],
    title: { mode: 'reuse', scope: 'video', values: [], locks: {} },
    topics: { mode: 'reuse', scope: 'video', values: [], locks: {} },
    distribution: { mode: 'sequence' },
    cover: { mode: 'first' },
    location: { mode: 'none' },
    nativeSchedule: null,
    covers: {},
    locations: {},
    schedule: {
      mode: 'now',
      intervalMinutes: 10,
    },
    autoSubmit: false,
    overrides: {},
    previewOrder: [],
  });
  let input = freshInput();
  const notify = (message, type = 'success') =>
    window.publishingNotify
      ? window.publishingNotify(message, type)
      : window.browserAPI?.showToast({ message, type });
  const cmd = (command, value) => api.command(command, value);
  const safe =
    (fn) =>
    async (...args) => {
      try {
        return await fn(...args);
      } catch (error) {
        notify(error.message || String(error), 'error');
      }
    };
  function B(label, fn, primary = false) {
    const b = E(
      'button',
      'button ' + (primary ? 'button-primary' : 'button-secondary'),
      label,
    );
    b.type = 'button';
    b.addEventListener('click', safe(fn));
    return b;
  }
  function textButton(label, fn) {
    const b = B(label, fn);
    b.className = 'text-button';
    return b;
  }
  function field(label, type, value, onChange) {
    const l = E('label', 'publish-control', label),
      c = E(type === 'textarea' ? 'textarea' : 'input');
    if (type !== 'textarea') c.type = type;
    c.value = value ?? '';
    c.addEventListener('input', () => {
      onChange(c.value);
      saveSoon();
    });
    l.append(c);
    return l;
  }
  function choice(label, options, value, onChange) {
    const l = E('label', 'publish-control', label),
      c = E('select');
    c.setAttribute('aria-label', label);
    for (const [id, name] of options) {
      const o = E('option', '', name);
      o.value = id;
      c.append(o);
    }
    c.value = value;
    c.addEventListener(
      'change',
      safe(async () => {
        await onChange(c.value);
        saveSoon();
      }),
    );
    l.append(c);
    return l;
  }
  function check(label, value, onChange) {
    const l = E('label', 'publish-inline'),
      c = E('input');
    c.type = 'checkbox';
    c.checked = !!value;
    c.addEventListener('change', () => {
      onChange(c.checked);
      saveSoon();
    });
    l.append(c, E('span', '', label));
    return l;
  }
  function panel(title) {
    const n = E('section', 'publish-panel');
    if (title) n.append(E('h2', '', title));
    return n;
  }
  const expandedSections = new Map();
  function disclosure(label, key) {
    const d = E('details', 'publish-advanced');
    d.append(E('summary', '', label));
    d.open = expandedSections.get(key) === true;
    d.addEventListener('toggle', () => expandedSections.set(key, d.open));
    return d;
  }
  function locationText(location) {
    const identity = (p) => p.label + (p.address ? ' · ' + p.address : '');
    return identity(location) + (location.fallback ? '\n备选：' + identity(location.fallback) : '');
  }
  function note(text, warning = false) {
    return E('p', 'publish-notice' + (warning ? ' publish-warning' : ''), text);
  }
  function image(src, cls = '') {
    const e = E('img', cls);
    e.src = src;
    e.alt = '';
    e.draggable = false;
    return e;
  }
  const date = (v) => new Date(v).toLocaleString('zh-CN', { hour12: false });
  const local = (v) => {
    const d = new Date(v);
    return new Date(d - d.getTimezoneOffset() * 60000)
      .toISOString()
      .slice(0, 16);
  };
  function rowOverride(row, patch) {
    input.overrides ||= {};
    input.overrides[row.key] = { ...input.overrides[row.key], ...patch };
    saveSoon();
  }
  function lockRow(row, locked) {
    row.locked = locked;
    input.title.locks ||= {};
    input.topics.locks ||= {};
    if (locked) {
      input.title.locks[row.key] = row.title;
      input.topics.locks[row.key] = row.topics;
      rowOverride(row, {
        locked,
        cover: row.cover,
        location: row.location,
        nativeSchedule: row.nativeSchedule,
        autoSubmit: row.autoSubmit,
      });
    } else {
      delete input.title.locks[row.key];
      delete input.topics.locks[row.key];
      row.titleLocked = false;
      row.topicsLocked = false;
      rowOverride(row, { locked: false });
    }
  }
  function hydratePreview() {
    for (const row of preview.rows) {
      row.title = input.title.locks?.[row.key] ?? row.title;
      row.topics = input.topics.locks?.[row.key] ?? row.topics;
      const override = input.overrides?.[row.key];
      if (override) {
        for (const key of [
          'cover',
          'location',
          'nativeSchedule',
          'autoSubmit',
          'locked',
          'cancelled',
        ])
          if (Object.hasOwn(override, key))
            row[key] = structuredClone(override[key]);
      }
    }
    const order = new Map((input.previewOrder || []).map((key, i) => [key, i]));
    preview.rows.sort(
      (a, b) => (order.get(a.key) ?? 1e9) - (order.get(b.key) ?? 1e9),
    );
  }
  function saveSoon() {
    clearTimeout(draftTimer);
    draftTimer = setTimeout(
      () =>
        cmd('draft', { input, step, previewId: preview?.previewId }).catch(
          (e) => notify(e.message, 'error'),
        ),
      500,
    );
  }
  function saveUI() {
    cmd('ui', { page, step, scroll }).catch(() => {});
  }
  function remember() {
    const body = root.querySelector('.publish-body');
    if (body) scroll[page] = body.scrollTop;
  }
  function refresh(render = false) {
    // A mutation must obtain a fresh snapshot even if an older read is in flight.
    if (refreshJob) return refreshJob.then(() => refresh(render));
    refreshJob = readState(render).finally(() => {
      refreshJob = null;
    });
    return refreshJob;
  }
  async function readState(render) {
    try {
      const previous = data;
      data = await cmd('state');
      if (
        ready &&
        ['materials', 'library'].includes(page) &&
        JSON.stringify([
          previous?.videos,
          previous?.library,
          previous?.covers,
          previous?.locations,
        ]) !==
          JSON.stringify([
            data.videos,
            data.library,
            data.covers,
            data.locations,
          ])
      )
        render = true;
      if (
        ready &&
        ['video'].includes(page) &&
        ((step === 0 && previous?.videos.length !== data.videos.length) ||
          (step === 2 &&
            JSON.stringify(
              previous?.accounts.map((a) => [a.id, a.platformId]),
            ) !==
              JSON.stringify(data.accounts.map((a) => [a.id, a.platformId]))))
      )
        render = true;
      if (!ready) {
        const draft = data.drafts.find((d) => d.id === 'current');
        if (draft?.data?.input) {
          input = draft.data.input;
          const retired = !['sequence', 'single'].includes(input.distribution?.mode) || (input.schedule?.mode && input.schedule.mode !== 'now');
          input.schedule = { mode: 'now', intervalMinutes: input.schedule?.intervalMinutes ?? 10 };
          for (const override of Object.values(input.overrides || {})) delete override.plannedAt;
          if (!['sequence', 'single'].includes(input.distribution?.mode)) input.distribution = { mode: 'sequence' };
          step = retired ? Math.min(3, draft.data.step || 0) : draft.data.step || 0;
          const saved = data.drafts.find(
            (d) => d.id === `preview:${draft.data.previewId}`,
          );
          if (saved && !retired) {
            preview = {
              previewId: draft.data.previewId,
              rows: structuredClone(saved.data.rows),
            };
            hydratePreview();
          }
        }
        page = data.ui.page === 'plan' ? 'tasks' : names[data.ui.page] ? data.ui.page : 'video';
        step = Math.min(4, Math.max(0, draft ? step : data.ui.step ?? 0));
        scroll = data.ui.scroll || {};
        ready = true;
        render = true;
      }
      if (render) {
        remember();
        draw();
      } else if (
        ['tasks', 'history'].includes(page) &&
        !document.querySelector('.publish-dialog[open]')
      ) {
        if (updateTaskRows) updateTaskRows();
        else {
          remember();
          draw();
        }
      }
    } catch (error) {
      if (!ready) {
        const message = error.message.includes('No handler registered')
          ? '内容发布中心正在准备…'
          : error.message;
        root.replaceChildren(E('p', 'publish-error', message));
      }
    }
  }
  function go(next) {
    if (!names[next]) return;
    remember();
    page = next;
    selected.clear();
    filters = {};
    saveUI();
    draw();
  }
  function draw() {
    if (!data) return;
    updateTaskRows = null;
    root.replaceChildren();
    const head = E('header', 'publish-header'),
      copy = E('div');
    copy.append(
      E('h1', '', names[page]),
      E(
        'p',
        '',
        page === 'video'
          ? '导入素材、选择原有账号环境，预览并确认本地发布任务。'
          : '本地保存，与现有账号环境关联。',
      ),
    );
    head.append(copy);
    const actions = E('div', 'publish-actions');
    actions.append(
      B('备份数据', async () => {
        const r = await cmd('backup');
        if (r.saved) notify('发布数据库已备份');
      }),
    );
    head.append(actions);
    root.append(head);
    if (['video'].includes(page)) wizard();
    else {
      const body = E('div', 'publish-body');
      root.append(body);
      if (['image', 'article'].includes(page))
        body.append(
          note(
            '规划中：本期仅开放抖音视频发布。此页面保留框架，未提供实际发布能力。',
          ),
        );
      else if (['tasks', 'history'].includes(page)) tasks(body);
      else if (page === 'materials') materials(body, false);
      else if (page === 'library') library(body);
    }
    const body = root.querySelector('.publish-body');
    body.scrollTop = scroll[page] || 0;
    body.addEventListener(
      'scroll',
      () => {
        scroll[page] = body.scrollTop;
        saveUI();
      },
      { passive: true },
    );
    window.dispatchEvent(
      new CustomEvent('publishing:selected', { detail: page }),
    );
  }
  async function importVideos(command = 'files', files) {
    const r = await cmd(command, files);
    if (r.cancelled) return;
    await refresh();
    input.videoIds = [...new Set([...input.videoIds, ...r.added])];
    saveSoon();
    draw();
    notify(
      `导入 ${r.added.length} 条，重复 ${r.duplicates.length} 条，失败 ${r.errors.length} 条`,
      r.errors.length ? 'info' : 'success',
    );
    if (r.errors.length)
      show(
        '导入结果',
        r.errors.map((e) => E('p', 'publish-help', `${e.name}：${e.reason}`)),
      );
  }
  function table(headers) {
    const wrap = E('div', 'publish-table-wrap'),
      t = E('table', 'publish-table'),
      h = E('thead'),
      row = E('tr');
    headers.forEach((v) => row.append(E('th', '', v)));
    h.append(row);
    const body = E('tbody');
    t.append(h, body);
    wrap.append(t);
    return { wrap, body };
  }
  function cell(row, node) {
    const c = E('td');
    c.append(
      node instanceof Node ? node : document.createTextNode(String(node ?? '')),
    );
    row.append(c);
    return c;
  }
  function selectBox(id, set) {
    const c = E('input');
    c.type = 'checkbox';
    c.checked = set.has(id);
    c.setAttribute('aria-label', '选择');
    c.addEventListener('change', () => {
      c.checked ? set.add(id) : set.delete(id);
    });
    return c;
  }
  function previewVideo(v) {
    const video = E('video');
    video.controls = true;
    video.src = v.mediaUrl || `qiye-media://local/video/${v.id}`;
    show(
      v.name,
      [
        video,
        E(
          'p',
          'publish-help',
          `${v.width} × ${v.height} · ${v.duration.toFixed(1)} 秒 · ${(v.bytes / 1048576).toFixed(1)} MB`,
        ),
        E('p', 'publish-help', v.path),
      ],
      null,
      () => {
        video.pause();
        video.removeAttribute('src');
        video.load();
      },
    );
  }
  function materials(body, inWizard) {
    const toolbar = E('div', 'publish-toolbar');
    toolbar.append(
      B('导入视频', () => importVideos()),
      B('导入文件夹', () => importVideos('folder')),
      B('检查文件', async () => {
        const r = await cmd('file-check');
        show(
          '文件检查',
          r.map((v) =>
            E(
              'p',
              'publish-help',
              `${data.videos.find((x) => x.id === v.id)?.name}：${v.valid ? '有效' : v.reason}`,
            ),
          ),
        );
      }),
    );
    const search = E('input', 'publish-filter');
    search.type = 'search';
    search.placeholder = '搜索视频名称或分组';
    search.value = filters.materials || '';
    search.addEventListener('input', () => {
      filters.materials = search.value;
      fill();
    });
    toolbar.append(search);
    body.append(toolbar);
    const drop = E(
      'div',
      'publish-drop',
      '拖入视频文件，或从本地文件夹导入。保留本地路径引用，不复制原视频。',
    );
    for (const name of ['dragenter', 'dragover'])
      drop.addEventListener(name, (e) => {
        e.preventDefault();
        drop.classList.add('dragging');
      });
    drop.addEventListener('dragleave', () => drop.classList.remove('dragging'));
    drop.addEventListener(
      'drop',
      safe(async (e) => {
        e.preventDefault();
        drop.classList.remove('dragging');
        const paths = api.paths(Array.from(e.dataTransfer.files));
        await importVideos('import', paths);
      }),
    );
    body.append(drop);
    const selection = new Set(inWizard ? input.videoIds : []),
      operations = E('div', 'publish-toolbar');
    operations.append(
      B('全选', () => {
        data.videos.filter(matches).forEach((v) => selection.add(v.id));
        commit();
        fill();
      }),
      B('取消选择', () => {
        selection.clear();
        commit();
        fill();
      }),
    );
    if (!inWizard) {
      operations.append(
        B('删除选中记录', () => deleteResources([...selection])),
        B('删除当前筛选记录', () =>
          deleteResources(data.videos.filter(matches).map((v) => v.id)),
        ),
        B('设置分组', () =>
          editText('素材分组', '分组名称', '', async (group) => {
            for (const id of selection)
              await cmd('resource-edit', { id, kind: 'video', group });
            await refresh(true);
          }),
        ),
      );
    }
    operations.append(
      E('span', 'publish-metric', `${data.videos.length} 条本地素材`),
    );
    operations.append(more);
    body.append(operations);
    const { wrap, body: rows } = table([
      '选择',
      '视频',
      '名称 / 分组',
      '时长',
      '分辨率',
      '大小 / 格式',
      '操作',
    ]);
    body.append(wrap);
    function matches(v) {
      const q = (filters.materials || '').toLowerCase();
      return !q || `${v.name} ${v.group}`.toLowerCase().includes(q);
    }
    function commit() {
      if (inWizard) {
        input.videoIds = [...selection];
        saveSoon();
      }
    }
    function fill() {
      rows.replaceChildren();
      const list = inWizard
        ? [...data.videos].sort((a, b) => {
            const ai = input.videoIds.indexOf(a.id),
              bi = input.videoIds.indexOf(b.id);
            return (ai < 0 ? 1e9 : ai) - (bi < 0 ? 1e9 : bi);
          })
        : data.videos;
      for (const v of list.filter(matches)) {
        const r = E('tr');
        const c = selectBox(v.id, selection);
        c.addEventListener('change', commit);
        cell(r, c);
        cell(r, image(v.thumbnailData, 'video-thumb'));
        const info = E('div');
        info.append(
          E('strong', '', v.name),
          E('div', 'muted', v.group || '未分组'),
        );
        cell(r, info);
        cell(r, `${v.duration.toFixed(1)} 秒`);
        cell(r, `${v.width} × ${v.height}`);
        cell(r, `${(v.bytes / 1048576).toFixed(1)} MB / ${v.format}`);
        const actions = E('div', 'row-actions');
        actions.append(textButton('预览', () => previewVideo(v)));
        if (!inWizard)
          actions.append(textButton('删除记录', () => deleteResources([v.id])));
        if (inWizard && selection.has(v.id))
          actions.append(
            textButton('↑', () => moveVideo(v.id, -1)),
            textButton('↓', () => moveVideo(v.id, 1)),
            textButton('移除', () => {
              selection.delete(v.id);
              commit();
              fill();
            }),
          );
        cell(r, actions);
        rows.append(r);
      }
      if (!rows.children.length) {
        const row = E('tr'),
          td = cell(row, E('div', 'publish-empty', '暂无符合条件的视频'));
        td.colSpan = 7;
        rows.append(row);
      }
    }
    function moveVideo(id, delta) {
      const ids = [...selection],
        i = ids.indexOf(id),
        j = i + delta;
      if (j < 0 || j >= ids.length) return;
      [ids[i], ids[j]] = [ids[j], ids[i]];
      selection.clear();
      ids.forEach((v) => selection.add(v));
      commit();
      fill();
    }
    fill();
  }
  function resetWizard() {
    clearTimeout(draftTimer);
    input = freshInput();
    preview = null;
    step = 0;
    selected.clear();
    filters = {};
    scroll.video = 0;
    saveUI();
  }
  function deleteResources(ids) {
    if (!ids.length) throw new Error('请先选择记录');
    ask(
      `删除 ${ids.length} 条本地资源记录？不会删除原始视频或图片文件，也不会改变已确认任务。`,
      async () => {
        const result = await cmd('resource-remove', ids);
        input.videoIds = input.videoIds.filter((id) => !ids.includes(id));
        if (
          preview?.rows.some(
            (row) => ids.includes(row.videoId) || ids.includes(row.cover?.id),
          )
        ) {
          preview = null;
          step = Math.min(step, 3);
        }
        if (ids.includes(input.cover.id)) input.cover = { mode: 'first' };
        for (const map of [input.covers, input.overrides])
          for (const [key, value] of Object.entries(map || {}))
            if (ids.includes(value.id) || ids.includes(value.cover?.id))
              delete map[key];
        selected.clear();
        saveSoon();
        await refresh(true);
        notify(`已删除 ${result.removed} 条本地资源记录，原文件保留`);
      },
    );
  }
  function deleteTasks(ids) {
    if (!ids.length) throw new Error('请先选择任务');
    ask(
      `删除 ${ids.length} 条本地任务、计划、发布记录及日志？未执行任务将不再执行。不会删除平台作品或本地视频。执行中任务请先暂停；已提交或待核实任务请先核实结果。`,
      async () => {
        const r = await cmd('task-remove', { ids, confirmed: true });
        selected.clear();
        closeDialogs();
        await refresh(true);
        notify(`已删除 ${r.removed} 条本地任务记录`);
      },
    );
  }
  function wizard() {
    const steps = E('div', 'publish-steps');
    ['选择短视频', '选择平台', '选择账号', '配置参数', '任务预览'].forEach(
      (label, i) => {
        const n = E(
          'div',
          'publish-step' + (i === step ? ' current' : i < step ? ' done' : ''),
        );
        n.append(E('b', '', i < step ? '✓' : i + 1), E('span', '', label));
        steps.append(n);
      },
    );
    root.append(steps);
    const body = E('div', 'publish-body');
    root.append(body);
    if (step === 0) materials(body, true);
    else if (step === 1) platforms(body);
    else if (step === 2) accounts(body);
    else if (step === 3) configuration(body);
    else taskPreview(body);
    const foot = E('footer', 'publish-footer'),
      left = E('div', 'publish-actions'),
      right = E('div', 'publish-actions');
    left.append(
      B('保存草稿', async () => {
        await cmd('draft', { input, step, previewId: preview?.previewId });
        notify('发布草稿已保存');
      }),
      B('清空当前草稿', () =>
        ask(
          '清空本次选择、参数和预览，重新开始？已生成任务和素材库会保留。',
          async () => {
            clearTimeout(draftTimer);
            await cmd('draft-clear');
            resetWizard();
            await cmd('draft', { input, step, previewId: null });
            draw();
            notify('当前草稿已清空');
          },
        ),
      ),
    );
    if (step > 0)
      right.append(
        B('上一步', () => {
          step--;
          scroll[page] = 0;
          saveUI();
          draw();
        }),
      );
    if (step < 4)
      right.append(
        B(
          '下一步',
          async () => {
            if (step === 0 && !input.videoIds.length)
              throw new Error('请至少选择一条视频');
            if (step === 1 && !input.platformIds.length)
              throw new Error('请选择平台');
            if (step === 2 && !input.accountIds.length)
              throw new Error('请选择账号环境');
            if (step === 3) {
              preview = await cmd('preview', input);
            }
            step++;
            scroll[page] = 0;
            saveSoon();
            saveUI();
            draw();
          },
          true,
        ),
      );
    else right.append(B('确认生成并执行', () => confirmTasks(), true));
    foot.append(left, right);
    root.append(foot);
  }
  function platforms(body) {
    body.append(
      note(
        '第一期开放抖音视频发布，其他平台暂未开放。平台能力通过独立适配器管理。',
      ),
    );
    const grid = E('div', 'publish-platforms');
    for (const p of data.platforms) {
      const b = E(
        'button',
        'publish-choice' +
          (input.platformIds.includes(p.id) ? ' selected' : ''),
      );
      b.type = 'button';
      b.disabled = !p.enabled;
      const copy = E('span');
      copy.append(
        E('strong', '', p.name),
        E('small', '', p.enabled ? '已开放 · 复用原账号环境' : '暂未开放'),
      );
      b.append(image(iconFor(p.id)), copy);
      b.addEventListener('click', () => {
        input.platformIds = input.platformIds.includes(p.id)
          ? input.platformIds.filter((id) => id !== p.id)
          : [...input.platformIds, p.id];
        saveSoon();
        draw();
      });
      grid.append(b);
    }
    body.append(grid, note(data.platforms[0].note));
  }
  function accounts(body) {
    body.append(
      note(
        '选择原有抖音账号。多账号时按顺序分配，每条视频只发一个账号；单账号模式只选一个。已打开不等于已登录，执行时会检查。',
      ),
    );
    const eligible = data.accounts.filter((a) =>
        input.platformIds.includes(a.platformId),
      ),
      toolbar = E('div', 'publish-toolbar'),
      search = E('input', 'publish-filter');
    search.type = 'search';
    search.placeholder = '搜索账号环境';
    search.value = filters.accounts || '';
    search.addEventListener('input', () => {
      filters.accounts = search.value;
      fill();
    });
    toolbar.append(
      search,
      B('全选', () => {
        if (input.distribution.mode === 'single') throw new Error('此模式只允许选择一个账号');
        input.accountIds = eligible.map((a) => a.id);
        saveSoon();
        fill();
      }),
      B('取消选择', () => {
        input.accountIds = [];
        saveSoon();
        fill();
      }),
    );
    body.append(toolbar);
    const grid = E('div', 'publish-grid');
    body.append(grid);
    function fill() {
      grid.replaceChildren();
      for (const a of eligible.filter(
        (a) =>
          a.name.includes(filters.accounts || '') ||
          a.notes?.includes(filters.accounts || ''),
      )) {
        const l = E('label', 'publish-account'),
          c = E('input');
        c.type = input.distribution.mode === 'single' ? 'radio' : 'checkbox';
        if (c.type === 'radio') c.name = 'publishing-account';
        c.checked = input.accountIds.includes(a.id);
        c.addEventListener('change', () => {
          input.accountIds = c.checked && input.distribution.mode === 'single' ? [a.id] : c.checked
            ? [...new Set([...input.accountIds, a.id])]
            : input.accountIds.filter((id) => id !== a.id);
          saveSoon();
        });
        const copy = E('span', 'account-copy');
        copy.append(
          E('strong', '', a.name),
          E(
            'small',
            '',
            `${a.running ? '已打开' : '已保存'} · ${a.login.status === 'ready' ? '最近检查发布页可用' : a.login.status === 'manual' ? '需要人工检查' : '登录未核实'}`,
          ),
        );
        l.append(c, image(iconFor(a.platformId)), copy);
        grid.append(l);
      }
      if (!eligible.length)
        grid.append(
          E(
            'p',
            'publish-help',
            '暂无关联抖音的账号环境，请在“环境”中创建抖音预设环境，或明确关联下方已有自定义环境。',
          ),
        );
    }
    fill();
    const legacy = data.accounts.filter((a) => !a.platformId);
    if (legacy.length) {
      const p = panel('关联已有自定义环境');
      p.append(
        E(
          'p',
          'publish-help',
          '由你确认此环境用于抖音。仅保存发布中心关联，不修改原启动网址、平台图标或环境配置。',
        ),
      );
      for (const a of legacy) {
        const row = E('div', 'publish-toolbar');
        row.append(
          E('span', '', a.name),
          B('关联抖音', async () => {
            await cmd('bind', { id: a.id, platformId: 'douyin' });
            await refresh(true);
          }),
        );
        p.append(row);
      }
      body.append(p);
    }
  }
  function matchingConfig(kind, label) {
    const config = input[kind],
      p = panel(label),
      grid = E('div', 'publish-grid');
    grid.append(
      choice(
        '匹配模式',
        [
          ['fixed', '单个固定'],
          ['reuse', '单个复用全部'],
          ['sequence', '多个顺序循环'],
          ['random', '多个随机洗牌'],
        ],
        config.mode,
        (v) => {
          config.mode = v;
        },
      ),
      choice(
        '匹配范围',
        [
          ['video', '按视频：同视频各账号相同'],
          ['task', '按发布任务分别匹配'],
        ],
        config.scope,
        (v) => (config.scope = v),
      ),
    );
    p.append(grid.firstElementChild);
    const advanced = disclosure('更多匹配选项 / 文案库', 'matching-' + kind);
    advanced.append(grid);
    p.append(
      field(
        kind === 'topics' ? '话题组：每行一组，保留整组匹配' : '标题：每行一个',
        'textarea',
        config.values.join('\n'),
        (v) => (config.values = v.split(/\r?\n/)),
      ),
    );
    advanced.append(
      B('从文案库选取', () => {
        const resources = data.library
            .filter((r) => r.kind === kind)
            .sort((a, b) => a.order - b.order),
          picked = new Set();
        show(
          label + ' · 文案库',
          resources.map((r) =>
            check(r.value, false, (v) =>
              v ? picked.add(r.id) : picked.delete(r.id),
            ),
          ),
          async () => {
            config.values = resources
              .filter((r) => picked.has(r.id))
              .map((r) => r.value);
            saveSoon();
            draw();
          },
        );
      }),
      E(
        'p',
        'publish-help',
        '固定模式按匹配项顺序绑定并锁定；顺序不足时循环，随机每轮不重复。预览后可单独覆盖并锁定。',
      ),
    );
    p.append(advanced);
    return p;
  }
  function configuration(body) {
    body.append(
      matchingConfig('title', '标题配置'),
      matchingConfig('topics', '话题组配置'),
    );
    const p = panel('视频与账号分配');
    p.append(choice('分配方式', [['sequence', '一个视频发一个账号'], ['single', '单个账号发布多个视频']], input.distribution.mode, (v) => {
      input.distribution = { mode: v }; saveSoon(); draw();
    }));
    if (input.distribution.mode === 'single') {
      p.append(choice('发布账号', [['', '请选择一个账号'], ...data.accounts.filter((a) => input.platformIds.includes(a.platformId)).map((a) => [a.id, a.name])], input.accountIds.length === 1 ? input.accountIds[0] : '', (id) => {
        input.accountIds = id ? [id] : []; saveSoon();
      }));
    }
    p.append(E('p', 'publish-help', input.distribution.mode === 'single' ? '全部视频按顺序交给这个账号，每条视频只生成一条任务。' : '视频按排列顺序依次分给所选账号，账号用完后从第一个继续；每条视频只发一个账号。'));
    body.append(p);
    const cover = panel('封面与定位');
    cover.append(
      note(
        '默认封面沿用平台设置；自定义图片和指定帧仍需人工设置。指定位置在上传后搜索官方候选并核对；发布时间仅使用抖音官方定时。',
        true,
      ),
    );
    cover.append(
      coverControl(input.cover, (v) => {
        input.cover = v;
        saveSoon();
        draw();
      }),
      locationControl(input.location, (v) => {
        input.location = v;
        saveSoon();
      }),
    );
    const perVideo = E('div', 'publish-actions');
    perVideo.append(
      B('逐条视频设置', () => {
        const blocks = input.videoIds.map((id) => {
          const v = data.videos.find((v) => v.id === id),
            p = panel(v?.name || id);
          p.append(
            coverControl(
              input.covers[id] || input.cover,
              (c) => (input.covers[id] = c),
            ),
            locationControl(
              input.locations[id] || input.location,
              (l) => (input.locations[id] = l),
            ),
          );
          return p;
        });
        show('逐条视频封面 / 定位', blocks, () => {
          saveSoon();
        });
      }),
    );
    const individual = disclosure('按视频 / 账号单独设置', 'individual-options');
    individual.append(perVideo);
    individual.append(B('逐账号设置定位', () => {
      const blocks = input.accountIds.map((id) => { const p = panel(data.accounts.find((a) => a.id === id)?.name || id);
        p.append(locationControl(input.locations[id] || input.location, (value) => { input.locations[id] = value; }, id)); return p; });
      show('逐账号定位', blocks, () => saveSoon());
    }));
    cover.append(individual);
    body.append(cover);
    const native = panel('抖音官方定时');
    native.append(nativeControl(input.nativeSchedule, (v) => { input.nativeSchedule = v; saveSoon(); }, true));
    native.append(note('确认后直接进入上传队列，作品由抖音按官方时间安排发布。当前录制账号显示2小时后至14天内，执行时会核对账号实际范围及最终时间。审核、上传耗时和上线结果仍由平台决定。'));
    body.append(native);
    const advanced = disclosure('执行选项', 'execution-options');
    advanced.append(field('同一账号最小提交间隔（分钟）', 'number', input.schedule.intervalMinutes, (v) => { input.schedule.intervalMinutes = Number(v); }),
      E('p', 'publish-help', '任务确认后直接排队上传。此间隔仅防止同账号连续提交过密，不是本地定时；上传和提交时需要电脑运行并联网。'));
    body.append(advanced);
    const authorize = panel('提交授权');
    authorize.append(
      check(
        '授权本批次在检查通过后自动点击平台“发布”按钮（请先验证单条）',
        input.autoSubmit,
        (v) => (input.autoSubmit = v),
      ),
      E(
        'p',
        'publish-help',
        '未授权时自动上传及填写后暂停，由你审阅并提交。遇到验证码、账号限制或不明确结果，始终暂停等待处理。',
      ),
    );
    body.append(authorize);
  }
  function coverControl(value, onChange) {
    const p = E('div');
    const c = structuredClone(value || { mode: 'first' });
    p.append(
      choice(
        '封面方式',
        [
          ['first', '平台默认首帧'],
          ['frame', '指定视频帧（人工设置）'],
          ['image', '本地图片（人工设置）'],
        ],
        c.mode,
        (v) => {
          c.mode = v;
          if (v === 'frame') c.seconds ??= 0;
          onChange(c);
          p.replaceChildren(coverControl(c, onChange));
        },
      ),
    );
    if (c.mode === 'frame')
      p.append(
        field('指定帧时间（秒）', 'number', c.seconds ?? 0, (v) => {
          c.seconds = Number(v);
          onChange(c);
        }),
      );
    if (c.mode === 'image') {
      const s = choice(
        '已导入封面',
        [['', '请选择'], ...data.covers.map((v) => [v.id, v.name])],
        c.id || '',
        (v) => {
          c.id = v;
          onChange(c);
        },
      );
      p.append(
        s,
        B('导入封面', async () => {
          const r = await cmd('cover');
          if (r.cancelled) return;
          await refresh();
          c.id = r.id;
          onChange(c);
          p.replaceChildren(coverControl(c, onChange));
        }),
      );
    }
    return p;
  }
  function locationControl(value, onChange) {
    const p = E('div'), c = structuredClone(value || { mode: 'none' });
    p.append(choice('发布定位', [['none', '不设置定位'], ['specified', '固定地点 / 备选地点']], c.mode, (v) => {
      c.mode = v; onChange(c); p.replaceChildren(locationControl(c, onChange));
    }));
    if (c.mode === 'specified') {
      const primary = E('div', 'publish-grid');
      primary.append(field('固定地点名称', 'text', c.label || '', (v) => { c.label = v; delete c.query; onChange(c); }),
        field('固定地点完整地址', 'text', c.address || '', (v) => { c.address = v; onChange(c); }));
      const fallback = E('div', 'publish-grid');
      fallback.append(field('备选地点名称（可选）', 'text', c.fallback?.label || '', (v) => { c.fallback ||= {}; c.fallback.label = v; delete c.fallback.query; onChange(c); }),
        field('备选地点完整地址（可选）', 'text', c.fallback?.address || '', (v) => { c.fallback ||= {}; c.fallback.address = v; onChange(c); }));
      p.append(primary, fallback, E('p', 'publish-help', '发布时后台搜索固定地点，未准确匹配再搜索备选地点。按名称和完整地址核对；无法唯一匹配时暂停并提示人工接管。配置时不访问官网或上传视频。'));
    }
    return p;
  }
  function nativeControl(value, onChange, batch = false) {
    const p = E('div'); let c = value ? structuredClone(value) : null;
    const options = [['none', '立即发布'], ['at', '抖音官方定时'], ...(batch ? [['cycle', '循环定时']] : [])];
    p.append(choice('官方发布方式', options, c?.mode === 'cycle' ? 'cycle' : c ? 'at' : 'none', (v) => {
      c = v === 'none' ? null : v === 'cycle' ? { mode: 'cycle', cadence: 'daily', startDate: new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10), times: ['18:00'], weekdays: [1, 2, 3, 4, 5], timezone: 'Asia/Shanghai' }
        : c && c.mode !== 'cycle' ? c : { at: '', timezone: 'Asia/Shanghai', intervalMinutes: 10 };
      onChange(c); p.replaceChildren(nativeControl(c, onChange, batch));
    }));
    if (c?.mode === 'cycle') {
      p.append(choice('循环方式', [['daily', '日循环'], ['weekly', '周循环']], c.cadence, (v) => { c.cadence = v; onChange(c); p.replaceChildren(nativeControl(c, onChange, batch)); }),
        field('循环开始日期（北京时间）', 'date', c.startDate, (v) => { c.startDate = v; onChange(c); }),
        field('每日发布时间（每行一个 HH:mm）', 'textarea', c.times.join('\n'), (v) => { c.times = v.split(/\r?\n/).map((v) => v.trim()).filter(Boolean); onChange(c); }));
      if (c.cadence === 'weekly') {
        const days = E('fieldset', 'publish-weekdays'); days.append(E('legend', '', '每周发布日'));
        ['一', '二', '三', '四', '五', '六', '日'].forEach((name, index) => days.append(check('周' + name, c.weekdays.includes(index + 1), (selected) => {
          c.weekdays = selected ? [...new Set([...c.weekdays, index + 1])] : c.weekdays.filter((d) => d !== index + 1); onChange(c);
        })));
        p.append(days);
      }
      p.append(E('p', 'publish-help', '每个账号按分到的视频数量独立排期，按日期和时间顺序填满所选时段；过去的时段跳过。仅安排本批次视频，不循环重复发布。下一步可预览每条任务的具体官方时间。'));
    } else if (c) {
      p.append(field('官方发布时间（北京时间）', 'datetime-local', c.at || '', (v) => { c.at = v; c.timezone = 'Asia/Shanghai'; onChange(c); }));
      if (batch) p.append(field('同一账号官方定时间隔（分钟）', 'number', c.intervalMinutes ?? 10, (v) => { c.intervalMinutes = Number(v); onChange(c); }));
    }
    return p;
  }
  function taskPreview(body) {
    if (!preview) {
      body.append(note('请返回配置参数，重新生成最终预览。草稿已保留。'));
      return;
    }
    body.append(
      note(
        `共 ${preview.rows.length} 个视频与账号组合。此处编辑并锁定最终内容，确认后保存独立快照；文案库后续修改不影响任务。`,
      ),
    );
    const selectedRows = new Set(),
      toolbar = E('div', 'publish-toolbar'),
      search = E('input', 'publish-filter');
    search.type = 'search';
    search.placeholder = '按账号、视频搜索';
    search.value = filters.preview || '';
    search.addEventListener('input', () => {
      filters.preview = search.value;
      fill();
    });
    toolbar.append(
      search,
      B('全选', () => {
        preview.rows.filter(matches).forEach((r) => selectedRows.add(r.key));
        fill();
      }),
      B('批量修改标题', () =>
        editText('批量修改', '标题', '', (value) => {
          preview.rows
            .filter((r) => selectedRows.has(r.key) && !r.locked)
            .forEach((r) => {
              r.title = value;
              r.titleLocked = true;
              input.title.locks ||= {};
              input.title.locks[r.key] = value;
              saveSoon();
            });
          fill();
        }),
      ),
      B('批量修改话题组', () =>
        editText('批量修改', '完整话题组', '', (value) => {
          preview.rows
            .filter((r) => selectedRows.has(r.key) && !r.locked)
            .forEach((r) => {
              r.topics = value;
              r.topicsLocked = true;
              input.topics.locks ||= {};
              input.topics.locks[r.key] = value;
              saveSoon();
            });
          fill();
        }),
      ),
      B('重新匹配未锁定内容', async () => {
        const old = preview.rows,
          r = await cmd('preview', input);
        r.rows = r.rows.map((row) => {
          const previous = old.find((v) => v.key === row.key);
          if (previous?.locked) return previous;
          if (!previous) return row;
          return {
            ...previous,
            title: previous.titleLocked ? previous.title : row.title,
            topics: previous.topicsLocked ? previous.topics : row.topics,
            titleLocked: previous.titleLocked || row.titleLocked,
            topicsLocked: previous.topicsLocked || row.topicsLocked,
          };
        });
        preview = r;
        fill();
      }),
    );
    body.append(toolbar);
    const { wrap, body: rows } = table([
      '选择',
      '视频',
      '平台 / 账号',
      '标题',
      '完整话题组',
      '官方发布时间 / 地点',
      '锁定 / 取消',
      '操作',
    ]);
    body.append(wrap);
    function matches(r) {
      return `${r.accountName} ${r.video.name}`
        .toLowerCase()
        .includes((filters.preview || '').toLowerCase());
    }
    function fill() {
      rows.replaceChildren();
      for (const r of preview.rows.filter(matches)) {
        const row = E('tr');
        cell(row, selectBox(r.key, selectedRows));
        cell(row, r.video.name);
        cell(
          row,
          `${data.platforms.find((p) => p.id === r.platformId)?.name || r.platformId} / ${r.accountName}`,
        );
        for (const key of ['title', 'topics']) {
          const c = E('input', 'title-input');
          c.type = 'text';
          c.value = r[key];
          c.disabled = r.locked;
          c.maxLength = 1000;
          c.setAttribute(
            'aria-label',
            key === 'title' ? '任务标题' : '任务话题组',
          );
          c.addEventListener('input', () => {
            r[key] = c.value;
            r[key + 'Locked'] = true;
            input[key].locks ||= {};
            input[key].locks[r.key] = r[key];
            saveSoon();
          });
          cell(row, c);
        }
        cell(row, E('span', 'publish-help', `${r.nativeSchedule?.at?.replace('T', ' ') || '不启用官方定时'}${r.nativeSchedule ? '（北京时间）' : ''}\n${r.location?.mode === 'specified' ? locationText(r.location) : '不设置定位'}`));
        const flags = E('div');
        flags.append(
          check('锁定', r.locked, (v) => {
            lockRow(r, v);
            fill();
          }),
          check('取消', r.cancelled, (v) => {
            r.cancelled = v;
            rowOverride(r, { cancelled: v });
          }),
        );
        cell(row, flags);
        const actions = E('div', 'row-actions');
        actions.append(
          textButton('设置', () => {
            if (r.locked) throw new Error('请先取消此任务的锁定，再修改参数');
            const p = E('div');
            let cover = structuredClone(r.cover),
              location = structuredClone(r.location),
              nativeSchedule = structuredClone(r.nativeSchedule || null),
              autoSubmit = r.autoSubmit;
            p.append(
              coverControl(cover, (v) => {
                cover = v;
              }),
              locationControl(location, (v) => {
                location = v;
              }, r.accountId),
              nativeControl(nativeSchedule, (v) => { nativeSchedule = v; }),
              check('授权自动提交', autoSubmit, (v) => {
                autoSubmit = v;
              }),
            );
            show('单任务参数', [p], () => {
              r.cover = cover;
              r.location = location;
              r.nativeSchedule = nativeSchedule;
              r.autoSubmit = autoSubmit;
              rowOverride(r, { cover, location, nativeSchedule, autoSubmit });
              lockRow(r, true);
              fill();
            });
          }),
          textButton('↑', () => move(r, -1)),
          textButton('↓', () => move(r, 1)),
        );
        cell(row, actions);
        rows.append(row);
      }
    }
    function move(r, delta) {
      const i = preview.rows.indexOf(r),
        j = i + delta;
      if (j < 0 || j >= preview.rows.length) return;
      [preview.rows[i], preview.rows[j]] = [preview.rows[j], preview.rows[i]];
      input.previewOrder = preview.rows.map((r) => r.key);
      saveSoon();
      fill();
    }
    fill();
  }
  function confirmTasks() {
    if (!preview) throw new Error('请先生成任务预览');
    let name = '视频发布 ' + new Date().toLocaleDateString(),
      allowDuplicates = false;
    const controls = [
      note(
        `将创建 ${preview.rows.filter((r) => !r.cancelled).length} 条任务：官方定时 ${preview.rows.filter((r) => !r.cancelled && r.nativeSchedule?.at).length} 条；不设置官方定时 ${preview.rows.filter((r) => !r.cancelled && !r.nativeSchedule?.at).length} 条。任务确认后直接进入队列，发布时间仅使用官方设置。自动提交授权以各任务勾选状态为准，未授权任务在填写后暂停。`,
      ),
      field('批次名称', 'text', name, (v) => (name = v)),
      check(
        '已核实并允许相同账号重复发布同一素材',
        false,
        (v) => (allowDuplicates = v),
      ),
    ];
    show(
      '确认发布任务',
      controls,
      async () => {
        await cmd('confirm', {
          previewId: preview.previewId,
          rows: preview.rows,
          name,
          allowDuplicates,
        });
        resetWizard();
        clearTimeout(draftTimer);
        await cmd('draft', { input, step, previewId: null }).catch((error) =>
          notify(`任务已生成，但草稿保存失败：${error.message}`, 'error'),
        );
        await refresh();
        go('tasks');
        notify('发布任务已生成，已进入执行队列');
      },
      null,
      '确认生成并执行',
    );
  }
  function tasks(body) {
    const toolbar = E('div', 'publish-toolbar'),
      search = E('input', 'publish-filter');
    search.type = 'search';
    search.placeholder = '视频、账号、标题或批次搜索';
    search.value = filters.query || '';
    search.addEventListener('input', () => {
      filters.query = search.value;
      fill();
    });
    toolbar.append(
      search,
      choice(
        '状态',
        [['', '全部状态'], ...Object.entries(statuses)],
        filters.status || '',
        (v) => {
          filters.status = v;
          fill();
        },
      ),
      choice(
        '账号',
        [['', '全部账号'], ...data.accounts.map((a) => [a.id, a.name])],
        filters.account || '',
        (v) => {
          filters.account = v;
          fill();
        },
      ),
      field('日期', 'date', filters.day || '', (v) => {
        filters.day = v;
        fill();
      }),
    );
    body.append(toolbar);
    const operations = E('div', 'publish-toolbar');
    operations.append(
      B('全选当前结果', () => {
        visible().forEach((t) => selected.add(t.id));
        fill();
      }),
      B('取消选择', () => {
        selected.clear();
        fill();
      }),
    );
    for (const [action, label] of [
      ['start', '开始 / 继续'],
      ['pause', '暂停'],
      ['cancel', '取消'],
    ])
      operations.append(
        B(label, () => runAction([...selected], action), action === 'start'),
      );
    operations.append(
      B('删除选中记录', () => deleteTasks([...selected])),
    );
    const more = disclosure('更多操作', 'task-operations');
    more.append(
      B('删除当前筛选记录', () => deleteTasks(visible().map((t) => t.id))),
      B('导出记录', async () => {
        const r = await cmd('export', {
          ids: selected.size ? [...selected] : visible().map((t) => t.id),
        });
        if (r.saved) notify(`已导出 ${r.count} 条记录`);
      }),
      choice(
        '并发环境',
        [
          ['1', '1 个'],
          ['2', '2 个（默认）'],
          ['3', '3 个'],
          ['4', '4 个'],
          ['5', '5 个'],
          ['6', '6 个'],
        ],
        String(data.concurrency),
        async (v) => {
          await cmd('concurrency', Number(v));
          await refresh();
        },
      ),
    );
    operations.append(more);
    body.append(operations);
    const { wrap, body: rows } = table([
      '选择',
      '视频 / 批次',
      '平台 / 账号',
      '标题 / 话题',
      '官方发布时间',
      '状态 / 进度',
      '操作',
    ]);
    body.append(wrap);
    function visible() {
      return data.tasks.filter((t) => {
        const batch = data.batches.find((b) => b.id === t.batchId)?.name || '',
          q = (filters.query || '').toLowerCase();
        return (
          (!q ||
            `${t.video.name} ${t.accountName} ${t.title} ${batch}`
              .toLowerCase()
              .includes(q)) &&
          (!filters.status || t.status === filters.status) &&
          (!filters.account || t.accountId === filters.account) &&
          (!filters.day || (t.nativeSchedule?.at || local(t.plannedAt)).startsWith(filters.day)) &&
          (page !== 'history' ||
            [
              'submitted',
              'review',
              'success',
              'failed',
              'unverified',
              'cancelled',
            ].includes(t.status))
        );
      });
    }
    function fill() {
      rows.replaceChildren();
      for (const t of visible()) {
        const row = E('tr');
        cell(row, selectBox(t.id, selected));
        const v = E('div');
        v.append(
          E('strong', '', t.video.name),
          E(
            'div',
            'muted',
            data.batches.find((b) => b.id === t.batchId)?.name || t.batchId,
          ),
        );
        cell(row, v);
        cell(
          row,
          `${data.platforms.find((p) => p.id === t.platformId)?.name || t.platformId} / ${t.accountName}`,
        );
        const text = E('div', 'publish-caption');
        text.append(E('div', '', t.title), E('div', 'muted', t.topics));
        cell(row, text);
        const timing = E('div');
        timing.append(E('div', '', t.nativeSchedule?.at ? t.nativeSchedule.at.replace('T', ' ') + '（北京时间）' : '立即发布'));
        cell(row, timing);
        const state = E('div'),
          badge = E('span', 'publish-status', statuses[t.status]);
        badge.dataset.status = t.status;
        state.append(
          badge,
          E(
            'div',
            'muted',
            t.status === 'pending' && t.queue
              ? t.queue.message +
                  (t.queue.retryAt ? ' · ' + date(t.queue.retryAt) : '')
              : t.checkpoint.submitIntent
                ? '已到提交边界'
                : t.checkpoint.filled
                  ? '已填写'
                  : t.checkpoint.uploaded
                    ? '已上传'
                    : '等待检查',
          ),
        );
        cell(row, state);
        const actions = E('div', 'row-actions');
        actions.append(
          textButton('帮我排查', () => window.browserAPI.openDeveloperTools({ taskId: t.id })),
          textButton('详情 / 日志', () => details(t)),
          textButton('删除记录', () => deleteTasks([t.id])),
        );
        if (['manual', 'unverified', 'running', 'paused'].includes(t.status))
          actions.append(
            textButton('人工接管', () => runAction([t.id], 'takeover')),
          );
        cell(row, actions);
        rows.append(row);
      }
      if (!rows.children.length) {
        const row = E('tr'),
          td = cell(row, E('div', 'publish-empty', '暂无符合条件的任务'));
        td.colSpan = 7;
        rows.append(row);
      }
    }
    updateTaskRows = fill;
    fill();
  }
  async function runAction(ids, action, extra = {}) {
    if (!ids.length) throw new Error('请先选择任务');
    await cmd('tasks', { ids, action, ...extra });
    await refresh(true);
    notify('任务状态已更新');
  }
  async function details(t) {
    const current = await cmd('state');
    t = current.tasks.find((row) => row.id === t.id);
    if (!t) throw new Error('任务记录已经删除');
    const logs = await cmd('logs', t.id),
      body = [
        note(
          `${statuses[t.status]} · ${t.queue?.message || t.result?.reason || '等待执行'}${t.queue?.retryAt ? ' · 可执行时间：' + date(t.queue.retryAt) : ''}`,
        ),
        E(
          'p',
          'publish-help',
          `调度器：${current.scheduler.timerActive ? '运行中' : '未运行'} · 当前执行 ${current.scheduler.running}/${current.scheduler.concurrency} · 最近检查：${current.scheduler.lastTickAt ? date(current.scheduler.lastTickAt) : '尚未检查'}${current.scheduler.lastError ? ' · ' + current.scheduler.lastError : ''}`,
        ),
        E(
          'p',
          'publish-help',
          `环境 ID：${t.accountId}\n素材：${t.video.path}\n队列时间：${date(t.plannedAt)}\n官方发布时间：${t.nativeSchedule?.at?.replace('T', ' ') || '未设置'}${t.nativeSchedule?.at ? '（北京时间）' : ''}\n定位：${t.location?.mode === 'specified' ? locationText(t.location) + (t.checkpoint.locationVerified ? '\n实际定位：' + locationText(t.checkpoint.locationVerified) : '') : '不设置'}\n最终标题：${t.title}\n完整话题组：${t.topics}`,
        ),
        E(
          'pre',
          'publish-log',
          logs
            .map((l) => `${date(l.time)} [${l.level}] ${l.message}`)
            .join('\n') || '暂无执行日志',
        ),
      ];
    const actions = E('div', 'publish-actions');
    actions.append(B('帮我排查发布问题', () => window.browserAPI.openDeveloperTools({ taskId: t.id }), true));
    for (const [a, l] of [
      ['start', '开始 / 继续'],
      ['pause', '暂停'],
      ['cancel', '取消'],
      ['takeover', '人工接管'],
    ])
      actions.append(
        B(l, async () => {
          await runAction([t.id], a);
          closeDialogs();
        }),
      );
    if (t.status === 'manual')
      actions.append(
        B('已完成平台设置，继续', () =>
          ask('确认已在原页面完成所需封面、定位或平台定时设置？', () =>
            runAction([t.id], 'manual-options', { confirmed: true }),
          ),
        ),
        B('审阅并授权提交', () =>
          ask(
            '确认已核对素材、账号、标题、话题及平台设置，并授权此任务自动点击“发布”？',
            () => runAction([t.id], 'authorize', { confirmed: true }),
          ),
        ),
      );
    if (['unverified', 'submitted', 'review', 'manual'].includes(t.status))
      actions.append(
        B('核实发布成功', () =>
          editText('人工核实', '请填写核实说明或作品链接', '', (reason) =>
            runAction([t.id], 'resolve', { confirmed: true, reason }),
          ),
        ),
      );
    if (t.status === 'unverified')
      actions.append(
        B('核实尚未提交', () =>
          editText(
            '允许再次执行',
            '已检查平台不存在此次作品，请填写核实说明',
            '',
            (reason) =>
              runAction([t.id], 'not-submitted', { confirmed: true, reason }),
          ),
        ),
      );
    actions.append(
      B('删除记录', () => deleteTasks([t.id])),
      B('删除整个批次', () =>
        deleteTasks(
          data.tasks
            .filter((row) => row.batchId === t.batchId)
            .map((row) => row.id),
        ),
      ),
    );
    body.push(actions);
    const diagnostic = E('section', 'publish-diagnostic'),
      summary = E('p', 'publish-help'),
      controls = E('div', 'publish-actions');
    diagnostic.append(
      E('h3', '', '本地运行诊断'),
      E(
        'p',
        'publish-help',
        '记录调度原因、视口尺寸、页面控件结构及点击/输入/话题空格事件，每2秒检查一次，最多10分钟。不会保存输入内容、Cookie、账号名称或截图，也不会自动上传。可在记录时人工接管并操作页面，再导出报告。',
      ),
      summary,
      controls,
    );
    async function updateDiagnostic() {
      const state = await cmd('diagnostic-state', t.id),
        report = state.report,
        last = report?.frames.at(-1);
      summary.textContent = `${state.active ? '正在记录' : report ? '记录已停止' : '尚无记录'}${report ? ' · ' + report.frames.length + ' 个状态快照 · 最近采样：' + date(report.lastSampleAt || report.startedAt) : ''}${last ? '\n页面：' + (last.page.page || '未打开 / 暂不可读取') + ' · 视口：' + (last.page.viewport ? last.page.viewport.width + ' × ' + last.page.viewport.height : '不可用') + ' · 控件：' + (last.page.controlCount ?? 0) : ''}`;
      controls.replaceChildren(
        B(
          state.active ? '停止本地诊断' : '开始本地诊断',
          async () => {
            await cmd(
              state.active ? 'diagnostic-stop' : 'diagnostic-start',
              t.id,
            );
            await updateDiagnostic();
          },
          !state.active,
        ),
        B('刷新诊断', updateDiagnostic),
        B('导出诊断报告', async () => {
          const result = await cmd('diagnostic-export', t.id);
          if (result.saved) notify('诊断报告已保存');
        }),
        B('删除诊断', () =>
          ask(
            '只删除此任务的本地诊断记录，保留任务、日志和视频文件。',
            async () => {
              await cmd('diagnostic-clear', t.id);
              await updateDiagnostic();
            },
          ),
        ),
      );
    }
    let marker = 'unexpected-state';
    const marks = E('div', 'publish-toolbar');
    marks.append(
      choice(
        '标记当前页面阶段',
        [
          ['entered-page', '已进入发布页'],
          ['uploaded-video', '视频已可预览'],
          ['edited-caption', '标题已填写'],
          ['committed-topics', '话题已用空格确认'],
          ['ready-to-submit', '可以发布'],
          ['unexpected-state', '页面出现异常'],
        ],
        marker,
        (value) => {
          marker = value;
        },
      ),
      B('保存阶段标记', async () => {
        await cmd('diagnostic-mark', { id: t.id, step: marker });
        notify('诊断阶段已标记');
      }),
    );
    diagnostic.append(marks);
    body.push(diagnostic);
    await updateDiagnostic();
    show('任务详情 · ' + t.accountName, body);
  }
  function library(body) {
    const toolbar = E('div', 'publish-toolbar');
    let kind = filters.kind || 'title';
    toolbar.append(
      choice(
        '资源类型',
        [
          ['title', '标题'],
          ['topics', '话题组'],
          ['image', '封面图片'],
          ['location', '常用定位'],
        ],
        kind,
        (v) => {
          filters.kind = v;
          selected.clear();
          draw();
        },
      ),
      B(
        kind === 'image' ? '新增封面' : '批量新增',
        () => {
          if (kind === 'image')
            return safe(async () => {
              const r = await cmd('cover');
              if (!r.cancelled) {
                await refresh(true);
                notify('封面已导入');
              }
            })();
          let value = '',
            group = '';
          show(
            kind === 'title'
              ? '新增标题'
              : kind === 'location'
                ? '新增常用定位'
                : '新增话题组',
            [
              field(
                '每行一条（话题按整组）',
                'textarea',
                '',
                (v) => (value = v),
              ),
              field('分组', 'text', '', (v) => (group = v)),
            ],
            async () => {
              const r = await cmd('resource-add', {
                kind,
                lines: value.split(/\r?\n/),
                group,
              });
              await refresh(true);
              notify(
                `新增 ${r.added.length} 条，重复 ${r.duplicates.length} 条`,
              );
            },
          );
        },
        true,
      ),
      B(kind === 'image' ? '导入封面' : '导入 TXT / Excel', async () => {
        if (kind === 'image') {
          const r = await cmd('cover');
          if (!r.cancelled) await refresh(true);
          return;
        }
        if (kind === 'location') throw new Error('常用定位请使用批量新增');
        const r = await cmd('library-import', { kind });
        if (r.cancelled) return;
        await refresh(true);
        notify(`新增 ${r.added.length} 条，重复 ${r.duplicates.length} 条`);
      }),
    );
    if (kind === 'location') toolbar.lastElementChild.disabled = true;
    const search = E('input', 'publish-filter');
    search.type = 'search';
    search.placeholder = '搜索内容或分组';
    search.value = filters.library || '';
    search.addEventListener('input', () => {
      filters.library = search.value;
      fill();
    });
    toolbar.append(
      search,
      B('全选当前结果', () => {
        listResources().forEach((r) => selected.add(r.id));
        fill();
      }),
      B('取消选择', () => {
        selected.clear();
        fill();
      }),
      B('删除选中记录', () => deleteResources([...selected])),
      B('删除当前筛选记录', () =>
        deleteResources(listResources().map((r) => r.id)),
      ),
    );
    body.append(
      toolbar,
      note(
        kind === 'image'
          ? '只保存封面图片路径。删除记录不会删除原图片，也不影响已确认任务。'
          : kind === 'location'
            ? '常用定位作为文本配置保存。删除记录不改变已确认任务的定位。'
            : 'Excel 读取每个工作表的第一列；TXT 每行一条，话题组作为整行保存。随机匹配在预览时固定，执行时不会再次随机。',
      ),
    );
    const { wrap, body: rows } = table(['选择', '内容', '分组', '操作']);
    body.append(wrap);
    function listResources() {
      return (
        kind === 'image'
          ? data.covers
          : kind === 'location'
            ? data.locations
            : data.library
      )
        .filter(
          (r) =>
            r.kind === kind &&
            `${r.value || r.name} ${r.group || ''}`.includes(
              filters.library || '',
            ),
        )
        .sort((a, b) => (a.order ?? a.createdAt) - (b.order ?? b.createdAt));
    }
    function fill() {
      rows.replaceChildren();
      const list = listResources();
      for (const [i, r] of list.entries()) {
        const row = E('tr');
        cell(row, selectBox(r.id, selected));
        cell(row, E('div', 'publish-caption', r.value || r.name));
        cell(row, r.group || '未分组');
        const actions = E('div', 'row-actions');
        actions.append(
          textButton(kind === 'image' ? '查看路径' : '编辑', () => {
            if (kind === 'image') {
              show('封面图片', [E('p', 'publish-help', r.path)]);
              return;
            }
            let value = r.value,
              group = r.group;
            show(
              '编辑文案',
              [
                field('内容', 'textarea', value, (v) => (value = v)),
                field('分组', 'text', group, (v) => (group = v)),
              ],
              async () => {
                await cmd('resource-edit', {
                  id: r.id,
                  kind,
                  value,
                  group,
                  order: r.order,
                });
                await refresh(true);
              },
            );
          }),
          textButton('删除', () => deleteResources([r.id])),
          textButton('↑', async () => {
            if (!i || kind === 'image') return;
            const previous = list[i - 1];
            await cmd('resource-edit', { ...r, order: previous.order });
            await cmd('resource-edit', { ...previous, order: r.order });
            await refresh(true);
          }),
        );
        cell(row, actions);
        rows.append(row);
      }
    }
    fill();
  }
  function show(title, nodes, onSubmit, onClose, submitLabel = '保存') {
    const dialog = E('dialog', 'publish-dialog');
    dialog.setAttribute('closedby', 'none');
    const inner = E('div', 'publish-dialog-inner'),
      head = E('header'),
      close = B('×', () => finish());
    close.setAttribute('aria-label', '关闭对话框');
    head.append(E('h2', '', title), close);
    const body = E('div', 'publish-dialog-content');
    nodes.forEach((n) => body.append(n));
    const footer = E('footer'),
      error = E('p', 'form-error');
    error.hidden = true;
    body.append(error);
    footer.append(B('关闭', () => finish()));
    if (onSubmit) {
      const submit = B(
        submitLabel,
        async () => {
          submit.disabled = true;
          try {
            await onSubmit();
            finish();
          } catch (e) {
            error.textContent = e.message;
            error.hidden = false;
          } finally {
            submit.disabled = false;
          }
        },
        true,
      );
      footer.append(submit);
    }
    inner.append(head, body, footer);
    dialog.append(inner);
    document.body.append(dialog);
    dialog.addEventListener('cancel', (e) => e.preventDefault());
    dialog.addEventListener('close', () => {
      onClose?.();
      dialog.remove();
    });
    dialog.showModal();
    body.querySelector('input,textarea')?.focus();
    function finish() {
      dialog.close();
    }
    return dialog;
  }
  function closeDialogs() {
    document
      .querySelectorAll('.publish-dialog[open]')
      .forEach((d) => d.close());
  }
  function ask(message, fn) {
    show('请确认', [note(message, true)], fn, null, '确认');
  }
  function editText(title, label, value, fn) {
    let text = value;
    show(title, [field(label, 'textarea', value, (v) => (text = v))], () =>
      fn(text),
    );
  }
  window.addEventListener('publishing:page', (event) => {
    if (ready) go(event.detail);
  });
  window.addEventListener('publishing:visible', () => {
    if (ready) {
      window.dispatchEvent(
        new CustomEvent('publishing:selected', { detail: page }),
      );
    } else refresh();
  });
  window.addEventListener(
    'publishing:takeover-request',
    safe(async (event) => {
      await refresh();
      const t = data.tasks.find(
        (t) =>
          t.accountId === event.detail &&
          ['running', 'manual', 'paused', 'unverified'].includes(t.status),
      );
      if (t) await runAction([t.id], 'takeover');
    }),
  );
  api?.onTakeover(() => {
    closeDialogs();
    window.publishingNavigateEnvironment?.();
  });
  window.browserAPI?.onState((snapshot) => {
    if (!ready && snapshot.publishingError)
      root.replaceChildren(E('p', 'publish-error', snapshot.publishingError));
  });
  api?.onChanged(() => {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => refresh(), 100);
  });
  window.addEventListener('pagehide', () => {
    clearTimeout(draftTimer);
    cmd('draft', { input, step, previewId: preview?.previewId }).catch(
      () => {},
    );
    saveUI();
  });
  // The service is installed after account restoration; the ready event retries
  // initial state without rebuilding the environment sidebar.
  refresh();
})();
