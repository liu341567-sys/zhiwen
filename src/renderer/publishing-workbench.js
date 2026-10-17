'use strict';
(() => {
  const E = (tag, cls, text) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = String(text);
    return node;
  };
  const clone = (value) => structuredClone(value);
  const taskNames = {
    pending: '待提交', running: '执行中', paused: '已暂停',
    manual: '需要处理', submitted: '已提交', review: '审核中',
    success: '发布成功', failed: '发布失败', unverified: '结果待核实',
    cancelled: '已取消',
  };
  const terminal = new Set(['submitted', 'review', 'success', 'cancelled']);
  const abnormal = new Set(['manual', 'failed', 'unverified']);

  window.createPublishingWorkbench = ({ cmd, notify, onChange }) => {
    let data = null, model = null, host = null, shell = null, activeAccount = null;
    let changed = false, saving = false, saveTimer = null, revision = 0;
    let acceptedAt = 0, busy = false, dialog = null;
    const composing = new Set();
    const selected = new Set(), accountNodes = new Map(), entryNodes = new Map();
    let accountsList, cards, empty, accountHeading, listCount, batchName, saved;
    let errorsBox, errorList, publishButton, newButton, summary;
    let bulkButton, importButton, libraryButton, selectAll;

    function button(label, action, options = {}) {
      const node = E('button', `pwb-button${options.primary ? ' pwb-primary' : ''}${options.text ? ' pwb-text' : ''}`, label);
      node.type = 'button';
      if (options.hook) node.dataset.wbAction = options.hook;
      node.addEventListener('click', () => run(action));
      return node;
    }
    async function run(fn) {
      try { await fn(); }
      catch (error) { notify(error.message || String(error), 'error'); }
    }
    const account = (id) => data?.accounts.find((item) => item.id === id);
    const video = (id) => data?.videos.find((item) => item.id === id);
    const task = (entry) => data?.tasks.find((item) => item.id === entry.taskId);
    const editable = entry => !busy && (entry ? !entry.taskId : !model?.entries?.length || model.entries.some(e => !e.taskId));
    const icon = () => data?.platforms.find((item) => item.id === 'douyin')?.iconResource || '../assets/qiye.png';
    const includedAccounts = () => [...new Set(model.entries.map((entry) => entry.accountId))];
    const batchTasks = () => data?.tasks.filter(item => model?.entries?.some(e => e.taskId === item.id)) || [];
    const entryState = (entry) => {
      const item = task(entry);
      if (item) return [item.status, item.status === 'running' ? model.authorizedAt ? '正在发布' : '正在上传与填写' : taskNames[item.status] || item.status];
      const phase = entry.live?.phase;
      const names = { uploading: '视频正在上传', syncing: '正在同步官网', ready: '官网已核验', manual: '需要人工处理', error: '同步失败', publishing: '正在发布', submitted: '已提交' };
      if (phase && names[phase]) return [phase === 'ready' ? 'prepared' : phase, names[phase]];
      return !entry.videoId || !entry.title.trim() ? ['incomplete', '待完善'] : ['draft', '等待同步'];
    };
    function mergeLive(incoming) {
      for (const item of incoming.entries || []) {
        const local = model?.entries.find((entry) => entry.id === item.id);
        if (local) { local.live = clone(item.live || { phase: 'idle' }); if (item.taskId) local.taskId = item.taskId; }
      }
    }
    function adopt(incoming) {
      const current = new Map((model?.entries || []).map((entry) => [entry.id, entry]));
      const entries = (incoming.entries || []).map((entry) => {
        const existing = current.get(entry.id);
        if (existing) { Object.assign(existing, clone(entry)); return existing; }
        return clone(entry);
      });
      model = { ...clone(incoming), entries, name: incoming.name || '' };
    }
    function newEntry(accountId, videoId = '') {
      const row = { id: crypto.randomUUID(), accountId, videoId, title: '', topics: '', locked: false };
      selected.add(row.id);
      return row;
    }
    function dirty(immediate = false) {
      if (!editable()) return;
      changed = true;
      revision++;
      saved.textContent = '正在保存…';
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => run(flush), immediate ? 0 : 400);
      refreshStatus();
    }
    async function flush() {
      clearTimeout(saveTimer);
      if (saving) {
        // Keep one writer. A later edit is sent after the active snapshot commits.
        while (saving) await new Promise((resolve) => setTimeout(resolve, 25));
      }
      if (!changed || composing.size) return;
      const version = revision, snapshot = { entries: model.entries.map(({ id, accountId, videoId, title, topics, locked }) => ({ id, accountId, videoId, title, topics, locked })), name: model.name, activeEntryId: model.entries.find((entry) => entry.accountId === activeAccount)?.id || null };
      saving = true;
      try {
        const result = await cmd('workbench-sync', snapshot);
        acceptedAt = Math.max(acceptedAt, result?.updatedAt || 0);
        if (result?.entries) mergeLive(result);
        if (version === revision) changed = false;
        saved.textContent = changed ? '正在保存…' : '已保存到本机，官网状态见各字段';
      } catch (error) {
        saved.textContent = '保存失败，请重试';
        throw error;
      } finally { saving = false; }
      if (changed && version !== revision) await flush();
      onChange?.();
    }
    async function read() {
      const state = await cmd('state');
      update(state);
      onChange?.();
      return state;
    }
    function closeDialog() {
      if (!dialog) return;
      dialog.close();
      dialog.remove();
      dialog = null;
    }
    function modal(title, body, actions = []) {
      closeDialog();
      dialog = E('dialog', 'pwb-dialog');
      dialog.setAttribute('aria-label', title);
      const top = E('header', 'pwb-dialog-head'), titleNode = E('h2', '', title);
      const close = button('×', closeDialog, { text: true });
      close.classList.add('pwb-dialog-close');
      close.setAttribute('aria-label', '关闭');
      top.append(titleNode, close);
      const middle = E('div', 'pwb-dialog-body');
      middle.append(...body);
      const bottom = E('footer', 'pwb-dialog-foot');
      bottom.append(...actions);
      dialog.append(top, middle, bottom);
      dialog.addEventListener('cancel', (event) => event.preventDefault());
      document.body.append(dialog);
      dialog.showModal();
      return dialog;
    }
    function field(label, type, hook) {
      const wrap = E('label', 'pwb-field'), text = E('span', 'pwb-field-label', label);
      const input = E(type === 'textarea' ? 'textarea' : 'input');
      if (type !== 'textarea') input.type = type;
      input.setAttribute('aria-label', label);
      if (hook) input.dataset.wbField = hook;
      wrap.append(text, input);
      return { wrap, input };
    }
    function openAccounts() {
      const eligible = data.accounts.filter((item) => item.platformId === 'douyin');
      const existing = new Set(includedAccounts()), selection = new Set();
      const search = E('input', 'pwb-search');
      search.type = 'search'; search.placeholder = '搜索抖音账号环境';
      search.setAttribute('aria-label', '搜索可添加账号');
      const list = E('div', 'pwb-option-list');
      const render = () => {
        list.replaceChildren();
        for (const item of eligible.filter((item) => `${item.name} ${item.notes || ''}`.toLowerCase().includes(search.value.toLowerCase()))) {
          const label = E('label', 'pwb-option'), check = E('input');
          check.type = 'checkbox'; check.dataset.accountId = item.id;
          check.checked = existing.has(item.id) || selection.has(item.id);
          check.disabled = existing.has(item.id);
          check.addEventListener('change', () => check.checked ? selection.add(item.id) : selection.delete(item.id));
          const image = E('img'); image.src = icon(); image.alt = '';
          const copy = E('span'); copy.append(E('strong', '', item.name), E('small', '', existing.has(item.id) ? '已加入本批次' : item.running ? '环境已打开' : '使用原有独立环境'));
          label.append(check, image, copy); list.append(label);
        }
        if (!list.children.length) list.append(E('p', 'pwb-muted', '暂无可添加的抖音环境。请先在“环境”中创建抖音预设环境，或在原有发布向导中关联自定义环境。'));
      };
      search.addEventListener('input', render); render();
      modal('添加发布账号', [E('p', 'pwb-muted', '直接使用已有抖音独立环境及登录状态，不会新建浏览器。'), search, list], [button('取消', closeDialog), button('添加所选账号', () => {
        for (const id of selection) model.entries.push(newEntry(id));
        if (!activeAccount && selection.size) activeAccount = [...selection][0];
        closeDialog(); dirty(); renderAccounts(); renderEntries();
      }, { primary: true, hook: 'confirm-accounts' })]);
      search.focus();
    }
    function attachVideos(ids) {
      if (!activeAccount || !editable(model.entries.find(e => e.accountId === activeAccount))) return;
      const wanted = [...new Set(ids)].filter((id) => video(id));
      if (!wanted.length) return;
      if (wanted.length > 1) { notify('当前每个账号准备一条视频，请从素材库为该账号选择一条', 'info'); openLibrary(); return; }
      let entry = model.entries.find((entry) => entry.accountId === activeAccount);
      if (!entry) { entry = newEntry(activeAccount); model.entries.push(entry); }
      entry.videoId = wanted[0]; selected.add(entry.id);
      entry.live = { ...(entry.live || {}), phase: 'syncing', candidates: [] };
      dirty(true); renderAccounts(); renderEntries();
    }
    async function importVideos(command = 'files', paths) {
      if (!activeAccount) throw new Error('请先添加并选择一个账号');
      const accountId = activeAccount;
      const result = await cmd(command, paths);
      if (result.cancelled) return;
      await read();
      activeAccount = accountId;
      const ids = [...(result.added || []), ...(result.duplicateIds || [])];
      if (!ids.length && result.duplicates?.length) { notify('视频已在素材库中，请选择需要发布的一条', 'info'); openLibrary(); }
      else attachVideos(ids);
      const errors = result.errors || [];
      if (errors.length) modal('部分视频未能导入', errors.map((item) => E('p', 'pwb-muted', `${item.name}：${item.reason}`)), [button('知道了', closeDialog)]);
    }
    function openLibrary() {
      const selection = new Set(), list = E('div', 'pwb-option-list');
      const search = E('input', 'pwb-search'); search.type = 'search'; search.placeholder = '搜索本机视频素材'; search.setAttribute('aria-label', '搜索素材库视频');
      const fill = () => {
        list.replaceChildren();
        for (const item of data.videos.filter((item) => item.name.toLowerCase().includes(search.value.toLowerCase()))) {
          const label = E('label', 'pwb-option'), check = E('input');
          check.type = 'radio'; check.name = 'pwb-library-video'; check.dataset.wbVideo = item.id; check.checked = selection.has(item.id);
          check.addEventListener('change', () => { selection.clear(); if (check.checked) selection.add(item.id); });
          const image = E('img', 'pwb-library-thumb'); image.src = item.thumbnailData || ''; image.alt = '';
          const copy = E('span'); copy.append(E('strong', '', item.name), E('small', '', `${Number(item.duration || 0).toFixed(1)} 秒 · ${(Number(item.bytes || 0) / 1048576).toFixed(1)} MB`));
          label.append(check, image, copy); list.append(label);
        }
        if (!list.children.length) list.append(E('p', 'pwb-muted', '暂无视频。可以先选择“本地视频”导入。'));
      };
      search.addEventListener('input', fill); fill();
      modal('从视频素材库选择', [E('p', 'pwb-muted', '每个账号先准备一条视频；选择后会立即上传到该账号的官网页面。'), search, list], [button('取消', closeDialog), button('添加到当前账号', () => { if (!selection.size) throw new Error('请选择一条视频'); closeDialog(); attachVideos([...selection]); }, { primary: true, hook: 'confirm-videos' })]);
    }
    function openBulk() {
      const targets = model.entries.filter((entry) => selected.has(entry.id) && !entry.taskId && !entry.locked);
      if (!targets.length) throw new Error('请先勾选需要批量填写的任务，已锁定内容不会覆盖');
      const title = field('批量标题', 'text'), topics = field('批量话题', 'textarea');
      title.input.dataset.wbBulk = 'title'; topics.input.dataset.wbBulk = 'topics';
      title.input.placeholder = '填写后应用到选中的任务'; topics.input.placeholder = '#话题一 #话题二';
      const titleEnabled = E('input'), topicsEnabled = E('input');
      titleEnabled.type = topicsEnabled.type = 'checkbox'; titleEnabled.checked = topicsEnabled.checked = true;
      titleEnabled.setAttribute('aria-label', '批量应用标题'); topicsEnabled.setAttribute('aria-label', '批量应用话题');
      title.wrap.querySelector('span').prepend(titleEnabled); topics.wrap.querySelector('span').prepend(topicsEnabled);
      modal('批量填写', [E('p', 'pwb-muted', `将应用到 ${targets.length} 条已勾选且未锁定的任务。空白字段不覆盖原内容。`), title.wrap, topics.wrap], [button('取消', closeDialog), button('应用到所选任务', () => {
        const titleValue = title.input.value.trim(), topicsValue = topics.input.value.trim() ? topics.input.value.trimEnd() + ' ' : '';
        if ((!titleEnabled.checked || !titleValue) && (!topicsEnabled.checked || !topicsValue)) throw new Error('请填写至少一项需要应用的内容');
        for (const entry of targets) {
          if (titleEnabled.checked && titleValue) entry.title = titleValue;
          if (topicsEnabled.checked && topicsValue) entry.topics = topicsValue;
        }
        closeDialog(); dirty(true); renderEntries(); renderAccounts(); notify(`已批量填写 ${targets.length} 个账号，正在同步官网`);
      }, { primary: true, hook: 'apply-bulk' })]);
      title.input.focus();
    }
    function removeEntry(entry) {
      if (!editable(entry)) return;
      model.entries = model.entries.filter((item) => item.id !== entry.id); selected.delete(entry.id);
      if (!model.entries.some((item) => item.accountId === activeAccount)) activeAccount = includedAccounts()[0] || null;
      dirty(); renderAccounts(); renderEntries();
    }
    function renderAccounts() {
      const ids = includedAccounts(), expected = new Set(ids);
      for (const [id, row] of accountNodes) if (!expected.has(id)) { row.node.remove(); accountNodes.delete(id); }
      if (!ids.includes(activeAccount)) activeAccount = ids[0] || null;
      for (const id of ids) {
        let view = accountNodes.get(id);
        if (!view) {
          const node = E('div', 'pwb-account-row'), check = E('input'), item = E('button', 'pwb-account');
          check.type = 'checkbox'; check.dataset.wbSelectAccount = id; check.setAttribute('aria-label', `批量选择${account(id)?.name || '账号'}的任务`);
          check.addEventListener('change', () => { for (const entry of model.entries.filter((entry) => entry.accountId === id)) check.checked ? selected.add(entry.id) : selected.delete(entry.id); renderAccounts(); renderEntries(); });
          item.type = 'button'; item.dataset.wbAccount = id;
          item.addEventListener('click', () => { activeAccount = id; renderAccounts(); renderEntries(); });
          const image = E('img'); image.src = icon(); image.alt = ''; image.draggable = false;
          const copy = E('span', 'pwb-account-copy'), name = E('strong'), status = E('small');
          copy.append(name, status); item.append(image, copy); node.append(check, item);
          view = { node, item, check, name, status }; accountNodes.set(id, view);
        }
        const rows = model.entries.filter((entry) => entry.accountId === id);
        const selectedCount = rows.filter((entry) => selected.has(entry.id) && !entry.taskId).length;
        const errors = rows.filter((entry) => abnormal.has(task(entry)?.status) || ['manual', 'error'].includes(entry.live?.phase)).length;
        view.name.textContent = account(id)?.name || '原账号已删除';
        view.status.textContent = errors ? '需要人工处理' : rows[0] ? entryState(rows[0])[1] : '待完善';
        view.node.classList.toggle('active', activeAccount === id);
        view.item.setAttribute('aria-pressed', String(activeAccount === id));
        view.check.checked = selectedCount === rows.length && rows.length > 0;
        view.check.indeterminate = selectedCount > 0 && selectedCount < rows.length;
        view.check.disabled = !editable();
        // Move existing keyed nodes only when their order changed; their icon is retained.
        const at = accountsList.children[ids.indexOf(id)];
        if (at !== view.node) accountsList.insertBefore(view.node, at || null);
      }
      listCount.textContent = `${ids.length} 个账号 · 逐账号同步官网`;
      accountsList.classList.toggle('pwb-no-accounts', !ids.length);
      if (!ids.length && !accountsList.querySelector('.pwb-account-empty')) accountsList.append(E('p', 'pwb-account-empty', '添加账号后，在右侧为每个账号配置视频和文案。'));
      if (ids.length) accountsList.querySelector('.pwb-account-empty')?.remove();
      refreshStatus();
    }
    function createEntryView(entry) {
      const node = E('section', 'pwb-entry'); node.dataset.wbEntry = entry.id;
      const head = E('div', 'pwb-entry-head'), select = E('input'), title = E('strong'), badge = E('span', 'pwb-badge');
      select.type = 'checkbox'; select.dataset.wbSelectEntry = entry.id; select.setAttribute('aria-label', '选择此条视频任务');
      select.addEventListener('change', () => { select.checked ? selected.add(entry.id) : selected.delete(entry.id); renderAccounts(); refreshStatus(); });
      const remove = button('移除账号', () => {
        modal('移除此发布账号', [E('p', 'pwb-muted', '移除本次发布配置，并释放此账号正在同步的未提交编辑页。原账号环境、任务记录和本地视频文件会保留。')], [button('返回', closeDialog), button('确认移除', () => { closeDialog(); removeEntry(entry); }, { hook: 'confirm-remove-entry' })]);
      }, { text: true, hook: 'remove-entry' });
      head.append(select, title, badge, remove);
      const media = E('div', 'pwb-media'), thumbnail = E('img', 'pwb-thumb'); thumbnail.alt = ''; thumbnail.draggable = false;
      const copy = E('div', 'pwb-media-copy'), name = E('strong'), metadata = E('small'); copy.append(name, metadata);
      const preview = button('预览', () => previewVideo(entry), { text: true, hook: 'preview' }); media.append(thumbnail, copy, preview);
      const titleField = field('标题', 'text', 'title'), topicsField = field('话题', 'textarea', 'topics');
      const videoStatus = E('small', 'pwb-field-status'), titleStatus = E('small', 'pwb-field-status'), topicsStatus = E('small', 'pwb-field-status');
      videoStatus.dataset.wbStatus = 'video'; titleStatus.dataset.wbStatus = 'title'; topicsStatus.dataset.wbStatus = 'topics';
      copy.append(videoStatus); titleField.wrap.querySelector('span').append(titleStatus); topicsField.wrap.querySelector('span').append(topicsStatus);
      titleField.input.placeholder = '填写这条视频的作品标题'; topicsField.input.placeholder = '#话题一 #话题二（可选）'; topicsField.input.rows = 2;
      for (const [key, control] of [['title', titleField.input], ['topics', topicsField.input]]) control.addEventListener('input', () => {
        entry[key] = control.value;
        entry.live = { ...(entry.live || {}), phase: entry.videoId ? 'syncing' : 'idle', candidates: [] };
        dirty(); renderAccounts(); renderEntries();
      });
      for (const control of [titleField.input, topicsField.input]) {
        control.addEventListener('compositionstart', () => { composing.add(control); refreshStatus(); });
        control.addEventListener('compositionend', () => { composing.delete(control); dirty(true); });
      }
      const candidates = E('div', 'pwb-candidates'); candidates.dataset.wbCandidates = entry.id; candidates.hidden = true;
      const hint = E('p', 'pwb-topic-hint', '输入话题后加空格确认，也可选择官网候选。');
      const bottom = E('div', 'pwb-entry-foot'), lockLabel = E('label', 'pwb-inline'), lock = E('input'), state = E('small', 'pwb-muted');
      lock.type = 'checkbox'; lock.dataset.wbLock = entry.id; lock.dataset.wbField = 'locked'; lock.addEventListener('change', () => { entry.locked = lock.checked; dirty(); refreshStatus(); });
      lockLabel.append(lock, E('span', '', '锁定文案，批量填写时不覆盖'));
      bottom.append(lockLabel, state);
      node.append(head, media, titleField.wrap, topicsField.wrap, hint, candidates, bottom);
      return { node, select, title, badge, remove, thumbnail, name, metadata, preview, titleInput: titleField.input, topicsInput: topicsField.input, videoStatus, titleStatus, topicsStatus, candidates, lock, state };
    }
    function renderEntries() {
      if (!model || !cards) return;
      const visible = model.entries.filter((entry) => entry.accountId === activeAccount), expected = new Set(model.entries.map((entry) => entry.id));
      for (const [id, view] of entryNodes) if (!expected.has(id)) { view.node.remove(); entryNodes.delete(id); }
      for (const view of entryNodes.values()) if (!visible.some((entry) => entry.id === view.node.dataset.wbEntry)) view.node.remove();
      visible.forEach((entry, index) => {
        let view = entryNodes.get(entry.id);
        if (!view) { view = createEntryView(entry); entryNodes.set(entry.id, view); }
        const item = video(entry.videoId), [state, text] = entryState(entry);
        view.title.textContent = '发布内容'; view.badge.textContent = text; view.badge.dataset.status = state;
        view.select.checked = selected.has(entry.id); view.select.disabled = !editable(entry);
        view.remove.hidden = !editable(entry); view.thumbnail.hidden = !item?.thumbnailData;
        if (view.thumbnail.dataset.video !== entry.videoId) { view.thumbnail.src = item?.thumbnailData || ''; view.thumbnail.dataset.video = entry.videoId; }
        view.name.textContent = item?.name || (entry.videoId ? '素材记录已移除，请重新选择' : '尚未选择视频');
        view.metadata.textContent = item ? `${Number(item.duration || 0).toFixed(1)} 秒 · ${item.width || '—'} × ${item.height || '—'} · ${(Number(item.bytes || 0) / 1048576).toFixed(1)} MB` : '选择视频后，会立即上传至此账号的官网页面';
        view.preview.hidden = !item;
        for (const [key, input] of [['title', view.titleInput], ['topics', view.topicsInput]]) {
          // Polling changes status only; never replace an active editor or its selection.
          if (input.value !== entry[key] && document.activeElement !== input) input.value = entry[key];
          input.readOnly = !editable(entry);
        }
        view.lock.checked = !!entry.locked; view.lock.disabled = !editable(entry);
        const verified = entry.live?.phase === 'ready' && entry.live.revision === entry.live.verifiedRevision;
        view.videoStatus.textContent = !entry.videoId ? '未选择' : entry.live?.phase === 'uploading' ? '正在上传官网' : entry.live?.uploaded || entry.live?.ready || verified ? '官网视频已就绪' : '等待官网核验';
        view.titleStatus.textContent = verified ? '官网已核验' : entry.title ? '待官网核验' : '待填写';
        view.topicsStatus.textContent = verified ? '官网已核验' : entry.live?.pendingTopics ? '请选择候选或输入空格确认' : entry.topics ? '待官网核验' : '可不填';
        for (const status of [view.videoStatus, view.titleStatus, view.topicsStatus]) status.classList.toggle('verified', verified);
        const candidates = entry.live?.candidates || [];
        const candidateSignature = JSON.stringify([entry.live?.candidateRevision, candidates]);
        const rebuildCandidates = view.candidates.dataset.signature !== candidateSignature;
        if (rebuildCandidates) { view.candidates.replaceChildren(); view.candidates.dataset.signature = candidateSignature; }
        view.candidates.hidden = !candidates.length || !editable(entry);
        if (candidates.length && rebuildCandidates) {
          view.candidates.append(E('small', '', '抖音官网话题候选'));
          for (const candidate of candidates) {
            const pick = button(candidate.label, async () => {
              await flush();
              const result = await cmd('workbench-pick', { id: entry.id, candidateId: candidate.id, revision: entry.live?.candidateRevision ?? entry.live?.revision });
              if (result?.entries) { adopt(result); changed = false; }
              else if (result?.topics !== undefined) entry.topics = result.topics;
              await read();
            }, { text: true });
            pick.dataset.wbCandidate = candidate.id;
            view.candidates.append(pick);
          }
        }
        view.state.textContent = entry.taskId ? '本次发布参数已锁定' : '填写后自动同步到原账号官网页面';
        const at = cards.children[index]; if (at !== view.node) cards.insertBefore(view.node, at || null);
      });
      empty.hidden = visible.length > 0;
      accountHeading.textContent = activeAccount ? account(activeAccount)?.name || '账号已删除' : '为账号填写发布内容';
      importButton.disabled = libraryButton.disabled = !activeAccount || !editable(model.entries.find(e => e.accountId === activeAccount));
      refreshStatus();
    }
    function previewVideo(entry) {
      const item = video(entry.videoId); if (!item) return;
      const element = E('video', 'pwb-video-preview'); element.controls = true; element.src = item.mediaUrl || `qiye-media://local/video/${item.id}`;
      const modalNode = modal(item.name, [element], [button('关闭', closeDialog)]);
      modalNode.addEventListener('close', () => { element.pause(); element.removeAttribute('src'); element.load(); }, { once: true });
    }
    function refreshErrors() {
      if (!model || !errorsBox) return;
      const affected = model.entries.filter((entry) => {
        const item = task(entry);
        return abnormal.has(item?.status) || (!item && ['manual', 'error'].includes(entry.live?.phase));
      });
      errorsBox.hidden = affected.length === 0;
      errorList.replaceChildren();
      for (const entry of affected) {
        const item = task(entry);
        const row = E('div', 'pwb-error-item'), copy = E('div');
        copy.append(E('strong', '', `${account(entry.accountId)?.name || '账号'} · ${video(entry.videoId)?.name || '视频'}`), E('p', '', entry.live?.error || item?.result?.reason || item?.result?.message || '官网页面需要检查。'));
        const actions = E('div', 'pwb-error-actions');
        actions.append(button('打开原页面处理', () => cmd('workbench-takeover', { id: entry.id }), { hook: 'takeover' }));
        if (item) actions.append(button('查看日志', async () => {
            const logs = await cmd('logs', item.id);
            modal('本条任务日志', [E('pre', 'pwb-logs', logs.map((line) => `${new Date(line.time).toLocaleTimeString('zh-CN', { hour12: false })} [${line.level}] ${line.message}`).join('\n') || '暂无日志')], [button('关闭', closeDialog)]);
          }, { text: true }));
        if (item?.status !== 'unverified') actions.append(button('处理完成，重新检查', async () => {
          if (item) await cmd('tasks', { ids: [item.id], action: 'start' });
          else await cmd('workbench-retry', { id: entry.id });
          await read();
        }, { primary: true, hook: 'retry' }));
        else actions.append(E('span', 'pwb-muted', '请在任务列表核实是否已发布，避免重复提交。'));
        row.append(copy, actions); errorList.append(row);
      }
    }
    function refreshStatus() {
      if (!model || !shell) return;
      const rows = model.entries, tasks = batchTasks();
      const targets = rows.filter((entry) => selected.has(entry.id) && !entry.taskId);
      const verified = (entry) => entry.live?.phase === 'ready' && entry.live.revision === entry.live.verifiedRevision;
      const readyCount = rows.filter(verified).length;
      const completed = tasks.filter((item) => terminal.has(item.status)).length;
      publishButton.hidden = rows.length > 0 && rows.every(e => e.taskId);
      publishButton.disabled = busy || changed || saving || composing.size > 0 || !targets.length || targets.some((entry) => !verified(entry));
      newButton.disabled = busy || !!model.batchId && tasks.some((item) => !terminal.has(item.status));
      bulkButton.disabled = !editable() || !rows.some((entry) => selected.has(entry.id) && !entry.taskId && !entry.locked);
      selectAll.disabled = !editable() || !rows.length;
      selectAll.checked = rows.length > 0 && targets.length === rows.length;
      selectAll.indeterminate = targets.length > 0 && targets.length < rows.length;
      shell.querySelector('[data-wb-action="add-accounts"]').disabled = !editable();
      batchName.readOnly = !editable();
      summary.textContent = !model.batchId
        ? `官网已核验 ${readyCount} / ${rows.length} 个账号 · 已勾选 ${targets.length} 个。所选账号核验完成后可正式发布。`
        : model.authorizedAt
          ? `正在逐账号提交 · 已提交或结束 ${completed} / ${tasks.length} 条。发布时直接使用已核验的官网页面。`
          : '发布参数已锁定，请在任务列表查看执行结果。';
      refreshErrors();
    }
    function confirmPublish() {
      const entryIds = model.entries.filter((entry) => selected.has(entry.id) && !entry.taskId).map((entry) => entry.id);
      modal('确认正式发布', [E('p', 'pwb-confirm-copy', `确认将已勾选的 ${entryIds.length} 个账号的视频正式发布？`), E('p', 'pwb-muted', '视频、标题和话题已经在各账号官网页面填写并核验。确认后系统将逐页点击官方“发布”按钮，不会重新上传或重新填写。提交后不能保证撤回。')], [button('返回检查', closeDialog), button('确认并正式发布', async () => {
        busy = true; refreshStatus();
        try {
          await flush(); await cmd('workbench-publish', { entryIds, confirmed: true }); closeDialog(); await read(); notify('已授权，系统开始逐页提交发布');
        } finally { busy = false; renderAccounts(); renderEntries(); }
      }, { primary: true, hook: 'confirm-publish' })]);
    }
    function startNew() {
      modal('新建发布批次', [E('p', 'pwb-muted', '清空当前账号和文案配置，并释放本工作台已准备但尚未提交的官网编辑页。已有发布记录、账号登录状态和本地视频文件会保留。')], [button('返回', closeDialog), button('新建空白批次', async () => {
        await flush(); const result = await cmd('workbench-new', { confirmed: true }); closeDialog(); changed = false;
        adopt(result?.entries ? result : { entries: [], name: '', batchId: null });
        activeAccount = null; selected.clear(); acceptedAt = 0; await read(); renderAccounts(); renderEntries();
      }, { primary: true, hook: 'confirm-new-batch' })]);
    }
    function build() {
      shell = E('div', 'pwb'); shell.dataset.workbench = 'true';
      const top = E('div', 'pwb-top'), heading = E('div'), tools = E('div', 'pwb-tools');
      heading.append(E('strong', 'pwb-title', '账号发布工作台'), E('p', 'pwb-muted', '选择视频立即上传，文案自动同步，确认后统一发布。'));
      bulkButton = button('批量填写', openBulk, { primary: true, hook: 'batch-fill' });
      newButton = button('新建批次', startNew, { hook: 'new-batch' });
      tools.append(bulkButton, newButton);
      top.append(heading, tools);
      const content = E('div', 'pwb-content'), left = E('aside', 'pwb-accounts'); left.setAttribute('aria-label', '发布账号列表');
      const listHead = E('div', 'pwb-list-head'); listHead.append(E('h2', '', '发布账号'), button('添加账号', openAccounts, { hook: 'add-accounts' }));
      listCount = E('p', 'pwb-list-count'); accountsList = E('div', 'pwb-account-list');
      const selectWrap = E('label', 'pwb-select-all'), select = E('input'); select.type = 'checkbox'; select.setAttribute('aria-label', '全选批量填写任务'); select.dataset.wbAction = 'select-all'; selectAll = select;
      select.addEventListener('change', () => { for (const entry of model.entries) select.checked ? selected.add(entry.id) : selected.delete(entry.id); renderAccounts(); renderEntries(); });
      selectWrap.append(select, E('span', '', '全选批量填写任务')); left.append(listHead, listCount, selectWrap, accountsList);
      const right = E('section', 'pwb-form'), formHead = E('div', 'pwb-form-head'), formTools = E('div', 'pwb-tools');
      accountHeading = E('h2'); importButton = button('本地视频', () => importVideos(), { hook: 'import-videos' });
      libraryButton = button('素材库', openLibrary, { hook: 'library' });
      formTools.append(importButton, libraryButton); formHead.append(accountHeading, formTools);
      const formBody = E('div', 'pwb-form-body'); cards = E('div', 'pwb-entries'); empty = E('div', 'pwb-empty');
      empty.append(E('strong', '', '先添加发布账号'), E('p', '', '左侧选择账号，右侧填写视频、标题和话题。本期每个账号准备一条视频，支持多个账号一起发布。'));
      errorsBox = E('section', 'pwb-errors'); errorsBox.hidden = true; errorsBox.dataset.wbManual = 'true'; errorsBox.setAttribute('aria-label', '人工操作栏目');
      errorsBox.append(E('h3', '', '需要人工处理'), E('p', 'pwb-muted', '已完成的步骤会保留。打开对应账号原页面处理异常，再继续该任务。')); errorList = E('div'); errorsBox.append(errorList);
      formBody.append(errorsBox, empty, cards); right.append(formHead, formBody); content.append(left, right);
      const footer = E('footer', 'pwb-footer'), details = E('div', 'pwb-footer-copy'), nameLabel = E('label', 'pwb-batch-name', '批次名称');
      batchName = E('input'); batchName.type = 'text'; batchName.placeholder = '视频发布批次'; batchName.setAttribute('aria-label', '发布批次名称');
      batchName.addEventListener('input', () => { model.name = batchName.value; dirty(); }); nameLabel.append(batchName);
      summary = E('p', 'pwb-summary'); saved = E('small', 'pwb-save-state', '已保存到本机');
      details.append(nameLabel, summary, saved); const buttons = E('div', 'pwb-footer-actions');
      publishButton = button('正式发布', confirmPublish, { primary: true, hook: 'publish' });
      buttons.append(publishButton); footer.append(details, buttons); shell.append(top, content, footer);
      for (const event of ['dragenter', 'dragover']) formBody.addEventListener(event, (event) => { if (editable() && activeAccount) { event.preventDefault(); formBody.classList.add('pwb-drop-active'); } });
      formBody.addEventListener('dragleave', () => formBody.classList.remove('pwb-drop-active'));
      formBody.addEventListener('drop', (event) => { event.preventDefault(); formBody.classList.remove('pwb-drop-active'); if (editable() && activeAccount) run(() => importVideos('import', window.publishingAPI.paths(event.dataTransfer.files))); });
    }
    function update(snapshot) {
      data = snapshot;
      const incoming = snapshot.workbench || { entries: [], name: '', batchId: null, updatedAt: 0 };
      const incomingBatch = incoming.batchId || null;
      if (!model || (incomingBatch !== (model.batchId || null) && incomingBatch) || (!changed && !saving && (incoming.updatedAt || 0) > acceptedAt)) {
        adopt(incoming);
        acceptedAt = incoming.updatedAt || acceptedAt;
        if (incomingBatch) changed = false;
        if (!selected.size) model.entries.forEach((entry) => selected.add(entry.id));
      } else {
        mergeLive(incoming);
        if (model.batchId && incomingBatch === model.batchId) model.authorizedAt = incoming.authorizedAt;
      }
      if (!shell) build();
      if (batchName.value !== model.name && document.activeElement !== batchName) batchName.value = model.name;
      renderAccounts(); renderEntries();
    }
    return {
      mount(container, snapshot) { host = container; update(snapshot); if (shell.parentNode !== host) host.append(shell); },
      update,
      leave() { closeDialog(); flush().catch((error) => notify(error.message, 'error')); },
    };
  };
})();
