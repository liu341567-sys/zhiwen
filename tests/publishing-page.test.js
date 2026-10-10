'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Page } = require('../src/publishing/adapters/page');
function fixture(capture) {
  const events = [],
    logs = [],
    controller = new AbortController();
  let points = [
    { x: 100, y: 84 },
    { x: 120, y: 90 },
  ];
  const wc = {
    isDestroyed: () => false,
    capturePage: capture,
    executeJavaScriptInIsolatedWorld: async () => points.shift() || null,
    debugger: {
      sendCommand: async (method, args) => {
        events.push({ method, ...args });
        return {};
      },
    },
  };
  return {
    page: new Page(wc, controller.signal, (m) => logs.push(m)),
    events,
    logs,
    controller,
    setPoints: (p) => {
      points = p;
    },
  };
}
test('an unresolved hidden frame is optional: click uses a fresh hit test and trusted native input', async () => {
  const f = fixture(() => new Promise(() => {}));
  const start = Date.now();
  await f.page.click({ selector: 'button' });
  assert.ok(Date.now() - start < 2000);
  assert.deepEqual(
    f.events.map((e) => e.type),
    ['mouseMoved', 'mousePressed', 'mouseReleased'],
  );
  assert.equal(f.events[0].x, 100);
  assert.equal(f.events[1].x, 120);
  assert.ok(f.logs.includes('后台画面准备未完成，继续依据实时控件状态操作'));
});
test('failed and empty hidden frames do not prevent a uniquely hit-tested click', async () => {
  for (const capture of [
    () => Promise.reject(new Error('surface unavailable')),
    () => Promise.resolve({ isEmpty: () => true }),
  ]) {
    const f = fixture(capture);
    await f.page.click({ selector: 'button' });
    assert.equal(f.events.filter((e) => e.type === 'mousePressed').length, 1);
  }
});
test('a target obscured after hover is never pressed even when capture failed', async () => {
  const f = fixture(() => Promise.reject(new Error('unavailable')));
  f.setPoints([{ x: 100, y: 84 }, null]);
  await assert.rejects(f.page.click({ selector: 'button' }), /无法唯一识别/);
  assert.deepEqual(
    f.events.map((e) => e.type),
    ['mouseMoved'],
  );
});
test('pausing while a hidden frame is pending stops before sending any input', async () => {
  const f = fixture(() => new Promise(() => {}));
  const pending = f.page.click({ selector: 'button' });
  setImmediate(() => f.controller.abort());
  await assert.rejects(pending, /任务已暂停/);
  assert.equal(f.events.length, 0);
});
