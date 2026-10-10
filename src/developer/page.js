'use strict';
// Executed in a private isolated world of each existing frame. No IPC bridge,
// storage access, network calls, page scripts, values or inline HTML are exposed.
function pageTool(input) {
  const key = '__qiyeDeveloperTools';
  const clean = (s, max = 240) =>
    String(s || '')
      .slice(0, 4000)
      .replace(
        /(?:bearer\s+|(?:password|passwd|cookie|token|secret|authorization|csrf|密码|令牌)\s*[:=]\s*)[^\s,;<>]+/gi,
        '[已脱敏]',
      )
      .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[邮箱]')
      .replace(/\b(?:\+?86[- ]?)?1[3-9]\d{9}\b/g, '[手机号]')
      .replace(/\b(?:[a-f0-9]{24,}|[A-Za-z0-9_+/=-]{32,})\b/gi, '[不透明标识]')
      .replace(/https?:\/\/[^\s<>"']+/gi, (value) => {
        try {
          const u = new URL(value);
          return (
            u.origin +
            u.pathname.replace(/[a-f0-9]{24,}|[A-Za-z0-9_-]{32,}/gi, '[标识]')
          );
        } catch {
          return '[网址]';
        }
      })
      .slice(0, max);
  const safeURL = (value) => {
    try {
      const u = new URL(value);
      return clean(u.origin + u.pathname, 600);
    } catch {
      return '';
    }
  };
  let state = globalThis[key];
  if (!state) {
    state = {
      ids: new WeakMap(),
      counter: 0,
      events: [],
      observers: new Map(),
      dirty: true,
      record: false,
      inspecting: false,
      selected: null,
      highlight: null,
      handlers: [],
      seen: new WeakSet(),
    };
    globalThis[key] = state;
  }
  state.policy = {
    includeText: input.includeText ?? state.policy?.includeText ?? true,
    exclude: input.exclude ?? state.policy?.exclude ?? [],
  };
  // A navigation creates a new isolated world. Every sample restores only the
  // explicitly requested recording/inspection flags on that new document.
  if (typeof input.record === 'boolean') state.record = input.record;
  if (typeof input.inspect === 'boolean') state.inspecting = input.inspect;
  const closestAcrossRoots = (e, selector) => {
    for (let n = e; n; n = n.getRootNode()?.host) {
      if (n.closest(selector)) return true;
    }
    return false;
  };
  const excluded = (e) => {
    if (closestAcrossRoots(e, '[data-qiye-developer-overlay]')) return true;
    for (const selector of state.policy.exclude || []) {
      try {
        if (closestAcrossRoots(e, selector)) return true;
      } catch {}
    }
    return false;
  };
  const sensitive = (e) =>
    closestAcrossRoots(
      e,
      'input[type=password],input[type=hidden],input[autocomplete="one-time-code"],input[autocomplete="current-password"],input[autocomplete="new-password"],[data-qiye-private]',
    ) || excluded(e);
  const path = (e) => {
    const p = [];
    for (let n = e; n && n.nodeType === 1; n = n.parentElement) {
      const same = n.parentNode?.children
        ? [...n.parentNode.children].filter((v) => v.tagName === n.tagName)
        : [n];
      p.unshift(
        n.tagName.toLowerCase() + ':nth-of-type(' + (same.indexOf(n) + 1) + ')',
      );
    }
    return p.join(' > ');
  };
  const roots = (e) => {
    const chain = [];
    let r = e.getRootNode();
    while (r.host) {
      chain.unshift(path(r.host));
      r = r.host.getRootNode();
    }
    return chain;
  };
  const stable = (value) =>
    !!value &&
    value.length < 160 &&
    !/[a-f0-9]{8,}|\d{4,}|[A-Za-z0-9_-]{24,}|css-[\w-]+|_[A-Za-z0-9]{5,}$/i.test(
      value,
    ) &&
    clean(value, 160) === value;
  const visible = (e) => {
    const r = e.getBoundingClientRect();
    for (let n = e; n; n = n.parentElement || n.getRootNode()?.host) {
      const c = getComputedStyle(n);
      if (
        n.hidden ||
        n.inert ||
        c.display === 'none' ||
        c.visibility === 'hidden' ||
        Number(c.opacity) === 0
      )
        return false;
    }
    return r.width > 0 && r.height > 0;
  };
  const describe = (e) => {
    if (!e || !(e instanceof Element) || excluded(e)) return null;
    if (!state.ids.has(e)) state.ids.set(e, ++state.counter);
    const editable = e.matches('input,textarea') || e.isContentEditable,
      privateNode = sensitive(e);
    const attrs = {};
    for (const name of [
      'id',
      'class',
      'name',
      'type',
      'role',
      'aria-label',
      'aria-labelledby',
      'aria-describedby',
      'aria-expanded',
      'aria-checked',
      'aria-selected',
      'aria-disabled',
      'placeholder',
      'accept',
      'autocomplete',
      'data-testid',
      'data-test',
    ]) {
      if (e.hasAttribute(name)) attrs[name] = clean(e.getAttribute(name));
    }
    // Only locator-relevant attributes; no value, handlers, style, dataset dump,
    // src, hidden fields, authentication attributes or URL query strings.
    if (privateNode) delete attrs.placeholder;
    const root = e.getRootNode(),
      suggestions = [],
      escape = CSS.escape;
    for (const [name, value] of [
      ['id', e.id],
      ['data-testid', e.getAttribute('data-testid')],
      ['name', e.getAttribute('name')],
      ['aria-label', e.getAttribute('aria-label')],
      ['placeholder', e.getAttribute('placeholder')],
    ]) {
      if (privateNode || !stable(value)) continue;
      const selector =
        name === 'id'
          ? '#' + escape(value)
          : e.tagName.toLowerCase() + '[' + name + '="' + escape(value) + '"]';
      try {
        suggestions.push({
          kind: 'css',
          selector,
          count: root.querySelectorAll(selector).length,
          stability: 'attribute',
        });
      } catch {}
    }
    const selector = path(e);
    suggestions.push({
      kind: 'css',
      selector,
      count: 1,
      stability: 'structural',
    });
    const xpath =
      root === document
        ? '/' +
          selector
            .split(' > ')
            .map((p) => p.replace(/:nth-of-type\((\d+)\)/, '[$1]'))
            .join('/')
        : null;
    const r = e.getBoundingClientRect(),
      shown = visible(e),
      x = Math.max(0, Math.min(innerWidth - 1, r.x + r.width / 2)),
      y = Math.max(0, Math.min(innerHeight - 1, r.y + r.height / 2));
    const hit =
      root.elementFromPoint?.(x, y) || document.elementFromPoint(x, y);
    const interactive = e.matches(
      'button,a[href],input,textarea,select,option,[contenteditable=true],[role=button],[role=menuitem],[role=checkbox],[role=combobox],[role=textbox]',
    );
    return {
      id: state.ids.get(e),
      tag: e.tagName.toLowerCase(),
      attributes: attrs,
      text:
        !privateNode && !editable && state.policy.includeText !== false
          ? clean(
              [...e.childNodes]
                .filter((n) => n.nodeType === 3)
                .map((n) => n.textContent)
                .join(' '),
              160,
            )
          : '',
      sensitive: privateNode,
      editable,
      interactive,
      visible: shown,
      enabled:
        !e.matches(':disabled') && e.getAttribute('aria-disabled') !== 'true',
      clickable:
        shown &&
        !e.disabled &&
        getComputedStyle(e).pointerEvents !== 'none' &&
        !!hit &&
        (e === hit || e.contains(hit)),
      selector,
      roots: roots(e),
      xpath,
      locators: suggestions,
      semantic: {
        role: clean(
          e.getAttribute('role') || (e.tagName === 'BUTTON' ? 'button' : ''),
        ),
        label: privateNode
          ? ''
          : clean(
              e.getAttribute('aria-label') ||
                [...(e.labels || [])].map((l) => l.textContent).join(' '),
            ),
        placeholder: privateNode ? '' : clean(e.getAttribute('placeholder')),
      },
      unstableAttributes: ['id', 'class'].filter(
        (name) => e.getAttribute(name) && !stable(e.getAttribute(name)),
      ),
      rect: {
        x: Math.round(r.x),
        y: Math.round(r.y),
        width: Math.round(r.width),
        height: Math.round(r.height),
      },
      shadow: e.shadowRoot
        ? 'open'
        : e.tagName.includes('-')
          ? '未开放或无 Shadow DOM'
          : null,
      iframe: e.tagName === 'IFRAME' ? { url: safeURL(e.src) } : null,
      file: e.matches('input[type=file]')
        ? {
            count: e.files.length,
            types: [...e.files]
              .slice(0, 20)
              .map((f) => clean(f.type || 'unknown', 80)),
            sizes: [...e.files].slice(0, 20).map((f) => f.size),
          }
        : null,
    };
  };
  const removeHighlight = () => {
    state.highlight?.remove();
    state.highlight = null;
  };
  const highlight = (e) => {
    removeHighlight();
    if (!e || !visible(e)) return false;
    const r = e.getBoundingClientRect(),
      box = document.createElement('div');
    box.setAttribute('data-qiye-developer-overlay', 'highlight');
    Object.assign(box.style, {
      position: 'fixed',
      left: r.left + 'px',
      top: r.top + 'px',
      width: r.width + 'px',
      height: r.height + 'px',
      outline: '2px solid #1760d8',
      background: 'rgba(23,96,216,.08)',
      pointerEvents: 'none',
      zIndex: 2147483647,
      boxSizing: 'border-box',
    });
    document.documentElement.append(box);
    state.highlight = box;
    return true;
  };
  const resolve = (locator) => {
    let root = document;
    for (const host of locator.roots || []) {
      const list = root.querySelectorAll(host);
      if (list.length !== 1 || !list[0].shadowRoot)
        throw new Error('Shadow DOM 路径不唯一或未开放');
      root = list[0].shadowRoot;
    }
    if (locator.kind === 'xpath') {
      if (root !== document) throw new Error('XPath 不支持跨 Shadow DOM');
      const result = document.evaluate(
        locator.selector,
        document,
        null,
        XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
        null,
      );
      return Array.from(
        { length: Math.min(result.snapshotLength, 1000) },
        (_, i) => result.snapshotItem(i),
      ).filter((e) => e instanceof Element);
    }
    return [...root.querySelectorAll(locator.selector)].slice(0, 1001);
  };
  const attachRoot = (root) => {
    if ((root.nodeType !== 9 && !root.host) || state.observers.has(root))
      return;
    const observer = new MutationObserver((records) => {
      const overlay = (node) =>
        node instanceof Element &&
        node.hasAttribute('data-qiye-developer-overlay');
      const changed = records.some((r) => {
        if (
          r.target instanceof Element &&
          r.target.closest('[data-qiye-developer-overlay]')
        )
          return false;
        if (
          r.type === 'childList' &&
          [...r.addedNodes, ...r.removedNodes].every(overlay)
        )
          return false;
        return true;
      });
      if (changed) {
        state.dirty = true;
        if (state.maskToken) state.maskChanged = true;
      }
    });
    observer.observe(root, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
      attributeFilter: [
        'id',
        'class',
        'role',
        'disabled',
        'hidden',
        'aria-expanded',
        'aria-disabled',
        'aria-checked',
        'aria-selected',
        'style',
      ],
    });
    state.observers.set(root, observer);
    const handler = (event) => {
      if (event.type === 'scroll' && state.maskToken) state.maskChanged = true;
      const e =
        event.composedPath().find((n) => n instanceof Element) ||
        (event.type === 'scroll' ? document.documentElement : null);
      if (!e || excluded(e) || sensitive(e) || state.seen.has(event)) return;
      state.seen.add(event);
      if (state.inspecting) {
        if (event.type === 'pointermove') {
          highlight(e);
          return;
        }
        if (event.type === 'click') {
          event.preventDefault();
          event.stopImmediatePropagation();
          state.selected = describe(e);
          state.inspecting = false;
          removeHighlight();
          return;
        }
      }
      if (!state.record) return;
      if (event.type === 'pointermove') return;
      if (
        event.type === 'keydown' &&
        (event.key !== ' ' || !(e.matches('textarea') || e.isContentEditable))
      )
        return;
      const type =
        event.type === 'keydown'
          ? 'topic-space'
          : event.type === 'change' && e.matches('input[type=file]')
            ? 'upload'
            : event.type === 'change' &&
                e.matches('select,input[type=checkbox],input[type=radio]')
              ? 'select'
              : event.type;
      const target = describe(e);
      if (!target) return;
      const item = {
        time: Date.now(),
        type,
        target,
        trusted: event.isTrusted,
        inputRedacted: event.type === 'input' || event.type === 'change',
        scroll:
          type === 'scroll'
            ? { x: Math.round(scrollX), y: Math.round(scrollY) }
            : undefined,
      };
      if (typeof globalThis.__qiyeDeveloperNotify === 'function') {
        globalThis.__qiyeDeveloperNotify(item);
        return;
      }
      const last = state.events.at(-1);
      if (
        last &&
        ['input', 'scroll'].includes(type) &&
        last.type === type &&
        last.target.id === target.id &&
        item.time - last.time < 500
      )
        state.events[state.events.length - 1] = item;
      else state.events.push(item);
      if (state.events.length > 200) {
        state.events.shift();
        state.dropped = (state.dropped || 0) + 1;
      }
    };
    for (const type of [
      'click',
      'input',
      'change',
      'keydown',
      'scroll',
      'pointermove',
    ])
      root.addEventListener(type, handler, {
        capture: true,
        passive: !['click'].includes(type),
      });
    state.handlers.push({ root, handler });
  };
  if (input.action === 'stop') {
    for (const { root, handler } of state.handlers)
      for (const type of [
        'click',
        'input',
        'change',
        'keydown',
        'scroll',
        'pointermove',
      ])
        root.removeEventListener(type, handler, true);
    for (const o of state.observers.values()) o.disconnect();
    removeHighlight();
    delete globalThis[key];
    document
      .querySelectorAll('[data-qiye-developer-overlay="mask"]')
      .forEach((e) => e.remove());
    return { released: true };
  }
  if (input.action === 'validate' || input.action === 'highlight') {
    try {
      const nodes = resolve(input.locator);
      return {
        count: nodes.length,
        targets: nodes.slice(0, 5).map(describe),
        highlighted:
          input.action === 'highlight' && nodes.length === 1
            ? highlight(nodes[0])
            : false,
      };
    } catch {
      return { count: 0, error: '定位器无效或目标框架 / Shadow DOM 不可访问' };
    }
  }
  if (input.action === 'validate-many') {
    return (input.locators || []).slice(0, 60).map((locator) => {
      try {
        return { locator, count: resolve(locator).length };
      } catch {
        return { locator, count: 0, error: '框架或根路径已变化' };
      }
    });
  }
  if (input.action === 'inspect') {
    state.inspecting = !!input.enabled;
    if (!state.inspecting) removeHighlight();
  }
  if (input.action === 'configure') {
    state.record = !!input.record;
    state.inspecting = !!input.inspect;
  }
  if (input.action === 'unmask') {
    state.maskToken = null;
    document
      .querySelectorAll('[data-qiye-developer-overlay="mask"]')
      .forEach((e) => e.remove());
    return true;
  }
  if (input.action === 'mask-status')
    return { valid: state.maskToken === input.token && !state.maskChanged };
  const nodes = [];
  let truncated = false;
  const walk = (root, parent = null, depth = 0) => {
    attachRoot(root);
    for (const e of root.children || []) {
      if (
        excluded(e) ||
        ['SCRIPT', 'STYLE', 'NOSCRIPT', 'META', 'LINK'].includes(e.tagName)
      )
        continue;
      if (nodes.length >= (input.limit || 1200)) {
        truncated = true;
        return;
      }
      const d = describe(e);
      if (!d) continue;
      d.parentId = parent;
      d.depth = depth;
      nodes.push(d);
      if (sensitive(e)) continue;
      walk(e, d.id, depth + 1);
      if (e.shadowRoot) walk(e.shadowRoot, d.id, depth + 1);
    }
  };
  walk(document);
  // Roots removed by the SPA release their listeners/observers as well.
  for (const [root, observer] of state.observers) {
    if (root !== document && !root.host?.isConnected) {
      observer.disconnect();
      state.observers.delete(root);
      const slot = state.handlers.find((s) => s.root === root);
      if (slot)
        for (const type of [
          'click',
          'input',
          'change',
          'keydown',
          'scroll',
          'pointermove',
        ])
          root.removeEventListener(type, slot.handler, true);
      state.handlers = state.handlers.filter((s) => s.root !== root);
    }
  }
  if (input.action === 'mask') {
    if (truncated) throw new Error('页面超出安全截图采样范围');
    removeHighlight();
    const allowed =
      /^(?:作品发布|发布视频|发布图文|上传视频|上传|发布|取消|确定|保存|下一步|上一步|标题|作品标题|简介|作品简介|作品描述|话题|封面|定位|位置|定时|立即发布|重新上传|上传完成|上传成功|处理中|选择视频|返回|视频发布|预览|登录|扫码登录|关闭|继续|提交|操作成功|发布成功|审核中|选择封面|添加话题)$/;
    const cover = (e) => {
      const r = e.getBoundingClientRect();
      if (!r.width || !r.height) return;
      const box = document.createElement('div');
      box.setAttribute('data-qiye-developer-overlay', 'mask');
      Object.assign(box.style, {
        position: 'fixed',
        left: r.left + 'px',
        top: r.top + 'px',
        width: r.width + 'px',
        height: r.height + 'px',
        background: '#d9dee7',
        zIndex: 2147483646,
        pointerEvents: 'none',
      });
      (
        e.closest('dialog[open]') ||
        document.fullscreenElement ||
        document.documentElement
      ).append(box);
    };
    const scan = (root) => {
      for (const e of root.querySelectorAll('*')) {
        if (e.closest('[data-qiye-developer-overlay]')) continue;
        if (excluded(e)) {
          cover(e);
          continue;
        }
        const style = getComputedStyle(e);
        if (
          e.matches(
            'input,textarea,[contenteditable=true],img,video,canvas,iframe,svg,object,embed',
          ) ||
          style.backgroundImage !== 'none' ||
          ['::before', '::after'].some(
            (p) =>
              !['none', 'normal', '""'].includes(
                getComputedStyle(e, p).content,
              ),
          )
        ) {
          cover(e);
          continue;
        }
        if (
          [...e.childNodes].some(
            (n) =>
              n.nodeType === 3 &&
              n.textContent.trim() &&
              !allowed.test(n.textContent.trim()),
          )
        )
          cover(e);
        if (e.shadowRoot) scan(e.shadowRoot);
      }
    };
    scan(document);
    state.maskToken = input.token;
    state.maskChanged = false;
    // Wait for the covered surface to reach the compositor before capturePage.
    // A suspended renderer times out in the caller and never saves a raw frame.
    return new Promise((resolve) =>
      requestAnimationFrame(() =>
        requestAnimationFrame(() =>
          resolve({ masked: true, token: state.maskToken }),
        ),
      ),
    );
  }
  const result = {
    url: safeURL(location.href),
    title:
      state.policy.includeText !== false
        ? clean(document.title)
        : '[页面标题已隐藏]',
    readyState: document.readyState,
    viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
    time: Date.now(),
    nodes,
    truncated,
    dirty: state.dirty,
    events: state.events.splice(0),
    selected: state.selected,
    dropped: state.dropped || 0,
  };
  state.selected = null;
  state.dirty = false;
  return result;
}
module.exports = { pageTool };
