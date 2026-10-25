import assert from 'node:assert/strict';import{it}from'node:test';
import{normalizeRoomCode,roomCodeFromPhrase}from'../src/game/pvp.js';
import{readCommand}from'../src/game/command.js';
import{GameService}from'../src/game/service.js';import{BattleStore}from'../src/store/battles.js';import{RoomStore}from'../src/store/rooms.js';import{createLogger}from'../src/log.js';
it('用户ASR原句七幺二六与一/数字/空格标点都只解析为7126',()=>{
 for(const text of ['加入挑战，编号七幺二六。','加入挑战，编号七一二六。','接受挑战，编号7126。','加入挑战 编号 七 幺 二 六 。','加入房间7126','进房七幺二六']){
  assert.equal(roomCodeFromPhrase(text),'7126',text);assert.deepEqual(readCommand(text),{kind:'join-room',code:'7126'},text);
 }
 assert.equal(readCommand('我接下了编号七幺二六的挑战').kind,'echo');
 assert.equal(normalizeRoomCode('七幺二六'),'7126');assert.equal(normalizeRoomCode('〇幺两三'),'0123');
});
it('3/5位、两个编号与资源上下文不可拼成新编号',()=>{
 for(const text of ['加入挑战，编号七幺二。','加入挑战编号71266','加入挑战编号12，我还有34点能量','我有7点能量，加入挑战编号126','加入挑战，我有7126点生命值','加入挑战7126点能量','接受挑战编号7126或编号1234']){
  assert.equal(roomCodeFromPhrase(text),null,text);assert.notEqual(readCommand(text).kind,'open-room',text);
 }
 assert.equal(roomCodeFromPhrase('我有99点能量，加入挑战编号7126'),'7126');
 assert.equal(normalizeRoomCode('12生命值34'),null);assert.equal(roomCodeFromPhrase('加入挑战'),null);
});
it('原句目标不存在返回room_missing；目标存在加入同一局，不创建不调用模型',async()=>{
 let calls=0;const rooms=new RoomStore({ttlMs:60000,random:()=>6126/9000});const service=new GameService({rooms,store:new BattleStore({ttlMs:60000}),logger:createLogger('error'),random:()=>0,router:{async resolve(){calls++;return{kind:'open-room'};}}});
 const raw='加入挑战，编号七幺二六。';const missing=await service.say('guest',raw);assert.equal(missing.reply?.reason,'room_missing');assert.equal(rooms.size,0);
 const opened=await service.say('host','发起挑战');assert.equal(opened.reply?.room,'7126');const joined=await service.say('guest',raw);assert.equal(rooms.size,1);assert.equal(joined.reply?.room,'7126');assert.equal(joined.battle?.id,opened.battle?.id);assert.ok(joined.reply?.events?.some(e=>e.t==='join'));assert.equal(calls,0);
});
