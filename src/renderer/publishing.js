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
    create: '创建发布任务',
    image: '图文发布',
    article: '文章发布',
    tasks: '任务列表',
    plan: '发布计划',
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
    loading = false,
    refreshTimer,
    draftTimer,
    preview = null,
    filters = {},
    selected = new Set(),
    scroll = {};
  let input = {
    videoIds: [],
    platformIds: ['douyin'],
    accountIds: [],
    title: { mode: 'reuse', scope: 'video', values: [], locks: {} },
    topics: { mode: 'reuse', scope: 'video', values: [], locks: {} },
    distribution: { mode: 'all' },
    cover: { mode: 'first' },
    location: { mode: 'none' },
    covers: {},
    locations: {},
    schedule: {
      mode: 'now',
      intervalMinutes: 10,
      windows: [{ start: '09:00', end: '11:00', quota: 2 }],
    },
    autoSubmit: false,
  };
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
        plannedAt: row.plannedAt,
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
          'plannedAt',
          'autoSubmit',
          'locked',
          'cancelled',
        ])
          if (Object.hasOwn(override, key))
            row[key] = structuredClone(override[key]);
        row.timeLocked = Object.hasOwn(override, 'plannedAt');
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
  async function refresh(render = false) {
    if (loading) return;
    loading = true;
    try {
      const previous = data;
      data = await cmd('state');
      if (
        ready &&
        ['video', 'create'].includes(page) &&
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
          step = draft.data.step || 0;
          const saved = data.drafts.find(
            (d) => d.id === `preview:${draft.data.previewId}`,
          );
          if (saved) {
            preview = {
              previewId: draft.data.previewId,
              rows: structuredClone(saved.data.rows),
            };
            hydratePreview();
          }
        }
        page = names[data.ui.page] ? data.ui.page : 'video';
        step = Math.min(4, Math.max(0, draft?.data?.step ?? data.ui.step ?? 0));
        scroll = data.ui.scroll || {};
        ready = true;
        render = true;
      }
      if (render) {
        remember();
        draw();
      } else if (
        ['tasks', 'plan', 'history'].includes(page) &&
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
    } finally {
      loading = false;
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
        page === 'video' || page === 'create'
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
    if (['video', 'create'].includes(page)) wizard();
    else {
      const body = E('div', 'publish-body');
      root.append(body);
      if (['image', 'article'].includes(page))
        body.append(
          note(
            '规划中：本期仅开放抖音视频发布。此页面保留框架，未提供实际发布能力。',
          ),
        );
      else if (['tasks', 'plan', 'history'].includes(page)) tasks(body);
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
        B('从素材库移除', () =>
          ask('移除选中的素材索引？原视频文件不会删除。', async () => {
            await cmd('resource-remove', [...selection]);
            await refresh(true);
          }),
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
        '只选择与抖音关联的原有独立环境。未运行网页检查前，登录状态显示“未核实”，不会把“已打开”当作“已登录”。',
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
        c.type = 'checkbox';
        c.checked = input.accountIds.includes(a.id);
        c.addEventListener('change', () => {
          input.accountIds = c.checked
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
    p.append(
      grid,
      field(
        kind === 'topics' ? '话题组：每行一组，保留整组匹配' : '标题：每行一个',
        'textarea',
        config.values.join('\n'),
        (v) => (config.values = v.split(/\r?\n/)),
      ),
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
    return p;
  }
  function configuration(body) {
    body.append(
      matchingConfig('title', '标题配置'),
      matchingConfig('topics', '话题组配置'),
    );
    const p = panel('视频与账号分发'),
      modes = [
        ['all', '全部视频 → 全部账号'],
        ['sequence', '按视频与账号顺序均分'],
        ['random', '随机分配（可设置账号配额）'],
        ['manual', '逐条视频指定账号'],
      ];
    p.append(
      choice('分发方式', modes, input.distribution.mode, (v) => {
        input.distribution = { mode: v };
        saveSoon();
        draw();
      }),
    );
    if (input.distribution.mode === 'random') {
      p.append(
        E(
          'p',
          'publish-help',
          '不填配额时均分；填写后总数量必须等于视频数量。',
        ),
      );
      for (const id of input.accountIds) {
        const a = data.accounts.find((a) => a.id === id);
        p.append(
          field(
            a?.name || id,
            'number',
            input.distribution.quotas?.[id] ?? '',
            (v) => {
              input.distribution.quotas ||= {};
              if (v === '') delete input.distribution.quotas[id];
              else input.distribution.quotas[id] = Number(v);
            },
          ),
        );
      }
    }
    if (input.distribution.mode === 'manual')
      for (const id of input.videoIds) {
        const row = panel(data.videos.find((v) => v.id === id)?.name || id);
        for (const aid of input.accountIds)
          row.append(
            check(
              data.accounts.find((a) => a.id === aid)?.name || aid,
              input.distribution.manual?.[id]?.includes(aid),
              (v) => {
                input.distribution.manual ||= {};
                const list = input.distribution.manual[id] || [];
                input.distribution.manual[id] = v
                  ? [...new Set([...list, aid])]
                  : list.filter((a) => a !== aid);
              },
            ),
          );
        p.append(row);
      }
    body.append(p);
    const cover = panel('封面与定位');
    cover.append(
      note(
        '自定义封面、指定帧、定位及平台原生定时需要在抖音页面人工设置并核实。本地计划时间是开始执行时间，并非作品精确上线时间。',
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
    cover.append(perVideo);
    body.append(cover);
    const schedule = panel('本地发布时间计划');
    schedule.append(
      choice(
        '执行方式',
        [
          ['now', '立即进入队列'],
          ['at', '指定开始时间'],
          ['windows', '每天多时段'],
        ],
        input.schedule.mode,
        (v) => {
          input.schedule.mode = v;
          saveSoon();
          draw();
        },
      ),
      field(
        '同一账号最小发布间隔（分钟）',
        'number',
        input.schedule.intervalMinutes,
        (v) => (input.schedule.intervalMinutes = Number(v)),
      ),
    );
    if (input.schedule.mode === 'at')
      schedule.append(
        field(
          '计划开始执行时间',
          'datetime-local',
          input.schedule.at || '',
          (v) => (input.schedule.at = v),
        ),
      );
    if (input.schedule.mode === 'windows') {
      (input.schedule.windows ||= []).forEach((w, i) => {
        const row = E('div', 'publish-grid');
        row.append(
          field('时段开始', 'time', w.start, (v) => (w.start = v)),
          field('时段结束', 'time', w.end, (v) => (w.end = v)),
          field(
            '每账号此时段任务数量',
            'number',
            w.quota,
            (v) => (w.quota = Number(v)),
          ),
          B('删除时段', () => {
            input.schedule.windows.splice(i, 1);
            saveSoon();
            draw();
          }),
        );
        schedule.append(row);
      });
      schedule.append(
        B('添加时段', () => {
          input.schedule.windows.push({
            start: '14:00',
            end: '17:00',
            quota: 2,
          });
          saveSoon();
          draw();
        }),
      );
    }
    schedule.append(
      E(
        'p',
        'publish-help',
        '需要电脑开机、联网并保持栖页运行；重启时错过计划五分钟以上的任务暂停等待确认。立即队列也遵守同账号最小间隔。',
      ),
    );
    body.append(schedule);
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
    const p = E('div'),
      c = structuredClone(value || { mode: 'none' });
    p.append(
      choice(
        '发布定位',
        [
          ['none', '不设置定位'],
          ['specified', '指定位置（人工设置）'],
        ],
        c.mode,
        (v) => {
          c.mode = v;
          onChange(c);
          p.replaceChildren(locationControl(c, onChange));
        },
      ),
    );
    if (c.mode === 'specified') {
      const f = field('平台位置名称', 'text', c.label || '', (v) => {
        c.label = v;
        onChange(c);
      });
      p.append(f);
      if (data.locations.length)
        p.append(
          choice(
            '常用位置',
            [['', '请选择'], ...data.locations.map((l) => [l.value, l.value])],
            c.label || '',
            (v) => {
              c.label = v;
              onChange(c);
              p.replaceChildren(locationControl(c, onChange));
            },
          ),
        );
      p.append(
        B('保存常用位置', async () => {
          await cmd('resource-add', {
            kind: 'location',
            lines: [c.label || ''],
          });
          await refresh();
          notify('常用定位已保存');
        }),
      );
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
      '计划开始时间',
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
        const time = E('input');
        time.type = 'datetime-local';
        time.value = local(r.plannedAt);
        time.disabled = r.locked;
        time.addEventListener('change', () => {
          r.plannedAt = Date.parse(time.value);
          r.timeLocked = true;
          rowOverride(r, { plannedAt: r.plannedAt });
        });
        cell(row, time);
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
              autoSubmit = r.autoSubmit;
            p.append(
              coverControl(cover, (v) => {
                cover = v;
              }),
              locationControl(location, (v) => {
                location = v;
              }),
              check('授权自动提交', autoSubmit, (v) => {
                autoSubmit = v;
              }),
            );
            show('单任务参数', [p], () => {
              r.cover = cover;
              r.location = location;
              r.autoSubmit = autoSubmit;
              rowOverride(r, { cover, location, autoSubmit });
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
      const other = preview.rows[j];
      if (
        !r.timeLocked &&
        !r.locked &&
        !other.timeLocked &&
        !other.locked &&
        r.accountId === other.accountId
      ) {
        [r.plannedAt, other.plannedAt] = [other.plannedAt, r.plannedAt];
        rowOverride(r, { plannedAt: r.plannedAt });
        rowOverride(other, { plannedAt: other.plannedAt });
      }
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
        `将创建 ${preview.rows.filter((r) => !r.cancelled).length} 条任务。自动提交授权以各任务勾选状态为准，未授权任务在填写后暂停。`,
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
        for (const row of preview.rows) {
          delete input.title.locks?.[row.key];
          delete input.topics.locks?.[row.key];
        }
        preview = null;
        step = 0;
        input.overrides = {};
        input.previewOrder = [];
        input.autoSubmit = false;
        clearTimeout(draftTimer);
        await cmd('draft', { input, step, previewId: null }).catch((error) =>
          notify(`任务已生成，但草稿保存失败：${error.message}`, 'error'),
        );
        await refresh();
        go('tasks');
        notify('发布任务已生成，按本地计划进入队列');
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
        '平台',
        [
          ['', '全部平台'],
          ['douyin', '抖音'],
        ],
        filters.platform || '',
        (v) => {
          filters.platform = v;
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
    if (page === 'plan')
      body.append(
        note(
          '本地计划表示开始执行上传的时间，需要电脑保持开机和联网；平台处理、审核时间不能由本地计划保证。',
        ),
      );
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
    body.append(operations);
    const { wrap, body: rows } = table([
      '选择',
      '视频 / 批次',
      '平台 / 账号',
      '标题 / 话题',
      '计划时间',
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
          (!filters.platform || t.platformId === filters.platform) &&
          (!filters.day || local(t.plannedAt).startsWith(filters.day)) &&
          (page !== 'plan' ||
            ['pending', 'paused', 'manual'].includes(t.status)) &&
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
        cell(row, date(t.plannedAt));
        const state = E('div'),
          badge = E('span', 'publish-status', statuses[t.status]);
        badge.dataset.status = t.status;
        state.append(
          badge,
          E(
            'div',
            'muted',
            t.checkpoint.submitIntent
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
        actions.append(textButton('详情 / 日志', () => details(t)));
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
    const logs = await cmd('logs', t.id),
      body = [
        note(`${statuses[t.status]} · ${t.result?.reason || '等待执行'} `),
        E(
          'p',
          'publish-help',
          `环境 ID：${t.accountId}\n素材：${t.video.path}\n计划：${date(t.plannedAt)}\n最终标题：${t.title}\n完整话题组：${t.topics}`,
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
    body.push(actions);
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
        ],
        kind,
        (v) => {
          filters.kind = v;
          draw();
        },
      ),
      B(
        '批量新增',
        () => {
          let value = '',
            group = '';
          show(
            kind === 'title' ? '新增标题' : '新增话题组',
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
      B('导入 TXT / Excel', async () => {
        const r = await cmd('library-import', { kind });
        if (r.cancelled) return;
        await refresh(true);
        notify(`新增 ${r.added.length} 条，重复 ${r.duplicates.length} 条`);
      }),
    );
    const search = E('input', 'publish-filter');
    search.type = 'search';
    search.placeholder = '搜索内容或分组';
    search.value = filters.library || '';
    search.addEventListener('input', () => {
      filters.library = search.value;
      fill();
    });
    toolbar.append(search);
    body.append(
      toolbar,
      note(
        'Excel 读取每个工作表的第一列；TXT 每行一条，话题组作为整行保存。随机匹配在预览时固定，执行时不会再次随机。',
      ),
    );
    const { wrap, body: rows } = table(['内容', '分组', '操作']);
    body.append(wrap);
    function fill() {
      rows.replaceChildren();
      const list = data.library
        .filter(
          (r) =>
            r.kind === kind &&
            `${r.value} ${r.group}`.includes(filters.library || ''),
        )
        .sort((a, b) => a.order - b.order);
      for (const [i, r] of list.entries()) {
        const row = E('tr');
        cell(row, E('div', 'publish-caption', r.value));
        cell(row, r.group || '未分组');
        const actions = E('div', 'row-actions');
        actions.append(
          textButton('编辑', () => {
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
          textButton('删除', () =>
            ask('删除此文案？已确认任务不受影响。', async () => {
              await cmd('resource-remove', [r.id]);
              await refresh(true);
            }),
          ),
          textButton('↑', async () => {
            if (!i) return;
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
