'use strict';

// Playwright's Electron loader adds browser switches before this entry point.
// Clear its behavior changes here, never in the shipped application. Debugging
// ports remain because the test harness needs them to inspect the real app.
const { app, session, ipcMain } = require('electron');
const path = require('node:path');

const injectedSwitches = [
  'disable-field-trial-config', 'disable-background-networking',
  'disable-background-timer-throttling', 'disable-backgrounding-occluded-windows',
  'disable-back-forward-cache', 'disable-breakpad',
  'disable-client-side-phishing-detection', 'disable-component-extensions-with-background-pages',
  'disable-component-update', 'no-default-browser-check', 'disable-default-apps',
  'disable-dev-shm-usage', 'disable-edgeupdater', 'disable-extensions',
  'disable-features', 'enable-features', 'allow-pre-commit-input', 'disable-hang-monitor',
  'disable-ipc-flooding-protection', 'disable-popup-blocking', 'disable-prompt-on-repost',
  'disable-renderer-backgrounding', 'disable-updater-scheduler', 'force-color-profile',
  'metrics-recording-only', 'no-first-run', 'password-store', 'use-mock-keychain',
  'no-service-autorun', 'export-tagged-pdf', 'disable-search-engine-choice-screen',
  'unsafely-disable-devtools-self-xss-warnings', 'edge-skip-compat-layer-relaunch',
  'disable-infobars', 'disable-sync',
];

if (app.commandLine.hasSwitch('no-sandbox')) throw new Error('Tests must launch with chromiumSandbox: true');
const originalSwitches = Object.fromEntries(injectedSwitches.filter(name => app.commandLine.hasSwitch(name))
  .map(name => [name, app.commandLine.getSwitchValue(name)]));
for (const name of injectedSwitches) app.commandLine.removeSwitch(name);
globalThis.__qiyeTestRuntime = { injectedSwitches, originalSwitches, renderers: new Map() };

ipcMain.on('qiye-test:renderer-runtime', (event, runtime) => {
  // A later iframe report must not replace the main renderer's evidence.
  if (runtime?.isMainFrame === true) globalThis.__qiyeTestRuntime.renderers.set(event.sender.id, {
    sandboxed: runtime.sandboxed,
    contextIsolated: runtime.contextIsolated,
    isMainFrame: runtime.isMainFrame,
  });
  event.returnValue = true;
});
// All profile sessions receive a sandbox probe before any website preload runs.
const fromPartition = session.fromPartition.bind(session);
const registered = new WeakSet();
session.fromPartition = (...args) => {
  const ownSession = fromPartition(...args);
  if (!registered.has(ownSession)) {
    ownSession.registerPreloadScript({ type: 'frame', filePath: path.join(__dirname, 'electron-sandbox-preload.cjs') });
    registered.add(ownSession);
  }
  return ownSession;
};

if(process.env.QIYE_PUBLISH_FIXTURE==='1')require('./publishing-fixture.cjs');
if (process.env.QIYE_DEVELOPER_FIXTURE === '1') {
  const { DeveloperService } = require('../src/developer/service');
  const attach = DeveloperService.prototype.attach;
  DeveloperService.prototype.attach = function (...args) { globalThis.__qiyeTestDeveloper = this; return attach.apply(this, args); };
  globalThis.__qiyeTestPage = require('../src/publishing/adapters/page').Page;
}
require('../src/main.js');
