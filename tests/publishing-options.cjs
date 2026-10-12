'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { _electron } = require('playwright-core'), { ProfileStore } = require('../src/profile-store');
const root = path.resolve(__dirname, '..');
let checks = 0;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn) { for (let i = 0; i < 400; i++) { if (await fn()) return; await pause(50); } throw new Error('Options fixture timed out'); }
const check = (label) => { checks++; console.log('✓ ' + label); };
// Stable public control shapes observed in the user's recording. Fictional
// names/addresses only; route interception prevents any real platform access.
function fixture(account, settings = {}) {
  return `<!doctype html><meta charset="utf-8"><style>
    body{font:14px sans-serif;margin:24px;min-height:700px}button,label{padding:8px;cursor:pointer}input,textarea{padding:8px}
    #poi{width:min(360px,calc(100vw - 64px));min-height:36px;background:#eef4ff;padding:8px}.semi-select-dropdown{background:white;border:1px solid #888;width:min(360px,calc(100vw - 64px))}
    [role=option]{padding:8px;cursor:pointer}.address-demo{font-size:12px;color:#555}
    .semi-datepicker-month-grid{box-sizing:border-box;position:fixed;top:30px;left:18px;width:min(360px,calc(100vw - 36px));background:white;border:1px solid #888;padding:12px;z-index:10}
    #days{display:grid;grid-template-columns:repeat(7,1fr)}.semi-datepicker-day{padding:5px;cursor:pointer;text-align:center}.semi-datepicker-day-disabled{color:#bbb}
    .semi-datepicker-navigation{display:flex;justify-content:space-between}#wheels{display:flex;gap:30px}.semi-scrolllist-list-outer{height:70px;overflow-y:scroll;width:100px}
    ul{margin:0;padding:0;list-style:none}li{height:25px;line-height:25px;cursor:pointer}.semi-scrolllist-item-selected{background:#eef4ff}
  </style><h1>视频发布</h1><input id="upload" type="file" accept="video/mp4"><div id="status"></div><textarea aria-label="作品描述" style="display:none"></textarea>
  <div id="poi" class="semi-select semi-select-single semi-select-filterable semi-select-no-arrow"><span class="semi-select-selection-text">输入地理位置</span></div>
  <div id="candidates" class="semi-select-dropdown"></div>
  <label><input type="checkbox" checked>立即发布</label><label id="schedule"><input type="checkbox">定时发布</label>
  <p>支持2小时后及14天内的定时发布。发布后如需修改时间，可前往作品管理修改</p><input id="datetime" placeholder="日期和时间" style="display:none"><button id="submit" disabled>发布</button>
  <script>
    const config=${JSON.stringify(settings)},account=${JSON.stringify(account)};
    window.submissions=0;window.uploads=0;window.optionClicks=[];document.addEventListener('click',e=>{if(e.target.closest('[data-qiye-option]'))window.optionClicks.push({marker:e.target.closest('[data-qiye-option]').dataset.qiyeOption,trusted:e.isTrusted});});
    const poi=document.querySelector('#poi'),candidates=document.querySelector('#candidates');
    window.refreshCount=0;window.poiChosen=null;
    function candidateRows(query){
      candidates.replaceChildren();if(config.empty)return;
      const rows=[{name:'示例广场',address:account+'市东路1号'},{name:'示例广场',address:account+'市西路2号'}];
      if(++window.refreshCount%2===0)rows.reverse();
      for(const row of rows){const e=document.createElement('div');e.setAttribute('role','option');e.innerHTML='<div class="name-demo"></div><div class="address-demo"></div>';e.firstChild.textContent=row.name;e.lastChild.textContent=row.address;e.onclick=()=>{window.poiChosen=row;poi.querySelector('span').textContent=row.name;poi.querySelector('input')?.remove();candidates.replaceChildren();};candidates.append(e);}
    }
    poi.onclick=()=>{if(poi.querySelector('input'))return;const input=document.createElement('input');poi.append(input);candidateRows('old');input.oninput=()=>{const value=input.value;setTimeout(()=>{if(poi.contains(input)&&input.value===value)candidateRows(value);},config.delay||150);};};
    let now=new Date(Date.now()+8*3600000), date=now.toISOString().slice(0,10), time='12:20', month=now.toISOString().slice(0,7);
    if(config.previousMonth){let d=new Date(month+'-01T00:00:00Z');d.setUTCMonth(d.getUTCMonth()-1);month=d.toISOString().slice(0,7);}
    const field=document.querySelector('#datetime');field.readOnly=!config.directInput;field.onblur=()=>{const m=field.value.match(/^(\\d{4}-\\d{2}-\\d{2})[ T](\\d{2}:\\d{2})$/);if(config.directInput&&m&&!config.rejectInput){date=m[1];time=m[2];}update();};document.querySelector('#schedule').onclick=()=>{field.style.display=document.querySelector('#schedule input').checked?'inline-block':'none';};
    function update(){field.value=config.slashFormat?date.replaceAll('-','/')+' '+time+':00':date+' '+time;const d=document.querySelector('.semi-datepicker-switch-date'),t=document.querySelector('.semi-datepicker-switch-time');if(d)d.textContent=date;if(t)t.textContent=time;}
    function days(){const p=document.querySelector('.semi-datepicker-navigation strong');p.textContent=Number(month.slice(0,4))+'年 '+Number(month.slice(5))+'月';const grid=document.querySelector('#days');grid.replaceChildren();for(let i=1;i<=31;i++){const e=document.createElement('div');e.className='semi-datepicker-day'+(config.disabledDay===i?' semi-datepicker-day-disabled':'');e.textContent=i;e.onclick=()=>{if(!e.classList.contains('semi-datepicker-day-disabled')){date=month+'-'+String(i).padStart(2,'0');update();}};grid.append(e);}}
    function wheel(kind){const w=document.createElement('div');w.className='semi-scrolllist-item-wheel undefined-list-'+kind;w.innerHTML='<div class="semi-scrolllist-list-outer"><ul></ul></div>';const max=kind==='hour'?24:60, current=Number(time.split(':')[kind==='hour'?0:1]);for(let cycle=0;cycle<3;cycle++)for(let i=0;i<max;i++){const e=document.createElement('li');e.textContent=String(i).padStart(2,'0')+(kind==='hour'?'时':'分');if(cycle===1&&i===current)e.className='semi-scrolllist-item-selected';e.onclick=()=>setTimeout(()=>{let values=time.split(':');values[kind==='hour'?0:1]=String(i).padStart(2,'0');time=values.join(':');w.querySelectorAll('li').forEach(li=>li.classList.remove('semi-scrolllist-item-selected'));e.classList.add('semi-scrolllist-item-selected');update();},kind==='minute'?900:50);w.querySelector('ul').append(e);}document.querySelector('#wheels').append(w);w.firstChild.scrollTop=(max+current)*25-22;}
    field.onclick=()=>{if(document.querySelector('.semi-datepicker-month-grid'))return;const p=document.createElement('div');p.className='semi-datepicker-month-grid';p.innerHTML='<div class="semi-datepicker-navigation"><button id="left"><span class="semi-icons-chevron_left">←</span></button><strong></strong><button id="right"><span class="semi-icons-chevron_right">→</span></button></div><div id="days"></div><button class="semi-datepicker-switch-date"></button><button class="semi-datepicker-switch-time"></button><div id="wheels"></div>';document.body.append(p);for(const [id,delta]of[['left',-1],['right',1]])p.querySelector('#'+id).onclick=()=>{const d=new Date(month+'-01T00:00:00Z');d.setUTCMonth(d.getUTCMonth()+delta);month=d.toISOString().slice(0,7);days();};p.querySelector('.semi-datepicker-switch-time').onclick=()=>{if(!document.querySelector('#wheels').children.length){wheel('hour');wheel('minute');}};days();update();};
    document.addEventListener('keydown',e=>{if(e.key==='Escape')document.querySelector('.semi-datepicker-month-grid')?.remove();});
    document.querySelector('#upload').onchange=e=>{window.uploads++;history.replaceState({},'', '/creator-micro/content/post/video');document.querySelector('#status').textContent='上传完成 '+e.target.files[0].name;document.querySelector('textarea').style.display='block';document.querySelector('#submit').disabled=false;};
    document.querySelector('#submit').onclick=()=>{window.submissions++;const e=document.createElement('div');e.setAttribute('role','alert');e.textContent='发布成功';document.body.append(e);};
  </script>`;
}
async function run(scale) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'qiye-native-options-'));let app;
  try {
    const store=new ProfileStore(dir),a=store.create({name:'A',platformId:'douyin'}),b=store.create({name:'B',platformId:'douyin'});
    app=await _electron.launch({chromiumSandbox:true,args:[...(process.platform==='linux'?['--disable-setuid-sandbox']:[]),`--force-device-scale-factor=${scale}`,path.join(root,'tests/electron-launch.cjs')],cwd:root,env:{...process.env,QIYE_DATA_DIR:dir,QIYE_PUBLISH_FIXTURE:'1'}});
    await app.context().route('https://creator.douyin.com/**',r=>r.fulfill({contentType:'text/html; charset=utf-8',body:new URL(r.request().url()).pathname.endsWith('/content/upload')?fixture('B',{directInput:true}):'<h1>fixture</h1>'}));
    let shell;await until(()=>{shell=app.windows().find(p=>p.url().endsWith('/renderer/index.html'));return shell;});
    await shell.waitForFunction(()=>!!window.browserAPI && !!window.publishingAPI);
    const command=(name,value)=>shell.evaluate(({name,value})=>publishingAPI.command(name,value),{name,value});
    const ids={};
    for(const account of[a,b]){await shell.evaluate(id=>browserAPI.openProfile(id),account.id);ids[account.id]=await app.evaluate(({BrowserWindow},id)=>BrowserWindow.getAllWindows()[0].contentView.children.find(v=>v.webContents?.profileId===id).webContents.id,account.id);}
    const evaluate=(account,code)=>app.evaluate(async({webContents},{id,code})=>webContents.fromId(id).executeJavaScript(code),{id:ids[account.id],code});
    const load=async(account,settings={})=>{
      await app.evaluate(async({webContents},{id,html})=>{const wc=webContents.fromId(id);await wc.loadURL('https://creator.douyin.com/creator-micro/content/post/video');await wc.executeJavaScript('document.open();document.write('+JSON.stringify(html)+');document.close();void 0;');},{id:ids[account.id],html:fixture(account.name,settings)});
    };
    const runOptions=(account,input)=>app.evaluate(async(_electron,{id,input})=>globalThis.__publishingOptionsFixture(id,input),{id:account.id,input});
    const expected={at:new Date(Date.now()+3*86400000+8*3600000).toISOString().slice(0,10)+'T12:21',timezone:'Asia/Shanghai'};
    await shell.locator('button[data-module="publish"]').click();
    await until(()=>app.evaluate(({BrowserWindow},id)=>!BrowserWindow.getAllWindows()[0].contentView.children.find(v=>v.webContents?.profileId===id).getVisible(),b.id));
    await load(b,{previousMonth:true});
    let result=await runOptions(b,{nativeSchedule:expected,location:{mode:'specified',label:'示例广场',address:'B市东路1号',query:'广场'}});
    assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.state.fieldValue,expected.at.replace('T',' '));assert.equal(result.state.date, '');assert.equal(result.location.address,'B市东路1号');
    const clicks=await evaluate(b,'window.optionClicks');assert.ok(clicks.length>=7);assert.ok(clicks.every(c=>c.trusted));
    assert.equal(await evaluate(b,'window.submissions'),0);
    check(`options-${scale}: native month/day/hour/minute controls wait for delayed minute model update and read exact official time; POI survives candidate reordering`);
    await load(a);await load(b);
    for(const account of[a,b]){
      const candidates=await command('location-search',{accountId:account.id,query:'广场',requestId:require('node:crypto').randomUUID()});
      assert.ok(candidates.candidates.every(c=>c.address.startsWith(account.name)));
      const chosen=await command('location-select',{accountId:account.id,query:'广场',label:'示例广场',address:account.name+'市西路2号',requestId:require('node:crypto').randomUUID()});
      assert.equal(chosen.selected.address,account.name+'市西路2号');assert.equal((await evaluate(account,'window.poiChosen')).address,chosen.selected.address);
    }
    check(`options-${scale}: live official candidates and final UI selection are bound to original account IDs and full addresses`);
    await load(b);result=await runOptions(b,{location:{mode:'specified',label:'示例广场',query:'广场'}});
    assert.equal(result.ok,false);assert.match(result.reason,/未唯一匹配/);assert.equal(await evaluate(b,'window.poiChosen'),null);
    check(`options-${scale}: same-name POI ambiguity never selects the first row`);
    await load(b);result=await runOptions(b,{location:{mode:'specified',label:'示例广场',query:'广场',address:'B市东路1号'},intervene:true});
    assert.equal(result.ok,false);assert.match(result.reason,/位置发生变化/);
    check(`options-${scale}: manual POI intervention invalidates pre-submit address verification`);
    await load(b);const near={at:new Date(Date.now()+3600000+8*3600000).toISOString().slice(0,16),timezone:'Asia/Shanghai'};
    result=await runOptions(b,{nativeSchedule:near});assert.equal(result.ok,false);assert.match(result.reason,/超出此账号范围/);assert.equal(await evaluate(b,'window.submissions'),0);
    await load(b,{disabledDay:Number(expected.at.slice(8,10))});result=await runOptions(b,{nativeSchedule:expected});assert.equal(result.ok,false);assert.match(result.reason,/日期被平台禁用/);
    check(`options-${scale}: current account scheduling range and disabled date stop before submission`);
    await load(b);
    const videoPath=path.join(dir,'fixture.mp4');await require('../src/publishing/media').run(require('ffmpeg-static'),['-nostdin','-v','error','-f','lavfi','-i','color=c=blue:s=320x240:r=10','-t','1','-c:v','libx264','-pix_fmt','yuv420p','-y',videoPath]);const stat=fs.statSync(videoPath);
    const task={id:'native-'+scale,accountId:b.id,accountName:'B',platformId:'douyin',video:{name:'fixture.mp4',path:videoPath,format:'mp4',bytes:stat.size,mtime:stat.mtimeMs,sha256:require('node:crypto').createHash('sha256').update(fs.readFileSync(videoPath)).digest('hex')},title:'Fixture title',topics:'#Topic',cover:{mode:'first'},location:{mode:'specified',label:'示例广场',address:'B市西路2号',query:'广场'},nativeSchedule:expected,autoSubmit:true,checkpoint:{manualOptionsConfirmed:true}};
    result=await app.evaluate(async(_electron,task)=>globalThis.__publishingFixture(task,{timeoutMs:60000,captureMode:'pending'}),task);
    assert.equal(result.result.status,'submitted',JSON.stringify(result));assert.equal(result.checkpoint.submitIntent,true);assert.deepEqual(result.result.nativeSchedule,expected);assert.equal(result.result.location.address,'B市西路2号');assert.equal(await evaluate(b,'window.submissions'),1);
    assert.ok(result.logs.some(s=>s.includes('官方定时已设置并回读')));
    check(`options-${scale}: hidden original browser completes upload-caption-POI-native schedule-submit despite pending frame capture and reports submitted rather than online`);
    await load(b,{delay:4000});const requestId=require('node:crypto').randomUUID();
    const pending=command('location-search',{accountId:b.id,query:'广场',requestId}).then(()=>({ok:true}),e=>({error:e.message}));
    await until(()=>evaluate(b,'!!document.querySelector("[data-qiye-poi-input]")'));
    await command('location-cancel',{accountId:b.id,requestId});assert.match((await pending).error,/暂停/);
    const released=await app.evaluate(async({webContents},id)=>webContents.fromId(id).executeJavaScriptInIsolatedWorld(2002,[{code:'({watch:!!globalThis.__qiyePOIWatch,guard:!!globalThis.__qiyePOIGuard,markers:document.querySelectorAll("[data-qiye-option],[data-qiye-poi-root],[data-qiye-poi-input]").length})'}]),ids[b.id]);
    assert.deepEqual(released,{watch:false,guard:false,markers:0});
    await load(b);assert.equal((await command('location-search',{accountId:b.id,query:'广场',requestId:require('node:crypto').randomUUID()})).candidates.length,2);
    check(`options-${scale}: canceled searches release account lease, markers, listeners and observer before another search`);
    await evaluate(b,"history.replaceState({},'', '/creator-micro/content/manage');void 0;");
    await assert.rejects(command('location-search',{accountId:b.id,query:'广场',requestId:require('node:crypto').randomUUID()}),/视频编辑页/);
    assert.equal(await evaluate(b,'location.pathname'),'/creator-micro/content/manage');
    check(`options-${scale}: candidate queries never navigate, upload placeholder videos or create another account browser`);
    await load(b,{directInput:true,slashFormat:true});
    result=await runOptions(b,{nativeSchedule:expected});assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.state.fieldTime,expected.at.replace('T',' '));
    assert.ok(result.logs.some(s=>s.includes('已输入并回读')));
    await load(b,{directInput:true,rejectInput:true});result=await runOptions(b,{nativeSchedule:expected});assert.equal(result.ok,true,JSON.stringify(result));assert.ok(result.logs.some(s=>s.includes('改用日历')));
    check(`options-${scale}: recorded editable time input commits on blur, formatted seconds normalize, and rejected input uses verified calendar fallback`);
    await load(b);
    await command('location-search',{accountId:b.id,query:'广场',requestId:require('node:crypto').randomUUID()});
    const cachedCount=await evaluate(b,'window.refreshCount');
    assert.equal((await command('location-search',{accountId:b.id,query:'广场',requestId:require('node:crypto').randomUUID()})).candidates.length,2);
    assert.equal(await evaluate(b,'window.refreshCount'),cachedCount);
    check(`options-${scale}: identical current official query uses stable displayed candidates without requiring another DOM mutation`);
    const goHome=()=>app.evaluate(async({webContents},id)=>{const wc=webContents.fromId(id);await wc.loadURL('https://creator.douyin.com/creator-micro/home');await wc.executeJavaScript("document.body.innerHTML='<nav><button>作品发布</button></nav>';document.querySelector('button').onclick=()=>location.assign('https://creator.douyin.com/creator-micro/content/upload');void 0;");},ids[b.id]);
    const imported=await command('import',[videoPath]);assert.equal(imported.added.length,1);const preparedVideo=(await command('state')).videos.find(v=>v.id===imported.added[0]);
    await goHome();
    await shell.locator('.publish-table input[type="checkbox"]').first().check();
    await shell.getByRole('button',{name:'下一步',exact:true}).click();await shell.getByRole('button',{name:'下一步',exact:true}).click();
    await shell.locator('.publish-account').filter({hasText:'B'}).locator('input').check();
    await shell.getByRole('button',{name:'下一步',exact:true}).click();
    await shell.locator('.publish-control textarea').nth(0).fill('Real wizard schedule');await shell.locator('.publish-control textarea').nth(1).fill('#Topic');
    await shell.getByLabel('发布定位',{exact:true}).selectOption('specified');await shell.getByLabel('官方位置搜索词（留空使用名称）',{exact:true}).fill('广场');
    await shell.getByRole('button',{name:'上传所选视频并读取地点',exact:true}).click();
    await shell.getByRole('button',{name:'示例广场 · B市东路1号',exact:true}).waitFor({timeout:45000});
    assert.equal(await evaluate(b,'window.uploads'),1);assert.equal(await evaluate(b,'window.submissions'),0);
    await shell.getByRole('button',{name:'示例广场 · B市东路1号',exact:true}).click();
    await until(()=>shell.getByLabel('完整地点地址（同名地点须填写）',{exact:true}).inputValue().then(v=>v==='B市东路1号'));
    await shell.getByLabel('官方发布方式',{exact:true}).selectOption('at');await shell.getByLabel('官方发布时间（北京时间）',{exact:true}).fill(expected.at);
    await shell.getByRole('button',{name:'下一步',exact:true}).click();await shell.getByRole('button',{name:'确认生成并执行',exact:true}).click();
    await shell.locator('.publish-dialog[open]').getByRole('button',{name:'确认生成并执行',exact:true}).click();
    await until(async()=>{const tasks=(await command('state')).tasks;return tasks.length===1&&tasks[0].status==='manual';});
    const created=(await command('state')).tasks[0];assert.equal(created.checkpoint.preparedMediaReused,true,JSON.stringify(created));assert.equal(created.checkpoint.nativeScheduleVerified.at,expected.at);assert.equal(created.nativeSchedule.at,expected.at);assert.equal(await evaluate(b,'window.uploads'),1);assert.equal(await evaluate(b,'window.submissions'),0);
    await command('tasks',{ids:[created.id],action:'cancel'});
    check(`options-${scale}: real wizard prepares homepage account, displays official candidates, persists schedule and reuses exact upload while keeping submission review`);
    await assert.rejects(command('location-search',{accountId:b.id,query:'广场',prepareVideoId:preparedVideo.id,requestId:require('node:crypto').randomUUID()}),/未覆盖/);
    assert.equal(await evaluate(b,'window.uploads'),1);assert.equal(await evaluate(b,'window.submissions'),0);
    check(`options-${scale}: explicit query preparation refuses to overwrite an existing manual or task-owned editor`);
    await goHome();await command('location-search',{accountId:b.id,query:'广场',prepareVideoId:preparedVideo.id,requestId:require('node:crypto').randomUUID()});
    await evaluate(b,"document.querySelector('#upload').dispatchEvent(new Event('change',{bubbles:true}));void 0;");
    result=await app.evaluate(async(_electron,task)=>globalThis.__publishingFixture(task,{timeoutMs:20000}),{...task,id:'changed-preparation-'+scale,video:preparedVideo,checkpoint:{},autoSubmit:false});
    assert.equal(result.result.status,'manual');assert.match(result.result.reason,/无法证明/);assert.equal(result.checkpoint.preparedMediaReused,undefined);
    check(`options-${scale}: changed prepared file cannot transfer ownership to a task`);
    const secondPath=path.join(dir,'second.mp4');await require('../src/publishing/media').run(require('ffmpeg-static'),['-nostdin','-v','error','-f','lavfi','-i','color=c=red:s=320x240:r=10','-t','1','-c:v','libx264','-pix_fmt','yuv420p','-y',secondPath]);
    const secondImport=await command('import',[secondPath]),secondVideo=(await command('state')).videos.find(v=>v.id===secondImport.added[0]);
    await goHome();await command('location-search',{accountId:b.id,query:'广场',prepareVideoId:preparedVideo.id,requestId:require('node:crypto').randomUUID()});
    result=await app.evaluate(async(_electron,task)=>globalThis.__publishingFixture(task,{timeoutMs:30000}),{...task,id:'different-preparation-'+scale,video:secondVideo,checkpoint:{},autoSubmit:false});
    assert.equal(result.result.status,'manual',JSON.stringify(result));assert.equal(result.checkpoint.filled,true);assert.equal(result.checkpoint.preparedMediaReused,undefined);assert.ok(result.logs.some(s=>s.includes('已打开空白上传页')));
    assert.equal(await evaluate(b,"document.querySelector('#upload').files[0].name"),'second.mp4');assert.equal(await evaluate(b,'window.submissions'),0);
    check(`options-${scale}: a different assigned video replaces only verified untouched query preparation through a fresh upload page`);
  }finally{if(app)await app.close().catch(()=>{});fs.rmSync(dir,{recursive:true,force:true});}
}
(async()=>{for(const scale of[1,1.25,1.5])await run(scale);console.log(`${checks} publishing options real-window checks passed`);})().catch(error=>{console.error(JSON.stringify({uiFailure:{message:error.message,stack:error.stack}}));process.exitCode=1;});
