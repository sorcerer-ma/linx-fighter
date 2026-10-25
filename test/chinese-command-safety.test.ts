import assert from 'node:assert/strict';import{describe,it}from'node:test';
import{looksLikeAssistantEcho}from'../src/game/crosstalk.js';
import{readCommand}from'../src/game/command.js';import{normalizeRoomCode,parseRoomCodePhrase}from'../src/game/pvp.js';
import{GameService}from'../src/game/service.js';import{BattleStore}from'../src/store/battles.js';import{RoomStore}from'../src/store/rooms.js';import{createLogger}from'../src/log.js';import{parseRouteDecision}from'../src/game/router.js';
const cancelled=['取消普攻','别普攻','不要帮我开房','别帮我加入房间1000','取消加入房间1000','发起挑战，算了','加入房间1000，算了','我先不强攻','请不要退出房间'];
const queried=['怎么加入房间1000？','怎么发起挑战？','能不能联机','要不要发起挑战','可不可以发起挑战','如何退出房间','接受挑战编号1000吗','能否重新开始','是否发起挑战'];
const ambiguous=['先发起挑战，再加入房间1000','加入房间1000，然后普攻','先退出房间再开始游戏','加入房间1000，开始','普攻然后普攻','发起挑战再发起挑战','加入房间1000或者1001','加入房间1000、1001','接受挑战编号1000，编号1001','加入房间1000和加入房间1001','加入房间1000，另一个1001','加入房间1000。或者1001','加入房间1000，12'];
const invalid=['加入房间1000５','加入房间一零零零伍','加入房间一零零零十','加入房间1000a','加入房间1000.5','加入房间1000-5','加入房间10\n00','加入房间一千','加入房间1要00'];
function setup(){let routerCalls=0;const store=new BattleStore({ttlMs:60000}),rooms=new RoomStore({ttlMs:60000,random:()=>0});const service=new GameService({store,rooms,logger:createLogger('error'),random:()=>0,router:{async resolve(text,stage){routerCalls++;return parseRouteDecision({answers:{command:{choice:'open-room',confidence:1}}},stage,text);}}});return{service,store,rooms,calls:()=>routerCalls};}
describe('中文执行前安全分型',()=>{
 for(const text of cancelled)it('明确否定/取消不执行：'+text,()=>assert.deepEqual(readCommand(text),{kind:'refused',why:'negated'}));
 for(const text of queried)it('问句只读：'+text,()=>assert.deepEqual(readCommand(text),{kind:'route',question:true}));
 for(const text of ambiguous)it('歧义不择一：'+text,()=>assert.deepEqual(readCommand(text),{kind:'refused',why:'ambiguous'}));
 for(const text of invalid)it('编号完整边界：'+text,()=>assert.deepEqual(readCommand(text),{kind:'join-room',code:''}));
 it('正常指令、安抚、长别名和对手叙述不退化',()=>{
  for(const text of ['特别想普攻','普通攻击','特别强的攻击'])assert.deepEqual(readCommand(text),{kind:'turn',action:'light',chant:undefined},text);
  assert.deepEqual(readCommand('强化攻击'),{kind:'turn',action:'heavy',chant:undefined});assert.deepEqual(readCommand('对手放大招，我格挡'),{kind:'turn',action:'guard',chant:undefined});
  for(const text of ['别担心，发起挑战吧','不用怕，联机吧','别急，发起挑战','共鸣对决，发起挑战'])assert.equal(readCommand(text).kind,'open-room',text);
  for(const text of ['加入房间１０００','接受挑战编号幺零零零','加入挑战，编号一零零零。','加入房间1 0 0 0吧','接受双人挑战编号１０００'])assert.deepEqual(readCommand(text),{kind:'join-room',code:'1000'},text);
  assert.equal(readCommand('普攻和强攻怎么用').kind,'help');assert.equal(readCommand('退出房间').kind,'leave-room');
 });
});
describe('编号不猜词、不拼接或截断',()=>{
 it('只转换全角数字，四位完整校验，两种中文一保持等价',()=>{
  for(const raw of ['１０００','1０００','幺零〇零','一零零零'])assert.equal(normalizeRoomCode(raw),'1000',raw);
  for(const raw of ['123','１２３４５','1234伍','1234.5','12\n34','七千一百二十六','柒壹贰陆','七兩二六','要二三四'])assert.equal(normalizeRoomCode(raw),null,raw);
  assert.equal(parseRoomCodePhrase('加入挑战编号1000，我还有5点能量').code,'1000');
  assert.equal(parseRoomCodePhrase('加入挑战编号1000，我还有1234点能量').code,'1000');
  assert.equal(parseRoomCodePhrase('加入挑战编号1000，2026年').code,'1000');
  assert.equal(parseRoomCodePhrase('我有10点能量，加入挑战编号00').code,null);
  assert.equal(looksLikeAssistantEcho('我接下了编号１０００的挑战'),true);
  // Legacy broadcasts require a complete identifier too; never silence a five-digit prefix.
  for(const prefix of ['我进了房间','没找到房间']){
   for(const code of ['10000','一零零零五','1幺〇两5','１００００','1234伍'])assert.equal(looksLikeAssistantEcho(prefix+code),false,prefix+code);
   for(const code of ['1000','一零零零','1幺〇两','１０００'])assert.equal(looksLikeAssistantEcho(prefix+code),true,prefix+code);
  }
  assert.equal(parseRoomCodePhrase('加入房间1000编号1001').ambiguous,true);
  assert.equal(parseRoomCodePhrase('接受挑战，编号1000或是1001').ambiguous,true);
 });
 it('分两次输入不自动续填编号，也不能以裸编号新开房',async()=>{
  const {service,rooms}=setup();const a=await service.say('a','加入挑战');assert.equal(a.reply?.reason,'room_bad');
  for(const text of ['编号1000','1000']){assert.deepEqual(readCommand(text),{kind:'route',question:true});await service.say('a',text);assert.equal(rooms.size,0);assert.equal(service.snapshot('a'),null);}
 });
});
describe('真实内存服务无写入与事件边界',()=>{
 it('空身份、单人、等人、双人双方和待应对都不被误改',async()=>{
  for(const mode of ['empty','solo','waiting','host','guest','respond'])for(const text of [...cancelled,...queried,...ambiguous,...invalid]){
   const {service,rooms,calls}=setup();let key='a';
   if(mode==='solo')await service.say(key,'开始');
   if(mode==='waiting')await service.say(key,'开房');
   if(['host','guest','respond'].includes(mode)){await service.say('h','开房');await service.say('g','加入房间1000');service.status('h');key=mode==='host'?'h':'g';if(mode==='respond')await service.say('h','普攻');}
   const before=service.snapshot(key),roomCount=rooms.size;const related=service.snapshot(key==='h'?'g':'h');
   await service.say(key,text);assert.deepEqual(service.snapshot(key),before,mode+':'+text);assert.equal(rooms.size,roomCount);assert.deepEqual(service.snapshot(key==='h'?'g':'h'),related);
   if(!queried.includes(text))assert.equal(calls(),0,mode+':'+text);
  }
 });
 it('全角加入只进目标房，拒绝后等待事实仍只交付一次',async()=>{
  const {service,rooms}=setup();const opened=await service.say('h','开房');await service.say('g','开始');
  const before=service.snapshot('g');await service.say('g','加入房间1000或者1001');assert.deepEqual(service.snapshot('g'),before);assert.equal(rooms.size,1);
  const wait=service.waitEvent('h',{timeoutMs:1000});const joined=await service.say('g','接受挑战编号１０００');assert.equal(joined.reply?.room,opened.reply?.room);assert.equal(rooms.size,1);
  assert.equal((await wait).reply?.events?.filter(e=>e.t==='start').length,1);assert.equal(service.status('h').reply?.events?.length,0);
  const snapshots=[service.snapshot('h'),service.snapshot('g')];await service.say('g','别退出房间');assert.deepEqual([service.snapshot('h'),service.snapshot('g')],snapshots);
 });
});
