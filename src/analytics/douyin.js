'use strict';
const { metric } = require('./model');
const home = 'https://creator.douyin.com/creator-micro/home';
const management = 'https://creator.douyin.com/creator-micro/content/manage';
const operation = 'https://creator.douyin.com/creator-micro/data-center/operation';
function allowed(raw) { try { const u = new URL(raw); return u.origin === 'https://creator.douyin.com' && [new URL(home).pathname,new URL(management).pathname,new URL(operation).pathname].includes(u.pathname) && !u.search && !u.hash && !u.username && !u.password; } catch { return false; } }
// Runs in an isolated world. Read visible, explicitly labelled page content;
// never inspect cookies, storage, tokens, input values or private APIs.
function observe() {
  const visible = el => { const r=el.getBoundingClientRect(), s=getComputedStyle(el); return r.width>0 && r.height>0 && s.visibility!=='hidden' && s.display!=='none'; };
  const text = el => (el?.innerText || '').trim().replace(/\s+/g,' ');
  const number = /^\d[\d,，]*(?:\.\d+)?\s*(?:万|亿|[wWkK])?$/;
  const labels = { followers:['粉丝总数','粉丝总量','总粉丝数'], works:['作品总数','总作品数'], likes:['获赞总数','总获赞'] };
  const operation=location.pathname==='/creator-micro/data-center/operation';
  if(operation)Object.assign(labels,{periodPlays:['播放量'],periodLikes:['点赞量'],periodComments:['评论量'],periodFavorites:['收藏量'],periodShares:['分享量']});
  const nodes = [...document.querySelectorAll('span,div,p,strong,dt,dd,th,td')].filter(visible).slice(0,18000);
  const login = [...document.querySelectorAll('button,[role="button"],h1,h2')].filter(visible).some(n=>/^(扫码登录|手机号登录|登录抖音|请先登录|登录后查看)$/.test(text(n)));
  const verification = nodes.some(n=>/^(请完成安全验证|请完成验证|拖动滑块完成验证)$/.test(text(n)));
  if(login || verification)return {status:login?'login_required':'verification',metrics:{},works:[],diagnostic:{route:location.pathname,labels:[],headers:[]}};
  // Only an explicitly displayed absolute date range can define period data.
  // Relative presets such as “近7天” alone do not establish inclusion of today.
  const ranges=[...new Set(nodes.map(text).filter(t=>t.length<80).map(t=>t.match(/(20\d{2})[./-](\d{1,2})[./-](\d{1,2})\s*(?:至|到|~|—|–|-)\s*(20\d{2})[./-](\d{1,2})[./-](\d{1,2})/)).filter(Boolean).map(m=>`${m[1]}-${m[2].padStart(2,'0')}-${m[3].padStart(2,'0')}|${m[4]}-${m[5].padStart(2,'0')}-${m[6].padStart(2,'0')}`))];
  const period=ranges.length===1?{start:Date.parse(ranges[0].split('|')[0]+'T00:00:00+08:00'),end:Date.parse(ranges[0].split('|')[1]+'T23:59:59.999+08:00'),timezone:'Asia/Shanghai'}:null;
  const metrics={}, matched=[], ambiguous=[];
  for(const [key,names] of Object.entries(labels)) {
    const candidates=[];
    for(const el of nodes.filter(n=>names.includes(text(n)))) {
      // Smallest labelled block containing exactly one numeric leaf. Never
      // read an entire dashboard and guess which of its numbers belongs here.
      let parent=el.parentElement;
      for(let depth=0;parent && depth<3;depth++,parent=parent.parentElement) {
        if(text(parent).length>100)break;
        const nums=[...parent.querySelectorAll('span,div,p,strong,dd')].filter(visible).filter(n=>number.test(text(n)) && ![...n.children].some(c=>number.test(text(c))));
        if(nums.length===1){candidates.push(text(nums[0]));break;}
      }
    }
    const distinct=[...new Set(candidates)]; if(distinct.length===1 && (!key.startsWith('period') || period)){metrics[key]=distinct[0];matched.push(key);}else if(distinct.length>1)ambiguous.push(key);
  }
  const workLabels={plays:['播放量','播放'],workLikes:['点赞量','点赞'],comments:['评论量','评论'],favorites:['收藏量','收藏'],shares:['分享量','分享']};
  const works=[], seen=new Set(), headerFacts=[];
  const workId=raw=>{try{const u=new URL(raw,location.href);if(u.protocol!=='https:' || !['creator.douyin.com','www.douyin.com','douyin.com'].includes(u.hostname))return null;const id=u.pathname.match(/^\/video\/(\d{6,30})\/?$/)?.[1] || (u.hostname==='creator.douyin.com' && u.pathname.startsWith('/creator-micro/content/') ? u.searchParams.get('item_id') : null);return /^\d{6,30}$/.test(id || '')?id:null;}catch{return null;}};
  const date=raw=>{const m=String(raw).match(/(20\d{2})[年/.-](\d{1,2})[月/.-](\d{1,2})(?:[日 ]\s*(\d{1,2}):(\d{2}))?/);if(!m)return null;const n=Date.parse(`${m[1]}-${m[2].padStart(2,'0')}-${m[3].padStart(2,'0')}T${(m[4]||'00').padStart(2,'0')}:${m[5]||'00'}:00+08:00`);return Number.isFinite(n)?n:null;};
  const add=(row,cols,headers)=>{
    const links=[...row.querySelectorAll('a[href]')].filter(visible), ids=[...new Set(links.map(a=>workId(a.href)).filter(Boolean))];
    if(ids.length!==1 || seen.has(ids[0]))return;
    const link=links.find(a=>workId(a.href)===ids[0]), title=(text(link)||link.getAttribute('aria-label')||'').slice(0,500);
    if(!title)return;
    const values={};
    if(headers)for(const [key,names]of Object.entries(workLabels)){const index=headers.findIndex(h=>names.includes(h));if(index>=0 && cols[index] && number.test(text(cols[index])))values[key]=text(cols[index]);}
    if(!headers)for(const el of [...row.querySelectorAll('span,div,p')].filter(visible))for(const[key,names]of Object.entries(workLabels))if(names.includes(text(el))){const p=el.parentElement;if(text(p).length<50){const nums=[...p.children].filter(n=>number.test(text(n)));if(nums.length===1)values[key]=text(nums[0]);}}
    // Dates embedded in a title, an update time or an unrelated cell are not
    // evidence of publication. Require the official publication column/label.
    const dateColumn=headers?.findIndex(h=>['发布时间','作品发布时间'].includes(h));
    let publishedAt=dateColumn>=0 && cols[dateColumn]?date(text(cols[dateColumn])):null;
    if(!publishedAt)for(const el of [...row.querySelectorAll('span,p,time')].filter(visible)){
      const t=text(el);if(t.length<60 && /^(?:发布时间|发布于)\s*[:：]?\s*20\d{2}/.test(t)){publishedAt=date(t);break;}
    }
    seen.add(ids[0]);works.push({id:ids[0],title,metrics:values,publishedAt});
  };
  for(const table of [...document.querySelectorAll('table,[role="table"],[role="grid"]')].filter(visible)) {
    const headers=[...table.querySelectorAll('thead th,[role="columnheader"]')].map(text);
    headerFacts.push(...headers.filter(h=>Object.values(workLabels).some(v=>v.includes(h))));
    for(const row of [...table.querySelectorAll('tbody tr,[role="row"]')].filter(visible))add(row,[...row.querySelectorAll('td,[role="cell"],[role="gridcell"]')],headers);
  }
  for(const link of [...document.querySelectorAll('a[href]')].filter(visible))if(workId(link.href)){
    let row=link.closest('article,li,[role="listitem"],[data-item-id]');
    if(!row){row=link.parentElement;for(let i=0;row && i<3;i++,row=row.parentElement){if(text(row).length>1500)break;if(Object.values(workLabels).some(names=>names.some(n=>text(row).includes(n))))break;}}
    if(row && text(row).length<=2000)add(row,[],null);
  }
  return {status:'observed',metrics,period,works:works.slice(0,500),workCoverage:'visible-page',diagnostic:{route:location.pathname,labels:matched,ambiguous,period,headers:[...new Set(headerFacts)].slice(0,10),identifiedWorks:works.length,ready:document.readyState,locator:'exact-metric-label / table-column-header / official-work-link',iframes:document.querySelectorAll('iframe').length}};
}
async function deadline(promise,signal,ms) {
  let timer,abort;
  try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Object.assign(new Error('官方数据页面读取超时'),{code:'timeout'})),ms);abort=()=>reject(Object.assign(new Error('采集已取消'),{code:'aborted'}));signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();})]);}
  finally{clearTimeout(timer);signal.removeEventListener('abort',abort);}
}
async function readPage(wc,signal,kind,{timeoutMs=8000,now=Date.now}={}) {
  const expected=kind==='account'?operation:kind==='home'?home:management,start=Date.now();let sample;
  do {
    if(signal.aborted)throw Object.assign(new Error('采集已取消'),{code:'aborted'});
    if(wc.isDestroyed() || wc.getURL()!==expected)throw Object.assign(new Error('官方页面已跳转，未读取其他页面'),{code:'wrong_page'});
    sample=await deadline(wc.executeJavaScriptInIsolatedWorld(3103,[{code:`(${observe.toString()})()`}]),signal,Math.min(3000,timeoutMs));
    if(['login_required','verification'].includes(sample.status))return sample;
    if(kind!=='works'?Object.keys(sample.metrics || {}).length:sample.works?.length)break;
    if(Date.now()-start<timeoutMs)await deadline(new Promise(r=>setTimeout(r,250)),signal,1000);
  }while(Date.now()-start<timeoutMs);
  if(wc.getURL()!==expected)throw Object.assign(new Error('读取期间页面发生变化'),{code:'wrong_page'});
  const at=now(),normalize=values=>Object.fromEntries(Object.entries(values || {}).map(([key,raw])=>[key,metric(key,raw,expected,at,key.startsWith('period')?sample.period:'lifetime')]).filter(([,v])=>v));
  return {...sample,metrics:normalize(sample.metrics),works:(sample.works || []).map(w=>({...w,metrics:normalize(w.metrics)}))};
}
module.exports={id:'douyin',name:'抖音',verified:false,home,management,operation,launchUrl:operation,allowed,observe,readPage,deadline};
