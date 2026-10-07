'use strict';

// Start from Electron's native, ASCII application identity. Browser mode changes
// only the two application product tokens; the OS and Chromium version stay real.
function userAgentForMode(appUserAgent, mode) {
  if (typeof appUserAgent !== 'string' || !/^[\x20-\x7e]+$/.test(appUserAgent)) {
    throw new TypeError('浏览器标识必须是 ASCII 字符串');
  }
  if (mode === 'app') return appUserAgent;
  if (mode !== 'web') throw new TypeError('无效的浏览器兼容模式');
  return appUserAgent.replace(/\sQiye\/[^\s]+/g, '').replace(/\sElectron\/[^\s]+/g, '');
}

module.exports = { userAgentForMode };
