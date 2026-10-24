import assert from 'node:assert/strict';
import { it } from 'node:test';
import type { BattleState, HistoryEntryState } from '../src/game/state.js';
const { companionView, newSettlement, opponentDetails } = await import(new URL('../sandbox/public/companion.js', import.meta.url).href);
function battle(overrides: Partial<BattleState> = {}): BattleState {
  return {room:'1234',mode:'pvp',side:'player',phase:'battle',round:1,active:'player',firstMover:'player',pending:null,waiting:false,you:{name:'伙伴',hp:14,maxHp:14,ap:4,maxAp:5,ultLeft:1},opponent:{name:'对手',hp:18,maxHp:18,ap:3,maxAp:5,ultLeft:1},winner:null,history:[],updatedAt:1,...overrides};
}
it('大招必须同时满足真实阶段、资源、次数和连接条件', () => {
  assert.equal(companionView(battle(),true).ultimate,'ready');
  for (const ap of [0,1,2,3,4,5]) assert.equal(companionView(battle({you:{...battle().you,ap}}),true).ultimate,ap>=4?'ready':'insufficient');
  for (const state of [battle({waiting:true}),battle({active:'enemy'}),battle({pending:{actor:'enemy',move:'light',moveLabel:'普攻',damage:3}}),battle({pending:{actor:'player',move:'heavy',moveLabel:'强攻',damage:5}})]) assert.notEqual(companionView(state,true).ultimate,'ready');
  assert.equal(companionView(battle({you:{...battle().you,ultLeft:0}}),true).ultimate,'used');
  assert.equal(companionView(battle(),false).ultimate,'unknown');
  for (const phase of ['victory','defeat'] as const) assert.equal(companionView(battle({phase}),true).ultimate,'ended');
});
it('只用真实裁决表达命中、防御和闪避；终局与断网优先', () => {
  assert.equal(companionView(battle(),true).visual,'idle');
  const pending = {actor:'player' as const,move:'heavy' as const,moveLabel:'强攻',damage:5};
  assert.equal(companionView(battle({pending}),true).visual,'accepted');
  const hit:HistoryEntryState={round:1,actor:'enemy',action:'light',actionLabel:'普攻',damage:3};
  assert.equal(companionView(battle(),true,hit).visual,'hurt');
  assert.equal(companionView(battle(),true,{...hit,guarded:true,damage:1}).visual,'defending');
  assert.equal(companionView(battle(),true,{...hit,dodged:true,damage:0}).visual,'dodgeSuccess');
  assert.equal(companionView(battle(),true,{...hit,actor:'player'}).visual,'attacking');
  assert.equal(companionView(battle({phase:'defeat'}),true,hit).visual,'defeat');
  assert.equal(companionView(battle(),false,hit).visual,'offline');
});
it('初次载入、查询重复、换房和历史替换不重播战果', () => {
  const hit:HistoryEntryState={round:1,actor:'enemy',action:'light',actionLabel:'普攻',damage:3};
  const before=battle(),after=battle({history:[hit]});
  assert.equal(newSettlement(null,after),null);
  assert.deepEqual(newSettlement(before,after),hit);
  assert.equal(newSettlement(after,after),null);
  assert.equal(newSettlement(before,{...after,room:'5678'}),null);
  assert.equal(newSettlement(after,battle({history:[{...hit,damage:5},hit]})),null);
  assert.equal(newSettlement(before,battle({history:[{...hit,action:'charge'}]})),null);
});

it('对手调试只显示可信公开快照，明确缺席与阶段视角', () => {
  assert.ok(!opponentDetails(battle(),false).includes('18'));
  assert.ok(opponentDetails(null,true).includes('尚无对局'));
  assert.ok(opponentDetails(battle({waiting:true}),true).includes('尚未加入'));
  const b=battle({pending:{actor:'player',move:'light',moveLabel:'普攻',damage:999}});
  const text=opponentDetails(b,true);
  assert.ok(text.includes('18 / 18'));assert.ok(text.includes('需要应对'));assert.ok(!text.includes('999'));
  assert.ok(opponentDetails(battle({phase:'victory'}),true).includes('对手已被击倒'));
});
