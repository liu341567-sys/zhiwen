'use strict';
// Read-only structural sampling. No cookies, values, page HTML, URLs with query
// strings, media URLs, account labels or screenshots enter the report.
function samplePage(options) {
  const words = (value) => [
    ...new Set(
      String(value || '').match(
        /作品发布|发布视频|发布图文|发布作品|上传视频|作品标题|作品简介|作品描述|标题|简介|描述|话题|封面|定位|位置|定时|发布|上传|验证码|登录|安全验证|重新上传|处理中|转码中|上传成功|上传完成/g,
      ) || [],
    ),
  ];
  const visible = (e) => {
    const r = e.getBoundingClientRect();
    for (let p = e; p; p = p.parentElement) {
      const c = getComputedStyle(p);
      if (
        p.hidden ||
        c.display === 'none' ||
        c.visibility === 'hidden' ||
        Number(c.opacity) === 0
      )
        return false;
    }
    return r.width > 0 && r.height > 0;
  };
  const selector = (e) => {
    const parts = [];
    for (
      let p = e;
      p && p !== document.documentElement && parts.length < 10;
      p = p.parentElement
    ) {
      const siblings = p.parentElement
        ? [...p.parentElement.children].filter((n) => n.tagName === p.tagName)
        : [p];
      parts.unshift(
        p.tagName.toLowerCase() +
          ':nth-of-type(' +
          (siblings.indexOf(p) + 1) +
          ')',
      );
    }
    return parts.join(' > ');
  };
  const key = '__qiyePublishingDiagnosticEvents';
  if (options?.record && !globalThis[key]) {
    const state = { events: [], handler: null };
    state.handler = (event) => {
      const e = event.target;
      if (
        !(e instanceof Element) ||
        e.matches(
          'input[type="password"],input[type="tel"],input[type="email"]',
        )
      )
        return;
      if (
        event.type === 'keydown' &&
        (event.key !== ' ' || !e.matches('textarea,[contenteditable="true"]'))
      )
        return;
      state.events.push({
        time: Date.now(),
        type: event.type === 'keydown' ? 'topic-space' : event.type,
        selector: selector(e),
        tag: e.tagName.toLowerCase(),
        labels: words(
          e.matches('input,textarea,[contenteditable="true"]')
            ? e.getAttribute('aria-label') || e.getAttribute('placeholder')
            : e.textContent?.slice(0, 120),
        ),
        trusted: event.isTrusted,
      });
      state.events = state.events.slice(-50);
    };
    for (const type of ['click', 'input', 'change', 'keydown'])
      document.addEventListener(type, state.handler, {
        capture: true,
        passive: true,
      });
    globalThis[key] = state;
  }
  if (!options?.record && globalThis[key]) {
    for (const type of ['click', 'input', 'change', 'keydown'])
      document.removeEventListener(type, globalThis[key].handler, true);
    delete globalThis[key];
  }
  const nodes = [
    ...document.querySelectorAll(
      'a,button,input:not([type]),input[type="text"],input[type="file"],textarea,[contenteditable="true"],video,progress,[role="button"],[role="menuitem"],[role="textbox"],[role="dialog"],[role="listbox"],[role="progressbar"]',
    ),
  ];
  const controls = nodes.slice(0, 250).map((e) => {
    const r = e.getBoundingClientRect();
    const editable = e.matches('input,textarea,[contenteditable="true"]');
    const labels = words(
      [
        e.getAttribute('aria-label'),
        e.getAttribute('placeholder'),
        editable ? '' : e.textContent?.slice(0, 120),
      ].join(' '),
    );
    return {
      selector: selector(e),
      tag: e.tagName.toLowerCase(),
      visible: visible(e),
      enabled: !e.disabled && e.getAttribute('aria-disabled') !== 'true',
      editable,
      rich: e.isContentEditable,
      labels,
      accept:
        e.type === 'file'
          ? e.accept.match(
              /video\/\*|image\/\*|video\/mp4|video\/quicktime|video\/webm|image\/png|image\/jpeg|\.(?:mp4|mov|mkv|webm|avi|m4v|png|jpg|jpeg|webp)\b/gi,
            ) || []
          : [],
      selectedFileCount: e.type === 'file' ? e.files.length : undefined,
      rect: {
        x: Math.round(r.x),
        y: Math.round(r.y),
        width: Math.round(r.width),
        height: Math.round(r.height),
      },
      previewReady:
        e.tagName === 'VIDEO'
          ? e.readyState >= 2 && e.videoWidth > 0
          : undefined,
    };
  });
  const known =
    /^\/creator-micro\/(home|content\/(manage|upload|publish))\/?$/.test(
      location.pathname,
    );
  return {
    page:
      location.origin === 'https://creator.douyin.com' && known
        ? location.pathname
        : 'other-route',
    readyState: document.readyState,
    viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
    actions: globalThis[key]?.events.splice(0) || [],
    controlCount: nodes.length,
    truncated: nodes.length > 250,
    controls,
    focused: document.activeElement ? selector(document.activeElement) : null,
    loginPrompt: /扫码登录|登录过期|登录已失效/.test(document.body.innerText),
    challenge: /安全验证|滑块验证|二次验证/.test(document.body.innerText),
  };
}
class Diagnostics {
  constructor({
    store,
    scheduler,
    inspectView = () => null,
    changed = () => {},
  }) {
    this.store = store;
    this.scheduler = scheduler;
    this.inspectView = inspectView;
    this.changed = changed;
    this.active = new Map();
    this.closed = false;
  }
  report(id) {
    this.store.task(id);
    return this.store.setting(`diagnostic:${id}`);
  }
  state(id) {
    return { active: this.active.has(id), report: this.report(id) };
  }
  save(id, report) {
    // Bound disk use, even when the platform presents hundreds of controls.
    while (
      Buffer.byteLength(JSON.stringify(report), 'utf8') > 2 * 1024 * 1024 &&
      report.frames.length > 1
    ) {
      report.frames.shift();
      report.truncated = true;
    }
    this.store.setSetting(`diagnostic:${id}`, report);
  }
  async capture(id) {
    const task = this.store.task(id),
      old = this.report(id);
    if (!old) return;
    let page = { available: false };
    const wc = this.inspectView(task.accountId);
    if (wc && !wc.isDestroyed()) {
      let timer;
      try {
        page = await Promise.race([
          wc.executeJavaScriptInIsolatedWorld(2004, [
            { code: `(${samplePage.toString()})({record:true})` },
          ]),
          new Promise((_r, reject) => {
            timer = setTimeout(() => reject(new Error('timeout')), 5000);
          }),
        ]);
      } catch {
        page = {
          available: false,
          reason: '页面采样不可用或超时，未导航或重启环境',
        };
      } finally {
        clearTimeout(timer);
      }
      if (!wc.isDestroyed()) {
        const view = wc
          .getOwnerBrowserWindow?.()
          ?.contentView.children.find((v) => v.webContents === wc);
        page.nativeBounds = view?.getBounds();
      }
    }
    // A stop/delete while waiting for the renderer must not resurrect recording.
    if (this.closed || !this.active.has(id)) return;
    const report = this.report(id);
    if (!report || report.endedAt || report.sessionId !== old.sessionId) return;
    const frame = {
      time: Date.now(),
      status: task.status,
      queue: task.status === 'pending' ? this.scheduler.waitInfo(task) : null,
      runtime: {
        ...this.scheduler.runtime(),
        lastError: Boolean(this.scheduler.lastError),
      },
      checkpoint: Object.fromEntries(
        [
          'uploadStarted',
          'uploaded',
          'filled',
          'submitIntent',
          'manualOptionsConfirmed',
        ].map((k) => [k, task.checkpoint[k] === true]),
      ),
      page,
    };
    const previous = report.frames.at(-1);
    if (
      !previous ||
      JSON.stringify({
        ...previous,
        time: 0,
        runtime: { ...previous.runtime, lastTickAt: 0 },
      }) !==
        JSON.stringify({
          ...frame,
          time: 0,
          runtime: { ...frame.runtime, lastTickAt: 0 },
        }) ||
      frame.time - previous.time >= 30000
    ) {
      report.frames.push(frame);
      report.frames = report.frames.slice(-300);
    }
    report.lastSampleAt = frame.time;
    this.save(id, report);
  }
  async start(id) {
    const task = this.store.task(id);
    if (this.active.has(id)) return this.state(id);
    if (this.closed) throw new Error('诊断器已经退出');
    if (this.active.size >= 3)
      throw new Error('最多同时记录三个任务，请先停止其他诊断');
    if (
      [...this.active.values()].some(
        (slot) => slot.accountId === task.accountId,
      )
    )
      throw new Error('该账号已有诊断记录正在运行，请先停止');
    const { randomUUID } = require('node:crypto');
    const report = {
      schemaVersion: 1,
      sessionId: randomUUID(),
      startedAt: Date.now(),
      endedAt: null,
      frames: [],
      notes: [],
      events: [],
      privacy:
        '结构、状态和时间；不含账号名称、Cookie、输入值、完整网址、HTML或截图',
    };
    this.store.setSetting(`diagnostic:${id}`, report);
    const slot = { timer: null, busy: false, accountId: task.accountId };
    this.active.set(id, slot);
    const capture = async () => {
      if (slot.busy || this.closed || !this.active.has(id)) return;
      slot.busy = true;
      try {
        await this.capture(id);
      } catch {
        if (!this.closed && this.active.has(id)) this.stop(id);
      } finally {
        slot.busy = false;
      }
      if (
        !this.closed &&
        this.active.has(id) &&
        Date.now() - report.startedAt >= 600000
      )
        this.stop(id);
    };
    slot.timer = setInterval(capture, 2000);
    slot.timer.unref?.();
    await capture();
    this.changed();
    return this.state(id);
  }
  event(id, message, level = 'info') {
    if (!this.active.has(id)) return;
    const report = this.report(id);
    if (!report) return;
    const phase = /视口/.test(message)
      ? 'viewport'
      : /登录失效|重新登录/.test(message)
        ? 'login-check'
        : /安全验证|验证码/.test(message)
          ? 'challenge'
          : /^视频路径/.test(message)
            ? 'file-check'
            : /^控件点击：|^后台画面准备/.test(message)
              ? 'control-click'
              : /发布入口/.test(message)
                ? 'entry-check'
                : /^已点击平台/.test(message)
                  ? 'entry-click'
                  : /上传状态|等待.*上传/.test(message)
                    ? 'upload-wait'
                    : /视频已交给/.test(message)
                      ? 'upload-start'
                      : /上传完成/.test(message)
                        ? 'upload-ready'
                        : /标题|话题|填写/.test(message)
                          ? 'caption'
                          : /提交|发布结果/.test(message)
                            ? 'submission'
                            : 'other';
    const stage = new Map([
      ['控件点击：检查唯一目标与实时遮挡', 'target-check'],
      ['控件点击：短时准备后台画面', 'surface-hint'],
      ['后台画面准备未完成，继续依据实时控件状态操作', 'surface-unavailable'],
      ['控件点击：发送真实悬停并重新检查目标', 'hover-check'],
      ['控件点击：发送真实鼠标按下', 'mouse-press'],
      ['控件点击：发送真实鼠标松开', 'mouse-release'],
      ['控件点击：鼠标事件已发送，后续核验页面变化', 'input-sent'],
      ['网页操作超时，请人工检查', 'operation-timeout'],
    ]).get(message);
    report.events.push({
      time: Date.now(),
      phase,
      level: ['error', 'warning'].includes(level) ? level : 'info',
      ...(stage ? { stage } : {}),
    });
    report.events = report.events.slice(-300);
    this.save(id, report);
  }
  mark(id, note) {
    const report = this.report(id);
    if (!report) throw new Error('请先开始本地诊断');
    if (
      ![
        'entered-page',
        'uploaded-video',
        'edited-caption',
        'committed-topics',
        'ready-to-submit',
        'unexpected-state',
      ].includes(note)
    )
      throw new Error('无效的诊断标记');
    report.notes.push({ time: Date.now(), step: note });
    report.notes = report.notes.slice(-100);
    this.save(id, report);
  }
  stop(id) {
    const slot = this.active.get(id);
    if (slot) {
      clearInterval(slot.timer);
      this.active.delete(id);
    }
    let report = null;
    try {
      report = this.report(id);
    } catch {}
    if (report && !report.endedAt) {
      report.endedAt = Date.now();
      this.store.setSetting(`diagnostic:${id}`, report);
    }
    if (slot) {
      const wc = this.inspectView(slot.accountId);
      if (wc && !wc.isDestroyed())
        wc.executeJavaScriptInIsolatedWorld(2004, [
          { code: `(${samplePage.toString()})({record:false})` },
        ]).catch(() => {});
    }
    this.changed();
    return { active: false, report };
  }
  close() {
    this.closed = true;
    for (const id of this.active.keys()) this.stop(id);
  }
  clear(id) {
    this.store.task(id);
    this.stop(id);
    this.store.db
      .prepare('DELETE FROM settings WHERE key=?')
      .run(`diagnostic:${id}`);
  }
}
module.exports = { Diagnostics, samplePage };
