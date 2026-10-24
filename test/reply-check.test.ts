import assert from 'node:assert/strict';
import {it} from 'node:test';
import {presentation} from '../src/game/presentation.js';
import {checkReply} from '../sandbox/platform/reply-check.js';
it('自由改写而非句式选择，允许词语/句序变化和中文次数表达',()=>{
 const facts=presentation('status',null);
 assert.equal(checkReply('我14点生命值、3点能量，对手18点生命值、3点能量。','对方还有18点生命值、3点能量，我则剩14点生命值和3点能量。',facts),true);
 assert.equal(checkReply('我还剩一次大招。','我的大招还能用1次。',facts),true);
});
it('数值新增丢失或归属交换拒绝，不只比较相同数字集合',()=>{
 const facts=presentation('status',null),source='我14点生命值，对手18点生命值。';
 for(const text of ['我18点生命值，对手14点生命值。','我14点生命值，对手18点生命值，暴击99点。','我14点生命值。'])assert.equal(checkReply(source,text,facts),false);
});
it('明显胜负、待应对和闪避矛盾拒绝；不声称完整语义验证',()=>{
 const ended=presentation('turn',null);ended.facts.phase='victory';ended.facts.next='ended';
 assert.equal(checkReply('我赢了！','我获胜了，真痛快！',ended),true);
 assert.equal(checkReply('我赢了！','对手赢了。',ended),false);
 const pending=presentation('turn',null,{events:[{type:'pending',round:1,side:'player',move:'heavy'}]});pending.facts.next='wait-response';
 assert.equal(checkReply('我强攻，等对手应对。','我的强攻命中了，等对手应对。',pending),false);
 const dodged=presentation('turn',null,{events:[{type:'attack',round:1,side:'enemy',move:'light',response:'dodge',dodged:true,crit:false,guarded:false,forced:false,damage:0,targetHp:14}]});
 assert.equal(checkReply('对手普攻，我躲开了。','对手攻过来，我轻巧地避开了！',dodged),true);
 assert.equal(checkReply('对手普攻，我躲开了。','对手攻过来，我没能躲开。',dodged),false);
});

it('征求指挥保留主动下一步，不能省略玩家所需的行动提示',()=>{
 const active=presentation('status',null);active.facts.next='act';
 assert.equal(checkReply('该我出招。','我该怎么做？',active),true);
 assert.equal(checkReply('该我出招。','真痛快！',active),false);
});


it('开局名称归属可替换为对手，仍拒绝数字交换；等待加入不得开打',()=>{
 const facts=presentation('opening',null);facts.facts.opponentName='守擂教头';facts.facts.next='act';
 const source='我14点生命值，守擂教头18点生命值。该我出招。';
 assert.equal(checkReply(source,'我14点生命值，对手18点生命值。我该怎么做？',facts),true);
 assert.equal(checkReply(source,'我18点生命值，对手14点生命值。我该怎么做？',facts),false);
 facts.facts.next='wait-join';
 assert.equal(checkReply('还在等对手加入。','开打啦！',facts),false);
 const ended=presentation('status',null);ended.facts.next='ended';
 assert.equal(checkReply('这局结束了。','我该怎么做？',ended),false);
});


it('开局用“你定”征求指挥不误回退，数字交换和等待被省略仍拒绝',()=>{
 const details=presentation('opening',null);details.facts.opponentName='守擂教头';details.facts.next='act';
 const source='对决开始，你的对手是守擂教头，我先手，我14点生命值，守擂教头18点生命值。该我出招，说普攻、强攻、大招或蓄力，听你的。';
 const candidate='开局了，我14点对守擂教头18点，我先手。出普攻、强攻、大招还是蓄力？你定。';
 assert.equal(checkReply(source,candidate,details),true);
 assert.equal(checkReply(source,candidate.replace('我14点对守擂教头18点','我18点对守擂教头14点'),details),false);
 assert.equal(checkReply(source,'我14点，对手18点。',details),false);
 const waiting=presentation('turn',null);waiting.facts.next='wait-response';
 assert.equal(checkReply('我出大招了，等对手应对。','我出大招了，你定。',waiting),false);
});

it('开局命中受伤胜利和重说允许鲜明主观感受，不依赖固定台词',async()=>{
 const {createBattle}=await import('../src/game/engine.js');
 const b=createBattle({now:1,seed:0,firstMover:'player'});
 const hurt=structuredClone(b);hurt.player.hp=1;
 const won=structuredClone(b);won.phase='victory';won.enemy.hp=0;
 const cases=[
  {source:'对决开始，我先手，我14点生命值，对手18点生命值。该我出招。',reply:'嘿，我好兴奋！我先手，我14点生命值、对手18点生命值，你来指挥。',facts:presentation('opening',b)},
  {source:'我普攻命中，对手掉3点生命值、剩11点生命值。该我出招。',reply:'我普攻命中，真痛快，对手掉3点生命值、剩11点生命值！你来指挥。',facts:presentation('turn',b)},
  {source:'对手强攻，我没躲开，掉5点生命值，剩1。',reply:'嘶，好疼，对手强攻我没躲开，我掉5点生命值、只剩1点了，还是想跟你拼一把。',facts:presentation('turn',hurt,{events:[{type:'attack',round:1,side:'enemy',move:'heavy',response:'dodge',dodged:false,crit:false,guarded:false,forced:false,damage:5,targetHp:1}]})},
  {source:'我赢了，击倒对手啦。',reply:'太开心了，我赢了！这场咱们拿下啦！',facts:presentation('turn',won)},
  {source:'没听清这一手，再说一次。',reply:'我有点懵，没听清，再告诉我一次？',facts:presentation('retry',b)},
 ];
 for(const c of cases)assert.equal(checkReply(c.source,c.reply,c.facts),true,c.reply);
});


it('第一人称欢呼可改写为我把对手击倒，但不追加原文没有的轮次',()=>{
 const facts=presentation('turn',null);facts.facts.phase='victory';facts.facts.next='ended';facts.facts.opponentName='守擂教头';
 assert.equal(checkReply('我赢了，击倒对手啦。','赢了！我把守擂教头击倒啦，真痛快！',facts),true);
 assert.equal(checkReply('我赢了，击倒对手啦。','赢了！我把守擂教头击倒啦，第一回合就拿下！',facts),false);
 facts.facts.phase='battle';facts.facts.next='act';
 assert.equal(checkReply('我普攻。','我把对手击倒啦！',facts),false);
});
