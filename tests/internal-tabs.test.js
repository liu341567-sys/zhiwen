'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { InternalTabs } = require('../src/internal-tabs');
function fixture() {
  const own = {}, children = [], loads = [];
  class Contents extends EventEmitter {
    constructor(session) { super(); this.session = session; this.dead = false; }
    isDestroyed() { return this.dead; }
    close() { this.dead = true; this.emit('destroyed'); }
    loadURL(url, options) { loads.push({url,options}); return Promise.resolve(); }
  }
  class View { constructor(options) { this.options = options; this.webContents = options.webContents || new Contents(options.webPreferences.session); } setVisible() {} setBackgroundColor() {} }
  const manager = new InternalTabs({ window:{isDestroyed:()=>false,contentView:{addChildView:v=>children.push(v),removeChildView:v=>{const i=children.indexOf(v);if(i>=0)children.splice(i,1);}}},WebContentsView:View,sessionFor:()=>own,configure:(wc,id)=>{wc.profileId=id;},changed:()=>{},canActivate:()=>true });
  const opener = new Contents(own), open = (details={},options={}) => {const wc=manager.open('account',opener,{url:'https://example.com/',disposition:'new-window',referrer:{url:'https://source.test/',policy:'strict-origin-when-cross-origin'},...details},options);return{wc,entry:manager.entries.get(wc.pageTabId)};};
  return {manager,own,children,loads,opener,open,Contents};
}
test('adopt the original Chromium guest and never repeat its navigation',()=>{const f=fixture(),guest=new f.Contents(f.own),{wc}=f.open({}, {webContents:guest});assert.equal(wc,guest);assert.equal(f.loads.length,0);assert.equal(f.children.length,1);assert.equal(f.manager.activeId('account'),wc.pageTabId);});
test('deferred guests preserve POST body and HTTP referrer in one navigation',()=>{const f=fixture(),post={contentType:'multipart/form-data',boundary:'test-boundary',data:[{type:'rawData',bytes:Buffer.from('test')}]};f.open({disposition:'background-tab',postBody:post});assert.equal(f.loads.length,1);assert.equal(f.loads[0].options.extraHeaders,'content-type: multipart/form-data; boundary=test-boundary');assert.deepEqual(f.loads[0].options.postData,post.data);assert.equal(f.loads[0].options.httpReferrer.url,'https://source.test/');assert.equal(f.manager.activeId('account'),'account');});
test('an internal page cannot adopt another environment Session',()=>{const f=fixture();assert.throws(()=>f.open({}, {webContents:new f.Contents({})}),/会话/);assert.equal(f.children.length,0);});
test('site features cannot enable privileged capabilities or replace the Session',()=>{const f=fixture(),{entry}=f.open({}, {webPreferences:{nodeIntegration:true,sandbox:false,webSecurity:false,partition:'evil',webviewTag:true}});const p=entry.view.options.webPreferences;assert.equal(p.session,f.own);assert.equal(p.partition,undefined);for(const k of ['nodeIntegration','nodeIntegrationInWorker','nodeIntegrationInSubFrames','webviewTag'])assert.equal(p[k],false);for(const k of ['sandbox','webSecurity','contextIsolation'])assert.equal(p[k],true);});
test('closing the selected child returns to its live opener and retains siblings',()=>{const f=fixture(),a=f.open(),b=f.open();f.manager.select(a.wc.pageTabId,'account');const nested=f.manager.open('account',a.wc,{url:'about:blank',disposition:'new-window'},{});f.manager.close(nested.pageTabId);assert.equal(f.manager.activeId('account'),a.wc.pageTabId);assert(f.manager.entries.has(b.wc.pageTabId));assert.equal(f.loads.length,2);});
test('destroyed/script-closed pages unregister themselves and root is the fallback',()=>{const f=fixture(),{wc}=f.open();wc.close();assert.equal(f.manager.entries.size,0);assert.equal(f.children.length,0);assert.equal(f.manager.activeId('account'),'account');});
test('environment close releases all its child views without changing other environments',()=>{const f=fixture();f.open();f.open();const other=f.manager.open('other',f.opener,{url:'about:blank',disposition:'new-window'},{});f.manager.closeEnvironment('account');assert.equal(f.manager.entries.size,1);assert(f.manager.entries.has(other.pageTabId));assert.throws(()=>f.manager.select(other.pageTabId,'account'));});
