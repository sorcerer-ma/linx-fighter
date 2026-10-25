import assert from 'node:assert/strict';
import { it } from 'node:test';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { installTtsBridge } from '../sandbox/tts-bridge.js';
import { loadSandboxConfig } from '../sandbox/config.js';

async function bridge(enabled:boolean, upstream:typeof fetch, run:(url:string)=>Promise<void>){
 const app=express();app.use(express.json());installTtsBridge(app,enabled,upstream);
 const server=app.listen(0,'127.0.0.1');await new Promise<void>(r=>server.on('listening',r));
 try{await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/speech/tts`);}
 finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
}
const post=(url:string,body:object)=>fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
it('桥接显式开启、固定loopback且只发送text/emotion，不转发认证或任意URL',async()=>{
 assert.equal(loadSandboxConfig({}).ttsBridge,false);assert.equal(loadSandboxConfig({SANDBOX_TTS_BRIDGE:'local'}).ttsBridge,true);
 let calls=0;
 await bridge(true,async(input,init)=>{
  calls++;assert.equal(input,'http://127.0.0.1:18391/api/speech/tts');assert.equal(init?.redirect,'error');
  assert.deepEqual(init?.headers,{'Content-Type':'application/json'});
  assert.deepEqual(JSON.parse(init?.body as string),{text:'我准备好了！',emotion:'expectant',profileId:'cancan'});
  return new Response(new Uint8Array([82,73,70,70]),{headers:{'content-type':'audio/wav','X-Speech-Profile':'cancan','X-Speech-Speaker':'zh_female_cancan_uranus_bigtts','X-Speech-Emotion-Requested':'expectant','X-Speech-Emotion-Applied':'expectant','X-Speech-Control':'instruction','Authorization':'private'}});
 },async url=>{
  const r=await post(url,{text:'我准备好了！',emotion:'expectant',url:'http://other',token:'not-forwarded'});
  assert.equal(r.status,200);assert.equal(r.headers.get('X-Speech-Control'),'instruction');assert.equal(r.headers.get('authorization'),null);assert.equal((await r.arrayBuffer()).byteLength,4);
 });assert.equal(calls,1);
});
it('禁用/无效情绪不请求上游，供应商失败不泄露正文也不重试',async()=>{
 let calls=0;const upstream:typeof fetch=async()=>{calls++;return new Response('private supplier detail',{status:403});};
 await bridge(false,upstream,async url=>{assert.equal((await post(url,{text:'你好',emotion:'neutral'})).status,503);});
 await bridge(true,upstream,async url=>{
  assert.equal((await post(url,{text:'你好',emotion:'arbitrary'})).status,400);
  assert.equal((await post(url,{text:'你好',emotion:'neutral'})).status,502);
  const r=await post(url,{text:'你好',emotion:'neutral'});assert.deepEqual(await r.json(),{error:'speech_synthesis_failed',diagnostic:null});
 });assert.equal(calls,2);
});
it('断开页面请求取消合成，不重试',async()=>{
 let cancelled:Promise<void>|undefined;let calls=0;
 await bridge(true,async(_input,init)=>{
  calls++;cancelled=new Promise<void>(resolve=>{init!.signal!.addEventListener('abort',()=>resolve(),{once:true});});
  await cancelled;throw Error('cancelled');
 },async url=>{
  const controller=new AbortController();const pending=fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text:'加油',emotion:'excited'}),signal:controller.signal}).catch(()=>null);
  while(!cancelled)await new Promise(r=>setTimeout(r,5));controller.abort();await pending;await cancelled;
 });assert.equal(calls,1);
});

it('受控诊断可见，供应商原文和额外字段不透传',async()=>{
 await bridge(true,async()=>new Response(JSON.stringify({message:'private',diagnostic:{stage:'ws_handshake',reason:'http',httpStatus:403,providerReason:'resource_not_granted',secret:'private'}}),{status:502,headers:{'content-type':'application/json'}}),async url=>{
  const r=await post(url,{text:'加油',emotion:'determined'});
  assert.deepEqual(await r.json(),{error:'speech_synthesis_failed',diagnostic:{stage:'ws_handshake',reason:'http',providerReason:'resource_not_granted',httpStatus:403}});
 });
});

it('三profile绑定实际speaker；未知不联网，旧接口缺失profile不冒充新绑定',async()=>{
 let calls=0;
 await bridge(true,async(_input,init)=>{
  calls++;const value=JSON.parse(init!.body as string);assert.equal(value.profileId,'qingcang');
  return new Response(new Uint8Array([82,73,70,70]),{headers:{'content-type':'audio/wav','X-Speech-Profile':'cancan','X-Speech-Speaker':'zh_female_cancan_uranus_bigtts'}});
 },async url=>{
  assert.equal((await post(url,{text:'加油',emotion:'determined',profileId:'unknown'})).status,400);
  const result=await post(url,{text:'加油',emotion:'determined',profileId:'qingcang'});
  assert.equal(result.status,502);assert.deepEqual(await result.json(),{error:'speech_profile_mismatch'});
 });assert.equal(calls,1);
});

it('TTS桥接对三套profile逐项传递并核对speaker响应',async()=>{
 const profiles={cancan:'zh_female_cancan_uranus_bigtts',qingcang:'zh_male_qingcang_uranus_bigtts',tiancai:'zh_male_tiancaitongsheng_uranus_bigtts'};
 await bridge(true,async(_input,init)=>{
  const body=JSON.parse(init!.body as string);const speaker=profiles[body.profileId as keyof typeof profiles];
  return new Response(new Uint8Array([82,73,70,70]),{headers:{'content-type':'audio/wav','X-Speech-Profile':body.profileId,'X-Speech-Speaker':speaker}});
 },async url=>{for(const [profileId,speaker]of Object.entries(profiles)){
  const r=await post(url,{text:'我准备好了',emotion:'expectant',profileId});assert.equal(r.status,200);assert.equal(r.headers.get('X-Speech-Profile'),profileId);assert.equal(r.headers.get('X-Speech-Speaker'),speaker);
 }});
});
