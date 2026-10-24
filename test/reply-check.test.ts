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
