import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { GameService } from '../src/game/service.js';
import { createLogger } from '../src/log.js';
import { BattleStore } from '../src/store/battles.js';
import { RoomStore } from '../src/store/rooms.js';
import { pvpBattleKey } from '../src/game/pvp.js';

function setup(speakers:string[]=[]) {
  const store=new BattleStore({ttlMs:60000});
  const rooms=new RoomStore({ttlMs:60000,random:()=>0});
  const service=new GameService({store,rooms,logger:createLogger('error'),random:()=>0,speakers});
  return {service,store,rooms};
}
async function paired() {
  const fixture=setup();
  const opened=await fixture.service.say('host','发起挑战');
  await fixture.service.say('guest',`接受挑战，编号${opened.reply!.room}`);
  fixture.service.status('host');
  return {...fixture,code:opened.reply!.room!,battleId:opened.battle!.id};
}

describe('v2 notification facts, authority and shared consumption',()=>{
  it('join notification consumes confirmed start once; later wait/query cannot repeat event',async()=>{
    const {service}=setup();
    const opened=await service.say('host','发起挑战');
    await service.say('guest',`接受挑战，编号${opened.reply!.room}`);
    const options={battleId:opened.battle!.id,pushId:'join-1'};
    const result=service.notification('host','opponent-joined',options);
    assert.ok(result.reply?.events?.some(event=>event.t==='start'));
    assert.equal(result.reply?.need,'move');
    assert.deepEqual(service.notification('host','opponent-joined',options).reply,{v:2,ok:true,silent:true});
    assert.equal((await service.waitEvent('host',{timeoutMs:1})).reply?.silent,true);
    assert.deepEqual(service.status('host').reply?.events,[]);
  });
  it('wait delivery wins the join race and suppresses late notification',async()=>{
    const {service}=setup();
    const opened=await service.say('host','发起挑战');
    const waiting=service.waitEvent('host',{timeoutMs:100});
    await service.say('guest',`接受挑战，编号${opened.reply!.room}`);
    assert.ok((await waiting).reply?.events?.some(event=>event.t==='start'));
    assert.equal(service.notification('host','opponent-joined',{battleId:opened.battle!.id,pushId:'late'}).reply?.silent,true);
  });
  it('query delivery suppresses a matching opponent-move notification',async()=>{
    const {service,battleId}=await paired();
    await service.say('host','蓄力');
    await service.say('guest','强攻');
    const status=service.status('host');
    assert.equal(status.reply?.pending?.by,'foe');
    assert.equal(service.notification('host','opponent-move',{battleId,pushId:'late-move'}).reply?.silent,true);
  });
  it('opponent-move provides pending facts, not a fabricated hit or damage result',async()=>{
    const {service,battleId}=await paired();
    await service.say('host','蓄力');
    await service.say('guest','强攻');
    const before=service.snapshot('host');
    const result=service.notification('host','opponent-move',{battleId,pushId:'move'});
    assert.equal(result.reply?.need,'respond');assert.equal(result.reply?.pending?.mv,'heavy');
    assert.ok(!result.reply?.events?.some(event=>event.t==='hit'));
    assert.deepEqual(service.snapshot('host'),before);
    assert.equal(service.notification('host','opponent-move',{battleId,pushId:'move-again'}).reply?.silent,true);
  });
  it('stale battle and wrong phase are silent without consuming current start',async()=>{
    const {service}=setup();
    const old=await service.say('host','发起挑战');
    const next=await service.say('host','开始');
    assert.notEqual(next.battle!.id,old.battle!.id);
    assert.equal(service.notification('host','opponent-joined',{battleId:old.battle!.id,pushId:'old'}).reply?.silent,true);
    assert.equal(service.notification('host','wait-guest',{battleId:next.battle!.id,pushId:'wrong'}).reply?.silent,true);
    assert.equal(service.snapshot('host')?.state.mode,'solo');
  });
  it('all reminder kinds validate real need/resources and replay ids',async()=>{
    const {service,store}=setup();
    const opened=await service.say('host','发起挑战');
    const id=opened.battle!.id;
    assert.equal(service.notification('host','wait-guest',{battleId:id,pushId:'guest1'}).reply?.need,'wait_guest');
    assert.equal(service.notification('host','wait-guest',{battleId:id,pushId:'guest1'}).reply?.silent,true);
    await service.say('guest',`接受挑战，编号${opened.reply!.room}`);
    service.status('host');
    assert.equal(service.notification('host','idle-turn',{battleId:id,pushId:'idle1'}).reply?.need,'move');
    assert.equal(service.notification('host','ult-ready',{battleId:id,pushId:'no-ult'}).reply?.silent,true);
    const battle=store.get(pvpBattleKey(opened.reply!.room!))!;
    store.set(pvpBattleKey(opened.reply!.room!),{...battle,player:{...battle.player,ap:4}});
    assert.ok(service.notification('host','ult-ready',{battleId:id,pushId:'ready'}).reply?.choices?.includes('大招'));
    await service.say('host','强攻');
    assert.equal(service.notification('host','wait-opponent',{battleId:id,pushId:'waiting'}).reply?.need,'wait_foe');
    assert.equal(service.notification('guest','idle-respond',{battleId:id,pushId:'responding'}).reply?.need,'respond');
  });
  it('unrecognized/wrong-seat speaker cannot consume pending start via wait or notification',async()=>{
    const {service}=setup(['阿澈','阿岚']);
    const opened=await service.say('host','发起挑战',{speaker:'阿澈'});
    await service.say('guest',`接受挑战，编号${opened.reply!.room}`,{speaker:'阿岚'});
    const options={battleId:opened.battle!.id,pushId:'unauthorized'};
    assert.equal(service.notification('host','opponent-joined',{...options,speaker:'阿岚'}).reply?.silent,true);
    assert.equal((await service.waitEvent('host',{speaker:'陌生人'})).reply?.silent,true);
    assert.ok(service.status('host',{speaker:'阿澈'}).reply?.events?.some(event=>event.t==='start'));
  });
  it('cancelled wait is silent and leaves later start for notification',async()=>{
    const {service}=setup();
    const opened=await service.say('host','发起挑战');
    const controller=new AbortController();
    const waiting=service.waitEvent('host',{signal:controller.signal,timeoutMs:100});
    controller.abort();
    assert.deepEqual((await waiting).reply,{v:2,ok:true,silent:true});
    await service.say('guest',`接受挑战，编号${opened.reply!.room}`);
    assert.ok(service.notification('host','opponent-joined',{battleId:opened.battle!.id,pushId:'after-abort'}).reply?.events?.some(event=>event.t==='start'));
  });
  it('resource-ready reminder during response never claims ultimate currently executable',async()=>{
    const {service,battleId}=await paired();await service.say('host','蓄力');await service.say('guest','强攻');
    const result=service.notification('host','ult-ready',{battleId,pushId:'ready-but-respond'});
    assert.equal(result.reply?.need,'respond');assert.ok(!result.reply?.choices?.includes('大招'));
    assert.match(result.reply?.say??'',/等轮到主动行动/);
  });

  it('help does not mark unspoken pending state delivered or suppress later wait/notification',async()=>{
    for(const channel of ['notify','wait']){
      const {service,battleId}=await paired();await service.say('host','蓄力');await service.say('guest','强攻');
      const help=await service.say('host','怎么玩');assert.ok(help.reply?.text);assert.deepEqual(help.reply?.events,[]);
      const next=channel==='notify'?service.notification('host','opponent-move',{battleId,pushId:'after-help'}):await service.waitEvent('host');
      assert.equal(next.reply?.need,'respond');assert.notEqual(next.reply?.silent,true);
    }
  });

});
