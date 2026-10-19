'use strict';
const path=require('node:path');
const {randomUUID}=require('node:crypto');
const {AnalyticsStore}=require('./store');
const {filters,aggregate,definitions}=require('./model');
const douyin=require('./douyin');
class AnalyticsService {
  static async create(options){const{default:Queue}=await import('p-queue');return new AnalyticsService(options,Queue);}
  constructor({directory,profiles,getView,releaseView=()=>{},reserveAccount=()=>()=>{},isBusy=()=>false,reveal=async()=>{},changed=()=>{},notify=()=>{},now=Date.now,setTimer=setTimeout,clearTimer=clearTimeout,adapters=[douyin]},Queue){
    Object.assign(this,{profiles,getView,releaseView,reserveAccount,isBusy,reveal,changed,notify,now,setTimer,clearTimer});
    this.store=new AnalyticsStore(path.join(directory,'analytics'));this.config=this.store.settings();this.adapters=new Map(adapters.map(a=>[a.id,a]));this.queue=new Queue({concurrency:this.config.concurrency});this.controllers=new Map();this.running=false;this.closed=false;this.scanJob=null;this.nextAt=null;this.timer=null;
  }
  initialize(){if(this.config.enabled && this.config.autoResume)this.start().catch(()=>{});}
  accounts(){return this.profiles().map(p=>({...p,platformId:p.platformId || this.config.platformOverrides[p.id] || null}));}
  selected(p){return this.adapters.has(p.platformId) && (this.config.selectedIds===null || this.config.selectedIds.includes(p.id));}
  update(input){if(this.closed)throw new Error('采集服务已关闭');if(Object.hasOwn(input||{},'enabled'))throw new Error('请使用开始或暂停按钮');const old=this.config.intervalSeconds;this.config=this.store.settings(input);this.queue.concurrency=this.config.concurrency;for(const[id,c]of this.controllers)if(!this.accounts().some(p=>p.id===id && this.selected(p)))c.abort();if(this.running)this.schedule(old!==this.config.intervalSeconds);this.changed();return this.state();}
  select(id,selected){if(typeof selected!=='boolean' || !this.accounts().some(p=>p.id===id && this.adapters.has(p.platformId)))throw new Error('采集账号选择无效');const ids=new Set(this.config.selectedIds===null?this.accounts().filter(p=>this.adapters.has(p.platformId)).map(p=>p.id):this.config.selectedIds);if(selected)ids.add(id);else ids.delete(id);return this.update({selectedIds:[...ids]});}
  assign(id,platformId){const p=this.profiles().find(p=>p.id===id);if(!p || p.platformId || ![null,'douyin'].includes(platformId))throw new Error('只有自定义环境可以单独关联采集平台');const overrides={...this.config.platformOverrides};if(platformId)overrides[id]=platformId;else delete overrides[id];return this.update({platformOverrides:overrides});}
  state(input={}){
    const f=filters(input,this.now()),profiles=this.accounts(),rows=this.store.rows(profiles,f),eligible=rows.filter(r=>r.supported);
    const taskAccounts=this.store.rows(profiles,{...f,status:''});
    const allTasks=this.store.tasks().filter(t=>taskAccounts.some(r=>r.id===t.environmentId) && t.createdAt>=f.start && t.createdAt<=f.end && (!f.status || t.status===f.status));
    return{config:this.config,running:this.running,checking:!!this.scanJob,nextAt:this.nextAt,definitions,filters:f,rows:rows.slice((f.page-1)*f.pageSize,f.page*f.pageSize),total:rows.length,
      accounts:profiles.map(p=>({id:p.id,name:p.name,platformId:p.platformId,supported:this.adapters.has(p.platformId),selected:this.selected(p),custom:!this.profiles().find(raw=>raw.id===p.id)?.platformId})),
      summary:{connected:eligible.length,success:eligible.filter(r=>['success','partial'].includes(r.status)).length,followers:aggregate(eligible,'followers'),works:aggregate(eligible,'works'),likes:aggregate(eligible,'likes'),periodPlays:aggregate(eligible,'periodPlays'),periodLikes:aggregate(eligible,'periodLikes'),growth:eligible.length && eligible.every(r=>r.growth)?eligible.reduce((n,r)=>n+r.growth.value,0):null,lastCollectedAt:Math.max(0,...eligible.map(r=>r.lastSuccessAt||0))||null},
      tasks:allTasks.slice((f.page-1)*f.pageSize,f.page*f.pageSize),taskTotal:allTasks.length,
      capabilities:[...this.adapters.values()].map(a=>({id:a.id,name:a.name,verified:a.verified===true,note:'仅采集官网可见、具有明确标签的累计指标和当前加载的作品；真实登录页面待核对'}))};
  }
  works(input={}){
    const f=filters(input,this.now()),accounts=this.store.rows(this.accounts(),{...f,search:'',status:''}),ids=new Set(accounts.map(r=>r.id));
    const rows=this.store.works().filter(w=>ids.has(w.environmentId) && (!f.search || w.title.toLocaleLowerCase().includes(f.search.toLocaleLowerCase())) && (!f.status || w.status===f.status) && (!w.publishedAt || (w.publishedAt>=f.start && w.publishedAt<=f.end))).map(w=>{
      const metrics={};if(w.checkedAt<=f.end)Object.assign(metrics,w.metrics);else for(const h of this.store.history(w.environmentId,w.id,f.end))Object.assign(metrics,h.metrics);return{...w,name:accounts.find(a=>a.id===w.environmentId)?.name,metrics};
    }).sort((a,b)=>f.sort==='publishedAt'?(b.publishedAt||0)-(a.publishedAt||0):f.sort==='time'?b.checkedAt-a.checkedAt:(b.metrics[f.sort]?.value??-1)-(a.metrics[f.sort]?.value??-1));
    return{rows:rows.slice((f.page-1)*f.pageSize,f.page*f.pageSize),total:rows.length,filters:f};
  }
  detail(id,work=''){
    if(!this.accounts().some(p=>p.id===id) || (work && !/^\d{6,30}$/.test(work)))throw new Error('账号或作品无效');
    const history=this.store.history(id,work),limit=500;
    // Bucket by local observation day; keep last actual observation, no fill.
    const days=new Map();for(const row of history)days.set(new Date(row.at+8*3600000).toISOString().slice(0,10),row);
    return{account:this.store.account(id),history:[...days.values()].slice(-limit),observations:history.length,coverage:'最近 500 个有采集记录的日期；没有记录的日期不补 0',tasks:this.store.tasks().filter(t=>t.environmentId===id).slice(0,20)};
  }
  schedule(reset=false){this.clearTimer(this.timer);this.timer=null;if(!this.running || this.closed){this.nextAt=null;return;}const now=this.now();if(reset || this.nextAt===null)this.nextAt=now+this.config.intervalSeconds*1000;if(this.scanJob && this.nextAt<=now)return;this.timer=this.setTimer(()=>{this.timer=null;if(this.running && !this.scanJob)this.scan({automatic:true}).catch(()=>{});},Math.max(0,this.nextAt-now));this.timer.unref?.();}
  async start(){if(this.running)return this.state();this.running=true;this.config=this.store.settings({enabled:true});this.schedule(true);this.changed();await this.scan();return this.state();}
  async pause({persist=true}={}){this.running=false;this.clearTimer(this.timer);this.timer=null;this.nextAt=null;if(persist)this.config=this.store.settings({enabled:false});for(const c of this.controllers.values())c.abort();this.cycle?.abort();await this.scanJob?.catch(()=>{});this.changed();return this.state();}
  async cancelAccount(id){const c=this.controllers.get(id);if(c){c.userCancelled=true;c.abort();}else this.cancelledIds?.add(id);const job=this.jobs?.get(id);await job?.catch(()=>{});this.releaseView(id);}
  async scan({ids,automatic=false}={}){
    if(this.closed)throw new Error('采集服务已关闭');if(ids!==undefined && (!Array.isArray(ids)||ids.length>1000||ids.some(id=>typeof id!=='string')))throw new Error('采集账号无效');
    if(this.scanJob)return this.scanJob;if(automatic && !this.running)return this.state();
    if(automatic){const now=this.now(),interval=this.config.intervalSeconds*1000;this.nextAt=(this.nextAt??now)+(Math.floor(Math.max(0,now-(this.nextAt??now))/interval)+1)*interval;}
    const profiles=this.accounts().filter(p=>this.adapters.has(p.platformId)&&(ids?ids.includes(p.id):this.selected(p))),controller=this.cycle=new AbortController();this.jobs=new Map();this.cancelledIds=new Set();
    this.scanJob=(async()=>{
      const jobs=profiles.map(p=>{
        const task={id:randomUUID(),environmentId:p.id,platformId:p.platformId,name:p.name,type:'account-and-visible-works',createdAt:this.now(),status:'pending',startedAt:null,endedAt:null,metricCount:0,reason:'',logs:[]};this.store.task(task);
        const job=this.queue.add(()=>this.collect(p,task,controller.signal));this.jobs.set(p.id,job);return job;
      });await Promise.allSettled(jobs);
      if(!controller.signal.aborted)this.notify(`数据采集完成：${profiles.length} 个账号；请在采集任务中查看结果`,'info');
    })().finally(()=>{this.scanJob=null;this.cycle=null;this.jobs.clear();this.schedule();this.changed();});this.schedule();this.changed();await this.scanJob;return this.state();
  }
  async collect(p,task,cycleSignal){
    const local=new AbortController();this.controllers.set(p.id,local);const abort=()=>local.abort();cycleSignal.addEventListener('abort',abort,{once:true});if(cycleSignal.aborted)abort();let release,timer;
    const log=(level,message)=>{task.logs.push({at:this.now(),level,message});this.store.task(task);this.changed();};
    try{
      if(local.signal.aborted || this.cancelledIds?.has(p.id)){task.status='cancelled';task.endedAt=this.now();task.reason='用户已取消采集';this.store.task(task);return;}
      task.status='running';task.startedAt=this.now();log('info','开始采集，使用原环境的独立登录会话');
      // A bounded wait shares the exact same lease pool with messages/publishing.
      const start=Date.now();while(!release){
        if(local.signal.aborted)throw Object.assign(new Error('采集已取消'),{code:'aborted'});
        if(!this.isBusy(p.id))try{release=this.reserveAccount(p.id);}catch{}
        if(release)break;if(Date.now()-start>=15000)throw Object.assign(new Error('账号正在执行发布、巡检或录制，请稍后重试'),{code:'busy'});
        if(task.status!=='busy'){task.status='busy';log('info','等待账号空闲；未改变当前网页');}
        await douyin.deadline(new Promise(r=>setTimeout(r,250)),local.signal,1000);
      }
      task.status='running';timer=setTimeout(()=>local.abort(),65000);const adapter=this.adapters.get(p.platformId),samples=[];
      for(const kind of ['account','home','works']){
        if(!this.accounts().some(current=>current.id===p.id && current.platformId===p.platformId))throw Object.assign(new Error('环境已移除或采集关联已更改'),{code:'closed'});
        if(kind==='home' && ['followers','works','likes'].every(key=>samples[0]?.metrics?.[key]))continue;
        log('info',kind==='account'?'读取官方经营数据页明确标注的账号累计指标':kind==='home'?'补充读取官方首页累计指标':'读取作品管理当前加载页；不进入作品、不翻页、不改筛选');
        let sample;
        try{for(let attempt=0;attempt<2;attempt++){
          try{const wc=await this.getView(p.id,local.signal,{...adapter,launchUrl:kind==='account'?adapter.operation:kind==='home'?adapter.home:adapter.management});sample=await adapter.readPage(wc,local.signal,kind,{now:this.now});break;}
          catch(e){if(local.signal.aborted || !['timeout','load_error'].includes(e.code) || attempt===1)throw e;log('warning','临时加载异常，仅重试一次');}
          finally{this.releaseView(p.id);}
        }}catch(e){if(local.signal.aborted)throw e;sample={status:'failed',metrics:{},works:[],diagnostic:{route:kind,reason:['timeout','load_error','wrong_page','login_required'].includes(e.code)?e.code:'read_error'}};log('warning',`${kind} 页面未读取成功，保留本次其他页面的有效数据`);}
        samples.push(sample);if(['login_required','verification'].includes(sample.status))break;
      }
      if(local.signal.aborted)throw Object.assign(new Error('采集已取消或超时'),{code:'aborted'});
      if(!this.accounts().some(current=>current.id===p.id && current.platformId===p.platformId))return;
      const metrics=Object.assign({},...samples.map(s=>s.metrics||{})),works=samples.flatMap(s=>s.works||[]),manual=samples.some(s=>['login_required','verification'].includes(s.status));
      const status=manual?'manual':['followers','works','likes'].every(key=>metrics[key]) && works.length?'success':Object.keys(metrics).length || works.length?'partial':'failed';
      const reason=manual?'官网要求登录或安全验证，请在原环境完成；未绕过验证':status==='failed'?'未识别到具有明确口径的数据。可使用现有开发者工具录制官方数据页面，核对标签和结构':status==='partial'?'只保存已识别指标；缺失项、当前未加载作品不视为 0':'';
      log(status==='failed'?'warning':'info',reason||'可用数据已读取，保存历史快照');
      this.store.save(p,{metrics,works,status,reason,workCoverage:'visible-page',diagnostic:{schemaVersion:1,platformId:p.platformId,pages:samples.map(s=>s.diagnostic),limit:'不包含 Cookie、令牌、账号输入内容或原始网页全文'}},task,this.now());
    }catch(e){const cancelled=cycleSignal.aborted || local.userCancelled;task.status=cancelled?'cancelled':['busy','login_required','verification'].includes(e.code)?'manual':'failed';task.endedAt=this.now();task.reason=e.code==='aborted'?(cancelled?'用户已取消采集':'采集超时，已释放后台页面'):e.message;task.logs.push({at:this.now(),level:'warning',message:task.reason});if(this.accounts().some(current=>current.id===p.id && current.platformId===p.platformId))this.store.save(p,{status:task.status,reason:task.reason},task,this.now());else this.store.task({...task,status:'cancelled',reason:'环境已移除或采集关联已更改'});}
    finally{clearTimeout(timer);this.releaseView(p.id);release?.();this.controllers.delete(p.id);cycleSignal.removeEventListener('abort',abort);if(local.signal.aborted && !task.endedAt){task.status='cancelled';task.endedAt=this.now();this.store.task(task);}this.changed();}
  }
  async open(id){const p=this.accounts().find(p=>p.id===id),a=this.adapters.get(p?.platformId);if(!a)throw new Error('此平台暂未支持');await this.cancelAccount(id);if(this.isBusy(id))throw new Error('账号正在执行其他任务');await this.reveal(id,a.operation);}
  async shutdown(){if(this.closed)return;await this.pause({persist:false});this.closed=true;this.store.close();}
}
module.exports={AnalyticsService};
