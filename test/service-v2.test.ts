import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { GameService } from '../src/game/service.js';
import { BattleStore } from '../src/store/battles.js';
import { RoomStore } from '../src/store/rooms.js';
import { createLogger } from '../src/log.js';
import { pvpBattleKey } from '../src/game/pvp.js';

function setup() {
  const store = new BattleStore({ ttlMs: 60000 });
  const rooms = new RoomStore({ ttlMs: 60000, random: () => 0 });
  const service = new GameService({ store, rooms, logger: createLogger('error'), random: () => 0 });
  return { service, store, rooms };
}

async function paired() {
  const fixture = setup();
  const opening = await fixture.service.say('host', '开房');
  const room = opening.reply!.room!;
  await fixture.service.say('guest', `加入房间${room}`);
  fixture.service.status('host');
  return { ...fixture, room };
}

describe('v2 authoritative service facts', () => {
  it('reports opening, choices and actual energy-denial gap', async () => {
    const { service } = setup();
    const opening = await service.say('a', '开始');
    assert.deepEqual(opening.reply?.events, [{ t: 'start', foe: '守擂教头', first: 'you' }]);
    assert.deepEqual(opening.reply?.choices, ['普攻', '强攻', '蓄力']);
    const denied = await service.say('a', '大招');
    assert.equal(denied.reply?.reason, 'no_ap');
    assert.deepEqual(denied.reply?.deny, { mv: 'ult', need: 4, short: 1 });
    assert.equal(denied.reply?.you?.ap, 3);
  });

  it('distinguishes pending from confirmed hit, and mirrors catch-up once', async () => {
    const { service } = await paired();
    const attack = await service.say('host', '强攻');
    assert.equal(attack.reply?.need, 'wait_foe');
    assert.deepEqual(attack.reply?.pending, { by: 'you', mv: 'heavy', dmg: 5 });
    assert.deepEqual(attack.reply?.events, []);
    const response = await service.say('guest', '格挡');
    const hit = response.reply?.events?.find(event => event.t === 'hit');
    assert.equal(hit?.t, 'hit');
    if (hit?.t === 'hit') {
      assert.equal(hit.by, 'foe');
      assert.equal(hit.r, 'guard');
    }
    const catchup = service.status('host', { catchUp: false }).reply!;
    assert.ok(catchup.events?.some(event => event.t === 'hit' && event.by === 'you'));
    assert.match(catchup.say!, /强攻/);
    assert.match(catchup.say!, /受到\d+点伤害/);
    assert.deepEqual(service.status('host').reply?.events, []);
  });

  it('rejects overlong raw input without executing its valid prefix', async () => {
    const { service } = setup();
    const result = await service.say('a', '开始' + ' '.repeat(200));
    assert.equal(result.reply?.reason, 'unclear');
    assert.equal(service.snapshot('a'), null);
  });

  it('keeps existing membership on invalid room join', async () => {
    const { service } = setup();
    const opened = await service.say('a', '开房');
    const refused = await service.say('a', '加入房间9999');
    assert.equal(refused.reply?.reason, 'room_missing');
    assert.equal(refused.reply?.room, opened.reply?.room);
    assert.equal(refused.reply?.need, 'wait_guest');
  });

  it('maps full-energy charge to wrong_stage with only legal choices', async () => {
    const { service, store } = setup();
    await service.say('a', '开始');
    const battle = store.get('a')!;
    battle.player.ap = battle.player.maxAp;
    store.set('a', battle);
    const result = await service.say('a', '蓄力');
    assert.equal(result.reply?.reason, 'wrong_stage');
    assert.deepEqual(result.reply?.choices, ['普攻', '强攻', '大招']);
  });

  it('retains confirmed end in catch-up exactly once', async () => {
    const { service, store, room } = await paired();
    const battle = store.get(pvpBattleKey(room))!;
    battle.enemy.hp = 1;
    store.set(pvpBattleKey(room), battle);
    await service.say('host', '普攻');
    await service.say('guest', '承受');
    const result = service.status('host').reply!;
    assert.equal(result.phase, 'victory');
    assert.ok(result.events?.some(event => event.t === 'end' && event.win === 'you'));
    assert.deepEqual(service.status('host').reply?.events, []);
  });

  for (const catchUp of [true, false]) {
    it(`does not duplicate missed hit or victory in fallback (catchUp=${catchUp})`, async () => {
      const { service, store, room } = await paired();
      const battle = store.get(pvpBattleKey(room))!;
      battle.enemy.hp = 1;
      store.set(pvpBattleKey(room), battle);
      await service.say('host', '普攻');
      await service.say('guest', '承受');
      const caught = await service.say('host', '战况如何', { catchUp });
      assert.equal(caught.reply?.events?.filter(event => event.t === 'hit').length, 1);
      assert.equal(caught.reply?.events?.filter(event => event.t === 'end').length, 1);
      assert.equal((caught.reply?.say?.match(/受到\d+点伤害/g) ?? []).length, 1);
      assert.equal((caught.reply?.say?.match(/我赢了/g) ?? []).length, 1);
      assert.doesNotMatch(caught.reply!.say!, /刚才那一手/);
      if (catchUp) assert.match(caught.text, /刚才那一手/);
    });

    it(`keeps current rejection separate from missed hit (catchUp=${catchUp})`, async () => {
      const { service } = await paired();
      await service.say('host', '普攻');
      await service.say('guest', '承受');
      const response = await service.say('host', '不要大招', { catchUp });
      assert.equal(response.reply?.reason, 'negated');
      assert.equal((response.reply?.say?.match(/受到\d+点伤害/g) ?? []).length, 1);
      assert.doesNotMatch(response.reply!.say!, /刚才那一手/);
    });
  }
});
