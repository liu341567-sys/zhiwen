'use strict';
// Synthetic official-origin pages for native Session/DOM/IPC tests. Never shipped.
const { session } = require('electron');
const { MessageService } = require('../src/messages/service');
const { MessageBrowser } = require('../src/messages/browser');
globalThis.__messageFixture = { samples: {}, pages: [], notifications: [], requests: [], service: null };
const fromPartition = session.fromPartition.bind(session), registered = new WeakSet();
session.fromPartition = (...args) => {
  const own = fromPartition(...args);
  if (!registered.has(own)) {
    registered.add(own); const id = args[0].replace('persist:account-', '');
    own.protocol.handle('https', async request => {
      const u = new URL(request.url); if (u.hostname !== 'creator.douyin.com') return new Response('', { status: 404 });
      const f = globalThis.__messageFixture, value = f.samples[id] ?? 8;
      f.requests.push({ id, route: u.pathname, method: request.method });
      if (!u.pathname.endsWith('/chat')) return new Response('<!doctype html><title>Editing</title><input id="editing" value="untouched"><script>window.ready=true;window.originalToken=crypto.randomUUID();</script>', { headers: { 'content-type': 'text/html' } });
      const body = value === 'login' ? '<button>扫码登录</button>' : value === 'absent' ? '<nav><button>私信</button></nav>'
        : value === 'conflict' ? '<nav><button aria-label="私信 8条未读">私信 8</button><button aria-label="私信 9条未读">私信 9</button></nav>'
        : `<nav><button aria-label="私信 ${value}条未读">私信<span class="badge">${value}</span></button><button>系统通知<span class="badge">99</span></button></nav>`;
      return new Response(`<!doctype html><meta charset="utf-8"><title>Private list fixture</title>${body}<div role="list"><div role="listitem"><button aria-label="私信 123条未读" onclick="document.body.dataset.clicked='yes'">Private conversation text DO_NOT_EXPORT</button></div></div><input type="password" value="DO_NOT_EXPORT"><script>window.ready=true;window.addEventListener('focus',()=>window.focused=true)</script>`, { headers: { 'content-type': 'text/html' } });
    });
  }
  return own;
};
const create = MessageService.create;
MessageService.create = async function (...args) {
  const service = await create.apply(this, args); globalThis.__messageFixture.service = service;
  const notify = service.notify; service.notify = (changes, settings) => { globalThis.__messageFixture.notifications.push(changes); return notify(changes, settings); };
  return service;
};
const acquire = MessageBrowser.prototype.acquire;
MessageBrowser.prototype.acquire = async function (...args) {
  const wc = await acquire.apply(this, args);
  globalThis.__messageFixture.pages.push({ id: args[0], wc: wc.id, original: !wc.messageProfileId, cookies: (await wc.session.cookies.get({ url: 'https://creator.douyin.com' })).map(c => ({ name: c.name, value: c.value })) });
  return wc;
};
