'use strict';
const { Page } = require('./page');
const MANAGEMENT_URL =
  'https://creator.douyin.com/creator-micro/content/manage';
const stateWhen = (condition) =>
  new Function(`const s=(${observe.toString()})();return ${condition};`);
const descriptor = {
  id: 'douyin',
  name: '抖音',
  enabled: true,
  entry: MANAGEMENT_URL,
  capabilities: {
    video: true,
    title: true,
    topics: true,
    cover: 'manual',
    location: 'manual',
    nativeSchedule: 'manual',
  },
  note: '预览适配器：真实账号发布与话题关联需实机核实，请先使用单条人工确认。上传、填写与提交需实时识别发布页；自定义封面、定位和平台原生定时目前需人工设置并核实。实际作品上线时间由平台决定。',
};
function observe() {
  const visible = (e) => {
    const r = e.getBoundingClientRect();
    return (
      r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden'
    );
  };
  const read = (e) => {
    if (!e) return '';
    if (e.tagName === 'INPUT' || e.tagName === 'TEXTAREA') return e.value;
    const copy = e.cloneNode(true);
    copy
      .querySelectorAll(
        '[data-slate-placeholder], [data-placeholder="true"], .public-DraftEditorPlaceholder-root',
      )
      .forEach((n) => n.remove());
    // textContent preserves inline hashtag chips even when an editor renders
    // block lines or noneditable entities; placeholder text is not user input.
    return copy.textContent || '';
  };
  const label = (e) =>
    [
      e.placeholder,
      e.dataset.placeholder,
      e.getAttribute('aria-label'),
      e.closest('label')?.innerText,
    ].join(' ');
  const text = document.body.innerText;
  const challenge =
    /请完成.{0,12}验证|安全验证|滑块验证|拖动.{0,12}滑块|验证码|二次验证|身份验证/.test(
      [
        ...document.querySelectorAll(
          '[role="dialog"], [class*="captcha"], [id*="captcha"], [class*="verify"]',
        ),
      ]
        .filter(visible)
        .map((e) => e.innerText)
        .join(' '),
    );
  const uploads = [...document.querySelectorAll('input[type="file"]')].filter(
    (e) => !e.disabled && /video|mp4|mov/i.test(e.accept),
  );
  const upload = uploads.length === 1 ? uploads[0] : null;
  document
    .querySelectorAll('[data-qiye-upload]')
    .forEach((e) => e.removeAttribute('data-qiye-upload'));
  if (upload) upload.setAttribute('data-qiye-upload', 'video');
  const login =
    /扫码登录|短信登录|手机号登录|登录已失效|登录过期/.test(text) &&
    !uploads.length;
  const editors = [
    ...document.querySelectorAll(
      'input:not([type]), input[type="text"], textarea, [contenteditable="true"]',
    ),
  ].filter((e) => visible(e) && !e.disabled && !e.readOnly);
  const descriptions = editors.filter((e) => /简介|描述/.test(label(e)));
  const titles = editors.filter(
    (e) => /标题/.test(label(e)) && !descriptions.includes(e),
  );
  const rich = editors.filter(
    (e) => e.isContentEditable && !/搜索|查找/.test(label(e)),
  );
  const editor =
    descriptions.length === 1
      ? descriptions[0]
      : !descriptions.length && rich.length === 1
        ? rich[0]
        : !descriptions.length && titles.length === 1
          ? titles[0]
          : null;
  const title =
    editor && titles.length === 1 && titles[0] !== editor ? titles[0] : null;
  document
    .querySelectorAll('[data-qiye-editor]')
    .forEach((e) => e.removeAttribute('data-qiye-editor'));
  if (editor) editor.setAttribute('data-qiye-editor', 'caption');
  if (title) title.setAttribute('data-qiye-editor', 'title');
  const error = [
    ...document.querySelectorAll(
      '[role="alert"], [class*="error"], [class*="Error"]',
    ),
  ]
    .filter(visible)
    .map((e) => e.innerText)
    .filter(
      (t) =>
        t &&
        t.length < 300 &&
        /失败|不支持|超出|不能为空|错误|限制|异常|不符合/.test(t),
    )
    .join('；');
  const submitReady = [
    ...document.querySelectorAll('button,[role="button"]'),
  ].some(
    (e) =>
      visible(e) &&
      e.textContent.trim() === '发布' &&
      !e.disabled &&
      e.getAttribute('aria-disabled') !== 'true',
  );
  // Completion of the video and validity of the caption are separate platform
  // states. Never require an enabled Publish button before filling the caption.
  const videoInputs = [
    ...document.querySelectorAll('input[type="file"]'),
  ].filter((e) => /video|mp4|mov/i.test(e.accept));
  const previews = [...document.querySelectorAll('video')].filter(
    (e) =>
      visible(e) &&
      !e.closest('aside,nav') &&
      (e.currentSrc || e.getAttribute('src')),
  );
  let uploadRoot = null;
  for (
    let parent = (videoInputs[0] || previews[0])?.parentElement;
    parent && parent !== document.body;
    parent = parent.parentElement
  ) {
    // Prefer the nearest common container of the input and preview. Some
    // upload inputs sit in a small hidden wrapper with a sibling preview.
    if (parent.querySelector('video')) {
      uploadRoot = parent;
      break;
    }
    if (
      /upload|uploader/i.test(
        [parent.id, parent.className, parent.getAttribute('data-testid')].join(
          ' ',
        ),
      )
    ) {
      uploadRoot = parent;
    }
  }
  const previewReady = previews.some(
    (e) =>
      (!uploadRoot || uploadRoot.contains(e)) &&
      e.readyState >= 2 &&
      e.videoWidth > 0 &&
      e.videoHeight > 0,
  );
  const semantics = (e) =>
    [
      e.id,
      e.className,
      e.getAttribute('aria-label'),
      e.getAttribute('data-testid'),
    ].join(' ');
  const related = (e) =>
    !e.closest('aside,nav') &&
    (uploadRoot
      ? uploadRoot.contains(e) ||
        /upload|上传|transcod|转码/i.test(semantics(e))
      : true);
  const progressNodes = [
    ...document.querySelectorAll('[role="progressbar"],progress'),
  ].filter((e) => visible(e) && related(e));
  const progress = progressNodes.map((e) => {
    const raw = e.getAttribute('aria-valuenow');
    const value =
      raw !== null && raw.trim() !== ''
        ? Number(raw)
        : e.tagName === 'PROGRESS' && e.hasAttribute('value')
          ? e.value
          : null;
    const rawMax = e.getAttribute('aria-valuemax');
    const max = rawMax
      ? Number(rawMax)
      : e.tagName === 'PROGRESS'
        ? e.max
        : 100;
    return {
      value: Number.isFinite(value) ? value : null,
      max: Number.isFinite(max) && max > 0 ? max : 100,
    };
  });
  const statusNodes = [
    ...document.querySelectorAll('div,span,p,[role="status"]'),
  ].filter(
    (e) =>
      visible(e) &&
      related(e) &&
      !e.closest('[contenteditable="true"]') &&
      !e.contains(editor) &&
      !e.contains(title),
  );
  const statusText = statusNodes
    .map((e) => e.innerText.trim())
    .filter((t) => t.length > 0 && t.length <= 120);
  const uploadComplete = statusText.some((t) =>
    /^(?:视频)?(?:已)?上传(?:完成|成功|完毕)/.test(t),
  );
  const busyText = statusText.some((t) =>
    /^(?:视频)?(?:正在)?(?:上传中|处理中|转码中|正在上传|正在处理)(?:\s|[，。…:.：\d%]|$)/.test(
      t,
    ),
  );
  const progressing =
    busyText || progress.some((p) => p.value === null || p.value < p.max);
  const ready = !!editor && !progressing && (uploadComplete || previewReady);
  const publishReady = ready && submitReady;
  const topicPopupOpen = [
    ...document.querySelectorAll(
      '[role="listbox"], [class*="suggest" i], [class*="mention" i], [class*="popover" i]',
    ),
  ].some(
    (e) =>
      visible(e) &&
      !e.closest('[contenteditable="true"]') &&
      !e.contains(editor) &&
      /#|话题/.test(e.innerText),
  );
  return {
    challenge,
    login,
    hasUpload: !!upload,
    uploadCount: uploads.length,
    uploadSelector: upload ? '[data-qiye-upload="video"]' : null,
    accept: upload?.accept || '',
    editorSelector: editor ? '[data-qiye-editor="caption"]' : null,
    titleSelector: title ? '[data-qiye-editor="title"]' : null,
    editorText: read(editor),
    titleText: read(title),
    editorKind: editor?.isContentEditable ? 'rich' : 'plain',
    maxLength: editor?.maxLength > 0 ? editor.maxLength : 1000,
    titleMaxLength: title?.maxLength > 0 ? title.maxLength : 1000,
    error,
    ready,
    progressing,
    previewReady,
    uploadComplete,
    submitReady,
    publishReady,
    progress,
    topicPopupOpen,
    submitted: /发布成功|发布完成|作品已提交|提交成功/.test(
      [
        ...document.querySelectorAll(
          '[role="alert"], [role="status"], [class*="toast"], [class*="Toast"], [class*="success"]',
        ),
      ]
        .filter(visible)
        .map((e) => e.innerText)
        .join(' '),
    ),
    reviewing: /审核中|审核通过/.test(text),
    url: location.href,
  };
}
function findEntry({ excluded = [] } = {}) {
  const normalize = (text) =>
    (text || '').replace(/[\u200B-\u200D\uFEFF\s]/g, '').replace(/^[+＋]/, '');
  const visible = (e) => {
    const r = e.getBoundingClientRect();
    if (
      !r.width ||
      !r.height ||
      e.closest(
        '[hidden],[inert],[aria-hidden="true"],[aria-disabled="true"]',
      ) ||
      e.matches(':disabled')
    )
      return false;
    for (let p = e; p; p = p.parentElement) {
      const style = getComputedStyle(p);
      if (
        style.visibility === 'hidden' ||
        style.display === 'none' ||
        Number(style.opacity) === 0
      )
        return false;
    }
    return getComputedStyle(e).pointerEvents !== 'none';
  };
  const explicit = ['发布视频', '上传视频', '发布视频作品'];
  const generic = ['作品发布', '发布作品', '去发布'];
  const all = [
    ...document.querySelectorAll(
      'a,button,[role="button"],[role="menuitem"],div,span',
    ),
  ];
  const labels = new Map();
  for (const e of all) {
    if (!visible(e)) continue;
    const names = [
      e.innerText,
      e.getAttribute('aria-label'),
      e.getAttribute('title'),
    ].map(normalize);
    const name = names.find(
      (name) => explicit.includes(name) || generic.includes(name),
    );
    if (name) labels.set(e, name);
  }
  // Keep the actual clickable owner, not a duplicate child label. Delegated SPA
  // spans remain supported when the page supplies no semantic control wrapper.
  const candidates = new Map();
  for (const [e, name] of labels) {
    if (
      [...labels.keys()].some(
        (other) =>
          other !== e && e.contains(other) && labels.get(other) === name,
      )
    )
      continue;
    const control =
      e.closest('a,button,[role="button"],[role="menuitem"]') || e;
    if (!visible(control)) continue;
    const anchor = control.closest('a[href]');
    let href = null;
    if (anchor) {
      try {
        const u = new URL(anchor.getAttribute('href'), location.href);
        if (u.origin !== location.origin) continue;
        href = u.href;
      } catch {
        continue;
      }
    }
    control.dataset.qiyeEntryKey ||= crypto.randomUUID();
    candidates.set(control, {
      e: control,
      name,
      href,
      key: control.dataset.qiyeEntryKey,
    });
  }
  // Actual links supplied by the platform are usable even when their visual
  // label is an icon. Never invent a route or follow an external origin.
  for (const e of document.querySelectorAll('a[href]')) {
    if (!visible(e) || candidates.has(e)) continue;
    try {
      const u = new URL(e.getAttribute('href'), location.href);
      if (
        u.origin !== location.origin ||
        !/\/creator-micro\/content\/upload(?:\/|$)/.test(u.pathname)
      )
        continue;
      const type = u.searchParams.get('type');
      if (type && type !== 'video') continue;
      e.dataset.qiyeEntryKey ||= crypto.randomUUID();
      candidates.set(e, {
        e,
        name: '视频上传链接',
        href: u.href,
        key: e.dataset.qiyeEntryKey,
      });
    } catch {}
  }
  const available = [...candidates.values()].filter(
    (c) => !excluded.includes(c.key),
  );
  let matches = available.filter(
    (c) => explicit.includes(c.name) || c.name === '视频上传链接',
  );
  if (!matches.length)
    matches = available.filter((c) => generic.includes(c.name));
  let target = matches.length === 1 ? matches[0] : null;
  let reason = !matches.length
    ? '没有可操作的视频入口或发布菜单'
    : '多个入口指向不明确';
  if (!target && matches.length > 1) {
    if (
      matches.every(
        (c) =>
          c.href &&
          /\/content\/upload(?:\/|$)/.test(new URL(c.href).pathname) &&
          c.href === matches[0].href,
      )
    ) {
      target = matches[0];
      reason = '重复入口指向同一平台网址';
    } else {
      const menu = matches.filter((c) =>
        c.e.closest('[role="menu"],[role="menuitem"]'),
      );
      const nav = matches.filter((c) =>
        c.e.closest('nav,aside,header,[role="navigation"]'),
      );
      if (menu.length === 1) {
        target = menu[0];
        reason = '菜单内明确的视频入口';
      } else if (nav.length === 1 && explicit.includes(nav[0].name)) {
        target = nav[0];
        reason = '导航内明确的视频入口';
      }
    }
  }
  document
    .querySelectorAll('[data-qiye-entry]')
    .forEach((e) => e.removeAttribute('data-qiye-entry'));
  if (target) target.e.setAttribute('data-qiye-entry', 'video');
  return {
    target: target
      ? {
          selector: '[data-qiye-entry="video"]',
          key: target.key,
          name: target.name,
        }
      : null,
    reason: target ? (matches.length === 1 ? '唯一明确入口' : reason) : reason,
    candidates: available.slice(0, 12).map((c) => ({
      name: c.name,
      path: c.href ? new URL(c.href).pathname : null,
    })),
    count: available.length,
  };
}
async function openPublishingPage(page, context, state) {
  const excluded = [];
  const probe = new Function(
    'input',
    `const state=(${observe.toString()})();const entry=(${findEntry.toString()})(input);return {state,entry};`,
  );
  for (
    let attempt = 0;
    attempt < 3 && !state.hasUpload && !state.editorSelector;
    attempt++
  ) {
    let found;
    try {
      found = await page.wait(probe, { excluded }, attempt ? 60000 : 15000, {
        accept: (p) =>
          p.state.login ||
          p.state.challenge ||
          p.state.hasUpload ||
          !!p.state.editorSelector ||
          !!p.entry.target,
      });
    } catch (error) {
      if (context.signal.aborted) throw error;
      found = await page.evaluate(probe, { excluded });
    }
    state = found.state;
    if (
      state.login ||
      state.challenge ||
      state.hasUpload ||
      state.editorSelector
    )
      return state;
    const info = found.entry;
    context.log(
      `发布入口检查：页面 ${new URL(state.url).pathname}，视频上传控件 ${state.uploadCount} 个，候选 ${info.count} 个；${info.reason}；${info.candidates.map((c) => c.name + (c.path ? ' → ' + c.path : '')).join('、') || '无匹配入口'}`,
    );
    if (!info.target) return state;
    excluded.push(info.target.key);
    await page.click(info.target);
    context.log(
      `已点击平台页面中的「${info.target.name}」，等待视频入口或上传表单`,
    );
    state = await page.evaluate(observe);
  }
  // The last click may be an asynchronous SPA transition.
  if (
    !state.hasUpload &&
    !state.editorSelector &&
    !state.login &&
    !state.challenge
  ) {
    const latest = await page
      .wait(
        stateWhen(
          's.login||s.challenge||s.hasUpload||s.editorSelector?s:false',
        ),
        null,
        60000,
      )
      .catch((error) => {
        if (context.signal.aborted) throw error;
        return null;
      });
    if (latest) state = latest;
  }
  return state;
}
const normalizedCaption = (text) =>
  text
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    // Platform hashtag entities can be adjacent inline nodes with CSS spacing
    // instead of literal spaces. Compare whole hashtag names, not that spacing.
    .replace(/\s*#/g, ' #')
    .replace(/\s+/g, ' ')
    .trim();
async function waitUploadState(page, context, phase) {
  let last = '',
    loggedAt = 0;
  return page.wait(observe, null, 20 * 60000, {
    accept: (s) =>
      s.challenge ||
      s.login ||
      s.error ||
      (phase === 'form' ? s.ready : s.publishReady),
    onPoll: (s) => {
      const progress =
        s.progress
          .map((p) => (p.value === null ? '进行中' : `${p.value}/${p.max}`))
          .join('、') || '无活动指标';
      const summary = `上传状态检查（${phase === 'form' ? '填写前' : '提交前'}）：完成提示${s.uploadComplete ? '有' : '无'}，视频预览${s.previewReady ? '可播放' : '未就绪'}，简介${s.editorSelector ? '可编辑' : '未识别'}，上传/处理${s.progressing ? '进行中' : '未检测到进行中'}，相关进度 ${progress}，发布按钮${s.submitReady ? '可用' : '不可用'}`;
      const now = Date.now();
      if (
        !loggedAt ||
        (summary !== last && now - loggedAt >= 5000) ||
        now - loggedAt >= 30000
      ) {
        context.log(summary);
        last = summary;
        loggedAt = now;
      }
    },
  });
}
async function execute(task, context, { getView, validate, accountStatus }) {
  await validate(task.video);
  context.log('视频路径、可读性和内容摘要检查通过');
  const wc = await getView(task.accountId),
    page = new Page(wc, context.signal, context.log, context.trace);
  const manual = (reason) => ({ status: 'manual', reason });
  try {
    await page.connect();
    let url = new URL(wc.getURL());
    if (
      url.protocol !== 'https:' ||
      url.hostname !== 'creator.douyin.com' ||
      !url.pathname.includes('/creator-micro/')
    ) {
      await page.navigate(MANAGEMENT_URL);
      context.log('打开用户指定的抖音作品管理入口');
    }
    let state = await page
      .wait(() => document.readyState === 'complete', null, 60000)
      .then(() => page.evaluate(observe));
    if (state.challenge || state.login) {
      accountStatus(task.accountId, 'manual');
      return manual(
        state.challenge
          ? '平台要求安全验证，请人工接管'
          : '账号登录失效，请在原环境登录后继续',
      );
    }
    if (!state.hasUpload && !state.editorSelector) {
      state = await openPublishingPage(page, context, state);
      if (
        !state.login &&
        !state.challenge &&
        !state.hasUpload &&
        !state.editorSelector
      )
        return manual(
          '未识别到可操作的视频发布入口；日志已记录页面路径和候选，请人工打开发布页后继续',
        );
    }
    if (state.login || state.challenge)
      return manual('发布页要求登录或验证，请人工处理');
    accountStatus(task.accountId, 'ready');
    if (state.error) return manual(state.error);
    const owned = await page.evaluate(
      (id) => document.documentElement.dataset.qiyePublishTask === id,
      task.id,
    );
    if (!state.ready) {
      if ((task.checkpoint.uploaded || task.checkpoint.uploadStarted) && !owned)
        return manual(
          '先前上传页面已变化，无法核实当前素材，请人工检查，未重新上传',
        );
      if (!task.checkpoint.uploaded && !task.checkpoint.uploadStarted) {
        if (!state.hasUpload)
          return manual('当前发布页上传控件变化或存在多个候选，请人工检查');
        const extension = task.video.format;
        if (
          state.accept &&
          state.accept.includes('.') &&
          !state.accept.includes('video') &&
          !state.accept.toLowerCase().includes(`.${extension}`)
        )
          throw new Error(`平台上传控件不接受 ${extension}，请转换后重新导入`);
        await page.upload(state.uploadSelector, task.video.path);
        await page.evaluate((id) => {
          document.documentElement.dataset.qiyePublishTask = id;
        }, task.id);
        context.checkpoint({ uploadStarted: true });
        context.log('视频已交给当前环境上传，等待视频预览和作品表单就绪');
      } else context.log('继续等待本任务已启动的上传，未重复上传文件');
      state = await waitUploadState(page, context, 'form');
      if (state.challenge || state.login || state.error)
        return manual(state.error || '上传过程中需要登录 / 验证');
    } else if (
      !(task.checkpoint.uploaded || task.checkpoint.uploadStarted) ||
      !owned
    ) {
      return manual(
        '发布页已有视频，无法证明是当前任务素材；请人工核实，避免覆盖',
      );
    }
    context.checkpoint({
      formReady: true,
      ...(state.uploadComplete ? { uploaded: true } : {}),
    });
    context.log(
      state.uploadComplete
        ? '平台视频上传完成提示已确认，进入文案填写'
        : '视频预览与作品表单已就绪，进入文案填写；提交前仍会检查上传状态',
    );
    const split = !!state.titleSelector;
    const caption = split
      ? task.topics || ''
      : [task.title, task.topics].filter(Boolean).join(' ');
    if (
      caption.length > state.maxLength ||
      (split && task.title.length > state.titleMaxLength)
    )
      throw new Error(
        `标题 / 简介超过当前页面上限：标题 ${split ? state.titleMaxLength : state.maxLength} 字，简介 ${state.maxLength} 字`,
      );
    if (!state.editorSelector)
      return manual('作品描述输入区未识别或存在多个候选');
    context.log(
      `识别到${split ? '独立标题与简介' : '作品简介'}输入区（${state.editorKind === 'rich' ? '富文本' : '普通文本'}），开始填写`,
    );
    if (
      task.checkpoint.filled &&
      normalizedCaption(state.editorText) === normalizedCaption(caption) &&
      (!split ||
        normalizedCaption(state.titleText) === normalizedCaption(task.title))
    ) {
      context.log('已确认当前标题和话题与任务一致，保留原页面内容，未重复填写');
    } else {
      if (split) await page.fill(state.titleSelector, task.title);
      const topics = (task.topics || '').match(/#[^\s#]+/g) || [];
      const structuredTopics =
        topics.length &&
        normalizedCaption(topics.join(' ')) === normalizedCaption(task.topics);
      if (structuredTopics) {
        await page.fill(state.editorSelector, split ? '' : task.title);
        for (const topic of topics) {
          if (!split && topic === topics[0])
            await page.append(state.editorSelector, ' ');
          await page.append(state.editorSelector, topic);
          await page.space(state.editorSelector);
          context.log(
            '已发送话题结束空格按键，由平台编辑器转换话题；未选择候选项',
          );
        }
      } else await page.fill(state.editorSelector, caption);
    }
    let filled;
    try {
      filled = await page.wait(
        new Function(
          'expected',
          `const s=(${observe.toString()})();const norm=${normalizedCaption.toString()};return !s.topicPopupOpen&&norm(s.editorText)===norm(expected.caption)&&(!expected.split||norm(s.titleText)===norm(expected.title))?s:false;`,
        ),
        { caption, title: task.title, split },
        5000,
      );
    } catch (error) {
      if (context.signal.aborted) throw error;
      const actual = await page.evaluate(observe);
      if (actual.topicPopupOpen)
        return manual(
          '话题结束空格已发送，但平台候选框尚未收起，请检查话题转换状态；未选择候选项或提交',
        );
      context.log(
        `填写校验未通过：简介预期 ${normalizedCaption(caption).length} 字 / 实际 ${normalizedCaption(actual.editorText).length} 字；标题独立输入框 ${split ? '有' : '无'}。已忽略占位文字和不可见字符`,
        'warning',
      );
      return manual('页面未保留完整标题和话题，请核对任务与作品简介；未提交');
    }
    context.checkpoint({ filled: true });
    context.log('已填写并核对最终标题与整组话题');
    const special =
      task.cover.mode !== 'first' ||
      task.location.mode !== 'none' ||
      task.nativeSchedule;
    if (special && !task.checkpoint.manualOptionsConfirmed)
      return manual(
        '任务包含自定义封面 / 定位 / 平台定时，请在原页面设置，核实后点击「已完成平台设置，继续」',
      );
    if (!task.autoSubmit && !task.checkpoint.submissionAuthorized)
      return manual(
        '已完成上传及填写，当前为人工确认模式，请在原页面审阅后提交或授权此任务自动提交',
      );
    if (filled.error || filled.challenge || filled.login)
      return manual(filled.error || '提交前需要人工检查');
    const preSubmit = await waitUploadState(page, context, 'submit');
    if (preSubmit.error || preSubmit.challenge || preSubmit.login)
      return manual(preSubmit.error || '提交前需要登录 / 验证，请人工处理');
    if (
      normalizedCaption(preSubmit.editorText) !== normalizedCaption(caption) ||
      (split &&
        normalizedCaption(preSubmit.titleText) !==
          normalizedCaption(task.title)) ||
      preSubmit.topicPopupOpen
    )
      return manual('提交前标题 / 话题状态发生变化，请人工核对；未提交');
    if (
      !(await page.evaluate(
        (id) => document.documentElement.dataset.qiyePublishTask === id,
        task.id,
      ))
    )
      return manual('提交前页面素材归属发生变化，请人工核对；未提交');
    context.checkpoint({
      uploaded: true,
      uploadCompletionEvidence: preSubmit.uploadComplete
        ? 'platform-message'
        : 'platform-publish-enabled',
    });
    const submit = await page.evaluate(() => {
      const nodes = [
        ...document.querySelectorAll('button,[role="button"]'),
      ].filter(
        (e) =>
          e.getBoundingClientRect().width > 0 &&
          e.textContent.trim() === '发布' &&
          !e.disabled &&
          e.getAttribute('aria-disabled') !== 'true',
      );
      return nodes.length === 1
        ? { selector: 'button,[role="button"]', text: '发布' }
        : null;
    });
    if (!submit)
      return manual('未识别到唯一可操作的发布按钮，可能有必填项或权限限制');
    context.checkpoint({ submitIntent: true, submitTime: Date.now() });
    context.log('已同步保存提交边界，后续不允许自动重试');
    await page.click(submit);
    const result = await page
      .wait(
        stateWhen(
          "s.error||s.challenge||s.submitted||s.url.includes('/content/manage')?s:false",
        ),
        null,
        60000,
      )
      .catch(() => null);
    if (!result || result.error || result.challenge)
      return {
        status: 'unverified',
        reason:
          result?.error || '提交后的平台结果不明确，需要人工核实，未重复提交',
      };
    if (result.submitted)
      return {
        status: 'submitted',
        reason: '页面反馈提交成功；作品审核与上线状态仍需核实',
        submittedAt: Date.now(),
      };
    return {
      status: 'unverified',
      reason: '返回作品管理页，但尚无当前作品的明确提交证据，请人工核实',
    };
  } finally {
    page.detach();
  }
}
module.exports = { descriptor, execute, observe, findEntry };
