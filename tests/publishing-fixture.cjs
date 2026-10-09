'use strict';
// Test-only access to the real adapter, never included in packaged application.
const { BrowserWindow } = require('electron');
const { execute, observe } = require('../src/publishing/adapters/douyin');
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
  try {
    result = await execute(
      task,
      {
        signal: controller.signal,
        checkpoint: (patch) => {
          task.checkpoint = { ...task.checkpoint, ...patch };
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
  };
};
