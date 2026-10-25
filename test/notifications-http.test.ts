import assert from 'node:assert/strict';import{it}from'node:test';import type{AddressInfo}from'node:net';
import{createApp}from'../src/http/app.js';import{loadConfig}from'../src/config.js';import{createLogger}from'../src/log.js';import{GameService}from'../src/game/service.js';import{BattleStore}from'../src/store/battles.js';import{RoomStore}from'../src/store/rooms.js';
it('issued push绑定身份与当前局面，通知只取事实且一次性，伪造或旧局静默',async()=>{
 const logger=createLogger('error'),store=new BattleStore({ttlMs:60000}),rooms=new RoomStore({ttlMs:60000,random:()=>0}),service=new GameService({store,rooms,logger,random:()=>0});
 const app=createApp({config:loadConfig({}),logger,store,rooms,service}),server=app.listen(0,'127.0.0.1');await new Promise<void>(r=>server.on('listening',r));const url=`http://127.0.0.1:${(server.address()as AddressInfo).port}`,controller=new AbortController();
 const key='host#qa',opened=await service.say(key,'共鸣对决，发起挑战'),room=opened.reply!.room!;
 try{
  const response=await fetch(url+'/events?device=host&agent=qa',{signal:controller.signal}),reader=response.body!.getReader();
  // Establish pre-join observation before the visitor arrives.
  await reader.read();await service.say('guest#qa','接受挑战，编号'+room);
  let text='',payload:any;const deadline=Date.now()+4000;
  while(!payload&&Date.now()<deadline){const chunk=await reader.read();text+=new TextDecoder().decode(chunk.value);const match=text.match(/event: push\ndata: ([^\n]+)/);if(match)payload=JSON.parse(match[1]!);}
  assert.ok(payload);assert.equal(payload.kind,'opponent-joined');assert.ok(payload.id);assert.ok(payload.battleId);
  const before=JSON.stringify(service.snapshot(key));
  const post=(device:string,body:object)=>fetch(url+'/notification',{method:'POST',headers:{'content-type':'application/json','X-Linx-Device-Id':device,'X-Linx-Agent-Id':'qa'},body:JSON.stringify(body)}).then(r=>r.json()) as Promise<any>;
  const notice={pushId:payload.id,battleId:payload.battleId,kind:payload.kind};
  assert.equal((await post('other',notice)).reply.silent,true);
  const actual=await post('host',notice);assert.equal(actual.reply.v,2);assert.notEqual(actual.reply.silent,true);
  assert.equal(JSON.stringify(service.snapshot(key)),before);assert.equal((await post('host',notice)).reply.silent,true);
  assert.equal((await post('host',{...notice,pushId:'fake'})).reply.silent,true);
  controller.abort();
 }finally{controller.abort();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
});
