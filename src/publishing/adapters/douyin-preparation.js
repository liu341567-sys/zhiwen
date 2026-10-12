'use strict';
const { randomUUID } = require('node:crypto');
const fail = (message) => { throw Object.assign(new Error(message), { manual: true }); };
// Evidence remains in the original page's private world, not account storage.
function evidence(input = {}) {
  input ||= {};
  const previous = globalThis.__qiyePreparedMedia;
  const remove = () => {
    if (previous) for (const type of ['input', 'change']) document.removeEventListener(type, previous.listener, true);
    delete globalThis.__qiyePreparedMedia;
  };
  if (input.action === 'clear') { if (!input.token || previous?.token === input.token) remove(); return null; }
  if (input.action === 'start') {
    remove();
    const state = { token: input.token, sha256: input.sha256, videoId: input.videoId, ready: false, dirty: false, draftTouched: false, expected: new Set(['input', 'change']) };
    state.listener = (event) => {
      const e = event.target;
      if (e?.tagName !== 'INPUT' || e.type !== 'file' || !/video|mp4|mov/i.test(e.accept)) {
        if (e?.tagName === 'TEXTAREA' || e?.isContentEditable || /标题|简介|描述|日期和时间/.test(e?.getAttribute?.('placeholder') || e?.getAttribute?.('aria-label') || '') || (e?.type === 'file' && /image/i.test(e.accept))) state.draftTouched = true;
        return;
      }
      const file = e.files?.[0];
      if (state.expected.has(event.type) && file?.name === input.name && file.size === input.bytes && Math.abs(file.lastModified - Math.trunc(input.mtime)) <= 1) state.expected.delete(event.type);
      else state.dirty = true;
    };
    for (const type of ['input', 'change']) document.addEventListener(type, state.listener, true);
    globalThis.__qiyePreparedMedia = state;
  }
  const state = globalThis.__qiyePreparedMedia;
  if (!state || (input.token && state.token !== input.token)) return null;
  if (input.action === 'ready') state.ready = true;
  const result = { token: state.token, sha256: state.sha256, videoId: state.videoId, ready: state.ready, dirty: state.dirty, draftTouched: state.draftTouched };
  if (input.action === 'consume' && state.ready && !state.dirty && !state.draftTouched && state.sha256 === input.sha256) {
    remove(); return { ...result, consumed: true };
  }
  return result;
}
async function prepare(page, video, context) {
  const { observe, openPublishingPage, waitUploadState } = require('./douyin');
  const url = new URL(page.wc.getURL());
  if (url.protocol !== 'https:' || url.hostname !== 'creator.douyin.com' || !url.pathname.startsWith('/creator-micro/'))
    await page.navigate('https://creator.douyin.com/creator-micro/content/manage');
  await page.wait(() => document.readyState === 'complete', null, 60000);
  let state = await page.evaluate(observe);
  const previous = await page.evaluate(evidence);
  if (state.login || state.challenge) fail('账号需要登录或验证，请在原环境处理后重新准备地点查询');
  if (previous?.ready && !previous.dirty && !previous.draftTouched && previous.sha256 === video.sha256 && state.ready) return previous;
  if (state.ready || state.progressing || state.editorSelector || state.previewReady || state.uploadComplete || previous) fail('此账号已在编辑或上传其他素材，未覆盖。请先在原网页打开新的空白发布页');
  if (!state.hasUpload && !state.editorSelector) state = await openPublishingPage(page, context, state);
  if (state.login || state.challenge) fail('发布入口需要登录或验证');
  if (!state.hasUpload || state.ready || state.progressing) fail('未找到唯一的空白视频上传控件，未修改现有作品');
  const token = randomUUID();
  await page.evaluate(evidence, { action: 'start', token, sha256: video.sha256, videoId: video.id, name: video.name, bytes: video.bytes, mtime: video.mtime });
  try {
    await page.upload(state.uploadSelector, video.path);
    state = await waitUploadState(page, context, 'form');
    if (state.login || state.challenge || state.error) fail(state.error || '准备上传需要人工处理');
    const ready = await page.evaluate(evidence, { action: 'ready', token });
    if (!ready || ready.dirty) fail('准备上传期间页面或视频发生变化，无法确认素材归属');
    context.log('已上传所选真实视频用于地点查询；未填写文案或提交作品，对应任务可复用');
    return ready;
  } catch (error) {
    if (!page.wc.isDestroyed()) { let timer; try { await Promise.race([
      page.wc.executeJavaScriptInIsolatedWorld(2002, [{ code: `(${evidence.toString()})(${JSON.stringify({ action: 'clear', token })})` }]).catch(() => {}),
      new Promise((resolve) => { timer = setTimeout(resolve, 1500); })]); } finally { clearTimeout(timer); } }
    throw error;
  }
}
module.exports = { evidence, prepare };
