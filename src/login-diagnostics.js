'use strict';

// A local, opt-in summary. Raw network details, page text and account data are
// never retained. Each bucket name below is supplied by this module, not a page.
const MAX_DURATION_MS = 120_000;
const MAX_COUNT = 1_000_000;
const STOP_REASONS = new Set(['user', 'timeout', 'profile-closed', 'app-exit', 'replaced']);
const METHODS = new Set(['GET', 'POST', 'HEAD', 'OPTIONS', 'PUT', 'PATCH', 'DELETE']);
const RESOURCE_TYPES = new Set([
  'mainFrame', 'subFrame', 'stylesheet', 'script', 'image', 'font', 'object',
  'xhr', 'ping', 'cspReport', 'media', 'webSocket', 'other',
]);
const NETWORK_ERRORS = new Set([
  'ERR_ABORTED', 'ERR_CONNECTION_CLOSED', 'ERR_CONNECTION_REFUSED',
  'ERR_CONNECTION_RESET', 'ERR_CONNECTION_TIMED_OUT', 'ERR_TIMED_OUT',
  'ERR_NAME_NOT_RESOLVED', 'ERR_INTERNET_DISCONNECTED', 'ERR_NETWORK_CHANGED',
  'ERR_SSL_PROTOCOL_ERROR', 'ERR_CERT_AUTHORITY_INVALID', 'ERR_CERT_DATE_INVALID',
  'ERR_CERT_COMMON_NAME_INVALID', 'ERR_BLOCKED_BY_CLIENT', 'ERR_BLOCKED_BY_RESPONSE',
  'ERR_FAILED', 'ERR_TUNNEL_CONNECTION_FAILED', 'ERR_PROXY_CONNECTION_FAILED',
  'ERR_HTTP_RESPONSE_CODE_FAILURE', 'ERR_TOO_MANY_REDIRECTS',
]);

// Execute only in an isolated world. The website's text and full User-Agent
// stay in that world; only fixed booleans and bounded engine majors are returned.
const PAGE_OBSERVATION_SCRIPT = `(() => {
  try {
    if (location.protocol !== 'https:' || typeof location.hostname !== 'string' ||
        !(location.hostname === 'zhihu.com' || location.hostname.endsWith('.zhihu.com'))) return null;
  } catch { return null; }
  const result = {
    zhihu10001Shown: false,
    uaASCII: false,
    hasElectronProduct: false,
    hasApplicationProduct: false,
    chromeMajor: null,
    clientHintChromiumMajor: null
  };
  try {
    const ua = navigator.userAgent;
    if (typeof ua === 'string') {
      result.uaASCII = /^[\\x20-\\x7e]*$/.test(ua);
      result.hasElectronProduct = /\\bElectron\\/\\d/.test(ua);
      result.hasApplicationProduct = /\\bQiye\\/\\d/.test(ua);
      const chrome = /\\bChrome\\/(\\d{1,3})\\./.exec(ua);
      if (chrome && Number(chrome[1]) > 0) result.chromeMajor = Number(chrome[1]);
    }
    const brands = navigator.userAgentData?.brands;
    if (Array.isArray(brands)) {
      const chromium = brands.find(brand => brand?.brand === 'Chromium');
      if (chromium && /^\\d{1,3}$/.test(chromium.version) && Number(chromium.version) > 0) {
        result.clientHintChromiumMajor = Number(chromium.version);
      }
    }
  } catch {}
  try {
    if (!document.body) return result;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const visibility = new WeakMap();
    let text = '';
    let scanned = 0;
    while (scanned++ < 10000) {
      const node = walker.nextNode();
      if (!node) break;
      let visible = true;
      for (let parent = node.parentElement; parent; parent = parent.parentElement) {
        if (!visibility.has(parent)) {
          const tag = parent.tagName;
          const style = getComputedStyle(parent);
          visibility.set(parent, !['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE'].includes(tag) &&
            !parent.hidden && parent.getAttribute('aria-hidden') !== 'true' &&
            style.display !== 'none' && style.visibility !== 'hidden' && style.visibility !== 'collapse');
        }
        if (!visibility.get(parent)) { visible = false; break; }
      }
      if (visible) text += (node.textContent || '').slice(0, Math.max(0, 200000 - text.length));
      if (text.length >= 200000) break;
    }
    result.zhihu10001Shown = /(?:^|[^0-9A-Za-z])10001\\s*[:：]?\\s*请求参数异常[，,\\s]*请升级客户端后重试/.test(text);
  } catch {}
  return result;
})()`;

function boolean(value) { return typeof value === 'boolean' ? value : null; }

function version(value, segments) {
  if (typeof value !== 'string') return 'unknown';
  const expression = segments === 4
    ? /^\d{1,3}\.\d{1,3}\.\d{1,5}\.\d{1,5}$/
    : /^\d{1,3}\.\d{1,3}\.\d{1,5}(?:-(?:alpha|beta|rc)(?:\.\d{1,3})?)?$/;
  return expression.test(value) ? value : 'unknown';
}

function runtimeMetadata(metadata) {
  const input = metadata && typeof metadata === 'object' ? metadata : {};
  const identity = input.identity && typeof input.identity === 'object' ? input.identity : {};
  return {
    appVersion: version(input.appVersion, 3),
    electronVersion: version(input.electronVersion, 3),
    chromiumVersion: version(input.chromiumVersion, 4),
    platform: ['win32', 'linux', 'darwin'].includes(input.platform) ? input.platform : 'unknown',
    browserMode: ['web', 'app'].includes(input.browserMode) ? input.browserMode : 'unknown',
    identity: {
      ascii: boolean(identity.ascii),
      hasApplicationProduct: boolean(identity.hasApplicationProduct),
      hasElectronProduct: boolean(identity.hasElectronProduct),
      chromeVersionMatches: boolean(identity.chromeVersionMatches),
    },
  };
}

function emptyReport() {
  return {
    schemaVersion: 1,
    running: false,
    remainingSeconds: 0,
    runtime: runtimeMetadata({}),
    counters: {
      completed: 0,
      failed: 0,
      statusCodes: {},
      routeCategories: { oauth: 0, captcha: 0, account: 0, other: 0 },
      methods: {},
      resourceTypes: {},
      networkErrors: {},
    },
    page: {
      observations: 0,
      zhihu10001Shown: false,
      zhihu10001Observations: 0,
      configuredUaMatchesPage: null,
      clientHintsMatchChromium: null,
    },
    stopReason: null,
  };
}

function increment(object, key) {
  object[key] = Math.min(MAX_COUNT, (object[key] || 0) + 1);
}

function classifyRequest(details) {
  if (!details || typeof details !== 'object' || typeof details.url !== 'string') return null;
  let parsed;
  try { parsed = new URL(details.url); } catch { return null; }
  if (parsed.protocol !== 'https:' || !(parsed.hostname === 'zhihu.com' || parsed.hostname.endsWith('.zhihu.com'))) return null;
  let route = 'other';
  if (/^\/api\/v\d{1,2}\/oauth(?:\/|$)/.test(parsed.pathname)) route = 'oauth';
  else if (parsed.hostname === 'captcha.zhihu.com' || /^\/(?:api\/v\d{1,2}\/)?captcha(?:\/|$)/.test(parsed.pathname)) route = 'captcha';
  else if (/^\/api\/v\d{1,2}\/account(?:\/|$)/.test(parsed.pathname)) route = 'account';
  return {
    route,
    method: METHODS.has(details.method) ? details.method : 'other',
    resourceType: RESOURCE_TYPES.has(details.resourceType) ? details.resourceType : 'other',
  };
}

class LoginDiagnostics {
  #now;
  #durationMs;
  #expiresAt = 0;
  #id = null;
  #started = false;
  #report = emptyReport();

  constructor({ now = Date.now, durationMs = MAX_DURATION_MS } = {}) {
    this.#now = typeof now === 'function' ? now : Date.now;
    this.#durationMs = Number.isFinite(durationMs)
      ? Math.max(0, Math.min(MAX_DURATION_MS, Math.floor(durationMs))) : MAX_DURATION_MS;
  }

  #expire() {
    if (this.#report.running && this.#now() >= this.#expiresAt) this.stop('timeout');
  }

  get targetId() {
    this.#expire();
    return this.#id;
  }

  start(id, metadata = {}) {
    if (typeof id !== 'string' || !id || id.length > 128) throw new TypeError('Invalid diagnostic target');
    if (this.#report.running) this.stop('replaced');
    this.#id = id;
    this.#expiresAt = this.#now() + this.#durationMs;
    this.#report = emptyReport();
    this.#started = true;
    this.#report.runtime = runtimeMetadata(metadata);
    this.#report.running = true;
    return this.getReport();
  }

  #record(id, details) {
    this.#expire();
    if (!this.#report.running || id !== this.#id) return false;
    const request = classifyRequest(details);
    if (!request) return false;
    const counters = this.#report.counters;
    increment(counters.routeCategories, request.route);
    increment(counters.methods, request.method);
    increment(counters.resourceTypes, request.resourceType);
    return true;
  }

  recordCompleted(id, details) {
    if (!this.#record(id, details)) return false;
    const counters = this.#report.counters;
    counters.completed = Math.min(MAX_COUNT, counters.completed + 1);
    if (Number.isInteger(details.statusCode) && details.statusCode >= 100 && details.statusCode <= 599) {
      increment(counters.statusCodes, String(details.statusCode));
    }
    return true;
  }

  recordError(id, details) {
    if (!this.#record(id, details)) return false;
    const counters = this.#report.counters;
    counters.failed = Math.min(MAX_COUNT, counters.failed + 1);
    const error = typeof details.error === 'string' ? details.error.replace(/^net::/, '') : '';
    increment(counters.networkErrors, NETWORK_ERRORS.has(error) ? error : 'other');
    return true;
  }

  observePage(id, observation) {
    this.#expire();
    if (!this.#report.running || id !== this.#id || !observation || typeof observation !== 'object') return false;
    const page = this.#report.page;
    page.observations = Math.min(MAX_COUNT, page.observations + 1);
    if (observation.zhihu10001Shown === true) {
      page.zhihu10001Shown = true;
      page.zhihu10001Observations = Math.min(MAX_COUNT, page.zhihu10001Observations + 1);
    }
    for (const flag of ['configuredUaMatchesPage', 'clientHintsMatchChromium']) {
      if (typeof observation[flag] === 'boolean') page[flag] = observation[flag];
    }
    return true;
  }

  stop(reason = 'user') {
    if (this.#report.running) {
      this.#report.running = false;
      this.#report.remainingSeconds = 0;
      this.#report.stopReason = STOP_REASONS.has(reason) ? reason : 'user';
      this.#id = null;
    }
    return this.getReport();
  }

  getReport() {
    if (!this.#started) return null;
    this.#expire();
    this.#report.remainingSeconds = this.#report.running
      ? Math.max(0, Math.ceil((this.#expiresAt - this.#now()) / 1000)) : 0;
    return structuredClone(this.#report);
  }
}

module.exports = { LoginDiagnostics, PAGE_OBSERVATION_SCRIPT };
