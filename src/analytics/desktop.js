'use strict';
const fs=require('node:fs');
const {app,dialog,ipcMain}=require('electron');
const {AnalyticsService}=require('./service');
const {MessageBrowser}=require('../messages/browser');
const {csv,safeCell}=require('./model');
const {scrub}=require('../developer/data');
function reportRows(service,input){
  const state=service.state({...input,page:1}),all=[];for(let page=1;page<=Math.ceil(state.total/50);page++)all.push(...service.state({...input,page}).rows);
  const f=state.filters,fmt=m=>m?`${m.precision==='rounded'?'约 ':''}${m.value}`:'暂无数据';
  return [
    ['栖页运营数据报表','统计开始（北京时间）',new Date(f.start).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'}),'统计结束（北京时间）',new Date(f.end).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'})],
    ['口径说明','粉丝/作品/获赞为截至统计结束前最后一次可用快照的累计值。粉丝变化为起点前有效快照与期内最后快照之差；不等于平台日统计。作品仅采集当前加载页，未加载作品不视为 0。'],
    ['筛选','平台',f.platformId||'全部','账号',f.ids?.join(' / ')||'全部','搜索',f.search,'状态',f.status||'全部'],
    ['数据类型','环境ID','平台','账号','作品ID/标题','粉丝总数','粉丝变化','累计作品数','累计获赞','播放量','点赞量','评论量','收藏量','分享量','采集状态','采集时间（北京时间）','数据来源/缺失说明'],
    ...all.map(r=>['账号',r.id,r.platformId||'自定义',r.name,'',fmt(r.metrics.followers),r.growth?.value??'暂无数据',fmt(r.metrics.works),fmt(r.metrics.likes),'暂不支持','暂不支持','暂不支持','暂不支持','暂不支持',r.status,r.lastSuccessAt?new Date(r.lastSuccessAt).toISOString():'尚未采集',JSON.stringify({metrics:r.metrics,growth:r.growth,reason:r.reason||null})]),
    ...(()=>{const rows=[],first=service.works({...input,page:1});for(let page=1;page<=Math.ceil(first.total/50);page++)for(const w of service.works({...input,page}).rows)rows.push(['作品',w.environmentId,w.platformId,w.name,`${w.id} / ${w.title}`,'','','','',fmt(w.metrics.plays),fmt(w.metrics.workLikes),fmt(w.metrics.comments),fmt(w.metrics.favorites),fmt(w.metrics.shares),w.status,new Date(w.checkedAt).toISOString(),JSON.stringify({url:w.url,metrics:w.metrics,coverage:'当前加载页；累计指标；发布时间未知时不计入周期新增作品'})]);return rows;})()
  ];
}
async function installAnalytics(options){
  const {window,scheduler,debugging,toast,reveal}=options;
  // Always independent background pages in the SAME original Session. No
  // refresh or navigation of the user's current editor, conversation or tab.
  const browser=new MessageBrowser({...options,inspect:()=>null});
  const service=await AnalyticsService.create({directory:options.directory,profiles:options.profiles,
    getView:(...args)=>browser.acquire(...args),releaseView:id=>browser.release(id),
    isBusy:id=>!scheduler()||scheduler().leased(id)||debugging(id),reserveAccount:id=>{const shared=scheduler();if(!shared)throw new Error('账号调度服务暂不可用');return shared.reserveReadOnly(id);},
    changed:()=>{if(!window.isDestroyed())window.webContents.send('analytics:changed');},notify:toast,reveal});
  ipcMain.handle('analytics:command',async(event,command,input)=>{
    if(window.isDestroyed()||event.sender!==window.webContents||event.senderFrame!==window.webContents.mainFrame)throw new Error('此页面无权访问运营数据');
    switch(command){
      case 'state':return service.state(input);
      case 'works':return service.works(input);
      case 'detail':return service.detail(input?.id,input?.work||'');
      case 'settings':return service.update(input);
      case 'select':return service.select(input?.id,input?.selected);
      case 'platform':return service.assign(input?.id,input?.platformId);
      case 'scan':return service.scan({ids:input?.ids});
      case 'start':return service.start();
      case 'pause':return service.pause();
      case 'cancel':for(const id of input?.ids||[])await service.cancelAccount(id);return service.state();
      case 'open':return service.open(input);
      case 'work-open':{const work=service.store.works().find(w=>w.environmentId===input?.id&&w.id===input?.work);if(!work)throw new Error('作品记录无效');await service.cancelAccount(work.environmentId);if(service.isBusy(work.environmentId))throw new Error('账号正在执行其他任务');await reveal(work.environmentId,work.url);return{opened:true};}
      case 'delete-tasks':if(!Array.isArray(input?.ids)||input.ids.some(id=>typeof id!=='string'))throw new Error('记录选择无效');service.store.deleteTasks(input.ids);service.changed();return service.state();
      case 'export':{
        if(!['csv','xlsx'].includes(input?.format))throw new Error('报表格式无效');const rows=reportRows(service,input.filters);
        const result=await dialog.showSaveDialog(window,{title:'导出当前筛选的运营数据',defaultPath:`Qiye-Analytics-${Date.now()}.${input.format}`,filters:[{name:input.format.toUpperCase(),extensions:[input.format]}]});if(result.canceled||!result.filePath)return{cancelled:true};
        if(input.format==='csv')await fs.promises.writeFile(result.filePath,csv(rows),{mode:0o600});else{const Excel=require('exceljs'),book=new Excel.Workbook(),sheet=book.addWorksheet('运营数据');for(const row of rows)sheet.addRow(row.map(safeCell));sheet.views=[{state:'frozen',ySplit:4}];sheet.columns.forEach(c=>{c.width=24;});await book.xlsx.writeFile(result.filePath);}return{saved:true};
      }
      case 'diagnostic':{
        const row=service.store.account(String(input)),report=scrub({schemaVersion:1,applicationVersion:app.getVersion(),createdAt:Date.now(),purpose:'analytics-page-adapter',platformId:row?.platformId,status:row?.status,reason:row?.reason,diagnostic:row?.diagnostic,credentials:false,inputValues:false});
        const result=await dialog.showSaveDialog(window,{title:'导出数据采集诊断',defaultPath:'Qiye-Analytics-Diagnostic.json',filters:[{name:'JSON',extensions:['json']}]});if(result.canceled||!result.filePath)return{cancelled:true};await fs.promises.writeFile(result.filePath,JSON.stringify(report,null,2),{mode:0o600});return{saved:true};
      }
      case 'backup':{const result=await dialog.showSaveDialog(window,{title:'备份运营数据库',defaultPath:`Qiye-Analytics-${Date.now()}.sqlite`,filters:[{name:'SQLite',extensions:['sqlite']}]});if(result.canceled||!result.filePath)return{cancelled:true};service.store.backup(result.filePath);return{saved:true};}
      default:throw new Error('不支持的数据中心操作');
    }
  });
  service.initialize();const shutdown=service.shutdown.bind(service);service.shutdown=async()=>{try{await shutdown();}finally{browser.shutdown();}};return service;
}
module.exports={installAnalytics,reportRows};
