import assert from 'node:assert/strict';
import { it } from 'node:test';
import { checkReply, replyRejectionReason } from '../sandbox/platform/reply-check.js';
import type { GameReply } from '../src/game/protocol.js';
const battle:GameReply={v:2,ok:true,phase:'battle',need:'none',you:{hp:14,maxHp:14,ap:3,maxAp:5,ult:1},foe:{name:'教头',hp:18,maxHp:18,ap:3,ult:1},events:[]};
it('自由邀请不要求关键词白名单，不强制复读快照；错误数字归属受控拒绝',()=>{
 for(const candidate of ['我精神十足，告诉我怎么出招！','嘿嘿，告诉我打哪招？','轻松一点，怎么打？'])assert.equal(checkReply(candidate,{...battle,need:'move'}),true,candidate);
 assert.equal(checkReply('我14点生命值，对手18点生命值。',battle),true);
 assert.equal(replyRejectionReason('我18点生命值，对手14点生命值。',battle),'ownership');
 assert.equal(replyRejectionReason('我99点能量。',battle),'number');
});
it('hit必须保留伤害与归属，不能明确反向攻击或错招式',()=>{
 const facts:GameReply={...battle,events:[{t:'hit',by:'you',mv:'light',r:'take',dmg:3}]};
 assert.equal(checkReply('我普攻击中，对手掉了3点，真痛快！',facts),true);
 assert.equal(checkReply('对手打我，我掉了3点。',facts),false);
 assert.equal(checkReply('我强攻打中了对手，掉了3点。',facts),false);
 assert.equal(checkReply('我普攻击中，真痛快！',facts),false);
});
it('闪避成败、暴击和胜负不可被情绪掩盖',()=>{
 const dodge:GameReply={...battle,events:[{t:'hit',by:'foe',mv:'light',r:'dodge',dmg:0,miss:true}]};
 assert.equal(checkReply('对手普攻，我躲开了，0点伤害，嘿嘿！',dodge),true);
 assert.equal(checkReply('对手普攻，我没能躲开，0点伤害。',dodge),false);
 const end:GameReply={...battle,phase:'victory',need:'none',events:[{t:'end',win:'you'}]};
 assert.equal(checkReply('我赢了，痛快！再来吗？',end),true);assert.equal(replyRejectionReason('对手赢了。',end),'winner');
});
it('锁定不等于命中，等待与未知不能假报结果，明确阶段矛盾仍受控拒绝',()=>{
 const pending:GameReply={...battle,need:'wait_foe',pending:{by:'you',mv:'ult',dmg:9}};
 assert.equal(checkReply('共鸣冲击！我已经出手，等对手应对。',pending),true);
 assert.equal(checkReply('我大招命中了，等对手。',pending),false);
 assert.equal(replyRejectionReason('我该怎么做？',{...battle,need:'wait_guest'}),'stage');
 assert.equal(replyRejectionReason('轮到对手出招了。',{...battle,need:'move'}),'stage');
 assert.equal(checkReply('这一手没生效，再说攻击。',{v:2,ok:false,reason:'unknown',events:[]}),false);
});
it('开局须保留先手，房号和明确拒绝可自由表达',()=>{
 const opening:GameReply={...battle,need:'move',events:[{t:'start',foe:'教头',first:'you'}]};
 assert.equal(replyRejectionReason('教头来了，告诉我打哪招？',opening),'event_start');
 assert.equal(checkReply('教头来了，我先手！告诉我打哪招？',opening),true);
 const room:GameReply={v:2,ok:true,phase:'room',need:'wait_guest',room:'1234',events:[{t:'room',code:'1234'}]};
 assert.equal(checkReply('房间1234开好了，我等不及想见对手啦！',room),true);
 assert.equal(checkReply('房间4321开好了，等人。',room),false);
 const refusal:GameReply={...battle,ok:false,reason:'no_ap',deny:{mv:'ult',need:4,short:1}};
 assert.equal(checkReply('还差1点能量，有点着急呀。',refusal),true);assert.equal(checkReply('我的大招命中了！',refusal),false);
});
it('受伤不当成剩余生命值，交错两次攻击按各自归属校验',()=>{
 const facts:GameReply={...battle,events:[{t:'hit',by:'you',mv:'light',r:'take',dmg:3},{t:'hit',by:'foe',mv:'heavy',r:'take',dmg:5}]};
 assert.equal(checkReply('我普攻打中对手，对手掉了3点生命值；对手强攻击中我，我挨了5点，疼呀！',facts),true);
 assert.equal(checkReply('我普攻打中对手，对手掉了5点；对手强攻击中我，我挨了3点。',facts),false);
 assert.equal(checkReply('我普攻暴击打中对手，对手掉了3点；对手强攻击中我，我挨了5点。',facts),false);
});
it('review: 明确拒绝不说已放出，正确胜负/零伤闪避不误拒，资源是为句式保归属',()=>{
 const denied:GameReply={...battle,ok:false,reason:'no_ap',deny:{mv:'ult',need:4,short:1}};
 assert.equal(replyRejectionReason('大招放出去了！',denied),'certainty');
 assert.equal(checkReply('没能放出大招，还差1点能量。',denied),true);
 const won:GameReply={...battle,phase:'victory',need:'none',events:[{t:'end',win:'you'}]};
 assert.equal(checkReply('对手输了，这一局归我！',won),true);
 const dodge:GameReply={...battle,events:[{t:'hit',by:'you',mv:'light',r:'dodge',dmg:0,miss:true}]};
 assert.equal(checkReply('对手闪开了我这一拳。',dodge),true);
 for(const text of ['对手的生命值是14点','对手目前生命值为14点','我现在能量是5点'])assert.equal(replyRejectionReason(text,battle),'ownership',text);
 assert.equal(checkReply('对手的生命值是18点，我的能量为3点。',battle),true);
});
