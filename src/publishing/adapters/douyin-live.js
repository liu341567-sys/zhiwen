'use strict';

// The workbench keeps one connection to the existing account page. Editing is
// performed here, before a publish task is authorized. submit() deliberately
// has no upload or caption-writing path.
const { Page } = require('./page');
const { observe, openPublishingPage, waitUploadState } = require('./douyin');

const MANAGEMENT_URL = 'https://creator.douyin.com/creator-micro/content/manage';
const normalize = text => String(text || '').replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\s*#/g, ' #').replace(/\s+/g, ' ').trim();
const manual = reason => Object.assign(new Error(reason), { manual: true });
const editorUrl = value => {
  try { const url = new URL(value); return url.protocol === 'https:' && url.hostname === 'creator.douyin.com' && url.pathname === '/creator-micro/content/post/video'; }
  catch { return false; }
};

// Executed in the same isolated world as the existing publishing adapter. DOM
// references stay in the page; only bounded, public topic labels leave it.
function probe(input, base) {
  const visible = e => {
    if (!e?.isConnected) return false;
    const r = e.getBoundingClientRect(), style = getComputedStyle(e);
    return r.width > 0 && r.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
  };
  const text = e => String(e.innerText || e.textContent || '').replace(/[\u200B-\u200D\uFEFF]/g, '').trim().slice(0, 400);
  const topicName = e => {
    const official = e.querySelector('[class^="tag-hash-view-name-"],[class*=" tag-hash-view-name-"]');
    const value = official ? text(official) : text(e).split(/[\n\r]/).map(v => v.trim()).find(Boolean) || '';
    return value.startsWith('#') ? value : `#${value}`;
  };
  let state = window.__qiyeLiveTopics;
  if (!state || state.owner !== input.owner) {
    state = window.__qiyeLiveTopics = { owner: input.owner, serial: 0, signature: '', version: 0, entries: [] };
  }
  const owned = document.documentElement.dataset.qiyePublishTask === input.owner;
  const editor = base.editorSelector && document.querySelector(base.editorSelector);
  const raw = base.editorText || '';
  const pending = /(?:^|\s)(#[^\s#]+)$/.exec(raw)?.[1] || '';
  const linked = new Set(String(editor?.getAttribute('aria-controls') || editor?.getAttribute('aria-owns') || '').split(/\s+/).filter(Boolean));
  // The recorded official popup has no ARIA roles. Use its stable component
  // prefixes, plus explicit listboxes; static recommended hashtags elsewhere
  // on the page must never become selectable "official search results".
  const roots = [...document.querySelectorAll('.mention-suggest-mount-dom,[class^="mention-suggest-"],[class*=" mention-suggest-"],[role="listbox"]')]
    .filter(e => visible(e) && !e.contains(editor) && !editor?.contains(e))
    .filter(e => linked.has(e.id) || (pending && (/#|话题/.test(text(e)) || text(e).includes(pending.slice(1)))));
  const nodes = [];
  for (const root of roots) {
    const officialRows = [...root.querySelectorAll('[class^="tag-hash-view-name-"],[class*=" tag-hash-view-name-"]')].map(name => {
      for (let node = name.parentElement; node && root.contains(node); node = node.parentElement)
        if ([...node.classList].some(value => /^tag-hash-(?!view-)/.test(value))) return node;
      return null;
    }).filter(visible);
    const semantic = [...officialRows, ...root.querySelectorAll('[role="option"],li,[data-topic-id],[class*="suggestion-item"],[class*="mention-item"],[class*="topic-item" i]')].filter(visible);
    const choices = semantic.length ? semantic : [...root.children].filter(visible);
    for (const node of choices) {
      if (nodes.includes(node) || choices.some(child => child !== node && node.contains(child))) continue;
      if (node.disabled || node.getAttribute('aria-disabled') === 'true') continue;
      const value = text(node);
      if (!value || value.length > 300 || !pending) continue;
      // A topic row may include a usage count on a later line. Keep the full
      // official text for identity checks and display a bounded first line.
      const label = topicName(node);
      if (label.length < 2 || label.length > 160) continue;
      nodes.push(node);
    }
  }
  const entries = nodes.slice(0, 30).map(node => {
    const value = text(node), label = topicName(node);
    const old = state.entries.find(entry => entry.node === node && entry.text === value && entry.caption === raw && entry.pending === pending);
    return old || { node, id: `topic-${++state.serial}`, text: value, label, caption: raw, pending };
  });
  const signature = JSON.stringify([raw, entries.map(e => [e.id, e.text])]);
  if (signature !== state.signature) { state.signature = signature; state.version++; }
  state.entries = entries;
  if (input.action === 'pick') {
    const chosen = entries.find(entry => entry.id === input.id);
    if (!owned || !chosen || input.candidateRevision !== state.version || !visible(chosen.node) || text(chosen.node) !== chosen.text)
      return { invalidCandidate: true, candidateRevision: state.version };
    document.querySelectorAll('[data-qiye-live-topic]').forEach(e => e.removeAttribute('data-qiye-live-topic'));
    chosen.node.setAttribute('data-qiye-live-topic', input.marker);
    return { target: `[data-qiye-live-topic="${input.marker}"]`, label: chosen.label, candidateRevision: state.version };
  }
  if (input.action === 'cleanup') {
    document.querySelectorAll('[data-qiye-live-topic]').forEach(e => e.removeAttribute('data-qiye-live-topic'));
    if (window.__qiyeLiveTopics?.owner === input.owner) delete window.__qiyeLiveTopics;
  }
  return {
    ...base, owned, pendingTopics: !!pending,
    videoPresent: [...document.querySelectorAll('video')].some(e => visible(e) && !!(e.currentSrc || e.getAttribute('src'))),
    videoSelected: [...document.querySelectorAll('input[type="file"]')].some(e => /video|mp4|mov/i.test(e.accept) && e.files?.length),
    candidateRevision: state.version,
    candidates: entries.map(e => ({ id: e.id, label: e.label, text: e.text, kind: 'topic' })),
  };
}
const readProbe = new Function('input', `const base=(${observe.toString()})();return (${probe.toString()})(input,base);`);

class DouyinLiveEditor {
  constructor({ getView, accountId, token, signal, log = () => {}, trace = () => {}, checkpoint = () => {} }) {
    if (typeof getView !== 'function' || typeof accountId !== 'string' || typeof token !== 'string' || !token)
      throw new Error('实时编辑环境参数无效');
    this.getView = getView;
    this.accountId = accountId;
    this.token = token;
    this.signal = signal || new AbortController().signal;
    this.log = log;
    this.trace = trace;
    this.checkpoint = checkpoint;
    this.queue = Promise.resolve();
    this.latestRevision = 0;
    this.appliedRevision = 0;
    this.desired = { title: '', topics: '' };
    this.uploadStarted = false;
    this.submissionIntent = false;
    this.closed = false;
  }
  _enqueue(operation) {
    const job = this.queue.catch(() => {}).then(() => {
      if (this.closed) throw manual('实时编辑连接已关闭，请重新连接账号');
      return operation();
    });
    this.queue = job.catch(() => {});
    return job;
  }
  async _read() {
    if (!this.page) return { owned: false, ready: false, candidates: [], candidateRevision: 0 };
    return this.page.evaluate(readProbe, { owner: this.token });
  }
  _caption(state, desired = this.desired) {
    return state.titleSelector ? desired.topics : [desired.title, desired.topics].filter(Boolean).join(' ');
  }
  _matches(state, desired = this.desired) {
    return !!state.editorSelector && normalize(state.editorText) === normalize(this._caption(state, desired)) &&
      (!state.titleSelector || normalize(state.titleText) === normalize(desired.title));
  }
  _public(state) {
    const matched = this._matches(state), split = !!state.titleSelector;
    const pendingTopics = /(?:^|\s)#[^\s#]+$/.test(this.desired.topics);
    const caption = state.editorText || '';
    let title = split ? state.titleText || '' : '', topics = caption;
    if (!split && caption.startsWith(this.desired.title)) {
      title = this.desired.title;
      topics = caption.slice(title.length).trimStart();
    }
    if (matched && /\s$/.test(this.desired.topics) && normalize(topics) === normalize(this.desired.topics)) topics = this.desired.topics;
    const verified = !!(state.owned && state.ready && editorUrl(state.url) && matched && this.appliedRevision === this.latestRevision && !state.challenge && !state.login && !state.error);
    return {
      ready: !!(state.ready && state.owned), uploading: !!(this.uploadStarted && !state.ready),
      owned: !!state.owned, verified, canSubmit: verified && !!state.publishReady && !pendingTopics && !state.topicPopupOpen,
      revision: this.latestRevision, appliedRevision: this.appliedRevision,
      title, topics, caption, candidates: state.candidates || [], candidateRevision: state.candidateRevision || 0,
      pendingTopics, login: !!state.login, challenge: !!state.challenge,
      error: state.error || '', url: state.url || this.page?.wc.getURL() || '',
      submitted: !!state.submitted, submitIntent: this.submissionIntent,
    };
  }
  async prepare(video, { resume = false } = {}) {
    return this._enqueue(async () => {
      if (!video || typeof video.path !== 'string' || !video.path) throw new Error('请选择真实的本地视频');
      if (this.video && this.video.path !== video.path) throw manual('当前官方编辑页已有视频，请先移除此账号草稿再更换视频');
      if (!this.page) {
        const wc = await this.getView(this.accountId);
        this.page = new Page(wc, this.signal, this.log, this.trace);
        await this.page.connect();
      }
      const page = this.page;
      const url = new URL(page.wc.getURL());
      if (url.protocol !== 'https:' || url.hostname !== 'creator.douyin.com' || !url.pathname.startsWith('/creator-micro/'))
        await page.navigate(MANAGEMENT_URL);
      await page.wait(() => document.readyState === 'complete', null, 60000);
      let state = await this._read();
      const context = { signal: this.signal, log: this.log, trace: this.trace };
      if (state.login || state.challenge) throw manual('请在此账号的原页面完成登录或安全验证，再继续同步');
      if (!state.hasUpload && !state.editorSelector) state = await openPublishingPage(page, context, state);
      if (state.login || state.challenge) throw manual('发布页要求登录或安全验证，请人工处理');
      state = await this._read();
      if (state.error) throw manual(state.error);
      if ((state.ready || state.previewReady || state.progressing || state.videoPresent || state.videoSelected || normalize(state.titleText) || normalize(state.editorText)) && !state.owned)
        throw manual('该账号官网已有未关联的视频草稿，请先处理原页面内容，未覆盖或重复上传');
      if (!this.uploadStarted && resume) {
        if (!state.owned || !(state.ready || state.videoPresent || state.videoSelected || state.progressing))
          throw manual('原草稿视频或页面归属已变化，请人工检查，未重新上传');
        // The controller retains the original token and exact video snapshot
        // when the user temporarily takes over the same official page.
        this.video = { ...video };
        this.uploadStarted = true;
        this.log('实时编辑：重新连接原草稿页面，保留已上传视频，未重复上传');
      }
      if (!this.uploadStarted && state.owned && (state.ready || state.videoPresent || state.videoSelected || state.progressing))
        throw manual('该账号已有当前草稿视频，请通过继续同步恢复，未重复上传');
      if (this.uploadStarted) {
        if (!state.owned) throw manual('原上传页面已变化，无法确认当前视频，请人工检查');
      } else {
        if (!state.hasUpload || state.uploadCount !== 1) throw manual('未找到唯一可用的视频上传控件，请打开官方视频上传页');
        const otherOwner = await page.evaluate(() => document.documentElement.dataset.qiyePublishTask || '');
        if (otherOwner && otherOwner !== this.token) throw manual('此官方编辑页属于其他发布任务，请先处理该任务');
        const extension = String(video.format || video.path.split('.').pop()).toLowerCase();
        if (state.accept.includes('.') && !state.accept.includes('video') && !state.accept.toLowerCase().includes(`.${extension}`))
          throw new Error(`平台上传控件不接受 ${extension}，请转换后重新导入`);
        await page.evaluate(owner => { document.documentElement.dataset.qiyePublishTask = owner; }, this.token);
        this.video = { ...video };
        // Once native upload is invoked, an uncertain acknowledgement must not
        // lead to a second upload. A retry only observes this owned page.
        this.uploadStarted = true;
        this.checkpoint({ uploadStarted: true, liveOwner: this.token });
        this.log('实时编辑：立即向当前账号官方页面上传所选视频');
        await page.upload(state.uploadSelector, video.path);
      }
      state = await waitUploadState(page, context, 'form');
      if (state.login || state.challenge || state.error) throw manual(state.error || '上传期间需要登录或验证');
      state = await this._read();
      if (!state.owned) throw manual('上传后页面归属发生变化，请人工检查');
      this.checkpoint({ formReady: true, uploaded: true, liveOwner: this.token });
      this.log('实时编辑：官方视频预览与表单已就绪，可开始同步标题和话题');
      return this._public(state);
    });
  }
  async sync({ title = '', topics = '', revision }) {
    if (typeof title !== 'string' || typeof topics !== 'string' || title.length > 5000 || topics.length > 10000 || !Number.isSafeInteger(revision) || revision < 1)
      throw new Error('实时文案参数无效');
    if (revision < this.latestRevision) return { ...(await this.inspect()), stale: true };
    if (revision === this.latestRevision && (title !== this.desired.title || topics !== this.desired.topics))
      throw new Error('文案版本已变化，请重新同步');
    this.latestRevision = revision;
    this.desired = { title, topics };
    return this._enqueue(async () => {
      if (revision !== this.latestRevision) return { ...(await this.inspect()), stale: true };
      let state = await this._read();
      if (!state.owned || !state.ready || !editorUrl(state.url)) throw manual('该账号视频尚未在官方页面准备完成，或页面已变化');
      if (state.challenge || state.login || state.error) throw manual(state.error || '请先处理账号登录或安全验证');
      const desired = { title, topics }, caption = this._caption(state, desired);
      if (caption.length > state.maxLength || (state.titleSelector && title.length > state.titleMaxLength))
        throw new Error(`文案超过官网当前上限：标题 ${state.titleSelector ? state.titleMaxLength : state.maxLength} 字，简介 ${state.maxLength} 字`);
      if (!this._matches(state, desired)) {
        if (state.titleSelector && normalize(state.titleText) !== normalize(title)) await this.page.fill(state.titleSelector, title);
        if (revision !== this.latestRevision) return { ...(await this.inspect()), stale: true };
        const pieces = [...topics.matchAll(/#[^\s#]+/g)];
        const onlyTopics = pieces.length && normalize(pieces.map(m => m[0]).join(' ')) === normalize(topics);
        if (onlyTopics) {
          await this.page.fill(state.editorSelector, state.titleSelector ? '' : title);
          for (let i = 0; i < pieces.length; i++) {
            if (revision !== this.latestRevision) return { ...(await this.inspect()), stale: true };
            if (i === 0 && !state.titleSelector && title) await this.page.append(state.editorSelector, ' ');
            await this.page.append(state.editorSelector, pieces[i][0]);
            if (i < pieces.length - 1 || /\s$/.test(topics)) await this.page.space(state.editorSelector);
          }
        } else await this.page.fill(state.editorSelector, caption);
      } else if (/\s$/.test(topics) && state.pendingTopics) {
        // An explicit trailing space is the user's normal official hashtag
        // confirmation gesture; it does not choose an arbitrary suggestion.
        await this.page.space(state.editorSelector);
      }
      if (revision !== this.latestRevision) return { ...(await this.inspect()), stale: true };
      const end = Date.now() + 5000;
      do {
        state = await this._read();
        if (this._matches(state, desired)) break;
        this.page.check();
        await new Promise(resolve => setTimeout(resolve, 100));
      } while (Date.now() < end && revision === this.latestRevision);
      if (!this._matches(state, desired)) throw manual('官网未保留最新标题或话题，请查看官方页面；未提交发布');
      if (revision === this.latestRevision) this.appliedRevision = revision;
      this.log('实时编辑：标题和话题已写入并回读官方页面');
      return this._public(state);
    });
  }
  async inspect() {
    if (this.closed) throw manual('实时编辑连接已关闭');
    return this._public(await this._read());
  }
  async pick({ id, revision, candidateRevision }) {
    if (typeof id !== 'string' || !Number.isSafeInteger(revision)) throw new Error('话题候选参数无效');
    return this._enqueue(async () => {
      if (revision !== this.latestRevision || this.appliedRevision !== revision) throw manual('文案已变化，请等待最新官方候选后重新选择');
      let state = await this._read();
      const choice = state.candidates?.find(c => c.id === id);
      if (!choice || (candidateRevision != null && candidateRevision !== state.candidateRevision)) throw manual('官方话题候选已更新，请选择当前列表中的候选');
      const marker = `${this.token.replace(/[^a-zA-Z0-9-]/g, '').slice(0, 64)}-${revision}`;
      const target = await this.page.evaluate(readProbe, { action: 'pick', owner: this.token, id, candidateRevision: state.candidateRevision, marker });
      if (!target.target) throw manual('官方候选已变化，未点击其他话题，请刷新候选后重选');
      await this.page.click({ selector: target.target }, { hover: false });
      const before = normalize(state.editorText);
      state = await this.page.wait(readProbe, { owner: this.token }, 5000, {
        accept: s => s.owned && !s.challenge && !s.login && (!s.pendingTopics || !s.topicPopupOpen || normalize(s.editorText) !== before),
      });
      if (!state.owned || state.challenge || state.login) throw manual('选择话题后页面需要人工检查');
      const split = !!state.titleSelector;
      const actualTopics = split ? state.editorText : state.editorText.startsWith(this.desired.title) ? state.editorText.slice(this.desired.title.length).trimStart() : null;
      if (actualTopics === null) throw manual('选择话题后官方文案结构发生变化，请人工检查');
      if (!(normalize(actualTopics).match(/#[^\s#]+/g) || []).includes(normalize(choice.label)))
        throw manual('官网没有保留所选话题，请检查当前候选和文案，未确认该话题');
      // Selecting an official candidate commits that hashtag. Preserve an
      // explicit local token terminator even when its noneditable chip omits
      // trailing whitespace from textContent. No additional native write.
      this.desired = { title: split ? state.titleText : this.desired.title, topics: actualTopics.trimEnd() ? actualTopics.trimEnd() + ' ' : '' };
      this.log('实时编辑：已在原账号官网选择该话题，并回读实际文案');
      return this._public(state);
    });
  }
  async validate(snapshot) {
    const state = await this._read();
    const video = snapshot?.video;
    const owner = snapshot?.liveOwner || snapshot?.checkpoint?.liveOwner;
    if (owner !== this.token || !state.owned || !editorUrl(state.url) || !this.uploadStarted || !this.video || video?.path !== this.video.path ||
        (video.sha256 && this.video.sha256 && video.sha256 !== this.video.sha256))
      throw manual('当前官方视频与已确认草稿无法对应，请重新检查，未上传或提交');
    if (this.submissionIntent) throw manual('此草稿已经发出提交操作，必须核实官网结果，不会重复点击发布');
    if (normalize(snapshot.title) !== normalize(this.desired.title) || normalize(snapshot.topics) !== normalize(this.desired.topics) || !this._matches(state, snapshot))
      throw manual('官网文案与确认的草稿不一致，请先在表单同步并核验');
    if (this.appliedRevision !== this.latestRevision || !state.publishReady || state.challenge || state.login || state.error || this._public(state).pendingTopics || state.topicPopupOpen)
      throw manual(state.error || '官方页面尚未就绪，或话题仍待确认，请先处理对应表单；未提交');
    return this._public(state);
  }
  async reconnectPrepared(snapshot) {
    return this._enqueue(async () => {
      const owner = snapshot?.liveOwner || snapshot?.checkpoint?.liveOwner;
      if (owner !== this.token || !snapshot?.video?.path || snapshot.checkpoint?.submitIntent)
        throw manual('原实时草稿归属或提交状态无法确认，未重试发布');
      if (this.page) throw manual('实时草稿已连接，请先关闭原调试连接');
      const wc = await this.getView(this.accountId);
      this.page = new Page(wc, this.signal, this.log, this.trace);
      try {
        await this.page.connect();
        const state = await this._read();
        if (!state.owned || !state.ready || !editorUrl(state.url)) throw manual('原草稿页面或视频已变化，请重新核对，未上传或填写');
        this.video = { ...snapshot.video };
        this.uploadStarted = true;
        this.desired = { title: snapshot.title || '', topics: snapshot.topics || '' };
        const revision = snapshot.liveRevision || snapshot.revision;
        this.latestRevision = this.appliedRevision = Number.isSafeInteger(revision) && revision > 0 ? revision : 1;
        const result = await this.validate(snapshot);
        this.log('实时编辑：重新连接并核验原草稿，未导航、上传或填写');
        return result;
      } catch (error) { this.close(); throw error; }
    });
  }
  async submit(snapshot, context = {}) {
    return this._enqueue(async () => {
      const page = this.page;
      if (!page) return { status: 'manual', reason: '实时编辑连接不存在，请重新连接该账号' };
      const oldSignal = page.signal;
      page.signal = context.signal ? AbortSignal.any([this.signal, context.signal]) : this.signal;
      try {
        if (!snapshot.autoSubmit && !snapshot.checkpoint?.submissionAuthorized)
          throw manual('尚未取得本次发布授权，请先确认发布');
        await this.validate(snapshot);
        const target = await page.evaluate(() => {
          const matches = [...document.querySelectorAll('button,[role="button"]')].filter(e => {
            const r = e.getBoundingClientRect();
            return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden' && e.textContent.trim() === '发布' && !e.disabled && e.getAttribute('aria-disabled') !== 'true';
          });
          return matches.length === 1 ? { selector: 'button,[role="button"]', text: '发布' } : null;
        });
        if (!target) throw manual('未找到唯一可操作的官方发布按钮，请人工检查');
        // Persist the boundary before sending any mouse button event. The task
        // engine must retain this checkpoint if click acknowledgement times out.
        await (context.checkpoint || this.checkpoint)({ submitIntent: true, submitTime: Date.now(), liveOwner: this.token });
        this.submissionIntent = true;
        (context.log || this.log)('实时草稿已核验，直接点击官网发布；未重复上传或填写');
        await page.click(target, { hover: false });
        const result = await page.wait(readProbe, { owner: this.token }, 60000, {
          accept: s => s.error || s.challenge || s.login || s.submitted || s.url.includes('/content/manage'),
        }).catch(() => null);
        if (result?.submitted) return { status: 'submitted', reason: '官方页面反馈提交成功；作品审核与上线仍由平台处理', submittedAt: Date.now() };
        return { status: 'unverified', reason: result?.error || '已发送提交，但未取得明确成功反馈，请核实官网结果；不会自动重复提交' };
      } catch (error) {
        if (this.submissionIntent) return { status: 'unverified', reason: `已到达提交边界：${error.message}；不会自动重复提交` };
        if (error.manual) return { status: 'manual', reason: error.message };
        throw error;
      } finally { page.signal = oldSignal; this.close(); }
    });
  }
  async discard() {
    // Called only for an explicit removal/replacement action. The session
    // signal may already be aborted, so use a separate bounded connection to
    // inspect ownership, never a new browser or a different account context.
    const wc = this.page?.wc;
    if (!wc || wc.isDestroyed() || this.submissionIntent) { this.close(); return false; }
    const controller = new AbortController();
    const page = new Page(wc, controller.signal);
    let timer;
    try {
      timer = setTimeout(() => controller.abort(), 8000);
      const owned = await page.evaluate(owner => document.documentElement.dataset.qiyePublishTask === owner, this.token);
      if (!owned) return false;
      this.page.detach();
      await page.navigate(MANAGEMENT_URL);
      this.uploadStarted = false;
      return true;
    } finally { clearTimeout(timer); this.close(); }
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    // No navigation, storage clearing, or account teardown belongs to close.
    const page = this.page;
    if (page && !page.wc.isDestroyed()) {
      page.wc.executeJavaScriptInIsolatedWorld(2002, [{ code: `if(window.__qiyeLiveTopics?.owner===${JSON.stringify(this.token)}){delete window.__qiyeLiveTopics;document.querySelectorAll('[data-qiye-live-topic]').forEach(e=>e.removeAttribute('data-qiye-live-topic'));}` }]).catch(() => {});
      page.detach();
    }
  }
}

module.exports = { DouyinLiveEditor, normalize, probe };
