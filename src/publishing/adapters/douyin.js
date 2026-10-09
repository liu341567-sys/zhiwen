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
  const login =
    /扫码登录|短信登录|手机号登录|登录已失效|登录过期/.test(text) &&
    !document.querySelector('input[type="file"][accept*="video"]');
  const upload = [...document.querySelectorAll('input[type="file"]')].find(
    (e) => !e.disabled && /video|mp4|mov/i.test(e.accept),
  );
  const editor =
    [...document.querySelectorAll('textarea, [contenteditable="true"]')]
      .filter(visible)
      .find((e) =>
        /描述|标题|作品/.test(
          [
            e.placeholder,
            e.dataset.placeholder,
            e.getAttribute('aria-label'),
            e.closest('label')?.innerText,
          ].join(' '),
        ),
      ) ||
    [...document.querySelectorAll('[contenteditable="true"]')].filter(
      visible,
    )[0];
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
  const ready =
    !!editor &&
    /重新上传|更换视频|上传完成|上传成功|设置封面|编辑封面/.test(text) &&
    !/上传中|正在上传|处理中|转码中/.test(text);
  const editorSelector = editor
    ? editor.tagName === 'TEXTAREA'
      ? 'textarea'
      : '[contenteditable="true"]'
    : null;
  return {
    challenge,
    login,
    hasUpload: !!upload,
    accept: upload?.accept || '',
    editorSelector,
    editorText: editor ? (editor.value ?? editor.innerText) : '',
    maxLength: editor?.maxLength > 0 ? editor.maxLength : 1000,
    error,
    ready,
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
async function execute(task, context, { getView, validate, accountStatus }) {
  await validate(task.video);
  context.log('视频路径、可读性和内容摘要检查通过');
  const wc = await getView(task.accountId),
    page = new Page(wc, context.signal);
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
      const target = await page.evaluate(() => {
        const visible = (e) =>
          e.getBoundingClientRect().width > 0 &&
          e.getBoundingClientRect().height > 0;
        const candidates = [
          ...document.querySelectorAll('a,button,[role="button"]'),
        ].filter(
          (e) =>
            visible(e) &&
            ['发布视频', '发布作品', '上传视频'].includes(e.textContent.trim()),
        );
        if (candidates.length === 1)
          return {
            selector: 'a,button,[role="button"]',
            text: candidates[0].textContent.trim(),
          };
        const links = [...document.querySelectorAll('a[href]')].filter(
          (e) =>
            visible(e) &&
            /\/content\/upload(?:\?|$|\/)/.test(e.getAttribute('href')),
        );
        return links.length === 1
          ? {
              selector: `a[href=${JSON.stringify(links[0].getAttribute('href'))}]`,
            }
          : null;
      });
      if (!target)
        return manual(
          '未识别到唯一的视频发布入口，请打开发布页后继续；未尝试盲点',
        );
      await page.click(target);
      state = await page.wait(
        stateWhen('s.login||s.challenge||s.hasUpload?s:false'),
        null,
        60000,
      );
    }
    if (state.login || state.challenge)
      return manual('发布页要求登录或验证，请人工处理');
    accountStatus(task.accountId, 'ready');
    if (state.error) return manual(state.error);
    if (!state.ready) {
      if (task.checkpoint.uploaded)
        return manual('先前上传状态无法核实，请检查原页面，避免重复覆盖');
      if (!state.hasUpload) return manual('当前发布页上传控件变化，请人工检查');
      const extension = task.video.format;
      if (
        state.accept &&
        state.accept.includes('.') &&
        !state.accept.includes('video') &&
        !state.accept.toLowerCase().includes(`.${extension}`)
      )
        throw new Error(`平台上传控件不接受 ${extension}，请转换后重新导入`);
      await page.upload(
        'input[type="file"][accept*="video"],input[type="file"][accept*="mp4"]',
        task.video.path,
      );
      context.log('视频已交给当前环境上传，按页面状态等待完成');
      state = await page.wait(
        stateWhen('s.challenge||s.login||s.error||s.ready?s:false'),
        null,
        20 * 60000,
      );
      if (state.challenge || state.login || state.error)
        return manual(state.error || '上传过程中需要登录 / 验证');
      await page.evaluate((id) => {
        document.documentElement.dataset.qiyePublishTask = id;
      }, task.id);
      context.checkpoint({ uploaded: true });
      context.log('发布表单已显示上传完成状态');
    } else if (
      !task.checkpoint.uploaded ||
      !(await page.evaluate(
        (id) => document.documentElement.dataset.qiyePublishTask === id,
        task.id,
      ))
    ) {
      return manual(
        '发布页已有视频，无法证明是当前任务素材；请人工核实，避免覆盖',
      );
    }
    const caption = [task.title, task.topics].filter(Boolean).join(' ');
    if (caption.length > state.maxLength)
      throw new Error(
        `标题与话题共 ${caption.length} 字，超过页面上限 ${state.maxLength}`,
      );
    if (!state.editorSelector) return manual('作品描述输入区未识别');
    await page.fill(state.editorSelector, caption);
    const filled = await page.evaluate(observe);
    if (
      filled.editorText.replace(/\s+/g, ' ').trim() !==
      caption.replace(/\s+/g, ' ').trim()
    )
      return manual('页面未保留完整标题和话题，请人工检查');
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
module.exports = { descriptor, execute, observe };
