'use strict';
const assert = require('node:assert/strict'),
  fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path');
const { _electron } = require('playwright-core'),
  { ProfileStore } = require('../src/profile-store'),
  { run: binary } = require('../src/publishing/media');
const root = path.resolve(__dirname, '..'),
  out = path.join(root, 'test-results', 'ui');
fs.mkdirSync(out, { recursive: true });
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, label) {
  const end = Date.now() + 20000;
  while (Date.now() < end) {
    if (await fn()) return;
    await pause(50);
  }
  throw new Error('Timeout: ' + label);
}
let checks = 0;
function check(label, fn) {
  fn();
  checks++;
  console.log('✓ ' + label);
}
const fixture = `<!doctype html><html><head><meta charset="utf-8"></head><body><h1>视频发布</h1><input type="file" accept="video/mp4,video/webm"><div id="status">选择视频</div><textarea aria-label="作品描述" style="display:none" maxlength="1000"></textarea><button id="publish" style="display:none">发布</button><script>window.submissions=0;document.querySelector('input').onchange=e=>{document.querySelector('#status').textContent='上传完成 '+e.target.files[0].name;document.querySelector('textarea').style.display='block';document.querySelector('#publish').style.display='block';};document.querySelector('#publish').onclick=()=>{window.submissions++;const n=document.createElement('div');n.setAttribute('role','alert');n.textContent='发布成功';document.body.append(n);};</script></body></html>`;
async function run(scale) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qiye-publish-ui-')),
    source = path.join(dir, 'sample.mp4');
  let app;
  try {
    await binary(require('ffmpeg-static'), [
      '-nostdin',
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'color=c=blue:s=320x240:r=10',
      '-t',
      '1',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-y',
      source,
    ]);
    const store = new ProfileStore(dir),
      a = store.create({ name: '抖音账号 A', platformId: 'douyin' }),
      b = store.create({ name: '抖音账号 B', platformId: 'douyin' });
    store.open(a.id);
    store.open(b.id);
    store.activate(a.id);
    const launch = async () => {
      app = await _electron.launch({
        chromiumSandbox: true,
        args: [
          ...(process.platform === 'linux' ? ['--disable-setuid-sandbox'] : []),
          `--force-device-scale-factor=${scale}`,
          path.join(root, 'tests/electron-launch.cjs'),
        ],
        cwd: root,
        env: { ...process.env, QIYE_DATA_DIR: dir, QIYE_PUBLISH_FIXTURE: '1' },
      });
      await app.context().route('https://creator.douyin.com/**', (route) =>
        route.fulfill({
          contentType: 'text/html; charset=utf-8',
          body: fixture,
        }),
      );
      let shell;
      await until(() => {
        shell = app
          .windows()
          .find((p) => p.url().endsWith('/renderer/index.html'));
        return shell;
      }, 'shell');
      await shell.waitForFunction(
        () => !!document.querySelector('[data-module="publish"]'),
      );
      await until(
        () =>
          shell.evaluate(() =>
            publishingAPI
              .command('state')
              .then(() => true)
              .catch(() => false),
          ),
        'publishing service',
      );
      await app.evaluate(({ BrowserWindow, screen }) => {
        const w = BrowserWindow.getAllWindows()[0],
          area = screen.getDisplayMatching(w.getBounds()).workArea,
          frame = w.getBounds(),
          size = w.getContentSize();
        w.setMinimumSize(0, 0);
        w.setContentSize(
          Math.min(1000, area.width - frame.width + size[0]),
          Math.min(650, area.height - frame.height + size[1]),
        );
      });
      return shell;
    };
    let shell = await launch();
    const command = (name, value) =>
      shell.evaluate(({ name, value }) => publishingAPI.command(name, value), {
        name,
        value,
      });
    await shell.locator('button[data-module="publish"]').click();
    await shell.locator('.publish-steps').waitFor();
    const imported = await command('import', [source]);
    assert.equal(imported.added.length, 1);
    const duplicate = await command('import', [source]);
    assert.equal(duplicate.duplicates.length, 1);
    await until(
      () =>
        shell
          .locator('.video-thumb')
          .count()
          .then((n) => n === 1),
      'imported thumbnail',
    );
    const state = await command('state'),
      video = state.videos[0];
    const playable = await shell.evaluate(async (url) => {
      const v = document.createElement('video');
      v.src = url;
      document.body.append(v);
      try {
        return await new Promise((resolve, reject) => {
          v.onloadedmetadata = () =>
            resolve({
              width: v.videoWidth,
              height: v.videoHeight,
              duration: v.duration,
            });
          v.onerror = () =>
            reject(
              new Error('Local media protocol failed: ' + v.error?.message),
            );
          setTimeout(() => reject(new Error('Media timeout')), 5000);
        });
      } finally {
        v.remove();
      }
    }, video.mediaUrl);
    assert.equal(playable.width, 320);
    const escape = await shell.evaluate(async () => {
      try {
        return await fetch('qiye-media://local/video/../../profiles.json').then(
          (r) => r.ok,
        );
      } catch {
        return false;
      }
    });
    assert.equal(escape, false);
    check(
      `publishing-${scale}: real FFprobe metadata, FFmpeg thumbnail and checksum duplicate detection`,
      () => {
        assert.equal(video.width, 320);
        assert.equal(video.height, 240);
        assert.equal(video.duration, 1);
        assert.ok(video.thumbnailData.startsWith('data:image/jpeg;base64,'));
        assert.equal(state.accounts.length, 2);
        assert.equal(state.accounts[0].login.status, 'unknown');
      },
    );
    // Exercise the actual five-step wizard. Import does not choose videos implicitly
    // when invoked directly; selecting a row is a real UI input.
    await shell
      .locator('.publish-table input[type="checkbox"]')
      .first()
      .check();
    await shell.getByRole('button', { name: '下一步', exact: true }).click();
    assert.equal(await shell.locator('.publish-choice:disabled').count(), 3);
    await shell.getByRole('button', { name: '下一步', exact: true }).click();
    await shell
      .locator('.publish-account input')
      .check({ timeout: 1000 })
      .catch(async () => {
        await shell.locator('.publish-account input').nth(0).check();
        await shell.locator('.publish-account input').nth(1).check();
      });
    await shell.getByRole('button', { name: '下一步', exact: true }).click();
    await shell
      .locator('.publish-control textarea')
      .nth(0)
      .fill('第一期测试标题');
    await shell.locator('.publish-control textarea').nth(1).fill('#AI #运营');
    await shell.getByRole('button', { name: '下一步', exact: true }).click();
    assert.equal(await shell.locator('.publish-table tbody tr').count(), 2);
    await shell
      .locator('.publish-table tbody tr')
      .first()
      .getByLabel('锁定', { exact: true })
      .check();
    await shell.getByRole('button', { name: '上一步', exact: true }).click();
    await shell
      .locator('.publish-control textarea')
      .nth(0)
      .fill('回退后新标题');
    await shell.getByRole('button', { name: '下一步', exact: true }).click();
    assert.deepEqual(
      await shell
        .getByLabel('任务标题', { exact: true })
        .evaluateAll((nodes) => nodes.map((n) => n.value)),
      ['第一期测试标题', '回退后新标题'],
    );
    await shell.getByRole('button', { name: '上一步', exact: true }).click();
    await shell
      .locator('.publish-control textarea')
      .nth(0)
      .fill('第一期测试标题');
    await shell.getByRole('button', { name: '下一步', exact: true }).click();
    await shell.getByRole('button', { name: '保存草稿', exact: true }).click();
    const savedDraft = (await command('state')).drafts.find(
      (d) => d.id === 'current',
    );
    assert.ok(savedDraft.data.previewId);
    await app.close();
    app = null;
    shell = await launch();
    await shell.locator('button[data-module="publish"]').click();
    await shell
      .getByRole('button', { name: '确认生成并执行', exact: true })
      .waitFor();
    check(
      `publishing-${scale}: returning to configuration and restarting retain locked preview captions and saved task bindings`,
      () => {
        assert.ok(savedDraft.data.input.overrides);
      },
    );
    assert.deepEqual(
      await shell
        .getByLabel('任务标题', { exact: true })
        .evaluateAll((nodes) => nodes.map((n) => [n.value, n.disabled])),
      [
        ['第一期测试标题', true],
        ['第一期测试标题', false],
      ],
    );
    const settingsButton = () =>
      shell
        .locator('.publish-table tbody tr')
        .nth(1)
        .getByRole('button', { name: '设置', exact: true });
    await settingsButton().click();
    let options = shell.locator('.publish-dialog[open]');
    await options.getByLabel('封面方式').selectOption('frame');
    await options.getByLabel('指定帧时间（秒）', { exact: true }).fill('0.5');
    await options.getByLabel('发布定位').selectOption('specified');
    await options.getByLabel('平台位置名称', { exact: true }).fill('上海市');
    await options.getByLabel('授权自动提交', { exact: true }).check();
    await options.getByRole('button', { name: '关闭', exact: true }).click();
    await settingsButton().click();
    options = shell.locator('.publish-dialog[open]');
    assert.equal(
      await options.getByLabel('授权自动提交', { exact: true }).isChecked(),
      false,
    );
    assert.equal(await options.getByLabel('封面方式').inputValue(), 'first');
    assert.equal(await options.getByLabel('发布定位').inputValue(), 'none');
    await options.getByRole('button', { name: '关闭', exact: true }).click();
    check(
      `publishing-${scale}: closing unsaved task settings discards cover, location and submission authorization changes`,
      () => assert.ok(true),
    );
    const layout = await shell.evaluate(() => {
      const r = (n) => {
        const b = n.getBoundingClientRect();
        return { top: b.top, bottom: b.bottom, height: b.height };
      };
      const body = document.querySelector('.publish-body');
      body.scrollTop = body.scrollHeight;
      return {
        header: r(document.querySelector('.publish-header')),
        footer: r(document.querySelector('.publish-footer')),
        body: r(body),
        height: innerHeight,
        overflow: document.documentElement.scrollHeight > innerHeight,
      };
    });
    console.log(JSON.stringify({ publishingLayout: layout, scale }));
    check(
      `publishing-${scale}: wizard actions stay visible and only body scrolls`,
      () => {
        assert.ok(layout.footer.bottom <= layout.height + 1);
        assert.ok(layout.footer.height > 35);
        assert.ok(layout.body.bottom <= layout.footer.top + 1);
        assert.equal(layout.overflow, false);
      },
    );
    await shell.getByRole('button', { name: '保存草稿', exact: true }).click();
    await shell.locator('button[data-module="environment"]').click();
    await shell.locator('#sidebar-toggle').click();
    await shell.locator('button[data-module="publish"]').click();
    assert.equal(await shell.locator('#secondary-sidebar').isVisible(), false);
    await shell.locator('#sidebar-toggle').click();
    await shell
      .getByRole('button', { name: '确认生成并执行', exact: true })
      .click();
    await shell
      .locator('.publish-dialog')
      .getByRole('button', { name: '确认生成并执行', exact: true })
      .click();
    await until(async () => {
      const s = await command('state');
      return (
        s.tasks.length === 2 && s.tasks.every((t) => t.status === 'manual')
      );
    }, 'manual review after real CDP upload');
    let tasks = (await command('state')).tasks;
    if (tasks.some((t) => !t.checkpoint.filled))
      console.log(
        JSON.stringify(
          tasks.map((t) => ({
            status: t.status,
            checkpoint: t.checkpoint,
            result: t.result,
          })),
        ),
      );
    const nextDraft = (await command('state')).drafts.find(
      (d) => d.id === 'current',
    );
    assert.equal(nextDraft.data.step, 0);
    assert.equal(nextDraft.data.previewId, null);
    assert.equal(nextDraft.data.input.autoSubmit, false);
    assert.deepEqual(nextDraft.data.input.videoIds, []);
    assert.deepEqual(nextDraft.data.input.accountIds, []);
    assert.deepEqual(nextDraft.data.input.title.values, []);
    assert.deepEqual(nextDraft.data.input.topics.values, []);
    assert.equal(nextDraft.data.input.schedule.mode, 'now');
    assert.deepEqual(nextDraft.data.input.overrides, {});
    check(
      `publishing-${scale}: native CDP file upload and text fill bind exact accounts without auto-submitting`,
      () => {
        assert.equal(new Set(tasks.map((t) => t.accountId)).size, 2);
        assert.ok(
          tasks.every(
            (t) =>
              t.checkpoint.uploaded &&
              t.checkpoint.filled &&
              !t.checkpoint.submitIntent,
          ),
        );
        assert.ok(
          tasks.every(
            (t) => t.title === '第一期测试标题' && t.topics === '#AI #运营',
          ),
        );
      },
    );
    const viewIdentity = await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]
        .contentView.children.filter((v) => v.webContents?.profileId)
        .map((v) => ({ id: v.webContents.profileId, wc: v.webContents.id })),
    );
    await command('tasks', { ids: [tasks[0].id], action: 'takeover' });
    await until(
      () => shell.locator('#browser-view').isVisible(),
      'takeover environment',
    );
    const after = await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]
        .contentView.children.filter((v) => v.webContents?.profileId)
        .map((v) => ({ id: v.webContents.profileId, wc: v.webContents.id })),
    );
    assert.deepEqual(after, viewIdentity);
    await command('tasks', {
      ids: [tasks[0].id],
      action: 'authorize',
      confirmed: true,
    });
    await until(
      async () =>
        (await command('state')).tasks.find((t) => t.id === tasks[0].id)
          .status === 'submitted',
      'authorized submission',
    );
    tasks = (await command('state')).tasks;
    check(
      `publishing-${scale}: explicit authorization submits once; submitted is distinct from published success`,
      () => {
        assert.equal(tasks.filter((t) => t.status === 'submitted').length, 1);
        assert.equal(tasks.filter((t) => t.status === 'manual').length, 1);
        assert.ok(
          tasks.find((t) => t.status === 'submitted').checkpoint.submitIntent,
        );
        assert.equal(
          tasks.find((t) => t.status === 'submitted').autoSubmit,
          false,
        );
      },
    );
    const sent = tasks.find((t) => t.status === 'submitted');
    await assert.rejects(() =>
      command('tasks', { ids: [sent.id], action: 'retry' }),
    );
    const bWcId = viewIdentity.find((v) => v.id === b.id).wc;
    const setScenario = async (html) =>
      app.evaluate(
        async ({ webContents }, { id, html }) =>
          webContents
            .fromId(id)
            .executeJavaScript(
              `document.body.innerHTML=${JSON.stringify(html)}`,
            ),
        { id: bWcId, html },
      );
    await setScenario(
      '<div role="dialog">请完成安全验证</div><button>发布</button>',
    );
    const blocked = await app.evaluate(
      async (_electron, task) => globalThis.__publishingFixture(task),
      {
        ...tasks.find((t) => t.accountId === b.id),
        checkpoint: {},
        autoSubmit: true,
      },
    );
    assert.equal(blocked.result.status, 'manual');
    if (!blocked.result.reason.includes('安全验证'))
      console.log(JSON.stringify({ blocked }));
    assert.ok(blocked.result.reason.includes('安全验证'));
    assert.equal(blocked.checkpoint.submitIntent, undefined);
    assert.equal(blocked.geometry.dpr, blocked.identity.dpr);
    assert.deepEqual(blocked.geometry.screen, blocked.identity.screen);
    assert.ok(
      Math.abs(
        blocked.activeMetrics.width - blocked.activeMetrics.bounds.width,
      ) <= 1,
    );
    assert.ok(
      Math.abs(
        blocked.activeMetrics.height - blocked.activeMetrics.bounds.height,
      ) <= 1,
    );
    assert.deepEqual(blocked.activeMetrics.screen, blocked.identity.screen);
    assert.equal(blocked.activeMetrics.dpr, blocked.identity.dpr);
    await setScenario('<h1>扫码登录</h1>');
    const expired = await app.evaluate(
      async (_electron, task) => globalThis.__publishingFixture(task),
      {
        ...tasks.find((t) => t.accountId === b.id),
        checkpoint: {},
        autoSubmit: true,
      },
    );
    assert.equal(expired.result.status, 'manual');
    assert.ok(expired.result.reason.includes('登录失效'));
    await setScenario(
      '<input type="file" accept="video/mp4"><div>上传完成</div><textarea aria-label="作品描述"></textarea><button>发布</button>',
    );
    const unknownMaterial = await app.evaluate(
      async (_electron, task) => globalThis.__publishingFixture(task),
      {
        ...tasks.find((t) => t.accountId === b.id),
        checkpoint: {},
        autoSubmit: true,
      },
    );
    assert.equal(unknownMaterial.result.status, 'manual');
    assert.ok(unknownMaterial.result.reason.includes('已有视频'));
    check(
      `publishing-${scale}: captcha, expired login and unowned uploaded media pause before any submit`,
      () => assert.equal(unknownMaterial.checkpoint.submitIntent, undefined),
    );
    // Reproduce the reported home route and its exact “作品发布” label.
    await app.evaluate(async ({ webContents }, id) => {
      await webContents
        .fromId(id)
        .loadURL('https://creator.douyin.com/creator-micro/home');
    }, bWcId);
    const runEntry = async (html, handlers, name) => {
      await setScenario(html);
      await app.evaluate(
        async ({ webContents }, { id, handlers }) => {
          await webContents.fromId(id).executeJavaScript(`
          window.entryClicks=0;window.workEntryClicks=0;window.videoEntryClicks=0;window.imageEntryClicks=0;window.entryUploads=0;window.entrySubmits=0;window.entryEvents=[];
          if(!window.entryEventListenersInstalled){['mousemove','mousedown','mouseup','click'].forEach(type=>document.addEventListener(type,event=>window.entryEvents.push({type,target:event.target.id,x:event.clientX,y:event.clientY,trusted:event.isTrusted}),{capture:true}));window.entryEventListenersInstalled=true;}
          window.openVideoForm=()=>{
            document.body.innerHTML='<h1>视频发布</h1><input type="file" accept="video/mp4"><div id="entry-status"></div><textarea aria-label="作品描述" style="display:none"></textarea><button id="entry-submit" disabled>发布</button>';
            document.querySelector('input').onchange=()=>{window.entryUploads++;document.querySelector('#entry-status').textContent='上传完成';document.querySelector('textarea').style.display='block';document.querySelector('#entry-submit').disabled=false;};
            document.querySelector('#entry-submit').onclick=()=>window.entrySubmits++;
          };
          ${handlers};void 0;`);
        },
        { id: bWcId, handlers },
      );
      const result = await app.evaluate(
        async (_electron, task) => globalThis.__publishingFixture(task),
        {
          ...tasks.find((t) => t.accountId === b.id),
          id: name,
          checkpoint: {},
          autoSubmit: false,
        },
      );
      assert.equal(result.result.status, 'manual');
      if (!result.checkpoint.filled)
        throw new Error(
          JSON.stringify({
            entryFailure: name,
            reason: result.result.reason,
            checkpoint: result.checkpoint,
            logs: result.logs,
            html: result.geometry.html.slice(0, 2500),
            bounds: result.bounds,
            metrics: result.activeMetrics,
            events: await app.evaluate(
              async ({ webContents }, id) =>
                webContents.fromId(id).executeJavaScript('window.entryEvents'),
              bWcId,
            ),
          }),
        );
      assert.equal(result.checkpoint.filled, true);
      assert.equal(result.checkpoint.submitIntent, undefined);
      const actions = await app.evaluate(
        async ({ webContents }, id) =>
          webContents
            .fromId(id)
            .executeJavaScript(
              '({clicks:window.entryClicks,images:window.imageEntryClicks,uploads:window.entryUploads,submits:window.entrySubmits,path:location.pathname,events:window.entryEvents,workClicks:window.workEntryClicks,videoClicks:window.videoEntryClicks})',
            ),
        bWcId,
      );
      assert.equal(actions.images, 0);
      assert.equal(actions.uploads, 1);
      assert.equal(actions.submits, 0);
      if (actions.clicks)
        assert.ok(
          actions.events.some((e) => e.type === 'mousemove' && e.trusted),
        );
      return { result, actions };
    };
    for (let iteration = 0; iteration < 3; iteration++) {
      await app.evaluate(
        async ({ webContents }, id) =>
          webContents
            .fromId(id)
            .loadURL('https://creator.douyin.com/creator-micro/home'),
        bWcId,
      );
      const homeEntry = await runEntry(
        '<nav><button id="work-publish"><span>作品发布</span></button></nav>',
        "document.querySelector('#work-publish').onclick=()=>{window.entryClicks++;window.openVideoForm();}",
        'home-entry-fixture',
      );
      assert.equal(homeEntry.actions.clicks, 1);
      assert.equal(homeEntry.actions.path, '/creator-micro/home');
      assert.ok(homeEntry.result.logs.some((log) => log.includes('作品发布')));
    }
    check(
      `publishing-${scale}: reported home-page Works Publish entry opens the upload form in the original environment`,
      () => assert.ok(true),
    );
    const menuEntry = await runEntry(
      '<nav><button id="work-publish"><span>作品发布</span></button><div role="menu" hidden><button role="menuitem" id="menu-video">发布视频</button><button role="menuitem" id="menu-image">发布图文</button></div></nav>',
      "document.querySelector('#work-publish').onmouseenter=()=>{document.querySelector('[role=menu]').hidden=false;};document.querySelector('#work-publish').onclick=()=>{window.entryClicks++;window.workEntryClicks++;document.querySelector('[role=menu]').hidden=false;};document.querySelector('#menu-video').onclick=()=>{window.entryClicks++;window.videoEntryClicks++;window.openVideoForm();};document.querySelector('#menu-image').onclick=()=>window.imageEntryClicks++;",
      'menu-entry-fixture',
    );
    // Native hover may already reveal the menu before the first probe (Windows
    // dispatches it when DOM changes under a stationary pointer). Both routes
    // must select video exactly once and never toggle the menu repeatedly.
    assert.equal(menuEntry.actions.videoClicks, 1);
    assert.ok([0, 1].includes(menuEntry.actions.workClicks));
    assert.equal(menuEntry.actions.clicks, 1 + menuEntry.actions.workClicks);
    check(
      `publishing-${scale}: Works Publish menu selects video only and never clicks image publication or final submit`,
      () => assert.ok(true),
    );
    const duplicateEntry = await runEntry(
      '<header><a class="video-entry" href="/creator-micro/content/upload">发布视频</a></header><main><a class="video-entry" href="/creator-micro/content/upload">发布视频</a></main>',
      "document.querySelectorAll('.video-entry').forEach(e=>e.onclick=event=>{event.preventDefault();window.entryClicks++;window.openVideoForm();});",
      'duplicate-entry-fixture',
    );
    assert.equal(duplicateEntry.actions.clicks, 1);
    assert.ok(
      duplicateEntry.result.logs.some((log) => log.includes('重复入口')),
    );
    check(
      `publishing-${scale}: duplicate controls with the same actual platform upload URL are handled once`,
      () => assert.ok(true),
    );
    const delayedForm = await runEntry(
      '<h1>创作者中心</h1>',
      'setTimeout(window.openVideoForm,600)',
      'delayed-form-fixture',
    );
    assert.equal(delayedForm.actions.clicks, 0);
    check(
      `publishing-${scale}: asynchronous upload form appearing during entry discovery is used without extra navigation`,
      () => assert.ok(true),
    );
    await setScenario(
      '<header><button id="unsafe-submit">发布</button></header><button disabled><span>发布视频</span></button><div style="opacity:0">发布视频</div><a href="https://example.com/upload">发布视频</a>',
    );
    let probe = await app.evaluate(
      async (_electron, id) => globalThis.__publishingEntryProbe(id),
      b.id,
    );
    assert.equal(probe.target, null);
    assert.equal(probe.count, 0);
    await setScenario(
      '<a href="/creator-micro/content/upload?type=video&item=A">发布视频</a><a href="/creator-micro/content/upload?type=video&item=B">发布视频</a>',
    );
    probe = await app.evaluate(
      async (_electron, id) => globalThis.__publishingEntryProbe(id),
      b.id,
    );
    assert.equal(probe.target, null);
    assert.equal(probe.count, 2);
    check(
      `publishing-${scale}: disabled/transparent/external controls and ambiguous URLs never become entry targets`,
      () => assert.ok(true),
    );
    // Creator pages can use an SPA div entry, a short title input and a rich
    // description editor with placeholder/zero-width nodes. Keep this distinct
    // from the original textarea fixture so regressions cannot hide behind it.
    await setScenario(`<h1>作品管理</h1><textarea placeholder="搜索作品"></textarea>
      <div id="video-entry" style="width:120px;height:40px"><span>发布视频</span></div>`);
    await app.evaluate(
      async ({ webContents }, id) =>
        webContents.fromId(id).executeJavaScript(`
      window.setupRich=()=>{
        document.body.innerHTML='<h1>视频发布</h1><input placeholder="填写作品标题" maxlength="30"><textarea placeholder="搜索"></textarea><input type="file" accept=".mov,.mp4"><div id="status">选择视频</div><div id="caption" contenteditable="true" data-placeholder="添加作品简介" style="width:500px;min-height:60px"><span data-slate-placeholder="true" contenteditable="false">添加作品简介</span></div><button id="publish" disabled>发布</button>';
        document.querySelector('input[type=file]').onchange=e=>{
          document.querySelector('#status').textContent='上传中';
          const progress=document.createElement('div');progress.id='upload-progress';progress.setAttribute('role','progressbar');progress.setAttribute('aria-valuenow','10');progress.setAttribute('aria-valuemax','100');document.body.append(progress);
          document.querySelector('#status').textContent='设置封面';
          setTimeout(()=>{progress.remove();document.querySelector('#status').textContent='上传完成';document.querySelector('#publish').disabled=false;window.uploadFinished=true;},800);
        };
        document.querySelector('#caption').addEventListener('input',()=>{
          window.filledBeforeUpload=!window.uploadFinished;
          const editor=document.querySelector('#caption');
          const text=[...editor.childNodes].filter(n=>!n.dataset?.slatePlaceholder).map(n=>n.textContent).join('');
          document.querySelector('[role=listbox]')?.remove();
          const match=text.match(/#([^\\s#]+)$/);
          if(match){
            const list=document.createElement('div');list.setAttribute('role','listbox');
            for(const name of [match[1],'不匹配的热门话题']){
              const option=document.createElement('div');option.setAttribute('role','option');option.textContent='#'+name;
              option.onclick=()=>{window.candidateClicks=(window.candidateClicks||0)+1;};list.append(option);
            }
            document.body.append(list);
          }

          if(!document.querySelector('[data-slate-placeholder]')){
            const hint=document.createElement('span');hint.dataset.slatePlaceholder='true';hint.contentEditable='false';hint.textContent='添加作品简介';document.querySelector('#caption').append(hint);
          }
        });
        document.querySelector('#caption').addEventListener('keydown',event=>{
          if(event.code!=='Space')return;
          const editor=event.currentTarget,list=document.querySelector('[role=listbox]');
          if(!list)return;
          event.preventDefault();
          if(window.simulateSpaceFailure)return;
          const name=list.querySelector('[role=option]').textContent.slice(1);
          window.topicConversions=(window.topicConversions||[]).concat(name);
          list.remove();
          const content=[...editor.childNodes].filter(n=>!n.dataset?.slatePlaceholder).map(n=>n.textContent).join('');
          editor.querySelector('[data-slate-placeholder]')?.remove();
          const walker=document.createTreeWalker(editor,NodeFilter.SHOW_TEXT);const plain=[];while(walker.nextNode())plain.push(walker.currentNode);
          const pending=plain.findLast(n=>n.textContent.endsWith('#'+name));
          if(pending) pending.textContent=pending.textContent.slice(0,-name.length-1);
          const chip=document.createElement('span');chip.contentEditable='false';chip.dataset.topicId=name;chip.textContent='#'+name;editor.append(chip,document.createTextNode('\u200B'));

          const range=document.createRange();range.selectNodeContents(editor);range.collapse(false);getSelection().removeAllRanges();getSelection().addRange(range);
        });
        document.querySelector('#publish').onclick=()=>{window.splitSubmissions=(window.splitSubmissions||0)+1;const n=document.createElement('div');n.setAttribute('role','alert');n.textContent='作品已提交';document.body.append(n);};
      };document.querySelector('#video-entry').onclick=window.setupRich;void 0;
    `),
      bWcId,
    );
    const splitTask = {
      ...tasks.find((t) => t.accountId === b.id),
      id: 'split-editor-fixture',
      checkpoint: {},
      autoSubmit: true,
    };
    const splitResult = await app.evaluate(
      async (_electron, task) => globalThis.__publishingFixture(task),
      splitTask,
    );
    if (splitResult.result.status !== 'submitted')
      console.log(JSON.stringify({ splitResult }));
    check(
      `publishing-${scale}: SPA entry, split title/description, rich placeholder and upload progress work without manual intervention`,
      () => {
        assert.equal(splitResult.result.status, 'submitted');
        assert.equal(splitResult.checkpoint.uploaded, true);
        assert.equal(splitResult.checkpoint.filled, true);
      },
    );
    const splitFields = await app.evaluate(
      async ({ webContents }, id) =>
        webContents
          .fromId(id)
          .executeJavaScript(
            `({title:document.querySelector('input[placeholder]').value,caption:document.querySelector('#caption').innerText,early:window.filledBeforeUpload,count:window.splitSubmissions,search:document.querySelector('textarea').value,topics:window.topicConversions,candidateClicks:window.candidateClicks||0,pending:!!document.querySelector('[role=listbox]')})`,
          ),
      bWcId,
    );
    assert.equal(splitFields.title, splitTask.title);
    assert.deepEqual(splitFields.caption.match(/#[^\s#\u200B]+/g), [
      '#AI',
      '#运营',
    ]);
    assert.equal(splitFields.early, false);
    assert.equal(splitFields.count, 1);
    assert.equal(splitFields.search, '');
    assert.deepEqual(splitFields.topics, ['AI', '运营']);
    assert.equal(splitFields.candidateClicks, 0);
    assert.equal(splitFields.pending, false);
    await app.evaluate(
      async ({ webContents }, id) =>
        webContents
          .fromId(id)
          .executeJavaScript(
            `window.setupRich();document.querySelector('input[placeholder]').remove();window.topicConversions=[];window.splitSubmissions=0;window.uploadFinished=false;void 0;`,
          ),
      bWcId,
    );
    const combinedTask = {
      ...splitTask,
      id: 'combined-editor-fixture',
      checkpoint: {},
      autoSubmit: false,
    };
    const combinedResult = await app.evaluate(
      async (_electron, task) => globalThis.__publishingFixture(task),
      combinedTask,
    );
    check(
      `publishing-${scale}: single description commits topics with Space and retains manual authorization`,
      () => {
        assert.equal(combinedResult.result.status, 'manual');
        assert.ok(combinedResult.result.reason.includes('人工确认模式'));
        assert.equal(combinedResult.checkpoint.filled, true);
        assert.equal(combinedResult.checkpoint.submitIntent, undefined);
      },
    );
    const continued = await app.evaluate(
      async (_electron, task) => globalThis.__publishingFixture(task),
      {
        ...combinedTask,
        checkpoint: {
          ...combinedResult.checkpoint,
          submissionAuthorized: true,
        },
      },
    );
    assert.equal(continued.result.status, 'submitted');
    assert.ok(continued.logs.some((log) => log.includes('未重复填写')));
    const combinedFields = await app.evaluate(
      async ({ webContents }, id) =>
        webContents
          .fromId(id)
          .executeJavaScript(
            `({topics:window.topicConversions,count:window.splitSubmissions,clicks:window.candidateClicks||0,pending:!!document.querySelector('[role=listbox]')})`,
          ),
      bWcId,
    );
    assert.deepEqual(combinedFields.topics, ['AI', '运营']);
    assert.equal(combinedFields.count, 1);
    assert.equal(combinedFields.clicks, 0);
    assert.equal(combinedFields.pending, false);
    await app.evaluate(
      async ({ webContents }, id) =>
        webContents
          .fromId(id)
          .executeJavaScript(
            `window.setupRich();document.querySelector('input[placeholder]').remove();window.simulateSpaceFailure=true;window.splitSubmissions=0;void 0;`,
          ),
      bWcId,
    );
    const pendingResult = await app.evaluate(
      async (_electron, task) => globalThis.__publishingFixture(task),
      {
        ...combinedTask,
        id: 'pending-topic-fixture',
        checkpoint: {},
        autoSubmit: true,
      },
    );
    check(
      `publishing-${scale}: an uncommitted topic popup pauses before submit instead of accepting visible text`,
      () => {
        assert.equal(pendingResult.result.status, 'manual');
        assert.ok(pendingResult.result.reason.includes('候选框尚未收起'));
        assert.equal(pendingResult.checkpoint.submitIntent, undefined);
      },
    );
    await app.evaluate(
      async ({ webContents }, id) =>
        webContents.fromId(id).executeJavaScript(`
      window.sequenceRound=0;window.sequenceUploads=0;window.sequenceSubmissions=0;window.sequenceFiles=[];window.sequenceUnsafeSubmissions=0;
      window.sequenceManagement=()=>{
        document.body.innerHTML='<h1>作品管理</h1><div id="sequence-entry">发布视频</div><div role="alert">发布成功</div>';
        document.querySelector('#sequence-entry').onclick=window.sequenceForm;
      };
      window.sequenceForm=()=>{
        document.body.innerHTML=(window.sequenceRound ? '<aside id="other-task">上一条作品视频处理中<progress aria-label="其他作品处理进度" max="100" value="20"></progress><div role="progressbar" aria-label="其他作品处理进度" aria-valuenow="20" aria-valuemax="100"></div></aside>':'')+
          '<section class="video-upload"><input type="file" accept="video/mp4"><div id="sequence-status"></div><video controls style="width:320px;height:240px"></video></section><textarea placeholder="作品描述"></textarea><button id="sequence-submit" disabled>发布</button>';
        let processingStarted=false;window.finalProcessingActive=false;
        document.querySelector('textarea').oninput=()=>{
          if(window.deferFinalProcessing&&!processingStarted){
            processingStarted=true;window.finalProcessingActive=true;
            const progress=document.createElement('progress');progress.max=100;progress.value=25;progress.setAttribute('aria-label','当前视频转码进度');document.querySelector('.video-upload').append(progress);
            setTimeout(()=>{progress.remove();window.finalProcessingActive=false;document.querySelector('#sequence-submit').disabled=!document.querySelector('textarea').value.trim();},800);
          }
          document.querySelector('#sequence-submit').disabled=!(window.sequenceUploadComplete && document.querySelector('textarea').value.trim()&&!window.finalProcessingActive);
        };
        document.querySelector('input').onchange=event=>{
          window.sequenceUploads++;window.sequenceFiles.push(event.target.files[0].name);window.sequenceUploadComplete=false;
          const progress=document.createElement('progress');progress.max=100;progress.value=10;progress.setAttribute('aria-label','当前视频上传进度');document.querySelector('.video-upload').append(progress);
          const complete=()=>{
            progress.remove();window.sequenceUploadComplete=true;
            document.querySelector('video').src=URL.createObjectURL(event.target.files[0]);
            document.querySelector('#sequence-status').textContent=window.sequenceRound?'':'上传完成';
            document.querySelector('#sequence-submit').disabled=!document.querySelector('textarea').value.trim();
          };
          window.finishSequenceUpload=complete;
          if(!window.holdSequenceUpload)setTimeout(complete,600);
        };
        document.querySelector('#sequence-submit').onclick=()=>{window.sequenceUnsafeSubmissions+=window.finalProcessingActive?1:0;window.sequenceSubmissions++;window.sequenceRound++;window.sequenceManagement();};
      };window.sequenceForm();void 0;
    `),
      bWcId,
    );
    const firstSequential = {
      ...splitTask,
      id: 'sequence-first',
      title: '第一条视频',
      checkpoint: {},
      autoSubmit: true,
    };
    const firstSequentialResult = await app.evaluate(
      async (_electron, task) =>
        globalThis.__publishingFixture(task, { timeoutMs: 8000 }),
      firstSequential,
    );
    assert.equal(firstSequentialResult.result.status, 'submitted');
    const secondSource = path.join(dir, 'second-video.mp4');
    await binary(require('ffmpeg-static'), [
      '-nostdin',
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'color=c=red:s=320x240:r=10',
      '-t',
      '1',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-y',
      secondSource,
    ]);
    const secondImported = await command('import', [secondSource]);
    assert.equal(secondImported.added.length, 1);
    const secondVideo = (await command('state')).videos.find(
      (v) => v.id === secondImported.added[0],
    );
    assert.ok(secondVideo);
    const secondSequential = {
      ...firstSequential,
      id: 'sequence-second',
      video: secondVideo,
      title: '第二条视频',
      checkpoint: {},
    };
    const secondSequentialResult = await app.evaluate(
      async (_electron, task) =>
        globalThis.__publishingFixture(task, { timeoutMs: 8000 }),
      secondSequential,
    );
    if (secondSequentialResult.result.status !== 'submitted')
      console.log(JSON.stringify({ secondSequentialResult }));
    check(
      `publishing-${scale}: consecutive tasks use a playable preview without a completion label or initially enabled publish button`,
      () => {
        assert.equal(secondSequentialResult.result.status, 'submitted');
        assert.equal(secondSequentialResult.checkpoint.filled, true);
        assert.equal(secondSequentialResult.checkpoint.uploaded, true);
      },
    );
    const sequenceStats = await app.evaluate(
      async ({ webContents }, id) =>
        webContents
          .fromId(id)
          .executeJavaScript(
            '({uploads:window.sequenceUploads,submissions:window.sequenceSubmissions,files:window.sequenceFiles})',
          ),
      bWcId,
    );
    assert.deepEqual(sequenceStats, {
      uploads: 2,
      submissions: 2,
      files: [path.basename(source), path.basename(secondSource)],
    });
    await app.evaluate(
      async ({ webContents }, id) =>
        webContents
          .fromId(id)
          .executeJavaScript('window.holdSequenceUpload=true;void 0;'),
      bWcId,
    );
    const resumable = {
      ...secondSequential,
      id: 'sequence-resumed',
      checkpoint: {},
    };
    const pausedSequence = await app.evaluate(
      async (_electron, task) =>
        globalThis.__publishingFixture(task, {
          timeoutMs: 8000,
          pauseOnUpload: true,
        }),
      resumable,
    );
    assert.equal(pausedSequence.result.status, 'paused');
    assert.equal(pausedSequence.checkpoint.uploadStarted, true);
    assert.equal(pausedSequence.checkpoint.uploaded, undefined);
    await app.evaluate(
      async ({ webContents }, id) =>
        webContents
          .fromId(id)
          .executeJavaScript(
            'window.holdSequenceUpload=false;window.finishSequenceUpload();void 0;',
          ),
      bWcId,
    );
    await until(
      () =>
        app.evaluate(
          async ({ webContents }, id) =>
            webContents
              .fromId(id)
              .executeJavaScript(
                'document.querySelector("video").readyState>=2',
              ),
          bWcId,
        ),
      'resumed preview',
    );
    const resumedSequence = await app.evaluate(
      async (_electron, task) =>
        globalThis.__publishingFixture(task, { timeoutMs: 8000 }),
      { ...resumable, checkpoint: pausedSequence.checkpoint },
    );
    check(
      `publishing-${scale}: pause then resume an already playable upload without reselecting its file`,
      () => {
        assert.equal(resumedSequence.result.status, 'submitted');
        assert.equal(resumedSequence.checkpoint.uploaded, true);
      },
    );
    await app.evaluate(
      async ({ webContents }, id) =>
        webContents
          .fromId(id)
          .executeJavaScript('window.deferFinalProcessing=true;void 0;'),
      bWcId,
    );
    const deferredSequence = await app.evaluate(
      async (_electron, task) =>
        globalThis.__publishingFixture(task, { timeoutMs: 8000 }),
      { ...resumable, id: 'sequence-processing', checkpoint: {} },
    );
    const finalSequence = await app.evaluate(
      async ({ webContents }, id) =>
        webContents
          .fromId(id)
          .executeJavaScript(
            '({uploads:window.sequenceUploads,submissions:window.sequenceSubmissions,unsafe:window.sequenceUnsafeSubmissions})',
          ),
      bWcId,
    );
    check(
      `publishing-${scale}: real processing still blocks submit after filling while unrelated progress does not`,
      () => {
        assert.equal(deferredSequence.result.status, 'submitted');
        assert.deepEqual(finalSequence, {
          uploads: 4,
          submissions: 4,
          unsafe: 0,
        });
        assert.ok(
          deferredSequence.logs.some(
            (log) => log.includes('提交前') && log.includes('25/100'),
          ),
        );
      },
    );
    await shell.locator('button[data-module="publish"]').click();
    await shell.locator('[data-publish-page="tasks"]').click();
    await shell.screenshot({ path: path.join(out, `publishing-${scale}.png`) });
    const snapBefore = tasks.map((t) => ({
      id: t.id,
      title: t.title,
      accountId: t.accountId,
    }));
    await app.close();
    app = null;
    shell = await launch();
    const restored = (await command('state')).tasks;
    check(
      `publishing-${scale}: restart retains snapshots and pauses ambiguous submitted results`,
      () => {
        assert.deepEqual(
          restored.map((t) => ({
            id: t.id,
            title: t.title,
            accountId: t.accountId,
          })),
          snapBefore,
        );
        assert.equal(
          restored.find((t) => t.id === sent.id).status,
          'unverified',
        );
        assert.equal(
          restored.find((t) => t.status === 'manual').title,
          '第一期测试标题',
        );
      },
    );
    shell.setDefaultTimeout(15000);
    // A new batch must start empty, while the permanent library remains available.
    await shell.locator('button[data-module="publish"]').click();
    await shell.locator('[data-publish-page="video"]').click();
    assert.equal(
      await shell.locator('.publish-table input:checked').count(),
      0,
    );
    await shell
      .locator('.publish-table input[type="checkbox"]')
      .first()
      .check();
    await shell.getByRole('button', { name: '下一步', exact: true }).click();
    await shell.getByRole('button', { name: '下一步', exact: true }).click();
    for (const box of await shell.locator('.publish-account input').all())
      await box.check();
    await shell.getByRole('button', { name: '下一步', exact: true }).click();
    await shell
      .locator('.publish-control textarea')
      .nth(0)
      .fill('新的计划标题');
    await shell
      .getByLabel('封面方式', { exact: true })
      .selectOption('image')
      .catch(async (error) => {
        console.log(
          JSON.stringify({
            publishingDebug: await shell
              .locator('#publishing-module')
              .innerText(),
          }),
        );
        throw error;
      });
    await shell.getByRole('button', { name: '下一步', exact: true }).click();
    await pause(200);
    assert.ok(
      (await shell.locator('.publish-step.current').innerText()).includes(
        '配置参数',
      ),
    );
    check(
      `publishing-${scale}: empty image cover stays in configuration and never reaches an SQLite bind`,
      () => assert.ok(true),
    );
    const coverFile = path.join(dir, 'cover.jpg');
    fs.copyFileSync(video.thumbnail, coverFile);
    await app.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [file],
      });
    }, coverFile);
    await shell.getByRole('button', { name: '导入封面', exact: true }).click();
    await until(
      () =>
        shell
          .getByLabel('已导入封面', { exact: true })
          .inputValue()
          .then(Boolean),
      'import cover selection',
    );
    await shell.getByLabel('执行方式', { exact: true }).selectOption('at');
    const future = await shell.evaluate(() => {
      const d = new Date(Date.now() + 3600000);
      return new Date(d - d.getTimezoneOffset() * 60000)
        .toISOString()
        .slice(0, 16);
    });
    await shell.getByLabel('计划开始执行时间', { exact: true }).fill(future);
    await shell.getByRole('button', { name: '下一步', exact: true }).click();
    await shell
      .getByRole('button', { name: '确认生成并执行', exact: true })
      .click();
    let confirm = shell.locator('.publish-dialog[open]');
    await confirm.getByLabel('批次名称', { exact: true }).fill('清理测试批次');
    await confirm.getByRole('checkbox').check();
    await confirm
      .getByRole('button', { name: '确认生成并执行', exact: true })
      .click();
    await until(
      () => command('state').then((state) => state.tasks.length === 4),
      'second planned batch',
    );
    const afterBatch = await command('state');
    const blank = afterBatch.drafts.find((d) => d.id === 'current').data;
    assert.deepEqual(blank.input.videoIds, []);
    assert.deepEqual(blank.input.accountIds, []);
    assert.deepEqual(blank.input.title.values, []);
    assert.equal(blank.input.cover.mode, 'first');
    assert.equal(blank.input.schedule.mode, 'now');
    assert.equal(blank.previewId, null);
    assert.equal(
      afterBatch.tasks.filter((t) => t.title === '新的计划标题').length,
      2,
    );
    check(
      `publishing-${scale}: valid local image batch confirms and resets every wizard field without changing snapshots`,
      () => assert.ok(true),
    );
    await shell.locator('[data-publish-page="video"]').click();
    await shell
      .locator('.publish-table input[type="checkbox"]')
      .first()
      .check();
    await shell.getByRole('button', { name: '保存草稿', exact: true }).click();
    await shell
      .getByRole('button', { name: '清空当前草稿', exact: true })
      .click();
    await shell
      .locator('.publish-dialog[open]')
      .getByRole('button', { name: '关闭', exact: true })
      .click();
    assert.equal(
      await shell.locator('.publish-table input:checked').count(),
      1,
    );
    await shell
      .getByRole('button', { name: '清空当前草稿', exact: true })
      .click();
    await shell
      .locator('.publish-dialog[open]')
      .getByRole('button', { name: '确认', exact: true })
      .click();
    await until(
      () =>
        shell
          .locator('.publish-table input:checked')
          .count()
          .then((n) => n === 0),
      'clear draft',
    );
    assert.equal((await command('state')).tasks.length, 4);
    check(
      `publishing-${scale}: cancel preserves draft and explicit clear resets only the unsubmitted wizard`,
      () => assert.ok(true),
    );
    await shell.locator('[data-publish-page="plan"]').click();
    await shell
      .getByPlaceholder('视频、账号、标题或批次搜索')
      .fill('清理测试批次');
    await shell
      .locator('.publish-table tbody tr')
      .first()
      .getByRole('button', { name: '删除记录', exact: true })
      .click();
    await shell
      .locator('.publish-dialog[open]')
      .getByRole('button', { name: '确认', exact: true })
      .click();
    await until(
      () => command('state').then((state) => state.tasks.length === 3),
      'delete planned record',
    );
    await shell.locator('[data-publish-page="tasks"]').click();
    await shell
      .getByPlaceholder('视频、账号、标题或批次搜索')
      .fill('清理测试批次');
    await shell
      .getByRole('button', { name: '全选当前结果', exact: true })
      .click();
    await shell
      .getByRole('button', { name: '删除选中记录', exact: true })
      .click();
    await shell
      .locator('.publish-dialog[open]')
      .getByRole('button', { name: '关闭', exact: true })
      .click();
    assert.equal((await command('state')).tasks.length, 3);
    await shell
      .getByRole('button', { name: '删除选中记录', exact: true })
      .click();
    await shell
      .locator('.publish-dialog[open]')
      .getByRole('button', { name: '确认', exact: true })
      .click();
    await until(
      () => command('state').then((state) => state.tasks.length === 2),
      'delete selected task record',
    ).catch(async (error) => {
      console.log(
        JSON.stringify({
          deleteDebug: await shell.locator('#publishing-module').innerText(),
          dialogs: await shell.locator('.publish-dialog').allTextContents(),
          state: (await command('state')).tasks.map((t) => ({
            id: t.id,
            status: t.status,
            title: t.title,
          })),
        }),
      );
      throw error;
    });
    assert.equal((await command('state')).batches.length, 1);
    assert.ok(fs.existsSync(source));
    assert.ok(fs.existsSync(coverFile));
    await shell.locator('[data-publish-page="history"]').click();
    await shell
      .locator('.publish-table tbody tr')
      .first()
      .getByRole('button', { name: '删除记录', exact: true })
      .click();
    await shell
      .locator('.publish-dialog[open]')
      .getByRole('button', { name: '确认', exact: true })
      .click();
    await shell
      .locator('.publish-dialog[open] .form-error:not([hidden])')
      .waitFor();
    assert.equal((await command('state')).tasks.length, 2);
    await shell
      .locator('.publish-dialog[open]')
      .getByRole('button', { name: '关闭', exact: true })
      .click();
    check(
      `publishing-${scale}: plan/task deletion supports confirmation and preserves unresolved submissions and original files`,
      () => assert.ok(true),
    );
    for (const kind of ['title', 'topics', 'location'])
      await command('resource-add', { kind, lines: ['清理测试资源'] });
    await shell.locator('[data-publish-page="library"]').click();
    for (const kind of ['title', 'topics', 'image', 'location']) {
      await shell.getByLabel('资源类型', { exact: true }).selectOption(kind);
      await until(
        () =>
          shell
            .locator('.publish-table tbody tr')
            .count()
            .then((n) => n > 0),
        'render library ' + kind,
      );
      await shell
        .getByRole('button', { name: '全选当前结果', exact: true })
        .click();
      await shell
        .getByRole('button', { name: '删除选中记录', exact: true })
        .click();
      await shell
        .locator('.publish-dialog[open]')
        .getByRole('button', { name: '确认', exact: true })
        .click();
      await until(
        () =>
          command('state').then((state) =>
            kind === 'image'
              ? !state.covers.length
              : kind === 'location'
                ? !state.locations.length
                : !state.library.some((r) => r.kind === kind),
          ),
        'delete library ' + kind,
      );
    }
    assert.ok(fs.existsSync(coverFile));
    check(
      `publishing-${scale}: title, topic, cover and location records expose and execute bulk deletion without deleting image files`,
      () => assert.ok(true),
    );
    await shell.locator('[data-publish-page="materials"]').click();
    await shell
      .getByRole('button', { name: '删除当前筛选记录', exact: true })
      .click();
    await shell
      .locator('.publish-dialog[open]')
      .getByRole('button', { name: '确认', exact: true })
      .click();
    await until(
      () => command('state').then((state) => !state.videos.length),
      'delete material indices',
    );
    assert.ok(fs.existsSync(source));
    assert.equal((await command('state')).tasks.length, 2);
    await app.close();
    app = null;
    shell = await launch();
    const cleaned = await command('state');
    assert.equal(cleaned.videos.length, 0);
    assert.equal(cleaned.covers.length, 0);
    assert.equal(cleaned.locations.length, 0);
    assert.equal(cleaned.library.length, 0);
    assert.equal(cleaned.tasks.length, 2);
    assert.equal(cleaned.batches.length, 1);
    assert.equal(cleaned.tasks[0].title, '第一期测试标题');
    check(
      `publishing-${scale}: deleted local records stay deleted after restart while account-bound task snapshots remain intact`,
      () => assert.ok(true),
    );
  } finally {
    if (app) await app.close().catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
(async () => {
  const scales = process.argv[2] ? [Number(process.argv[2])] : [1, 1.25, 1.5];
  if (scales.some((scale) => ![1, 1.25, 1.5].includes(scale)))
    throw new Error('Unsupported test scale');
  for (const scale of scales) await run(scale);
  console.log(`${checks} publishing real-window checks passed`);
})().catch((error) => {
  console.error(
    JSON.stringify({
      uiFailure: { message: error.message, stack: error.stack },
    }),
  );
  process.exitCode = 1;
});
