'use strict';

const assert = require('node:assert/strict');
const vm = require('node:vm');
const { test } = require('node:test');
const { LoginDiagnostics, PAGE_OBSERVATION_SCRIPT } = require('../src/login-diagnostics');

const metadata = {
  appVersion: '0.1.1',
  electronVersion: '44.6.0',
  chromiumVersion: '152.0.7977.130',
  platform: 'win32',
  browserMode: 'web',
  identity: { ascii: true, hasApplicationProduct: false, hasElectronProduct: false, chromeVersionMatches: true },
};

function request(overrides = {}) {
  return {
    url: 'https://www.zhihu.com/api/v3/oauth/sign_in',
    method: 'POST',
    resourceType: 'xhr',
    statusCode: 200,
    ...overrides,
  };
}

function clock(durationMs) {
  let elapsed = 1000;
  const diagnostics = new LoginDiagnostics({ now: () => elapsed, durationMs });
  return { diagnostics, advance(milliseconds) { elapsed += milliseconds; } };
}

function observation(nodes, options = {}) {
  const body = { tagName: 'BODY', parentElement: null, hidden: false, getAttribute: () => null };
  const textNodes = nodes.map(input => {
    const data = typeof input === 'string' ? { text: input } : input;
    return {
      textContent: data.text,
      parentElement: {
        tagName: data.tag || 'DIV',
        parentElement: body,
        hidden: data.hidden || false,
        getAttribute: name => name === 'aria-hidden' && data.ariaHidden ? 'true' : null,
        display: data.display || 'block',
        visibility: data.visibility || 'visible',
      },
    };
  });
  let cursor = 0;
  return vm.runInNewContext(PAGE_OBSERVATION_SCRIPT, {
    location: options.location ?? { protocol: 'https:', hostname: 'www.zhihu.com' },
    navigator: {
      userAgent: options.ua ?? 'Mozilla/5.0 Chrome/152.0.7977.130 Safari/537.36',
      userAgentData: { brands: options.brands ?? [{ brand: 'Chromium', version: '152' }] },
    },
    document: { body, createTreeWalker: () => ({ nextNode: () => textNodes[cursor++] || null }) },
    NodeFilter: { SHOW_TEXT: 4 },
    getComputedStyle: element => ({ display: element.display || 'block', visibility: element.visibility || 'visible' }),
  });
}

test('collection is opt-in and reports omit the diagnostic target', () => {
  const { diagnostics } = clock();
  assert.equal(diagnostics.recordCompleted('private-account-id', request()), false);
  assert.equal(diagnostics.recordError('private-account-id', request({ error: 'net::ERR_FAILED' })), false);
  assert.equal(diagnostics.targetId, null);
  assert.equal(diagnostics.getReport(), null);
  assert.equal(diagnostics.stop(), null);
  assert.equal(diagnostics.observePage('private-account-id', { zhihu10001Shown: true }), false);
  assert.equal(diagnostics.getReport(), null);
  diagnostics.start('private-account-id', metadata);
  assert.equal(diagnostics.targetId, 'private-account-id');
  assert.equal(diagnostics.getReport().remainingSeconds, 120);
  assert.equal(JSON.stringify(diagnostics.getReport()).includes('private-account-id'), false);
});

test('only the selected profile and HTTPS Zhihu host boundary are counted', () => {
  const { diagnostics } = clock();
  diagnostics.start('A', metadata);
  assert.equal(diagnostics.recordCompleted('B', request()), false);
  assert.equal(diagnostics.observePage('B', { zhihu10001Shown: true }), false);
  for (const url of [
    'http://www.zhihu.com/api/v3/oauth/sign_in',
    'https://zhihu.com.evil.invalid/api/v3/oauth/sign_in',
    'https://evilzhihu.com/api/v3/oauth/sign_in',
    'https://zhihu.com@evil.invalid/api/v3/oauth/sign_in',
    'file:///zhihu.com/api/v3/oauth/sign_in',
    'not a URL',
  ]) assert.equal(diagnostics.recordCompleted('A', request({ url })), false, url);
  for (const url of [
    'https://zhihu.com/',
    'https://WWW.ZHIHU.COM/api/v3/oauth/sign_in',
    'https://api.zhihu.com/api/v4/account/',
    'https://captcha.zhihu.com/challenge',
  ]) assert.equal(diagnostics.recordCompleted('A', request({ url })), true, url);
  const report = diagnostics.getReport();
  assert.equal(report.counters.completed, 4);
  assert.deepEqual(report.counters.routeCategories, { oauth: 1, account: 1, captcha: 1, other: 1 });
  assert.equal(report.page.zhihu10001Shown, false);
});

test('report whitelist drops secrets in URLs, headers, bodies, metadata and page data', () => {
  const { diagnostics } = clock();
  const secrets = ['private-phone-13900000000', 'secret-sms-683219', 'secret-password', 'secret-token', 'secret-cookie'];
  const secret = secrets.join('-');
  diagnostics.start('private-profile-id', {
    ...metadata, name: secret, notes: secret, dataPath: `/Users/${secret}`,
    ua: secret, userAgent: secret, timestamp: secret,
    identity: { ...metadata.identity, token: secret },
  });
  diagnostics.recordCompleted('private-profile-id', request({
    url: `https://www.zhihu.com/api/v3/oauth/${secret}?phone=${secret}&token=${secret}`,
    headers: { cookie: secret, authorization: secret },
    requestHeaders: { Cookie: secret },
    responseHeaders: { 'Set-Cookie': secret },
    uploadData: [{ bytes: secret }],
    requestBody: secret, responseBody: secret, error: secret,
  }));
  diagnostics.recordError('private-profile-id', request({ error: `net::ERR_${secret}` }));
  diagnostics.observePage('private-profile-id', {
    zhihu10001Shown: true, configuredUaMatchesPage: true, clientHintsMatchChromium: true,
    textContent: secret, userAgent: secret, phone: secret, storage: { token: secret },
  });
  const report = diagnostics.stop(secret);
  const exported = JSON.stringify(report);
  for (const value of [...secrets, 'private-profile-id', '/api/v3/oauth', 'www.zhihu.com', 'Set-Cookie']) {
    assert.equal(exported.includes(value), false, value);
  }
  assert.equal(report.stopReason, 'user');
  assert.equal(report.counters.routeCategories.oauth, 2);
  assert.deepEqual(report.counters.networkErrors, { other: 1 });
  assert.deepEqual(Object.keys(report), ['schemaVersion', 'running', 'remainingSeconds', 'runtime', 'counters', 'page', 'stopReason']);
});

test('raw headers and body fields are never accessed', () => {
  const { diagnostics } = clock();
  diagnostics.start('A', metadata);
  const details = request();
  for (const field of ['requestHeaders', 'responseHeaders', 'uploadData', 'requestBody', 'responseBody']) {
    Object.defineProperty(details, field, { get() { throw new Error(`must not read ${field}`); } });
  }
  assert.equal(diagnostics.recordCompleted('A', details), true);
});

test('HTTP successes, HTTP failures and network failures use bounded safe buckets', () => {
  const { diagnostics } = clock();
  diagnostics.start('A', metadata);
  for (const statusCode of [100, 200, 429, 500, 599]) diagnostics.recordCompleted('A', request({ statusCode }));
  for (const statusCode of [99, 600, '200', 'secret-value', NaN]) diagnostics.recordCompleted('A', request({ statusCode }));
  diagnostics.recordCompleted('A', request({ method: '__proto__', resourceType: 'secret-value' }));
  diagnostics.recordError('A', request({ error: 'net::ERR_CONNECTION_RESET' }));
  diagnostics.recordError('A', request({ error: 'secret-value' }));
  const { counters } = diagnostics.getReport();
  assert.equal(counters.completed, 11);
  assert.equal(counters.failed, 2);
  assert.deepEqual(counters.statusCodes, { 100: 1, 200: 2, 429: 1, 500: 1, 599: 1 });
  assert.equal(counters.methods.other, 1);
  assert.equal(counters.resourceTypes.other, 1);
  assert.deepEqual(counters.networkErrors, { ERR_CONNECTION_RESET: 1, other: 1 });
  assert.equal(JSON.stringify(counters).includes('secret-value'), false);
});

test('runtime versions, browser mode and identity have a strict whitelist', () => {
  const { diagnostics } = clock();
  diagnostics.start('A', {
    appVersion: 'private-token', electronVersion: '44.6.0 private-token', chromiumVersion: '152.0.7977.130/private-token',
    platform: 'private-platform', browserMode: 'private-mode',
    identity: { ascii: 'private-token', hasApplicationProduct: 1, hasElectronProduct: false, chromeVersionMatches: true },
  });
  assert.deepEqual(diagnostics.getReport().runtime, {
    appVersion: 'unknown', electronVersion: 'unknown', chromiumVersion: 'unknown',
    platform: 'unknown', browserMode: 'unknown',
    identity: { ascii: null, hasApplicationProduct: null, hasElectronProduct: false, chromeVersionMatches: true },
  });
  diagnostics.start('A', { ...metadata, browserMode: 'app' });
  assert.equal(diagnostics.getReport().runtime.browserMode, 'app');
});

test('HTTP 200 can accompany a page message without claiming a server response code', () => {
  const { diagnostics } = clock();
  diagnostics.start('A', metadata);
  diagnostics.recordCompleted('A', request());
  diagnostics.observePage('A', { zhihu10001Shown: true, configuredUaMatchesPage: false, clientHintsMatchChromium: true });
  diagnostics.observePage('A', { zhihu10001Shown: false });
  const report = diagnostics.getReport();
  assert.deepEqual(report.counters.statusCodes, { 200: 1 });
  assert.equal(report.page.zhihu10001Shown, true);
  assert.equal(report.page.zhihu10001Observations, 1);
  assert.equal(report.page.observations, 2);
  assert.equal(report.page.configuredUaMatchesPage, false);
  assert.equal(report.page.clientHintsMatchChromium, true);
  assert.equal(Object.hasOwn(report, 'serverErrorCode'), false);
});

test('120 second maximum automatically expires on reads and rejects later events', () => {
  const { diagnostics, advance } = clock(999_999);
  diagnostics.start('A', metadata);
  advance(119_500);
  assert.equal(diagnostics.getReport().remainingSeconds, 1);
  advance(500);
  assert.equal(diagnostics.targetId, null);
  assert.equal(diagnostics.recordCompleted('A', request()), false);
  assert.equal(diagnostics.observePage('A', { zhihu10001Shown: true }), false);
  assert.equal(diagnostics.getReport().stopReason, 'timeout');
  assert.equal(diagnostics.getReport().remainingSeconds, 0);
});

test('a shorter capture expires on a network event even without a report read', () => {
  const { diagnostics, advance } = clock(1500);
  diagnostics.start('A', metadata);
  advance(1500);
  assert.equal(diagnostics.recordError('A', request({ error: 'net::ERR_FAILED' })), false);
  assert.equal(diagnostics.getReport().stopReason, 'timeout');
  assert.equal(diagnostics.getReport().counters.failed, 0);
});

test('replacing and stopping captures prevents account crossover', () => {
  const { diagnostics } = clock();
  diagnostics.start('A', metadata);
  diagnostics.recordCompleted('A', request());
  diagnostics.start('B', metadata);
  assert.equal(diagnostics.recordCompleted('A', request()), false);
  assert.equal(diagnostics.getReport().counters.completed, 0);
  diagnostics.recordCompleted('B', request());
  const report = diagnostics.stop('profile-closed');
  assert.equal(report.stopReason, 'profile-closed');
  assert.equal(diagnostics.targetId, null);
  assert.equal(diagnostics.recordCompleted('B', request()), false);
  assert.equal(diagnostics.getReport().counters.completed, 1);
  diagnostics.start('A', metadata);
  assert.equal(diagnostics.stop('app-exit').stopReason, 'app-exit');
  assert.equal(new LoginDiagnostics().getReport(), null);
});

test('metadata and returned reports cannot mutate internal summaries', () => {
  const { diagnostics } = clock();
  const mutable = { ...metadata, identity: { ...metadata.identity } };
  const first = diagnostics.start('A', mutable);
  mutable.identity.ascii = false;
  first.runtime.identity.ascii = false;
  first.counters.completed = 300;
  first.counters.methods.secret = 100;
  const report = diagnostics.getReport();
  assert.equal(report.runtime.identity.ascii, true);
  assert.equal(report.counters.completed, 0);
  assert.deepEqual(report.counters.methods, {});
});

test('page observation returns fixed flags and engine majors without DOM or full UA', () => {
  const result = observation(['13900000000 secret-password secret-token ', '10001:请求参数异常，请升级客户端后重试'], {
    ua: 'Mozilla/5.0 Qiye/0.1.1 Chrome/152.0.7977.130 Electron/44.6.0 Safari/537.36 secret-token',
  });
  assert.equal(result.zhihu10001Shown, true);
  assert.equal(result.uaASCII, true);
  assert.equal(result.hasElectronProduct, true);
  assert.equal(result.hasApplicationProduct, true);
  assert.equal(result.chromeMajor, 152);
  assert.equal(result.clientHintChromiumMajor, 152);
  assert.deepEqual(Object.keys(result), [
    'zhihu10001Shown', 'uaASCII', 'hasElectronProduct', 'hasApplicationProduct', 'chromeMajor', 'clientHintChromiumMajor',
  ]);
  const serialized = JSON.stringify(result);
  for (const secret of ['13900000000', 'secret-password', 'secret-token', 'Mozilla', '请求参数']) {
    assert.equal(serialized.includes(secret), false, secret);
  }
});

test('page observation verifies the current HTTPS Zhihu document before reading UA or DOM', () => {
  for (const location of [
    { protocol: 'https:', hostname: 'example.com' },
    { protocol: 'http:', hostname: 'www.zhihu.com' },
    { protocol: 'https:', hostname: 'zhihu.com.evil.invalid' },
    { protocol: 'https:', hostname: 'evilzhihu.com' },
    { protocol: 'file:', hostname: '' },
  ]) {
    const context = { location };
    let navigatorReads = 0;
    let documentReads = 0;
    Object.defineProperty(context, 'navigator', { get() { navigatorReads += 1; throw new Error('do not read UA'); } });
    Object.defineProperty(context, 'document', { get() { documentReads += 1; throw new Error('do not read DOM'); } });
    assert.equal(vm.runInNewContext(PAGE_OBSERVATION_SCRIPT, context), null, JSON.stringify(location));
    assert.equal(navigatorReads, 0);
    assert.equal(documentReads, 0);
  }
  for (const hostname of ['zhihu.com', 'www.zhihu.com', 'api.zhihu.com']) {
    assert.equal(observation(['10001:请求参数异常，请升级客户端后重试'], {
      location: { protocol: 'https:', hostname },
    }).zhihu10001Shown, true);
  }
});

test('page observation ignores hidden templates, script content, other codes and partial phrases', () => {
  const phrase = '10001:请求参数异常，请升级客户端后重试';
  const cases = [
    ['登录成功'],
    ['210001:请求参数异常，请升级客户端后重试'],
    ['10001:请求参数异常'],
    ['10001 unrelated text 请求参数异常，请升级客户端后重试'],
    [{ text: phrase, tag: 'SCRIPT' }],
    [{ text: phrase, tag: 'STYLE' }],
    [{ text: phrase, tag: 'TEMPLATE' }],
    [{ text: phrase, hidden: true }],
    [{ text: phrase, ariaHidden: true }],
    [{ text: phrase, display: 'none' }],
    [{ text: phrase, visibility: 'hidden' }],
  ];
  for (const nodes of cases) assert.equal(observation(nodes).zhihu10001Shown, false, JSON.stringify(nodes));
  assert.equal(observation(['10001：', '请求参数异常，', '请升级客户端后重试']).zhihu10001Shown, true);
  assert.equal(observation([phrase], { ua: '栖页/0.1.1 Chrome/152.0.7977.130' }).uaASCII, false);
});
