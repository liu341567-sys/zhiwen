'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { userAgentForMode } = require('../src/browser-identity');

test('browser mode removes application products while retaining the actual native platform and Chromium version', () => {
  for (const platform of ['Windows NT 10.0; Win64; x64', 'X11; Linux x86_64', 'Macintosh; Intel Mac OS X 10_15_7']) {
    const native = `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) Qiye/0.1.2 Chrome/152.0.7977.130 Electron/44.6.0 Safari/537.36`;
    const expected = `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.7977.130 Safari/537.36`;
    assert.equal(userAgentForMode(native, 'web'), expected);
    assert.equal(userAgentForMode(native, 'app'), native);
  }
});

test('browser identity follows native engine upgrades and leaves unrelated products intact', () => {
  const native = 'Mozilla/5.0 (Example OS) Qiye/2.5.0 Chrome/201.2.3.4 Electron/70.1.2 Safari/537.36 Custom/9';
  assert.equal(userAgentForMode(native, 'web'), 'Mozilla/5.0 (Example OS) Chrome/201.2.3.4 Safari/537.36 Custom/9');
  assert.equal(userAgentForMode(userAgentForMode(native, 'web'), 'web'), userAgentForMode(native, 'web'));
  assert.throws(() => userAgentForMode(native, 'unknown'));
  assert.throws(() => userAgentForMode('栖页/0.1.2', 'app'));
});
