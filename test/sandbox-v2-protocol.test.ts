import assert from 'node:assert/strict';
import { it } from 'node:test';
import { decodeReply, LinxMcpClient } from '../sandbox/platform/mcp.js';
import { createLogger } from '../src/log.js';

it('v2 decoder rejects old text, invalidversion/schema and over16KiB without truncation',()=>{
 for(const invalid of ['对决开始。','{"v":1,"ok":true}',JSON.stringify({v:2,ok:true,phase:'battle',need:'move',events:[],say:'缺失资源'}),JSON.stringify({v:2,ok:true,phase:'idle',need:'none',events:[{t:'hit',by:'enemy',mv:'light',r:'take',dmg:3}],say:'错误归属'}),JSON.stringify({v:2,ok:true,phase:'idle',need:'none',events:[],mode:'coop',say:'错误模式'}),JSON.stringify({v:2,ok:true,phase:'idle',need:'none',events:[],deny:{mv:'ult',short:-1},say:'错误缺口'}),JSON.stringify({v:2,ok:true,phase:'idle',need:'none',events:[],say:'啊'.repeat(6000)})])assert.throws(()=>decodeReply(invalid));
 assert.deepEqual(decodeReply('{"v":2,"ok":true,"silent":true}'),{v:2,ok:true,silent:true});
 const unknown={v:2,ok:false,reason:'unknown',events:[],say:'结果未确认，先核实。'};assert.deepEqual(decodeReply(JSON.stringify(unknown)),unknown);
});
it('wait cancellation forwarded, no second call or substituted game_say',async()=>{
 const original=globalThis.fetch;const requests:any[]=[];const controller=new AbortController();
 globalThis.fetch=async(_url,init)=>{
  requests.push(JSON.parse(String(init?.body)));
  return new Promise<Response>((_resolve,reject)=>{init?.signal?.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError')),{once:true});controller.abort();});
 };
 try{const client=new LinxMcpClient({upstream:'http://mock.invalid',deviceId:'test',agentId:'test',sessionId:'test',timeoutMs:1000,logger:createLogger('error')});await assert.rejects(client.callTool('wait_event',{}, {signal:controller.signal,timeoutMs:35000}));assert.equal(requests.length,1);assert.deepEqual(requests[0].params,{name:'wait_event',arguments:{}});}finally{globalThis.fetch=original;}
});
it('fault metadata cannot make unknown look like an actual no-battle identity',async()=>{
 const original=globalThis.fetch;
 globalThis.fetch=async()=>new Response(JSON.stringify({jsonrpc:'2.0',id:1,result:{isError:true,_meta:{'linx/battleId':null},content:[{type:'text',text:JSON.stringify({v:2,ok:false,reason:'unknown',events:[],say:'结果未确认。'})}]}}),{headers:{'content-type':'application/json'}});
 try{const client=new LinxMcpClient({upstream:'http://mock.invalid',deviceId:'test',agentId:'test',sessionId:'test',timeoutMs:1000,logger:createLogger('error')});const result=await client.callTool('game_say',{text:'强攻'});assert.equal(result.isError,true);assert.equal(result.battleId,undefined);}finally{globalThis.fetch=original;}
});
it('client preserves unknown feedback in an existing battle, and suppresses cancelled or old-battle expression',async()=>{
 const {SandboxClient}=await import('../sandbox/platform/client.js');
 const {SandboxAgent}=await import('../sandbox/platform/agent.js');
 const original=globalThis.fetch;
 let mode:'fault'|'stale'|'cancel'='fault';
 const controller=new AbortController();
 globalThis.fetch=async(url,init)=>{
  if(String(url).includes('/state'))return new Response(JSON.stringify({device:'test',agent:'test',room:null,battle:{battleId:mode==='stale'?'new':'existing'}}),{headers:{'content-type':'application/json'}});
  const request=JSON.parse(String(init?.body));
  if(!('id' in request))return new Response(null,{status:202});
  const result=request.method==='initialize'?{serverInfo:{name:'mock',version:'2'}}:{isError:mode==='fault',_meta:{'linx/battleId':mode==='fault'?null:'old'},content:[{type:'text',text:JSON.stringify(mode==='fault'?{v:2,ok:false,reason:'unknown',events:[],say:'结果未确认，先核实。'}:{v:2,ok:true,phase:'idle',need:'none',events:[],say:'我准备好了。'})}]};
  return new Response(JSON.stringify({jsonrpc:'2.0',id:request.id,result}),{headers:{'content-type':'application/json'}});
 };
 try{
  const client=new SandboxClient({upstream:'http://mock.invalid',agentId:'test',timeoutMs:1000,logger:createLogger('error'),agent:new SandboxAgent('伙伴',{async express(){if(mode==='cancel')controller.abort();return '我准备好了，好期待呀！';}})});
  const fault=await client.say('test','强攻');assert.equal(fault.silent,false);assert.equal(fault.sourceBattleId,undefined);assert.match(fault.reply,/结果未确认/);assert.equal(fault.speech.source,'fallback');assert.equal(fault.speech.segments.map(segment=>segment.text).join(''),fault.reply);
  mode='stale';const stale=await client.say('test','开始');assert.equal(stale.reply,'');assert.equal(stale.silent,true);assert.equal(stale.rewriteStatus,'stale');assert.deepEqual(stale.speech.segments,[]);
  mode='cancel';const cancelled=await client.say('test','开始',{signal:controller.signal});assert.equal(cancelled.reply,'');assert.equal(cancelled.silent,true);assert.equal(cancelled.rewriteStatus,'cancelled');assert.deepEqual(cancelled.speech.segments,[]);
 }finally{globalThis.fetch=original;}
});
