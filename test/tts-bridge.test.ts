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
  assert.deepEqual(JSON.parse(init?.body as string),{text:'我准备好了！',emotion:'expectant'});
  return new Response(new Uint8Array([82,73,70,70]),{headers:{'content-type':'audio/wav','X-Speech-Emotion-Requested':'expectant','X-Speech-Emotion-Applied':'expectant','X-Speech-Control':'instruction','Authorization':'private'}});
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
