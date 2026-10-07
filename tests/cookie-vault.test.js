'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomBytes, createCipheriv, createDecipheriv } = require('node:crypto');
const { test } = require('node:test');
const { CookieVault } = require('../src/cookie-vault');

const idA = 'd379f87c-bc9a-41bc-bc4e-179df825ad38';
const idB = '9502b54a-91eb-475e-b64d-01724810c57c';

// An authenticated encryption stub verifies vault behavior without claiming to
// emulate Windows DPAPI. Native safeStorage is exercised by Windows integration.
function nativeStorage({ available = true, backend = 'secret_service', key = randomBytes(32) } = {}) {
  return {
    isEncryptionAvailable: () => available,
    getSelectedStorageBackend: () => backend,
    encryptString(value) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
    },
    decryptString(value) {
      const decipher = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12));
      decipher.setAuthTag(value.subarray(12, 28));
      return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString('utf8');
    },
  };
}

function temporaryVault(t, crypto = nativeStorage(), platform = 'win32') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qiye-cookie-vault-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return { directory, crypto, vault: new CookieVault(directory, crypto, platform) };
}

function sessionCookie(overrides = {}) {
  return {
    name: 'session-account',
    value: 'synthetic-test-session-value',
    domain: '.example.com',
    hostOnly: false,
    path: '/creator',
    secure: true,
    httpOnly: true,
    sameSite: 'lax',
    session: true,
    ...overrides,
  };
}

test('only session cookies enter an encrypted, private environment vault', (t) => {
  const { vault, crypto } = temporaryVault(t);
  const session = sessionCookie();
  vault.save(idA, [session, sessionCookie({ name: 'persistent', session: false, expirationDate: 4_000_000_000 })]);
  const file = vault.filename(idA);
  const encrypted = fs.readFileSync(file);
  assert.equal(encrypted.includes(Buffer.from(session.value)), false);
  const saved = JSON.parse(crypto.decryptString(encrypted));
  assert.equal(saved.id, idA);
  assert.deepEqual(saved.cookies, [session]);
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o077, 0);
});

test('restore retains domain, path, HTTPS, HttpOnly and SameSite cookie attributes', async (t) => {
  const { vault } = temporaryVault(t);
  vault.save(idA, [sessionCookie()]);
  const restored = [];
  await vault.restore(idA, { cookies: { set: async cookie => restored.push(cookie) } });
  assert.deepEqual(restored, [{
    url: 'https://example.com/creator',
    name: 'session-account',
    value: 'synthetic-test-session-value',
    domain: '.example.com',
    path: '/creator',
    secure: true,
    httpOnly: true,
    sameSite: 'lax',
  }]);
});

test('host-only and loopback IPv6 cookies restore without widening their domain', async (t) => {
  const { vault } = temporaryVault(t);
  vault.save(idA, [sessionCookie({ domain: '::1', hostOnly: true, path: '/', secure: false })]);
  const restored = [];
  await vault.restore(idA, { cookies: { set: async cookie => restored.push(cookie) } });
  assert.equal(restored[0].url, 'http://[::1]/');
  assert.equal(Object.hasOwn(restored[0], 'domain'), false);
});

test('sessionStorage is encrypted and restored even when there are no session cookies', async (t) => {
  const { vault, crypto } = temporaryVault(t);
  const documentStorage = { 'https://example.com': [['account', 'synthetic-session-storage-value']] };
  vault.save(idA, [], documentStorage);
  assert.equal(fs.existsSync(vault.filename(idA)), true);
  const encrypted = fs.readFileSync(vault.filename(idA));
  assert.equal(encrypted.includes(Buffer.from('synthetic-session-storage-value')), false);
  const saved = JSON.parse(crypto.decryptString(encrypted));
  assert.equal(saved.id, idA);
  assert.deepEqual(saved.cookies, []);
  const restored = await vault.restore(idA, { cookies: { set: async () => assert.fail('no session cookies to restore') } });
  assert.deepEqual(restored, documentStorage);
});

test('same-origin sessionStorage remains separated by environment identity', async (t) => {
  const { vault } = temporaryVault(t);
  const storageA = { 'https://example.com': [['account', 'A']] };
  const storageB = { 'https://example.com': [['account', 'B']] };
  vault.save(idA, [], storageA);
  vault.save(idB, [], storageB);
  const noCookies = { cookies: { set: async () => assert.fail('no session cookies to restore') } };
  assert.deepEqual(await vault.restore(idA, noCookies), storageA);
  assert.deepEqual(await vault.restore(idB, noCookies), storageB);
  vault.remove(idA);
  assert.equal(fs.existsSync(vault.filename(idA)), false);
  assert.deepEqual(await vault.restore(idB, noCookies), storageB);
});

test('unavailable native encryption and Linux basic_text never write cookie values', (t) => {
  for (const configuration of [
    { available: false, backend: 'secret_service' },
    { available: true, backend: 'basic_text' },
  ]) {
    const { vault } = temporaryVault(t, nativeStorage(configuration), 'linux');
    assert.equal(vault.available, false);
    vault.save(idA, [sessionCookie()], { 'https://example.com': [['account', 'synthetic-session-storage-value']] });
    assert.equal(fs.existsSync(vault.filename(idA)), false);
  }
});

test('logging out removes an old session vault without removing another account', (t) => {
  const { vault } = temporaryVault(t);
  vault.save(idA, [sessionCookie({ value: 'A' })]);
  vault.save(idB, [sessionCookie({ value: 'B' })]);
  vault.save(idA, []);
  assert.equal(fs.existsSync(vault.filename(idA)), false);
  assert.equal(fs.existsSync(vault.filename(idB)), true);
  vault.remove(idB);
  assert.equal(fs.existsSync(vault.filename(idB)), false);
});

test('a different OS-user encryption key refuses restore and preserves the vault', async (t) => {
  const { directory, vault } = temporaryVault(t);
  vault.save(idA, [sessionCookie()]);
  const before = fs.readFileSync(vault.filename(idA));
  const differentUser = new CookieVault(directory, nativeStorage(), 'win32');
  let injected = 0;
  await assert.rejects(differentUser.restore(idA, { cookies: { set: async () => { injected += 1; } } }));
  assert.equal(injected, 0);
  assert.deepEqual(fs.readFileSync(vault.filename(idA)), before);
});

test('a vault copied from a different environment cannot inject its login cookies', async (t) => {
  const { vault } = temporaryVault(t);
  vault.save(idA, [sessionCookie({ value: 'A' })], { 'https://example.com': [['account', 'A']] });
  vault.save(idB, [sessionCookie({ value: 'B' })], { 'https://example.com': [['account', 'B']] });
  const otherData = fs.readFileSync(vault.filename(idB));
  fs.writeFileSync(vault.filename(idA), otherData);
  let injected = 0;
  await assert.rejects(vault.restore(idA, { cookies: { set: async () => { injected += 1; } } }));
  assert.equal(injected, 0);
  assert.deepEqual(fs.readFileSync(vault.filename(idA)), otherData);
});

test('corrupted ciphertext fails before cookie injection and remains available for recovery', async (t) => {
  const { vault } = temporaryVault(t);
  vault.save(idA, [sessionCookie()]);
  const broken = fs.readFileSync(vault.filename(idA));
  broken[broken.length - 1] ^= 0xff;
  fs.writeFileSync(vault.filename(idA), broken);
  let injected = 0;
  await assert.rejects(vault.restore(idA, { cookies: { set: async () => { injected += 1; } } }));
  assert.equal(injected, 0);
  assert.deepEqual(fs.readFileSync(vault.filename(idA)), broken);
});

test('missing secure storage refuses an existing encrypted vault without overwriting it', async (t) => {
  const { directory, vault } = temporaryVault(t);
  vault.save(idA, [sessionCookie()]);
  const before = fs.readFileSync(vault.filename(idA));
  const unavailable = new CookieVault(directory, nativeStorage({ available: false }), 'linux');
  await assert.rejects(unavailable.restore(idA, { cookies: { set: async () => assert.fail('no cookie injection') } }));
  assert.deepEqual(fs.readFileSync(vault.filename(idA)), before);
});

test('vault paths reject invalid environment IDs', (t) => {
  const { vault } = temporaryVault(t);
  for (const id of ['../other', '', 'persist:other']) {
    assert.throws(() => vault.save(id, [sessionCookie()]));
    assert.throws(() => vault.remove(id));
  }
});
