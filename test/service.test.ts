import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createBattle } from '../src/game/engine.js';
import { GameService, type GameServiceDeps } from '../src/game/service.js';
import { createLogger } from '../src/log.js';
import { BattleStore } from '../src/store/battles.js';
import { RoomStore } from '../src/store/rooms.js';

const KEY = 'device-a#agent-1';

function setup(overrides: Partial<GameServiceDeps> = {}) {
  let now = 1_000_000;
  const store = new BattleStore({ ttlMs: 60_000, now: () => now });
  const rooms = new RoomStore({ ttlMs: 60_000, now: () => now, random: () => 0 });
  const service = new GameService({
    store,
    rooms,
    logger: createLogger('error'),
    now: () => now,
    random: () => 0,
    ...overrides,
  });
  return {
    store,
    rooms,
    service,
    advance(ms: number): void {
      now += ms;
    },
  };
}

describe('游戏服务', () => {
  it('开局生成对局与初始属性', () => {
    const { service } = setup();
    const result = service.start(KEY);

    assert.ok(result.battle);
    assert.equal(result.battle.round, 1);
    assert.equal(result.battle.phase, 'battle');
    assert.equal(result.battle.firstMover, 'player');
    assert.equal(result.battle.active, 'player');
    assert.equal(result.battle.player.hp, 14);
    assert.equal(result.battle.player.maxHp, 14);
    assert.equal(result.battle.player.ap, 3);
    assert.equal(result.battle.enemy.hp, 18);
    assert.equal(result.battle.enemy.name, '守擂教头');
    assert.deepEqual(result.battle.history, []);
    assert.match(result.text, /对决开始/);
    assert.match(result.text, /守擂教头/);
    assert.match(result.text, /你先手/);
  });

  it('开局可以指定对手名字', () => {
    const { service } = setup();
    const result = service.start(KEY, { opponent: '阿青' });
    assert.equal(result.battle?.enemy.name, '阿青');
    assert.match(result.text, /阿青/);
  });

  it('出招推进回合并记录战报，应对阶段再结算', () => {
    const { service } = setup();
    service.start(KEY);

    const first = service.act(KEY, '普攻');
    assert.equal(first.battle?.round, 1);
    assert.equal(first.battle?.history.length, 1);
    assert.equal(first.battle?.history[0]?.actor, 'player');
    assert.equal(first.battle?.history[0]?.action, 'light');
    assert.deepEqual(first.battle?.pending, { actor: 'enemy', move: 'heavy', damage: 5 });
    assert.equal(first.battle?.player.ap, 2);
    assert.equal(first.battle?.enemy.hp, 17);
    assert.match(first.text, /普攻/);
    assert.match(first.text, /已锁定/);

    const second = service.act(KEY, '格挡');
    assert.equal(second.battle?.round, 2);
    assert.equal(second.battle?.pending, null);
    assert.equal(second.battle?.active, 'player');
    assert.equal(second.battle?.player.hp, 11);
    assert.equal(second.battle?.player.ap, 3);
    assert.equal(second.battle?.history.length, 2);
    assert.match(second.text, /格挡/);
  });

  it('招式认不出来时不改对局、只提示可选说法', () => {
    const { service } = setup();
    service.start(KEY);

    const result = service.act(KEY, '跳舞');
    assert.equal(result.battle?.round, 1);
    assert.equal(result.battle?.history.length, 0);
    assert.match(result.text, /没听清/);
    assert.match(result.text, /普攻/);
  });

  it('没有对局时直接出招会自动开局', () => {
    const { service } = setup();
    const result = service.act(KEY, '我要攻击');

    assert.equal(result.battle?.round, 1);
    assert.equal(result.battle?.history.length, 1);
    assert.match(result.text, /先开一局/);
    assert.match(result.text, /普攻/);
  });

  it('不同设备的对局互不影响', () => {
    const { service } = setup();
    service.start(KEY);
    service.act(KEY, '普攻');

    const other = service.status('device-b#agent-1');
    assert.equal(other.battle, null);
    assert.match(other.text, /没有进行中的对局/);

    const mine = service.status(KEY);
    assert.equal(mine.battle?.round, 1);
  });

  it('已结束的对局不再接受出招', () => {
    const { service, store } = setup();
    const started = service.start(KEY);
    store.set(KEY, { ...started.battle!, phase: 'victory' });

    const result = service.act(KEY, '攻击');
    assert.equal(result.battle?.phase, 'victory');
    assert.equal(result.battle?.history.length, 0);
    assert.match(result.text, /你赢了/);
  });

  it('念唤出指令时先回念一句再播报回合', () => {
    const { service } = setup();
    service.start(KEY);

    const result = service.act(KEY, '共鸣斩破军');
    assert.equal(result.battle?.history.length, 1);
    assert.match(result.text, /你朗声喝道：「共鸣斩破军」/);
    assert.match(result.text, /普攻/);
  });

  it('战败与未知状态都有对应播报', () => {
    const { service, store } = setup();
    const battle = service.start(KEY).battle!;

    store.set(KEY, { ...battle, phase: 'defeat' });
    assert.match(service.act(KEY, '攻击').text, /你输了/);

    store.set(KEY, { ...battle, phase: 'unknown' as typeof battle.phase });
    assert.match(service.act(KEY, '攻击').text, /这一局已经结束/);
  });

  it('待应对阶段出主动招式会被挡回', () => {
    const { service } = setup();
    service.start(KEY);
    service.act(KEY, '普攻');

    const result = service.act(KEY, '攻击');
    assert.equal(result.battle?.round, 1);
    assert.deepEqual(result.battle?.pending, { actor: 'enemy', move: 'heavy', damage: 5 });
    assert.match(result.text, /只能应对/);
  });

  it('真气不足与真气已满都不会改对局', () => {
    const { service, store } = setup();
    const battle = createBattle({ now: 1_000_000, seed: 0, firstMover: 'player' });

    store.set(KEY, { ...battle, player: { ...battle.player, ap: 1 } });
    const low = service.act(KEY, '强攻');
    assert.equal(low.battle?.player.ap, 1);
    assert.equal(low.battle?.history.length, 0);
    assert.match(low.text, /真气不够/);

    store.set(KEY, { ...battle, player: { ...battle.player, ap: 5 } });
    const full = service.act(KEY, '蓄力');
    assert.equal(full.battle?.player.ap, 5);
    assert.match(full.text, /已经满了/);
  });

  it('对手先手时开局先亮出它的招式', () => {
    const { service } = setup({ random: () => 0.5 });
    const started = service.start(KEY);

    assert.equal(started.battle?.firstMover, 'enemy');
    assert.deepEqual(started.battle?.pending, { actor: 'enemy', move: 'heavy', damage: 5 });
    assert.match(started.text, /对手先手/);
    assert.match(started.text, /强攻/);

    const responded = service.act(KEY, '闪避');
    assert.equal(responded.battle?.pending, null);
    assert.equal(responded.battle?.active, 'player');
    // 首个主动阶段不回气：3 - 1（闪避）= 2
    assert.equal(responded.battle?.player.ap, 2);
    assert.match(responded.text, /闪/);
  });

  it('玩法说明不需要对局', () => {
    const { service } = setup();
    const result = service.help();
    assert.equal(result.battle, null);
    assert.match(result.text, /普攻/);
    assert.match(result.text, /开始游戏/);
  });
});
