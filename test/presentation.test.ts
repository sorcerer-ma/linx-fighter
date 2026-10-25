import { viewAs } from '../src/game/pvp.js';
import assert from 'node:assert/strict';
import { it } from 'node:test';
import { createBattle,resolveTurn } from '../src/game/engine.js';
import { presentation } from '../src/game/presentation.js';
import { narrateTurn } from '../src/game/narrator.js';
it('真实结算生成双方归属、数值、下一步，不解析播报',async()=>{
 const initial=createBattle({now:1,seed:1,mode:'pvp',firstMover:'player'});
 const locked=await resolveTurn(initial,'heavy',2);
 const result=await resolveTurn(viewAs(locked.battle,'enemy'),'take',3);
 const facts=presentation('turn',result.battle,{events:result.events});
 assert.deepEqual(facts.facts.events,result.events);
 assert.equal(facts.facts.you?.hp,result.battle.player.hp);assert.equal(facts.facts.opponent?.hp,result.battle.enemy.hp);
 assert.equal(facts.facts.you?.energy,result.battle.player.ap);assert.equal(facts.facts.next,'act');
 const source=narrateTurn(result.battle,result.events),variant=narrateTurn(result.battle,result.events,{expressive:true});
 assert.notEqual(variant,source);assert.match(variant,/对手使出强攻/);assert.match(variant,/我承受/);
 assert.match(variant,new RegExp('损失'+result.events.find(e=>e.type==='attack')?.damage));
});
it('未知异常不声称未执行；明确拒绝是not-applied；未入房不造对手事实',()=>{
 assert.equal(presentation('error',null).certainty,'unknown');assert.equal(presentation('rejected',null,{rejection:'wrong-stage'}).certainty,'not-applied');
 const b=createBattle({now:1,seed:1,mode:'pvp',firstMover:'player'});
 const waiting=presentation('status',b,{waiting:true});
 assert.equal(waiting.facts.next,'wait-join');assert.equal(waiting.facts.opponent,undefined);
});

it('presentation 显式给出大招就绪事实，不用能量数值推断',()=>{
 const b=createBattle({now:1,seed:1,mode:'solo',firstMover:'player'});
 assert.equal(presentation('status',b).facts.you?.ultimateReady,false);
 b.player.ap=4;
 assert.equal(presentation('status',b).facts.you?.ultimateReady,true);
 b.player.ultLeft=0;
 assert.equal(presentation('status',b).facts.you?.ultimateReady,false);
});


it('开局、重说、明确拒绝来自真实服务结果且不推进被拒绝的对局',async()=>{
 const {GameService}=await import('../src/game/service.js');
 const {BattleStore}=await import('../src/store/battles.js');
 const {RoomStore}=await import('../src/store/rooms.js');
 const {createLogger}=await import('../src/log.js');
 const store=new BattleStore({ttlMs:60000});
 const service=new GameService({store,rooms:new RoomStore({ttlMs:60000}),logger:createLogger('error'),random:()=>0,fuzzy:null});
 const key='feedback-test';
 assert.equal(service.status(key).presentation?.facts.next,'start');
 const start=await service.say(key,'开始');
 assert.equal(start.presentation?.kind,'opening');
 assert.equal(start.presentation?.facts.you?.hp,start.battle?.player.hp);
 const before=JSON.stringify(start.battle);
 const retry=await service.say(key,'跳舞');
 assert.equal(retry.presentation?.kind,'retry');
 assert.equal(retry.presentation?.certainty,'not-applied');
 assert.equal(JSON.stringify(retry.battle),before);
 const refused=await service.say(key,'不要普攻');
 assert.equal(refused.presentation?.kind,'rejected');
 assert.equal(refused.presentation?.certainty,'not-applied');
 const invalid=await service.say(key,'大招');
 assert.equal(invalid.presentation?.facts.rejection,'insufficient-ap');
 assert.equal(JSON.stringify(invalid.battle),before);
 const room=await service.say('waiting-feedback','开房间');
 assert.equal(room.presentation?.kind,'opening');
 assert.equal(room.presentation?.facts.next,'wait-join');
 assert.equal(room.presentation?.facts.opponent,undefined);
 const waitingRetry=await service.say('waiting-feedback','跳舞');
 assert.equal(waitingRetry.presentation?.facts.next,'wait-join');
 assert.equal(waitingRetry.presentation?.facts.opponent,undefined);
});
