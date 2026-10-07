'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { partitionFor } = require('./profile-store');

function validateDocumentStorage(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('无效的网页会话存储');
  const result = {};
  for (const [origin, entries] of Object.entries(value)) {
    const url = new URL(origin);
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin || !Array.isArray(entries) ||
        !entries.every(entry => Array.isArray(entry) && entry.length === 2 && entry.every(item => typeof item === 'string'))) {
      throw new Error('无效的网页会话存储');
    }
    if (entries.length) result[origin] = entries;
  }
  return result;
}

// Chromium persists expiring cookies itself. Native OS encryption protects the
// session-only cookies needed to resume a saved account after an app restart.
class CookieVault {
  constructor(dataDir, safeStorage, platform = process.platform) {
    this.directory = path.join(dataDir, 'session-cookies');
    this.crypto = safeStorage;
    this.available = safeStorage.isEncryptionAvailable() &&
      !(platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text');
  }

  filename(id) {
    partitionFor(id);
    return path.join(this.directory, `${id}.bin`);
  }

  save(id, cookies, documentStorage = {}) {
    const filename = this.filename(id);
    if (!this.available) return;
    const selected = cookies.filter(cookie => cookie.session);
    const documents = validateDocumentStorage(documentStorage);
    if (!selected.length && !Object.keys(documents).length) return this.remove(id);
    const encrypted = this.crypto.encryptString(JSON.stringify({ version: 1, id, cookies: selected, documentStorage: documents }));
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const temp = `${filename}.tmp`;
    const fd = fs.openSync(temp, 'w', 0o600);
    try { fs.writeFileSync(fd, encrypted); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    fs.renameSync(temp, filename);
  }

  async restore(id, ownSession) {
    const filename = this.filename(id);
    if (!fs.existsSync(filename)) return {};
    if (!this.available) throw new Error('本机安全存储不可用，无法解密此环境的会话 Cookie；请在原 Windows 用户下重新打开');
    let saved;
    try {
      saved = JSON.parse(this.crypto.decryptString(fs.readFileSync(filename)));
      if (saved.version !== 1 || saved.id !== id || !Array.isArray(saved.cookies)) throw new Error('invalid vault');
      saved.documentStorage = validateDocumentStorage(saved.documentStorage ?? {});
    } catch {
      throw new Error('无法解密保存的会话 Cookie；数据未被覆盖，请使用原系统用户或备份恢复');
    }
    for (const cookie of saved.cookies) {
      let host = cookie.domain.replace(/^\./, '');
      if (host.includes(':') && !host.startsWith('[')) host = `[${host}]`;
      await ownSession.cookies.set({
        url: `${cookie.secure ? 'https' : 'http'}://${host}${cookie.path || '/'}`,
        name: cookie.name,
        value: cookie.value,
        ...(cookie.hostOnly ? {} : { domain: cookie.domain }),
        path: cookie.path,
        secure: cookie.secure,
        httpOnly: cookie.httpOnly,
        sameSite: cookie.sameSite
      });
    }
    return saved.documentStorage;
  }

  remove(id) { fs.rmSync(this.filename(id), { force: true }); }
}

module.exports = { CookieVault, validateDocumentStorage };
