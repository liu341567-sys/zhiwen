'use strict';
// Exercise the shipped workbench and real native input against fictional pages
// in the original isolated account views. No request reaches a real platform.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { _electron } = require('playwright-core');
const { ProfileStore } = require('../src/profile-store');
const { run: binary } = require('../src/publishing/media');
const root = path.resolve(__dirname, '..');
const out = path.join(root, 'test-results', 'ui');
fs.mkdirSync(out, { recursive: true });
let checks = 0;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn, label, milliseconds = 30000) {
  const end = Date.now() + milliseconds;
  while (Date.now() < end) {
    if (await fn()) return;
    await pause(75);
  }
  throw new Error('Workbench fixture timed out: ' + label);
}
function check(scale, message, fn = () => {}) {
  fn();
  checks++;
  console.log(`✓ workbench-${scale}: ${message}`);
}
function fixture(challenge = false) {
  if (challenge)
    return '<!doctype html><meta charset="utf-8"><div role="dialog">请完成安全验证</div>';
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    body{font:15px sans-serif;margin:24px}input,textarea,button{padding:8px}#form{display:none}
    #description{min-height:70px;border:1px solid #999;padding:10px;width:380px}
    #poi{width:340px;min-height:36px;padding:8px;background:#eef4ff}.semi-select-selection-text{display:block;padding:8px;cursor:pointer}
    [role=option],.tag-fixture{padding:8px;cursor:pointer;background:white;border:1px solid #ddd}.address-demo{font-size:12px;color:#555}
  </style></head><body><h1>视频发布</h1><input id="upload" type="file" accept="video/mp4"><div id="status"></div>
  <section id="form"><input id="title" aria-label="填写作品标题" maxlength="1000">
  <div id="description" contenteditable="true" role="textbox" aria-label="作品简介"></div>
  <div id="poi" class="semi-select semi-select-single semi-select-filterable semi-select-no-arrow"><span class="semi-select-selection-text">输入地理位置</span></div>
  <div id="candidates" class="semi-select-dropdown"></div><div id="topics" class="mention-suggest-mount-dom" style="display:none"></div><button id="publish">发布</button></section>
  <script>
  const read=(name)=>JSON.parse(sessionStorage.getItem('fixture:'+name)||'[]');
  const append=(name,row)=>{const rows=read(name);rows.push(row);sessionStorage.setItem('fixture:'+name,JSON.stringify(rows));};
  const upload=document.querySelector('#upload'),title=document.querySelector('#title'),description=document.querySelector('#description'),poi=document.querySelector('#poi'),candidates=document.querySelector('#candidates');
  window.fixtureMetrics=()=>({uploads:read('uploads'),inputs:read('inputs'),submissions:read('submissions'),topicSelections:read('topicSelections'),title:title.value,topics:description.textContent,selected:window.fixtureChosen||null,file:upload.files[0]?.name||null});
  upload.onchange=e=>{append('uploads',{name:e.target.files[0].name,trusted:e.isTrusted});history.replaceState({},'','/creator-micro/content/post/video');document.querySelector('#status').textContent='上传完成 '+e.target.files[0].name;document.querySelector('#form').style.display='block';};
  for(const field of[title,description])field.addEventListener('input',e=>append('inputs',{field:field.id,trusted:e.isTrusted}));
  const topicList=document.querySelector('#topics');
  window.fixtureRenderTopics=()=>{topicList.replaceChildren();const current=description.textContent;if(!/#待选[^\\s#]*$/.test(current)){topicList.style.display='none';return;}topicList.style.display='block';const suggest=document.createElement('div');suggest.className='mention-suggest-fixture';suggest.innerHTML='<div><div></div></div>';const list=suggest.firstChild.firstChild;topicList.append(suggest);if(window.fixtureAriaTopics)list.setAttribute('role','listbox');for(const label of['#待选甲','#待选乙']){const item=document.createElement('div');item.className='tag-fixture tag-hash-fixture';item.innerHTML='<div><span class="tag-hash-view-tag-fixture">#</span><span class="tag-hash-view-name-fixture"></span></div><span class="tag-hash-view-count-fixture">123次播放</span>';item.querySelector('.tag-hash-view-name-fixture').textContent=label.slice(1);if(window.fixtureAriaTopics)item.setAttribute('role','option');item.onclick=e=>{append('topicSelections',{label,trusted:e.isTrusted});const prefix=description.textContent.replace(/#待选[^\\s#]*$/,'');description.replaceChildren(document.createTextNode(prefix));const chip=document.createElement('span');chip.contentEditable='false';chip.className='mention-tag';chip.textContent=label;description.append(chip,document.createTextNode(' '));topicList.replaceChildren();topicList.style.display='none';description.dispatchEvent(new Event('input',{bubbles:true}));};list.append(item);}};
  description.addEventListener('input',()=>window.fixtureRenderTopics());
  description.addEventListener('keydown',e=>{if(e.key===' '){topicList.style.display='none';topicList.replaceChildren();}});
  let generation=0;
  function candidatesFor(query){
    candidates.replaceChildren();
    if(!query)return;
    const rows=[{name:'示例广场',address:'示例市东路1号'},{name:'示例广场',address:'示例市西路2号'}];
    if(++generation%2===0)rows.reverse();
    for(const row of rows){const item=document.createElement('div');item.setAttribute('role','option');const name=document.createElement('div'),address=document.createElement('div');name.className='name-demo';address.className='address-demo';name.textContent=row.name;address.textContent=row.address;item.append(name,address);item.onclick=e=>{window.fixtureChosen={...row,trusted:e.isTrusted};poi.querySelector('span').textContent=row.name;poi.querySelector('input')?.remove();candidates.replaceChildren();};candidates.append(item);}
  }
  poi.onclick=e=>{if(poi.querySelector('input'))return;const field=document.createElement('input');poi.append(field);field.oninput=()=>{const query=field.value;candidates.setAttribute('aria-busy','true');setTimeout(()=>{if(poi.contains(field)&&field.value===query){candidatesFor(query);candidates.setAttribute('aria-busy','false');}},150);};};
  document.querySelector('#publish').onclick=e=>{append('submissions',{file:upload.files[0]?.name||null,title:title.value,topics:description.textContent,location:window.fixtureChosen||null,trusted:e.isTrusted});const alert=document.createElement('div');alert.setAttribute('role','alert');alert.textContent='发布成功';document.body.append(alert);};
  </script></body></html>`;
}

async function run(scale) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qiye-workbench-'));
  let app, shell;
  try {
    const sources = [];
    for (const [index, color] of ['blue', 'green'].entries()) {
      const source = path.join(dir, `workbench-${index + 1}.mp4`);
      await binary(require('ffmpeg-static'), ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', `color=c=${color}:s=320x240:r=10`, '-t', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', source]);
      sources.push(source);
    }
    const profiles = new ProfileStore(dir);
    const accounts = ['抖音测试账号 A', '抖音测试账号 B', '抖音测试账号 C', '抖音测试账号 D'].map((name) => profiles.create({ name, platformId: 'douyin' }));
    profiles.touchUrl(accounts[2].id, 'https://creator.douyin.com/creator-micro/home?challenge=1');
    const launch = async () => {
      app = await _electron.launch({ chromiumSandbox: true, args: [...(process.platform === 'linux' ? ['--disable-setuid-sandbox'] : []), `--force-device-scale-factor=${scale}`, path.join(root, 'tests/electron-launch.cjs')], cwd: root, env: { ...process.env, QIYE_DATA_DIR: dir, QIYE_PUBLISH_FIXTURE: '1' } });
      await app.context().route('https://creator.douyin.com/**', async (route) => {
        const headers = await route.request().allHeaders();
        const challenge = new URL(route.request().url()).searchParams.has('challenge') || (headers.cookie || '').includes('fictionalChallenge=1');
        return route.fulfill({ contentType: 'text/html; charset=utf-8', body: fixture(challenge) });
      });
      await until(() => { shell = app.windows().find((window) => window.url().endsWith('/renderer/index.html')); return shell; }, 'manager shell');
      await shell.waitForFunction(() => !!window.publishingAPI && !!document.querySelector('[data-module="publish"]'));
      await until(() => shell.evaluate(() => publishingAPI.command('state').then(() => true).catch(() => false)), 'publishing service');
      await app.evaluate(({ BrowserWindow, screen }) => {
        const window = BrowserWindow.getAllWindows()[0], area = screen.getDisplayMatching(window.getBounds()).workArea, frame = window.getBounds(), size = window.getContentSize();
        window.setMinimumSize(0, 0);
        window.setContentSize(Math.min(1100, area.width - frame.width + size[0]), Math.min(700, area.height - frame.height + size[1]));
      });
      await shell.locator('button[data-module="publish"]').click();
      await shell.locator('[data-workbench]').waitFor();
    };
    const command = (name, value) => shell.evaluate(({ name, value }) => publishingAPI.command(name, value), { name, value });
    const views = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].contentView.children.filter((view) => view.webContents?.profileId).map((view) => ({ accountId: view.webContents.profileId, id: view.webContents.id, bounds: view.getBounds(), visible: view.getVisible() })));
    const metrics = (accountId) => app.evaluate(async ({ BrowserWindow }, id) => {
      const wc = BrowserWindow.getAllWindows()[0].contentView.children.find((view) => view.webContents?.profileId === id)?.webContents;
      if (!wc) return null;
      return wc.executeJavaScript('window.fixtureMetrics?.() || null');
    }, accountId);
    await launch();

    const baseEntries = accounts.slice(0, 2).map((account, index) => ({
      id: `entry-${index + 1}`, accountId: account.id, videoId: '',
      title: `账号 ${index + 1} 草稿标题`, topics: '', locked: false,
    }));
    await command('workbench-sync', { name: '原账号网页联动回归', entries: baseEntries, activeEntryId: baseEntries[0].id });
    await until(() => shell.locator(`[data-wb-account="${accounts[0].id}"]`).count().then((count) => count > 0), 'account rail');
    await app.close();
    app = null;
    await launch();
    let state = await command('state');
    assert.deepEqual(state.workbench.entries.map(({ id, accountId, videoId, title }) => ({ id, accountId, videoId, title })), baseEntries.map(({ id, accountId, videoId, title }) => ({ id, accountId, videoId, title })));
    check(scale, 'incomplete account forms restore from the local database after restart');

    const select = (index) => shell.locator(`[data-wb-account="${accounts[index].id}"]`).click();
    const importFor = async (index, source) => {
      await select(index);
      // Stub only the native file chooser response. Importing, metadata checks,
      // original-page upload and trusted keyboard/pointer input stay real.
      await app.evaluate(({ dialog }, source) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [source] }); }, source);
      await shell.locator('[data-wb-action="import-videos"]').click();
      await until(async () => (await metrics(accounts[index].id))?.uploads.length === 1, `immediate native upload ${index + 1}`);
      await until(async () => {
        const row = (await command('state')).workbench.entries.find((entry) => entry.id === baseEntries[index].id);
        return row?.live?.phase === 'ready' && row.live.verifiedRevision === row.live.revision;
      }, `verified original account ${index + 1}`);
    };
    await importFor(0, sources[0]);
    assert.equal((await metrics(accounts[0].id)).submissions.length, 0);
    assert.equal((await metrics(accounts[0].id)).file, path.basename(sources[0]));
    assert.equal((await metrics(accounts[0].id)).title, baseEntries[0].title);
    check(scale, 'choosing a local video uploads and fills the existing official page before any formal confirmation');
    await importFor(1, sources[1]);
    const identity = await views();
    assert.equal(new Set(identity.map((view) => view.accountId)).size, 2);
    assert.ok(identity.every((view) => view.bounds.width > 0 && view.bounds.height > 0 && !view.visible));
    check(scale, 'two cold isolated accounts retain distinct original webContents and native video files');

    await select(0);
    const titleField = shell.locator('[data-wb-field="title"]');
    await titleField.fill('账号 A 单独保留的标题');
    await titleField.evaluate((element) => { window.__workbenchTypingNode = element; element.setSelectionRange(5, 5); });
    await until(async () => (await metrics(accounts[0].id)).title === '账号 A 单独保留的标题', 'debounced live title');
    await pause(2500);
    assert.equal(await titleField.evaluate((element) => element === window.__workbenchTypingNode && document.activeElement === element && element.selectionStart === 5), true);
    await shell.locator('[data-wb-field="locked"]').check();
    check(scale, 'debounced typing updates the real official title without replacing the focused form node or caret');

    await shell.locator('[data-wb-action="batch-fill"]').click();
    const bulk = shell.locator('.pwb-dialog[open]');
    await bulk.locator('[data-wb-bulk="title"]').fill('批量复用标题');
    await bulk.locator('[data-wb-bulk="topics"]').fill('#AI #运营');
    await bulk.locator('[data-wb-action="apply-bulk"]').click();
    await until(async () => {
      const s = await command('state');
      return s.workbench.entries[1].title === '批量复用标题' && s.workbench.entries[1].live.phase === 'ready';
    }, 'batch fill verified');
    const aAfterBulk = await metrics(accounts[0].id), bAfterBulk = await metrics(accounts[1].id);
    assert.equal(aAfterBulk.title, '账号 A 单独保留的标题');
    assert.equal(bAfterBulk.title, '批量复用标题');
    assert.equal(bAfterBulk.topics.trim(), '#AI #运营');
    assert.equal(aAfterBulk.uploads.length, 1);
    assert.equal(bAfterBulk.uploads.length, 1);
    assert.equal(aAfterBulk.submissions.length + bAfterBulk.submissions.length, 0);
    check(scale, 'batch fill preserves locked account content while synchronizing unlocked accounts without reuploading');

    await select(0);
    await shell.locator('[data-wb-field="topics"]').fill('#待选');
    let live;
    await until(async () => {
      live = (await command('state')).workbench.entries[0].live;
      return live.candidates?.length === 2;
    }, 'mirrored official topic candidates');
    const stale = { id: baseEntries[0].id, candidateId: live.candidates[0].id, revision: live.candidateRevision };
    await app.evaluate(async ({ BrowserWindow }, id) => {
      const wc = BrowserWindow.getAllWindows()[0].contentView.children.find((view) => view.webContents?.profileId === id).webContents;
      await wc.executeJavaScript('window.fixtureRenderTopics();const list=document.querySelector("#topics .mention-suggest-fixture > div > div");list.append(list.firstElementChild);void 0;');
    }, accounts[0].id);
    await assert.rejects(() => command('workbench-pick', stale));
    assert.equal((await metrics(accounts[0].id)).topicSelections.length, 0);
    await until(async () => {
      live = (await command('state')).workbench.entries[0].live;
      return live.candidates?.some((row) => row.label === '#待选乙') && live.candidateRevision !== stale.revision;
    }, 'refreshed official candidate revision');
    const candidate = live.candidates.find((row) => row.label === '#待选乙');
    await shell.locator(`[data-wb-candidate="${candidate.id}"]`).click();
    await until(async () => (await command('state')).workbench.entries[0].live.phase === 'ready', 'native official candidate pick');
    const picked = await metrics(accounts[0].id);
    assert.equal(picked.topicSelections.length, 1);
    assert.equal(picked.topicSelections[0].label, '#待选乙');
    assert.equal(picked.topicSelections[0].trusted, true);
    assert.equal((await metrics(accounts[1].id)).topicSelections.length, 0);
    check(scale, 'official candidates are mirrored and selected in the right account; replaced stale candidates never click a different row');

    await select(1);
    await app.evaluate(async ({ BrowserWindow }, id) => {
      const wc = BrowserWindow.getAllWindows()[0].contentView.children.find((view) => view.webContents?.profileId === id).webContents;
      await wc.executeJavaScript('window.fixtureAriaTopics=true;void 0;');
    }, accounts[1].id);
    await shell.locator('[data-wb-field="topics"]').fill('#待选');
    await until(async () => {
      live = (await command('state')).workbench.entries[1].live;
      return live.candidates?.length === 2;
    }, 'ARIA alternative candidate list');
    await command('workbench-pick', { id: baseEntries[1].id, candidateId: live.candidates.find((row) => row.label === '#待选甲').id, revision: live.candidateRevision });
    await until(async () => (await command('state')).workbench.entries[1].live.phase === 'ready', 'ARIA alternative native selection');
    assert.equal((await metrics(accounts[1].id)).topicSelections[0].label, '#待选甲');
    assert.equal((await metrics(accounts[1].id)).topicSelections[0].trusted, true);
    check(scale, 'the alternative ARIA topic popup also commits a real chip and trailing space in its own official page');

    const layout = await shell.evaluate(() => {
      const r = (element) => { const rect = element.getBoundingClientRect(); return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right, height: rect.height }; };
      const workbench = document.querySelector('[data-workbench]');
      return { height: innerHeight, width: innerWidth, workbench: r(workbench), publish: r(document.querySelector('[data-wb-action="publish"]')), overflow: document.documentElement.scrollHeight > innerHeight + 1 };
    });
    console.log(JSON.stringify({ publishingWorkbenchLayout: layout, scale }));
    assert.equal(layout.overflow, false);
    assert.ok(layout.publish.top >= 0 && layout.publish.bottom <= layout.height + 1);
    assert.ok(layout.publish.right <= layout.width + 1);
    check(scale, 'account forms fit the window with a visible stable formal-publish action at Windows display scaling');

    const narrowLayout = await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0], size = window.getContentSize();
      window.setContentSize(Math.min(size[0], 900), size[1]);
      return size;
    });
    await pause(200);
    const narrow = await shell.evaluate(() => {
      const body = document.querySelector('.pwb-form-body'), button = document.querySelector('[data-wb-action="publish"]');
      const before = button.getBoundingClientRect();
      body.scrollTop = body.scrollHeight;
      const after = button.getBoundingClientRect();
      return { height: innerHeight, width: innerWidth, top: after.top, bottom: after.bottom, left: after.left, right: after.right, moved: Math.abs(after.top - before.top) > 1, documentOverflow: document.documentElement.scrollHeight > innerHeight + 1 };
    });
    assert.equal(narrow.moved, false);
    assert.equal(narrow.documentOverflow, false);
    assert.ok(narrow.top >= 0 && narrow.bottom <= narrow.height + 1 && narrow.right <= narrow.width + 1);
    await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(...size), narrowLayout);
    check(scale, 'narrow windows scroll only the form body and retain the same fixed final-publish control');

    state = await command('state');
    const expected = state.workbench.entries.map(({ accountId, title, topics }) => ({ accountId, title, topics }));
    const before = await Promise.all(accounts.slice(0, 2).map((account) => metrics(account.id)));
    await shell.locator('[data-wb-action="publish"]').click();
    await shell.locator('.pwb-dialog[open] [data-wb-action="confirm-publish"]').click();
    await until(async () => {
      const s = await command('state');
      return s.tasks.length === 2 && s.tasks.every((task) => task.status === 'submitted');
    }, 'formal publish on original prepared account pages');
    const after = await Promise.all(accounts.slice(0, 2).map((account) => metrics(account.id)));
    for (let index = 0; index < after.length; index++) {
      assert.equal(after[index].uploads.length, before[index].uploads.length);
      assert.equal(after[index].inputs.length, before[index].inputs.length);
      assert.equal(after[index].submissions.length, 1);
      assert.equal(after[index].submissions[0].trusted, true);
      assert.equal(after[index].submissions[0].title, expected[index].title);
      assert.equal(after[index].submissions[0].topics.trim(), expected[index].topics.trim());
      assert.equal(after[index].submissions[0].file, path.basename(sources[index]));
    }
    const afterViews = await views();
    const identities = (items) => items.map(({ accountId, id }) => ({ accountId, id })).sort((left, right) => left.accountId.localeCompare(right.accountId));
    assert.deepEqual(identities(afterViews), identities(identity));
    const finalTasks = (await command('state')).tasks;
    assert.ok(finalTasks.every((task) => task.checkpoint.submitIntent));
    for (const task of finalTasks) {
      const row = expected.find((entry) => entry.accountId === task.accountId);
      assert.equal(task.title, row.title);
      assert.equal(task.topics, row.topics);
    }
    check(scale, 'formal confirmation clicks each existing native Publish exactly once without uploading, filling or recreating an environment');

    const receiptCount = after.reduce((sum, row) => sum + row.submissions.length, 0);
    try { await command('workbench-publish', { confirmed: true }); } catch { /* Already submitted batches may reject a second confirmation. */ }
    await pause(700);
    assert.equal((await Promise.all(accounts.slice(0, 2).map((account) => metrics(account.id)))).reduce((sum, row) => sum + row.submissions.length, 0), receiptCount);
    const submittedTask = (await command('state')).tasks[0];
    await assert.rejects(() => command('tasks', { ids: [submittedTask.id], action: 'retry' }));
    check(scale, 'repeated confirmation and generic task retry cannot duplicate a submitted workbench publication');

    await command('workbench-new', { confirmed: true });
    state = await command('state');
    const nextEntries = accounts.slice(2).map((account, index) => ({
      id: `exception-${index + 1}`, accountId: account.id, videoId: finalTasks.find(task => task.accountId === accounts[index].id).videoId,
      title: `异常隔离标题 ${index + 1}`, topics: '#正常话题 ', locked: false,
    }));
    await shell.evaluate((id) => browserAPI.openProfile(id), accounts[2].id);
    await app.evaluate(async ({ BrowserWindow }, id) => {
      const wc = BrowserWindow.getAllWindows()[0].contentView.children.find((view) => view.webContents?.profileId === id).webContents;
      // A fictional, non-authentication fixture switch scoped to this exact
      // isolated Session keeps a challenge present across navigation attempts.
      await wc.session.cookies.set({ url: 'https://creator.douyin.com', name: 'fictionalChallenge', value: '1' });
    }, accounts[2].id);
    await shell.locator('button[data-module="publish"]').click();
    await command('workbench-sync', { name: '异常账号隔离', entries: nextEntries, activeEntryId: nextEntries[0].id });
    const previousSnapshots = (await command('state')).tasks;
    assert.deepEqual(previousSnapshots.map(({ id, accountId, title, topics, video }) => ({ id, accountId, title, topics, video })), finalTasks.map(({ id, accountId, title, topics, video }) => ({ id, accountId, title, topics, video })));
    await until(async () => {
      const entries = (await command('state')).workbench.entries;
      return entries[0].live.phase === 'manual' && entries[1].live.phase === 'ready';
    }, 'one manual account while the other prepares');
    await shell.locator(`[data-wb-account="${accounts[2].id}"]`).click();
    await shell.locator('[data-wb-manual]').waitFor();
    assert.equal((await metrics(accounts[3].id)).submissions.length, 0);
    check(scale, 'a platform security challenge opens the manual panel only for that account while another account finishes live preparation');
    await command('workbench-publish', { confirmed: true, entryIds: [nextEntries[1].id] });
    await until(async () => (await metrics(accounts[3].id))?.submissions.length === 1, 'healthy account proceeds despite independent challenge');
    const unaffected = (await command('state')).workbench.entries.find((entry) => entry.id === nextEntries[0].id);
    assert.equal(unaffected.live.phase, 'manual');
    assert.equal(await metrics(accounts[2].id), null);
    assert.equal((await metrics(accounts[3].id)).uploads.length, 1);
    check(scale, 'formal publication of a verified account does not submit or overwrite the account awaiting manual verification');

    await shell.screenshot({ path: path.join(out, `publishing-workbench-${scale}.png`) });
  } finally {
    if (app) await app.close().catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
(async () => {
  const scales = process.argv[2] ? [Number(process.argv[2])] : [1, 1.25, 1.5];
  if (scales.some((scale) => ![1, 1.25, 1.5].includes(scale))) throw new Error('Unsupported workbench test scale');
  for (const scale of scales) await run(scale);
  console.log(`${checks} publishing workbench real-window checks passed`);
})().catch((error) => {
  console.error(JSON.stringify({ uiFailure: { message: error.message, stack: error.stack } }));
  process.exitCode = 1;
});
