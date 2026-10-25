import assert from 'node:assert/strict';
import { it } from 'node:test';
import { GameService } from '../src/game/service.js';
import { BattleStore } from '../src/store/battles.js';
import { RoomStore } from '../src/store/rooms.js';
import { pvpBattleKey } from '../src/game/pvp.js';
import { createLogger } from '../src/log.js';
import { isEmptyWaitTimeout, type GameReply } from '../src/game/protocol.js';
import { SandboxAgent } from '../sandbox/platform/agent.js';
import type { CommandRouter } from '../src/game/router.js';
import type { ActionId } from '../src/game/types.js';

function setup(extra: { speakers?: string[]; router?: CommandRouter } = {}) {
  const store = new BattleStore({ ttlMs: 60000 });
  const service = new GameService({store, rooms:new RoomStore({ttlMs:60000,random:()=>0}), logger:createLogger('error'), random:()=>0, ...extra});
  return {service,store};
}
const silent = {v:2,ok:true,silent:true};
it('new validated wait supersedes old; late abort cannot erase the new owner or steal its event',async()=>{
  const {service:s}=setup();await s.say('h','开房');
  const controller=new AbortController();
  const old=s.waitEvent('h',{signal:controller.signal,timeoutMs:1000});
  const current=s.waitEvent('h',{timeoutMs:1000});
  assert.deepEqual((await old).reply,silent);controller.abort();
  await s.say('g','加入房间1000');
  assert.equal((await current).reply?.events?.filter(e=>e.t==='start').length,1);
  assert.deepEqual((await s.waitEvent('h',{timeoutMs:1})).reply,silent);
});
it('unauthorized, invalid input, broadcast echo and pre-cancelled wait cannot replace a valid owner',async()=>{
  const {service:s}=setup({speakers:['A','B','X']});await s.say('h','开房',{speaker:'A'});
  const current=s.waitEvent('h',{speaker:'A',timeoutMs:1000});
  assert.deepEqual((await s.waitEvent('h',{speaker:'X',timeoutMs:1})).reply,silent);
  await s.say('h','玩法',{speaker:'X'});
  await s.say('h','');await s.say('h','字'.repeat(201),{speaker:'A'});
  await s.say('h','挑战已发起',{speaker:'A'});
  const aborted=new AbortController();aborted.abort();
  assert.deepEqual((await s.waitEvent('h',{speaker:'A',signal:aborted.signal})).reply,silent);
  await s.say('g','加入房间1000',{speaker:'B'});
  assert.equal((await current).reply?.events?.filter(e=>e.t==='start').length,1);
});
it('new input cancels old wait once; a late model route does not cancel the later wait',async()=>{
  let release!:(value:{kind:'help'})=>void;
  const resolved=new Promise<{kind:'help'}>(done=>{release=done;});
  const {service:s}=setup({router:{async resolve(){return resolved;}}});
  await s.say('h','开房');const old=s.waitEvent('h',{timeoutMs:1000});
  const input=s.say('h','一些尚待分类的话');
  assert.deepEqual((await old).reply,silent);
  const next=s.waitEvent('h',{timeoutMs:1000});release({kind:'help'});await input;
  await s.say('g','加入房间1000');
  assert.equal((await next).reply?.events?.filter(e=>e.t==='start').length,1);
});
it('normal timeout preserves state and queued facts across the next request gap',async()=>{
  const {service:s}=setup();await s.say('h','开房');const before=s.snapshot('h');
  for(let i=0;i<3;i++)assert.equal(isEmptyWaitTimeout((await s.waitEvent('h',{timeoutMs:1})).reply!),true);
  assert.deepEqual(s.snapshot('h'),before);
  await s.say('g','加入房间1000');
  assert.equal((await s.waitEvent('h',{timeoutMs:1})).reply?.events?.filter(e=>e.t==='start').length,1);
});
it('complete isolated PVP delivers each terminal result once and pending wakes the defender',async()=>{
  const {service:s,store}=setup();await s.say('h','开房');await s.say('g','加入房间1000');s.status('h');
  const endCounts={h:0,g:0};let steps=0,pendingSeen=0;
  while(store.get(pvpBattleKey('1000'))!.phase==='battle' && steps++<60){
    const battle=store.get(pvpBattleKey('1000'))!;
    const side=battle.pending ? (battle.pending.actor==='player'?'enemy':'player') : battle.active;
    const who=side==='player'?'h':'g',other=who==='h'?'g':'h';
    const fighter=side==='player'?battle.player:battle.enemy;
    const action:ActionId=battle.pending?'take':fighter.ap>=2?'heavy':fighter.ap>=1?'light':'charge';
    const waiting=s.waitEvent(other,{timeoutMs:1000});
    const result=await s.say(who,({take:'承受',heavy:'强攻',light:'普攻',charge:'蓄力'} as Record<string,string>)[action]!);
    const response=await waiting;
    if(response.reply?.need==='respond'){assert.ok(response.reply.pending);pendingSeen++;}
    for(const [key,r] of [[who,result],[other,response]] as const)endCounts[key]+=r.reply?.events?.filter(e=>e.t==='end').length??0;
  }
  assert.ok(steps<60);assert.ok(pendingSeen>0);assert.deepEqual(endCounts,{h:1,g:1});
  for(const who of ['h','g'])assert.deepEqual((await s.waitEvent(who,{timeoutMs:1})).reply,silent);
});
it('only successful pure wait timeout bypasses expression; mixed events and ordinary calls remain visible',async()=>{
  let models=0,tools=0;
  const agent=new SandboxAgent('伙伴',{async express(){models++;return '结果未确认。';}});
  const timeout:GameReply={v:2,ok:true,phase:'room',need:'wait_guest',events:[{t:'timeout',what:'guest'}],say:'还在等。'};
  const tool=(reply:GameReply,isError=false)=>({async callTool(){tools++;return{reply,isError};}});
  const quiet=await agent.wait(tool(timeout));assert.equal(quiet.rewriteStatus,'wait-timeout');assert.equal(quiet.text,'');assert.deepEqual(quiet.speech.segments,[]);assert.equal(models,0);
  for(const reply of [{...timeout,events:[]},{...timeout,need:'none' as const},{...timeout,events:[{t:'timeout' as const,what:'foe' as const}]},{...timeout,text:'必须表达的文本'},{...timeout,ok:false,reason:'unknown' as const},...(['hit','start','end','chant'] as const).map(t=>({...timeout,events:[...timeout.events!,t==='hit'?{t,by:'foe' as const,mv:'heavy' as const,r:'take' as const,dmg:5}:t==='start'?{t,foe:'对手',first:'you' as const}:t==='end'?{t,win:'you' as const}:{t,text:'喝！'}]}))]){
    assert.equal(isEmptyWaitTimeout(reply),false);assert.notEqual((await agent.wait(tool(reply))).rewriteStatus,'wait-timeout');
  }
  assert.notEqual((await agent.run('等待',tool(timeout))).rewriteStatus,'wait-timeout');
  assert.notEqual((await agent.wait(tool(timeout,true))).rewriteStatus,'wait-timeout');
  assert.ok(models>0);assert.ok(tools>1);
});
