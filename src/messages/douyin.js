'use strict';
// Confirmed by the user: opening this list does not read a conversation.
const launchUrl = 'https://creator.douyin.com/creator-micro/data/following/chat';
function allowed(value) {
  try { const u = new URL(value); return u.origin === 'https://creator.douyin.com' && u.pathname.replace(/\/$/, '') === '/creator-micro/data/following/chat' && !u.search && !u.hash && !u.username && !u.password; } catch { return false; }
}
const jumpUrl = () => launchUrl;

// Getter-only isolated-world probe. Never read input values, conversations,
// cookies, storage, message text, names, peer IDs or request/response bodies.
function observe() {
  const visible = node => { const r = node.getBoundingClientRect(), s = getComputedStyle(node); return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden'; };
  const diagnostic = { locator: 'private-message-total-or-navigation-counter', candidates: 0, nodes: [], structure: [] };
  if (!document.body || document.readyState === 'loading') return { status: 'loading', diagnostic };
  const gates = [...document.querySelectorAll('[role="dialog"],[class*="captcha"],[id*="captcha"]')].slice(0, 30).filter(visible);
  if (gates.some(n => /安全验证|滑块|请完成验证|二次验证/.test(n.textContent.slice(0, 500)))) return { status: 'verification', diagnostic };
  if ([...document.querySelectorAll('button,[role="dialog"],h1,h2')].slice(0, 150).filter(visible)
    .some(n => /^(?:扫码登录|短信登录|手机号登录|登录已失效|登录过期|请先登录)$/.test((n.textContent || '').trim()))) return { status: 'login_required', diagnostic };
  diagnostic.structure = [...document.querySelectorAll('iframe,[role=tab],[role=navigation],[class*=badge i],[class*=unread i]')].slice(0, 40).map(n => ({
    tag: n.tagName.toLowerCase(), role: ['tab', 'navigation', 'status'].includes(n.getAttribute('role')) ? n.getAttribute('role') : null,
    kind: n.tagName === 'IFRAME' ? 'iframe' : /unread/i.test(n.className || '') ? 'unread' : /badge/i.test(n.className || '') ? 'badge' : 'navigation',
    numeric: /^\d+\+?$/.test((n.textContent || '').trim()) ? (n.textContent || '').trim() : null,
    label: /^(?:全部消息|未读消息|私信|消息|未读|全部)$/.test((n.getAttribute('aria-label') || '').trim()) ? n.getAttribute('aria-label').trim() : null
  }));
  const sources = [];
  for (const node of [...document.querySelectorAll('a,button,[role="tab"],[role="button"],[aria-label],h1,h2,h3')].slice(0, 4000)) {
    if (!visible(node)) continue;
    // A per-conversation badge is not an overall unread count, especially in a
    // virtualised list. Never sum conversation rows or infer zero from absence.
    if (node.closest('[role="listitem"],[role="row"],[class*="conversation" i],[class*="session-item" i],[class*="chat-item" i]')) continue;
    const label = (node.getAttribute('aria-label') || node.getAttribute('title') || node.textContent || '').trim().replace(/\s+/g, ' ');
    if (label.length > 70) continue;
    const explicit = /^(?:私信(?:消息)?[，,:： ]*(\d+\+?)\s*(条|个会话)?未读|(\d+\+?)\s*(条|个会话)?未读私信)$/.exec(label);
    const entry = /^(?:我的)?私信(?:消息)?(?:\s*[（(]?\d+\+?[）)]?)?$/.test(label);
    const unreadTab = node.getAttribute('role') === 'tab' && /^未读(?:私信)?\s*[（(]?\d+\+?[）)]?$/.test(label);
    if (!explicit && !entry && !unreadTab) continue;
    if (!unreadTab && !node.closest('nav,header,aside,[role=navigation],[role=tablist]') && !/^H[123]$/.test(node.tagName)) continue;
    diagnostic.candidates++;
    if (diagnostic.nodes.length < 12) diagnostic.nodes.push({ tag: node.tagName.toLowerCase(), role: node.getAttribute('role') || null, kind: explicit ? 'explicit-unread-total' : unreadTab ? 'unread-tab' : 'private-message-navigation' });
    let values = [], unit = 'unknown';
    if (explicit) { values = [explicit[1] || explicit[3]]; unit = (explicit[2] || explicit[4]) === '条' ? 'messages' : (explicit[2] || explicit[4]) === '个会话' ? 'conversations' : 'unknown'; }
    else {
      const direct = /\d+\+?/.exec(label); if (direct) values.push(direct[0]);
      for (const badge of [...node.querySelectorAll('[class*="badge" i],[class*="unread" i],[role="status"],[data-count]')].filter(visible)) {
        const value = (badge.getAttribute('data-count') || badge.textContent || '').trim(); if (/^\d+\+?$/.test(value)) values.push(value);
      }
    }
    for (const value of new Set(values)) { const n = Number(value.replace('+', '')); if (Number.isSafeInteger(n) && n <= 1000000) sources.push({ unread: n, exact: !value.endsWith('+'), unit }); }
  }
  const counts = new Set(sources.map(r => `${r.unread}:${r.exact}`));
  if (counts.size > 1) return { status: 'ambiguous', diagnostic };
  if (sources.length) return { status: 'success', ...(sources.find(r => r.unit !== 'unknown') || sources[0]), diagnostic };
  return { status: 'unrecognized', diagnostic };
}
async function read(wc, signal, timeoutMs = 8000) {
  if (!wc || wc.isDestroyed()) return { status: 'closed' };
  const before = wc.getURL(); if (!allowed(before)) return { status: /login|passport/.test(before) ? 'login_required' : 'wrong_page' };
  let timer, abort;
  try {
    const sample = await Promise.race([
      (async () => {
        let last; const end = Date.now() + timeoutMs - 350;
        do {
          if (signal.aborted || wc.isDestroyed()) return { status: 'loading' };
          last = await wc.executeJavaScriptInIsolatedWorld(3102, [{ code: `(${observe.toString()})()` }]);
          if (!['loading', 'unrecognized'].includes(last?.status)) return last;
          await new Promise(resolve => setTimeout(resolve, 250));
        } while (Date.now() < end);
        return last;
      })(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error(), { code: 'timeout' })), timeoutMs);
        abort = () => reject(Object.assign(new Error(), { code: 'aborted' })); signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort(); })
    ]);
    if (signal.aborted) return { status: 'aborted' };
    if (wc.isDestroyed() || wc.getURL() !== before) return { status: 'page_changed' };
    if (!sample || !['success', 'loading', 'verification', 'login_required', 'unrecognized', 'ambiguous'].includes(sample.status)) return { status: 'unrecognized' };
    return { ...sample, jumpUrl: launchUrl };
  } catch (error) { return { status: signal.aborted ? 'aborted' : error.code === 'timeout' ? 'timeout' : 'page_changed' }; }
  finally { clearTimeout(timer); if (abort) signal.removeEventListener('abort', abort); }
}
module.exports = { id: 'douyin', name: '抖音', verified: false, capability: 'count-estimate', launchUrl, allowed, jumpUrl, observe, read };
