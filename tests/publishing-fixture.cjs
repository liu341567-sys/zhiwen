'use strict';
// Test-only access to the real adapter, never included in packaged application.
const { BrowserWindow } = require('electron');
const {
  execute,
  observe,
  findEntry,
} = require('../src/publishing/adapters/douyin');
const { Page } = require('../src/publishing/adapters/page');
const activeMetrics = new Map(),
  originalConnect = Page.prototype.connect;
Page.prototype.connect = async function () {
  await originalConnect.call(this);
  activeMetrics.set(this.wc.id, {
    ...(await this.evaluate(() => ({
      width: innerWidth,
      height: innerHeight,
      dpr: devicePixelRatio,
      screen: [screen.width, screen.height, screen.colorDepth],
    }))),
    bounds: this.surfaceBounds,
  });
};
const { validate } = require('../src/publishing/media');
globalThis.__publishingFixture = async (task, options = {}) => {
  const view = BrowserWindow.getAllWindows()[0].contentView.children.find(
    (v) => v.webContents?.profileId === task.accountId,
  );
  if (!view) throw new Error('Test environment not found');
  const identity = await view.webContents.executeJavaScript(
    '({dpr:devicePixelRatio,screen:[screen.width,screen.height,screen.colorDepth]})',
  );
  const logs = [];
  const seen = await view.webContents.executeJavaScriptInIsolatedWorld(2002, [
    { code: `(${observe.toString()})()` },
  ]);
  const controller = new AbortController();
  const timeout = options.timeoutMs
    ? setTimeout(() => controller.abort(), options.timeoutMs)
    : null;
  let result;
  const originalCapture = view.webContents.capturePage;
  let captureCalls = 0;
  if (options.captureMode)
    view.webContents.capturePage = () => {
      captureCalls++;
      if (options.captureMode === 'pending') return new Promise(() => {});
      if (options.captureMode === 'rejected')
        return Promise.reject(new Error('fixture surface unavailable'));
      return Promise.resolve({ isEmpty: () => true });
    };
  try {
    result = await execute(
      task,
      {
        signal: controller.signal,
        checkpoint: (patch) => {
          task.checkpoint = { ...task.checkpoint, ...patch };
          if (options.pauseOnUpload && patch.uploadStarted) controller.abort();
        },
        log: (message) => logs.push(message),
      },
      {
        getView: async () => view.webContents,
        validate,
        accountStatus: () => {},
      },
    );
  } catch (error) {
    if (!controller.signal.aborted) throw error;
    result = { status: 'paused', reason: error.message };
  } finally {
    clearTimeout(timeout);
    view.webContents.capturePage = originalCapture;
  }
  return {
    result,
    checkpoint: task.checkpoint,
    logs,
    seen,
    geometry: await view.webContents.executeJavaScript(
      '({text:document.body.textContent,html:document.body.innerHTML,width:innerWidth,height:innerHeight,dpr:devicePixelRatio,screen:[screen.width,screen.height,screen.colorDepth]})',
    ),
    bounds: view.getBounds(),
    identity,
    activeMetrics: activeMetrics.get(view.webContents.id),
    captureCalls,
  };
};

globalThis.__publishingEntryProbe = async (accountId) => {
  const view = BrowserWindow.getAllWindows()[0].contentView.children.find(
    (v) => v.webContents?.profileId === accountId,
  );
  const page = new Page(view.webContents, new AbortController().signal);
  try {
    await page.connect();
    return await page.evaluate(findEntry, {});
  } finally {
    page.detach();
  }
};

globalThis.__publishingOptionsFixture = async (accountId, input = {}) => {
  const view = BrowserWindow.getAllWindows()[0].contentView.children.find((v) => v.webContents?.profileId === accountId);
  const options = require('../src/publishing/adapters/douyin-options');
  const controller = new AbortController(), page = new Page(view.webContents, controller.signal);
  const logs = [], checkpoint = {}, context = { log: (m) => logs.push(m), checkpoint: (v) => Object.assign(checkpoint, v) };
  const timer = input.abortAfter ? setTimeout(() => controller.abort(), input.abortAfter) : null;
  try {
    await page.connect();
    const location = input.location ? await options.setLocation(page, input.location, context) : null;
    const native = input.nativeSchedule ? await options.schedule(page, input.nativeSchedule, context) : null;
    if (input.intervene) await view.webContents.executeJavaScript(`document.querySelector('[data-qiye-poi-root]').dispatchEvent(new MouseEvent('click',{bubbles:true}));void 0;`);
    await options.verify(page, native, location);
    return { ok: true, location, native, logs, checkpoint, state: await options.read(page) };
  } catch (error) {
    const layout = await view.webContents.executeJavaScriptInIsolatedWorld(2002, [{ code: `({width:innerWidth,height:innerHeight,targets:[...document.querySelectorAll('[data-qiye-option]')].map(e=>{const r=e.getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return {marker:e.dataset.qiyeOption,rect:{x:r.x,y:r.y,width:r.width,height:r.height},hit:hit?{tag:hit.tagName,id:hit.id,class:hit.className}:null}})})` }]).catch(() => null);
    return { ok: false, reason: error.message, manual: !!error.manual, logs, checkpoint, layout };
  }
  finally { clearTimeout(timer); await options.cleanup(page); page.detach(); }
};
