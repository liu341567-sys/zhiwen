'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { UIPreferences } = require('../src/ui-preferences');
const { ProfileStore } = require('../src/profile-store');
function fixture(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qiye-preferences-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; }
test('old accounts gain default UI preferences without changing the account manifest', t => {
  const dir = fixture(t), store = new ProfileStore(dir); store.create({ name: 'Original' });
  const original = fs.readFileSync(store.file);
  const prefs = new UIPreferences(dir);
  assert.equal(prefs.get().activeModule, 'environment'); assert.equal(prefs.get().sidebarCollapsed, false);
  prefs.update({ activeModule: 'publish', sidebarCollapsed: true, environmentScroll: 2000, environmentSearch: '账号' });
  assert.deepEqual(fs.readFileSync(store.file), original);
});
test('module, collapse, search, scroll and native window size survive restart', t => {
  const dir = fixture(t), prefs = new UIPreferences(dir);
  const expected = prefs.update({ activeModule: 'settings', sidebarCollapsed: true, environmentSearch: '抖音',
    environmentScroll: 1780.5, panelScroll: { environment: 42, settings: 15 }, menuScroll: { publish: 25 }, railScroll: 14, windowMaximized: true, windowSize: { width: 1000, height: 680 } });
  assert.deepEqual(new UIPreferences(dir).get(), expected);
  expected.panelScroll.settings = 99; assert.equal(prefs.get().panelScroll.settings, 15);
});
test('invalid and unsupported updates cannot partially change saved UI preferences', t => {
  const prefs = new UIPreferences(fixture(t)); prefs.update({ sidebarCollapsed: true });
  const previous = fs.readFileSync(prefs.file), state = prefs.get();
  for (const update of [{ activeModule: 'unknown' }, { sidebarCollapsed: 'true' }, { windowMaximized: 'yes' }, { environmentScroll: -1 },
    { panelScroll: { unknown: 5 } }, { menuScroll: { unknown: 4 } }, { railScroll: -1 }, { panelScroll: [] }, { windowSize: { width: Infinity, height: 600 } },
    { environmentSearch: 'x'.repeat(561) }, { version: 2 }, { profiles: [] }, { activeModule: 'publish', environmentScroll: NaN }]) {
    assert.throws(() => prefs.update(update)); assert.deepEqual(prefs.get(), state); assert.deepEqual(fs.readFileSync(prefs.file), previous);
  }
});
test('optional malformed UI preferences recover a safe layout without touching their source', t => {
  const dir = fixture(t), file = path.join(dir, 'ui-preferences.json');
  for (const contents of ['bad json', '{"version":2}', '{"version":1,"sidebarCollapsed":"yes"}']) {
    fs.writeFileSync(file, contents); assert.equal(new UIPreferences(dir).get().activeModule, 'environment');
    assert.equal(fs.readFileSync(file, 'utf8'), contents);
  }
});
