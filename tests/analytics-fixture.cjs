'use strict';
// Native test pages only. Uses official origins in two original, isolated
// Electron Sessions; never included in application packaging.
const {session,dialog}=require('electron');
const {AnalyticsService}=require('../src/analytics/service');
const adapter=require('../src/analytics/douyin'),read=adapter.readPage;
adapter.readPage=(wc,signal,kind,options)=>read(wc,signal,kind,{...options,timeoutMs:600});
const fs=require('node:fs'),path=require('node:path');
globalThis.__analyticsFixture={samples:{},requests:[],service:null,exportFile:null};
const from=session.fromPartition.bind(session),registered=new WeakSet();
session.fromPartition=(...args)=>{const own=from(...args);if(!registered.has(own)){registered.add(own);const id=args[0].replace('persist:account-','');own.protocol.handle('https',request=>{
  const u=new URL(request.url),f=globalThis.__analyticsFixture,value=f.samples[id]??100;f.requests.push({id,path:u.pathname,method:request.method});
  if(u.hostname!=='creator.douyin.com')return new Response('',{status:404});
  if(u.pathname==='/creator-micro/editing')return new Response('<!doctype html><title>Original draft</title><input id="draft" value="unchanged"><script>window.token=crypto.randomUUID();window.ready=true;</script>',{headers:{'content-type':'text/html'}});
  let body=value==='login'?'<button>扫码登录</button>':value==='empty'?'<h1>数据加载中</h1>':u.pathname.endsWith('/content/manage')?
    `<table><thead><tr><th>作品</th><th>播放量</th><th>点赞量</th><th>评论量</th><th>收藏量</th><th>分享量</th></tr></thead><tbody><tr><td><a href="https://www.douyin.com/video/12345678901234">相同标题作品</a><span>2026-10-18 09:00</span></td><td>${value*10}</td><td>0</td><td>3</td><td>2</td><td>1</td></tr><tr><td><a href="https://www.douyin.com/video/22345678901234">相同标题作品</a></td><td>88</td><td>4</td><td>1</td><td>0</td><td>0</td></tr></tbody></table>`:
    `<h1>账号数据</h1><section><div><span>粉丝总数</span><strong>${value}</strong></div><div><span>作品总数</span><strong>2</strong></div><div><span>获赞总数</span><strong>500</strong></div></section>`;
  if(value==='ambiguous')body='<div><span>粉丝总数</span><strong>100</strong></div><div><span>粉丝总数</span><strong>200</strong></div>';
  if(value==='period')body='<p>2026.10.10 - 2026.10.16</p><div><span>播放量</span><strong>1234</strong></div>';
  if(value==='relative')body='<p>近7天</p><div><span>播放量</span><strong>999</strong></div>';
  return new Response(`<!doctype html><meta charset="utf-8"><title>Analytics fixture</title>${body}<div hidden>token=DO_NOT_EXPORT</div><input type="password" value="DO_NOT_EXPORT"><script>window.ready=true;</script>`,{headers:{'content-type':'text/html'}});
});}return own;};
const create=AnalyticsService.create;AnalyticsService.create=async function(...args){const s=await create.apply(this,args);globalThis.__analyticsFixture.service=s;return s;};
const save=dialog.showSaveDialog.bind(dialog);dialog.showSaveDialog=async(...args)=>{const f=globalThis.__analyticsFixture;if(f.exportFile){const destination=f.exportFile;f.exportFile=null;fs.mkdirSync(path.dirname(destination),{recursive:true});return{canceled:false,filePath:destination};}return save(...args);};
