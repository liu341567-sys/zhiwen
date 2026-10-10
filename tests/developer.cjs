'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { _electron } = require('playwright-core');
const { ProfileStore } = require('../src/profile-store');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'test-results', 'ui');
const testArgs = process.argv.slice(2);
const displayArg = testArgs.find((a) => a.startsWith('--display='));
if (displayArg) process.env.DISPLAY = displayArg.slice('--display='.length);
fs.mkdirSync(output, { recursive: true });
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
let checks = 0;
function check(label, fn) {
  fn();
  checks++;
  console.log('✓ ' + label);
}
async function until(fn, label) {
  const end = Date.now() + 15000;
  while (Date.now() < end) {
    if (await fn()) return;
    await pause(80);
  }
  throw new Error('Timed out: ' + label);
}
const servers = [];
async function serve(handler) {
  const server = http.createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  servers.push(server);
  return 'http://127.0.0.1:' + server.address().port;
}
async function run(scale, origin) {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'qiye-developer-native-'),
  );
  const store = new ProfileStore(directory);
  const a = store.create({ name: '调试账号 A', startUrl: origin + '/start' });
  const b = store.create({ name: '调试账号 B', startUrl: origin + '/start' });
  const manifest = () =>
    fs.readFileSync(path.join(directory, 'profiles.json'), 'utf8');
  let app, tools, shell, account;
  const launch = async () => {
    app = await _electron.launch({
      chromiumSandbox: true,
      args: [
        ...(process.platform === 'linux' ? ['--disable-setuid-sandbox'] : []),
        `--force-device-scale-factor=${scale}`,
        path.join(root, 'tests/electron-launch.cjs'),
      ],
      cwd: root,
      env: {
        ...process.env,
        QIYE_DATA_DIR: directory,
        QIYE_DEVELOPER_FIXTURE: '1',
      },
    });
    await until(() => {
      shell = app
        .windows()
        .find((p) => p.url().endsWith('/renderer/index.html'));
      return shell;
    }, 'main window');
    await shell.waitForFunction(
      () =>
        window.browserAPI &&
        !document.body.classList.contains('navigation-loading'),
    );
    await pause(350);
  };
  const openTools = async () => {
    await shell.evaluate(() => browserAPI.openDeveloperTools());
    await until(() => {
      tools = app
        .windows()
        .find((p) => p.url().endsWith('/developer/index.html'));
      return tools;
    }, 'developer window');
    await tools.waitForFunction(() => window.developerAPI);
  };
  const cmd = (command, input) =>
    tools.evaluate(
      ({ command, input }) => developerAPI.command(command, input),
      { command, input },
    );
  const state = () => cmd('state');
  const native = () =>
    app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .find((w) => w.webContents.getURL().endsWith('/renderer/index.html'))
        .contentView.children.filter((v) => v.webContents?.profileId)
        .map((v) => ({
          profile: v.webContents.profileId,
          wc: v.webContents.id,
        })),
    );
  try {
    await launch();
    await shell.evaluate((id) => browserAPI.openProfile(id), a.id);
    await until(() => {
      account = app.windows().find((p) => p.url() === origin + '/start');
      return account;
    }, 'account A');
    await account.waitForFunction(() => window.ready);
    await account.evaluate(() => {
      document.cookie = 'account=A;Path=/';
      localStorage.setItem('account', 'A');
      window.keepIdentity = crypto.randomUUID();
    });
    const identity = await account.evaluate(() => window.keepIdentity);
    await shell.evaluate((id) => browserAPI.openProfile(id), b.id);
    let other;
    await until(() => {
      other = app.windows().find(p => p !== account && p.url() === origin + '/start');
      return other;
    }, 'account B loaded');
    await other.waitForFunction(() => window.ready);
    await other.evaluate(() => {
      document.cookie = 'account=B;Path=/';
      localStorage.setItem('account', 'B');
    });
    await shell.evaluate((id) => browserAPI.openProfile(id), a.id);
    const before = await native(),
      configBefore = manifest();
    await openTools();
    const initial = await cmd('attach', { id: a.id });
    const snap = initial.report.snapshots.at(-1);
    check(
      `developer-${scale}: original main and cross-origin frames analyzed without a new browser`,
      () => {
        assert.ok(
          snap.frames[0].nodes.some((n) => n.attributes.id === 'submit'),
        );
        assert.ok(
          snap.frames.some(
            (f) =>
              f.key !== 'main' &&
              f.nodes.some((n) => n.attributes.id === 'frame-button'),
          ),
        );
        assert.ok(
          snap.frames[0].nodes.some(
            (n) => n.attributes.id === 'shadow-second' && n.roots.length === 1,
          ),
        );
      },
    );
    check(
      `developer-${scale}: credentials and rich text child values never enter structure`,
      () => {
        const json = JSON.stringify(snap);
        for (const secret of [
          'p@ss-secret',
          'rich-private',
          'raw-query',
          'hidden-secret',
          'script-secret',
        ])
          assert.ok(!json.includes(secret), secret);
        assert.ok(!snap.frames[0].url.includes('?'));
        assert.equal(
          snap.frames[0].nodes.find((n) => n.attributes.id === 'pw').text,
          '',
        );
      },
    );

    assert.deepEqual(
      await account.evaluate(() => [
        typeof developerAPI,
        typeof __qiyeDeveloperNotify,
        typeof require,
      ]),
      ['undefined', 'undefined', 'undefined'],
    );
    assert.equal(
      await app.evaluate(
        ({ webContents }, id) =>
          webContents
            .getAllWebContents()
            .find((w) => w.profileId === id)
            .debugger.isAttached(),
        a.id,
      ),
      false,
    );
    const shadow = snap.frames[0].nodes.find(
      (n) => n.attributes.id === 'shadow-second',
    );
    assert.equal(
      (
        await cmd('validate', {
          selector: shadow.selector,
          roots: shadow.roots,
        })
      ).count,
      1,
    );
    const submit = snap.frames[0].nodes.find(
      (n) => n.attributes.id === 'submit',
    );
    assert.equal(
      (await cmd('validate', { selector: submit.xpath, kind: 'xpath' })).count,
      1,
    );
    assert.equal((await cmd('validate', { selector: '.duplicate' })).count, 2);
    assert.equal((await cmd('validate', { selector: '[invalid' })).count, 0);
    check(
      `developer-${scale}: CSS, XPath, shadow roots and ambiguous locators validated`,
      () =>
        assert.ok(
          snap.frames[0].nodes.find(
            (n) => n.attributes.id === 'css-abcdef123456',
          ).unstableAttributes.length,
        ),
    );
    await cmd('inspect', { enabled: true });
    await account.locator('#submit').hover();
    await account.waitForFunction(() =>
      document.querySelector('[data-qiye-developer-overlay="highlight"]'),
    );
    await account.locator('#submit').click();
    await cmd('refresh');

    assert.equal(await account.evaluate(() => window.submits), 0);
    assert.equal((await state()).report.selected.attributes.id, 'submit');
    await account.locator('#submit').click();
    assert.equal(await account.evaluate(() => window.submits), 1);
    await cmd('start');
    await account.locator('#title').fill('input-private');
    await account.locator('#pw').fill('p@ss-new-secret');
    await account.locator('#rich').fill('another-rich-private #人工智能');
    await account.locator('#rich').press('Space');
    await account.locator('#choice').selectOption('second');
    await account.locator('#tick').check();
    await account.locator('#file').setInputFiles({
      name: 'personal-video.mp4',
      mimeType: 'video/mp4',
      buffer: Buffer.from('video sample'),
    });
    await account.locator('#shadow-first').click();
    await account.frameLocator('iframe').locator('#frame-button').click();
    await account.locator('#change').click();
    await cmd('refresh');
    let recorded = (await state()).report;
    check(
      `developer-${scale}: real click/input/select/upload/space actions have elements and snapshot links`,
      () => {
        for (const type of [
          'click',
          'input',
          'select',
          'upload',
          'topic-space',
        ])
          assert.ok(
            recorded.steps.some((s) => s.type === type),
            type,
          );
        assert.ok(recorded.steps.some((s) => s.frame !== 'main'));
        assert.ok(recorded.steps.every((s) => s.beforeId && s.afterId));
        const upload = recorded.steps.find((s) => s.type === 'upload');
        assert.equal(upload.target.file.count, 1);
        assert.deepEqual(upload.target.file.types, ['video/mp4']);
        const all = JSON.stringify(recorded);
        for (const secret of [
          'input-private',
          'p@ss-new-secret',
          'another-rich-private',
          'personal-video.mp4',
        ])
          assert.ok(!all.includes(secret), secret);
      },
    );
    const comparison = await cmd('compare', {
      before: recorded.snapshots[0].id,
      after: recorded.snapshots.at(-1).id,
    });
    check(
      `developer-${scale}: modal appearance and button enabled changes are represented`,
      () =>
        assert.ok(
          comparison.changes.some((c) => c.after?.attributes.id === 'dynamic'),
        ),
    );
    await cmd('pause');
    const pausedCount = (await state()).report.steps.length;
    await account.locator('#submit').click();
    await pause(100);
    assert.equal((await state()).report.steps.length, pausedCount);
    await cmd('resume');
    // This gesture immediately navigates; the private event transport must keep
    // the originating click even when the old isolated world is destroyed.
    await account.locator('#next').click();
    await account.waitForURL(origin + '/next');
    await cmd('refresh');
    await account.locator('#submit').click();
    await cmd('refresh');
    recorded = (await state()).report;
    check(
      `developer-${scale}: recorder survives full navigation and retains the click before it`,
      () => {
        assert.ok(
          recorded.steps.some((s) => s.target?.attributes.id === 'next'),
        );
        assert.ok(recorded.steps.some((s) => s.type === 'navigation'));
        assert.ok(
          recorded.steps.some(
            (s) =>
              s.target?.attributes.id === 'submit' &&
              s.time > recorded.steps.find((s) => s.type === 'navigation').time,
          ),
        );
      },
    );
    await account.evaluate(() => {
      history.pushState({}, '', '/next?token=raw-query');
    });
    await pause(100);
    await cmd('refresh');
    await account.evaluate(() => window.scrollTo(0, 700));
    await pause(120);
    await cmd('refresh');

    recorded = (await state()).report;
    assert.ok(recorded.steps.some((s) => s.type === 'scroll'));
    assert.ok(!JSON.stringify(recorded).includes('raw-query'));
    await cmd('stop');
    const ended = (await state()).report;
    const savedId = ended.id;
    await account.locator('#submit').click();
    await pause(100);
    assert.equal((await state()).report.steps.length, ended.steps.length);
    await cmd('note', { id: ended.steps[0].id, note: '已验证的入口' });
    await cmd('delete-step', { id: ended.steps.at(-1).id });
    await cmd('resume');
    await account.locator('#submit').click();
    await cmd('stop');
    check(
      `developer-${scale}: pause/end/delete/note and supplemental segment work`,
      () => assert.equal(ended.steps.length > 0, true),
    );
    await cmd('options', { screenshots: true });
    await cmd('reveal');
    await account.evaluate(() => window.scrollTo(0, 0));
    await cmd('screenshot');
    const shot = (await state()).report.screenshots.at(-1);
    assert.ok(shot, JSON.stringify((await state()).report.warnings));

    // Test the center of the actual input at the captured CSS -> PNG scale.
    const rect = await account.locator('#title').boundingBox();
    const pixels = await app.evaluate(
      ({ nativeImage }, { data, rect, viewport }) => {
        const image = nativeImage.createFromDataURL(data),
          size = image.getSize(),
          bitmap = image.toBitmap();
        const x = Math.round(
            ((rect.x + rect.width / 2) / viewport.width) * size.width,
          ),
          y = Math.round(
            ((rect.y + rect.height / 2) / viewport.height) * size.height,
          );
        return [
          ...bitmap.subarray(
            (y * size.width + x) * 4,
            (y * size.width + x) * 4 + 3,
          ),
        ];
      },
      {
        data: shot.data,
        rect,
        viewport: await account.evaluate(() => ({
          width: innerWidth,
          height: innerHeight,
        })),
      },
    );
    check(
      `developer-${scale}: screenshot contains a composited privacy mask and removes it afterwards`,
      () => assert.deepEqual(pixels, [231, 222, 217]),
    );
    assert.equal(
      await account.locator('[data-qiye-developer-overlay="mask"]').count(),
      0,
    );
    await cmd('preview');
    await assert.rejects(cmd('export', { format: 'json' }), /确认所有截图/);
    await cmd('review-shot', { id: shot.id });
    await cmd('preview');
    await app.evaluate(({ dialog }, directory) => {
      dialog.showSaveDialog = async (_owner, options) => ({
        canceled: false,
        filePath: directory + '/' + options.defaultPath,
      });
    }, directory);
    for (const format of ['json', 'md', 'html', 'zip'])
      assert.equal((await cmd('export', { format })).saved, true);
    const exported = JSON.parse(
      fs.readFileSync(
        path.join(directory, 'Qiye-Developer-Report.json'),
        'utf8',
      ),
    );
    check(
      `developer-${scale}: reviewed local exports associate snapshots and images and omit account ID`,
      () => {
        assert.equal(exported.accountId, undefined);
        assert.equal(
          exported.screenshots[0].file,
          'screenshots/' + shot.id + '.png',
        );
        assert.ok(exported.steps[0].beforeId);
      },
    );
    if (process.platform === 'win32') {
      require('node:child_process').execFileSync(
        'powershell.exe',
        ['-NoProfile', '-Command', '-'],
        {
          input: `Add-Type -AssemblyName System.IO.Compression.FileSystem\n$z=[System.IO.Compression.ZipFile]::OpenRead('${path.join(directory, 'Qiye-Developer-Report.zip').replace(/'/g, "''")}')\nif($z.Entries.Count -lt 4){throw 'ZIP incomplete'}\n$z.Dispose()\n`,
        },
      );
    }
    await cmd('new');
    const newId = (await state()).report.id;
    await account.locator('#submit').evaluate((n) => n.remove());
    await cmd('refresh');
    const history = await cmd('historical', { id: savedId });
    check(
      `developer-${scale}: historical recording reports locator drift`,
      () =>
        assert.ok(
          history.locatorChecks.some(
            (c) => c.locator.selector === '#submit' && c.count === 0,
          ),
        ),
    );
    await cmd('load', { id: savedId });
    // Real original publishing Page interface generates begin/end/error traces;
    // its debugger lease remains available because tools use a preload channel.
    await app.evaluate(
      async ({ webContents }, { id, root }) => {
        const wc = webContents
          .getAllWebContents()
          .find((w) => w.profileId === id);
        const page = new globalThis.__qiyeTestPage(
          wc,
          new AbortController().signal,
          () => {},
          (event) =>
            globalThis.__qiyeTestDeveloper.trace(id, {
              taskId: 'fixture-task',
              ...event,
            }),
        );
        try {
          await page.connect();
          await page.evaluate(() => document.readyState);
          await page
            .awaitOperation(
              Promise.reject(new Error('selector disappeared')),
              5000,
              { operation: 'fixture-submit' },
            )
            .catch(() => {});
        } finally {
          page.detach();
        }
      },
      { id: a.id, root },
    );
    await until(
      async () =>
        (await state()).report.scripts.some(
          (s) =>
            s.operation === 'fixture-submit' &&
            s.phase === 'error' &&
            s.snapshotId,
        ),
      'real publishing step and failure capture',
    );
    const scriptReport = (await state()).report;
    check(
      `developer-${scale}: real publishing Page trace reports timings, errors and snapshot association`,
      () => {
        const error = scriptReport.scripts.find(
          (s) => s.operation === 'fixture-submit' && s.phase === 'error',
        );
        assert.ok(error.snapshotId);
        assert.equal(error.reason, 'selector disappeared');
        assert.ok(error.durationMs >= 0);
        assert.ok(scriptReport.scripts.some((s) => s.phase === 'begin'));
      },
    );

    await tools.screenshot({
      path: path.join(output, `developer-${scale}.png`),
    });
    const layout = await tools.evaluate(() => ({
      width: innerWidth,
      overflow: document.documentElement.scrollWidth > innerWidth,
      toolbar: document.querySelector('.toolbar').getBoundingClientRect()
        .bottom,
      body: innerHeight,
    }));
    check(`developer-${scale}: tools remain usable at display scale`, () => {
      assert.equal(layout.overflow, false);
      assert.ok(layout.toolbar < layout.body - 100);
    });
    await tools.close();
    await pause(250);

    assert.deepEqual(await native(), before);
    assert.equal(
      await account.evaluate(() => window.keepIdentity || 'navigated'),
      'navigated',
    );
    assert.equal(
      await account.evaluate(() => localStorage.getItem('account')),
      'A',
    );
    assert.equal(
      await other.evaluate(() => localStorage.getItem('account')),
      'B',
    );
    // Navigation may update lastUrl, but launch/platform/IDs and session settings stay unchanged.
    const configAfter = JSON.parse(manifest()),
      original = JSON.parse(configBefore);
    assert.deepEqual(
      configAfter.profiles.map((p) => [p.id, p.startUrl, p.platformId]),
      original.profiles.map((p) => [p.id, p.startUrl, p.platformId]),
    );
    await openTools();
    await cmd('load', { id: savedId });
    assert.equal((await state()).report.id, savedId);
    await cmd('delete-report', { id: newId });
    await app.close();
    app = null;
    await launch();
    await openTools();
    const reopened = await state();
    assert.ok(reopened.reports.some((r) => r.id === savedId));
    assert.ok(!reopened.reports.some((r) => r.id === newId));
    check(
      `developer-${scale}: saved reports and report deletion survive app restart`,
      () => assert.equal(reopened.active, null),
    );
    console.log(
      JSON.stringify({
        developerLayout: scale,
        checks,
        viewport: layout,
        frames: snap.frames.length,
      }),
    );
  } catch (error) {
    console.error(
      JSON.stringify({
        uiFailure: 'developer-' + scale,
        error: error.message,
        stack: error.stack,
      }),
    );
    throw error;
  } finally {
    if (app) await app.close().catch(() => {});
  }
}
(async () => {
  const iframe = await serve((_req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end(
      '<button id="frame-button" onclick="this.disabled=true">上传</button>',
    );
  });
  const origin = await serve((_req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end(`<!doctype html><title>发布测试</title><style>body{margin:20px;min-height:1800px}input,select,button{margin:5px;padding:10px}#rich{border:1px solid gray;padding:10px;width:300px}iframe{display:block;height:60px}dialog{padding:20px}</style>
<label for="title">作品标题</label><input id="title" placeholder="填写作品标题"><input id="pw" type="password" value="p@ss-secret"><input type="hidden" value="hidden-secret"><div id="rich" contenteditable="true"><span>rich-private</span></div>
<select id="choice"><option value="first">第一项</option><option value="second">第二项</option></select><input id="tick" type="checkbox"><input id="file" type="file" accept="video/*"><button id="submit" aria-label="发布" onclick="window.submits++">发布</button><button class="duplicate">保存</button><button class="duplicate">保存</button><button id="css-abcdef123456">动态</button>
<button id="change" onclick="document.getElementById('dynamic').hidden=false">封面</button><div id="dynamic" hidden role="dialog">选择封面</div><a id="next" href="/next">下一步</a><x-controls></x-controls><iframe src="${iframe}/?token=raw-query"></iframe><script>window.submits=0;window.secret='script-secret'; const s=document.querySelector('x-controls').attachShadow({mode:'open'});s.innerHTML='<button id="shadow-first">上传</button><button id="shadow-second">发布</button>';window.ready=true;</script>`);
  });
  try {
    for (const scale of testArgs.filter((a) => !a.startsWith('--')).length
      ? testArgs.filter((a) => !a.startsWith('--')).map(Number)
      : [1, 1.25, 1.5])
      await run(scale, origin);
    console.log(`${checks} developer real-window checks passed`);
  } finally {
    for (const server of servers) await new Promise((r) => server.close(r));
  }
})().catch(() => {
  process.exitCode = 1;
});
