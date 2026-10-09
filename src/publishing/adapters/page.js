'use strict';
const { randomUUID } = require('node:crypto');
class Page {
  constructor(wc, signal) {
    this.wc = wc;
    this.signal = signal;
    this.attached = false;
  }
  check() {
    if (this.signal.aborted) throw new Error('任务已暂停');
    if (this.wc.isDestroyed()) throw new Error('环境网页已关闭');
  }
  async awaitOperation(operation, timeout = 5000) {
    this.check();
    let timer, abort;
    try {
      return await Promise.race([
        operation,
        new Promise((_resolve, reject) => {
          abort = () => reject(new Error('任务已暂停'));
          this.signal.addEventListener('abort', abort, { once: true });
          timer = setTimeout(
            () =>
              reject(
                Object.assign(new Error('网页操作超时，请人工检查'), {
                  manual: true,
                }),
              ),
            timeout,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
      this.signal.removeEventListener('abort', abort);
    }
  }
  async navigate(url) {
    return this.awaitOperation(this.wc.loadURL(url), 60000);
  }
  async evaluate(fn, arg) {
    this.check();
    return this.awaitOperation(
      this.wc.executeJavaScriptInIsolatedWorld(2002, [
        { code: `(${fn.toString()})(${JSON.stringify(arg ?? null)})` },
      ]),
      5000,
    );
  }
  async connect() {
    this.check();
    if (this.wc.debugger.isAttached())
      throw Object.assign(
        new Error('当前环境已被其他调试操作使用，请结束后继续'),
        { manual: true },
      );
    this.wc.debugger.attach('1.3');
    this.attached = true;
    // Electron can leave a never-visible / background native view with a zero or stale
    // renderer viewport despite nonzero native bounds. Resize only its visible
    // surface to the existing native size; do not change device or screen data.
    const viewport = await this.evaluate(() => ({
      width: innerWidth,
      height: innerHeight,
    }));
    const owner = this.wc.getOwnerBrowserWindow();
    const bounds = owner?.contentView.children
      .find((view) => view.webContents === this.wc)
      ?.getBounds();
    this.surfaceBounds = bounds;
    if (
      !viewport.width ||
      !viewport.height ||
      (bounds &&
        (viewport.width !== bounds.width || viewport.height !== bounds.height))
    ) {
      if (!bounds?.width || !bounds.height)
        throw Object.assign(
          new Error('环境视口尚未就绪，请人工打开此环境后继续'),
          { manual: true },
        );
      await this.command('Emulation.setVisibleSize', {
        width: bounds.width,
        height: bounds.height,
      });
      await this.wait(
        (expected) =>
          Math.abs(innerWidth - expected.width) <= 1 &&
          Math.abs(innerHeight - expected.height) <= 1,
        bounds,
        5000,
      );
    }
  }
  async command(method, args) {
    this.check();
    return this.awaitOperation(this.wc.debugger.sendCommand(method, args));
  }
  async wait(predicate, arg, timeout = 120000, options = {}) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      this.check();
      const value = await this.evaluate(predicate, arg);
      options.onPoll?.(value);
      if (options.accept ? options.accept(value) : value) return value;
      await new Promise((resolve, reject) => {
        const timer = setTimeout(done, 400);
        const signal = this.signal;
        function done() {
          signal.removeEventListener('abort', abort);
          resolve();
        }
        function abort() {
          clearTimeout(timer);
          signal.removeEventListener('abort', abort);
          reject(new Error('任务已暂停'));
        }
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      });
    }
    throw Object.assign(new Error('页面状态等待超时，需要人工检查'), {
      manual: true,
    });
  }
  async click(target) {
    const point = await this.evaluate(({ selector, text }) => {
      const visible = (e) => {
        const r = e.getBoundingClientRect();
        return (
          r.width > 0 &&
          r.height > 0 &&
          getComputedStyle(e).visibility !== 'hidden'
        );
      };
      const nodes = [...document.querySelectorAll(selector)];
      const matches = nodes.filter(
        (e) => visible(e) && (!text || e.textContent.trim() === text),
      );
      if (matches.length !== 1) return null;
      const e = matches[0];
      if (e.disabled || e.getAttribute('aria-disabled') === 'true') return null;
      e.scrollIntoView({ block: 'center', inline: 'nearest' });
      const r = e.getBoundingClientRect();
      const x = r.x + r.width / 2,
        y = r.y + r.height / 2;
      return e.contains(document.elementFromPoint(x, y)) ? { x, y } : null;
    }, target);
    if (!point)
      throw Object.assign(
        new Error(
          `页面控件无法唯一识别或不可操作：${target.text || target.selector}`,
        ),
        { manual: true },
      );
    await this.command('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      ...point,
      button: 'left',
      clickCount: 1,
    });
    await this.command('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      ...point,
      button: 'left',
      clickCount: 1,
    });
  }
  async focusEditor(selector, replace) {
    const focused = await this.evaluate(
      ({ selector, replace }) => {
        const nodes = [...document.querySelectorAll(selector)].filter((e) => {
          const r = e.getBoundingClientRect();
          return r.width > 0 && r.height > 0 && !e.disabled && !e.readOnly;
        });
        if (nodes.length !== 1) return false;
        const editor = nodes[0];
        editor.focus({ preventScroll: true });
        if (editor.isContentEditable) {
          const range = document.createRange();
          range.selectNodeContents(editor);
          if (!replace) range.collapse(false);
          const selection = getSelection();
          selection.removeAllRanges();
          selection.addRange(range);
        } else if (typeof editor.setSelectionRange === 'function') {
          editor.setSelectionRange(
            replace ? 0 : editor.value.length,
            editor.value.length,
          );
        }
        return (
          nodes[0] === document.activeElement ||
          nodes[0].contains(document.activeElement)
        );
      },
      { selector, replace },
    );
    if (!focused)
      throw Object.assign(new Error('作品描述输入区无法唯一聚焦'), {
        manual: true,
      });
  }
  async fill(selector, text) {
    await this.focusEditor(selector, true);
    // Native insertion keeps the site's normal beforeinput/input handling. A
    // DOM range also works in a background rich editor where Ctrl+A can target
    // a different selection or leave a noneditable placeholder selected.
    if (text) await this.command('Input.insertText', { text });
    else {
      await this.command('Input.dispatchKeyEvent', {
        type: 'keyDown',
        key: 'Backspace',
        code: 'Backspace',
        windowsVirtualKeyCode: 8,
      });
      await this.command('Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: 'Backspace',
        code: 'Backspace',
        windowsVirtualKeyCode: 8,
      });
    }
  }
  async append(selector, text) {
    await this.focusEditor(selector, false);
    await this.command('Input.insertText', { text });
  }
  async space(selector) {
    await this.focusEditor(selector, false);
    // Rich editors commit a hashtag on the normal Space key handler. A single
    // bulk insertText call does not emit keydown/keyup and leaves suggestions
    // pending even if the inserted string contains spaces.
    await this.command('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: ' ',
      code: 'Space',
      windowsVirtualKeyCode: 32,
      text: ' ',
      unmodifiedText: ' ',
    });
    await this.command('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: ' ',
      code: 'Space',
      windowsVirtualKeyCode: 32,
    });
  }
  async upload(selector, file) {
    const marker = `qiye-${randomUUID()}`;
    const tagged = await this.evaluate(
      ({ selector, marker }) => {
        const nodes = [...document.querySelectorAll(selector)].filter(
          (e) => e.tagName === 'INPUT' && e.type === 'file' && !e.disabled,
        );
        if (nodes.length !== 1) return false;
        nodes[0].setAttribute('data-qiye-file', marker);
        return true;
      },
      { selector, marker },
    );
    if (!tagged)
      throw Object.assign(new Error('上传控件不唯一或不可用'), {
        manual: true,
      });
    try {
      const { root } = await this.command('DOM.getDocument', { depth: 0 });
      const { nodeId } = await this.command('DOM.querySelector', {
        nodeId: root.nodeId,
        selector: `[data-qiye-file="${marker}"]`,
      });
      if (!nodeId) throw new Error('上传控件已变化');
      await this.command('DOM.setFileInputFiles', { nodeId, files: [file] });
    } finally {
      await this.evaluate(
        (marker) =>
          document
            .querySelector(`[data-qiye-file="${marker}"]`)
            ?.removeAttribute('data-qiye-file'),
        marker,
      ).catch(() => {});
    }
  }
  detach() {
    if (
      this.attached &&
      !this.wc.isDestroyed() &&
      this.wc.debugger.isAttached()
    )
      this.wc.debugger.detach();
    this.attached = false;
  }
}
module.exports = { Page };
