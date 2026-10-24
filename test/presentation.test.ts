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
 const waiting=presentation('status',b,{waiting:true});assert.equal(waiting.facts.next,'wait-join');assert.equal(waiting.facts.opponent,undefined);
});
