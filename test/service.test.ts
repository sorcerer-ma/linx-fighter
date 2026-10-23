import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DEFAULT_ENEMY_NAME, INITIAL_HP } from '../src/game/engine.js';
import { GameService } from '../src/game/service.js';
import { createLogger } from '../src/log.js';
import { BattleStore } from '../src/store/battles.js';

const KEY = 'device-a#agent-1';

function setup() {
  let now = 1_000_000;
  const store = new BattleStore({ ttlMs: 60_000, now: () => now });
  const service = new GameService({
    store,
    logger: createLogger('error'),
    now: () => now,
    random: () => 0.5,
  });
  return {
    store,
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
    assert.equal(result.battle.turn, 0);
    assert.equal(result.battle.phase, 'battle');
    assert.equal(result.battle.player.hp, INITIAL_HP);
    assert.equal(result.battle.player.maxHp, INITIAL_HP);
    assert.equal(result.battle.enemy.name, DEFAULT_ENEMY_NAME);
    assert.match(result.text, /对决开始/);
    assert.match(result.text, /守擂教头/);
  });

  it('出招推进回合并记录战报', () => {
    const { service } = setup();
    service.start(KEY);

    const first = service.act(KEY, '攻击');
    assert.equal(first.battle?.turn, 1);
    assert.equal(first.battle?.history.length, 1);
    assert.equal(first.battle?.history[0]?.playerAction, 'attack');
    assert.match(first.text, /第 1 回合/);
    assert.match(first.text, /攻击/);

    const second = service.act(KEY, 'attack');
    assert.equal(second.battle?.turn, 2);
    assert.equal(second.battle?.history[1]?.playerAction, 'attack');

    const third = service.act(KEY, '闪避');
    assert.equal(third.battle?.turn, 3);
    assert.equal(third.battle?.history[2]?.playerAction, 'dodge');
    assert.match(third.text, /闪避/);
  });

  it('招式认不出来时不推进回合', () => {
    const { service } = setup();
    service.start(KEY);
    service.act(KEY, '攻击');

    const result = service.act(KEY, '跳舞');
    assert.equal(result.battle?.turn, 1);
    assert.match(result.text, /没听清/);
    assert.match(result.text, /第 1 回合/);
  });

  it('没有对局时直接出招会自动开局', () => {
    const { service } = setup();
    const result = service.act(KEY, '我要攻击');

    assert.equal(result.battle?.turn, 1);
    assert.match(result.text, /先给你开了一局/);
    assert.match(result.text, /第 1 回合/);
  });

  it('不同设备的对局互不影响', () => {
    const { service } = setup();
    service.start(KEY);
    service.act(KEY, '攻击');

    const other = service.status('device-b#agent-1');
    assert.equal(other.battle, null);
    assert.match(other.text, /没有进行中的对局/);

    const mine = service.status(KEY);
    assert.equal(mine.battle?.turn, 1);
  });

  it('已结束的对局不再接受出招', () => {
    const { service, store } = setup();
    const started = service.start(KEY);
    assert.ok(started.battle);
    store.set(KEY, { ...started.battle, phase: 'victory' });

    const result = service.act(KEY, '攻击');
    assert.equal(result.battle?.turn, 0);
    assert.match(result.text, /你赢了/);
  });

  it('玩法说明不需要对局', () => {
    const { service } = setup();
    const result = service.help();
    assert.equal(result.battle, null);
    assert.match(result.text, /攻击/);
    assert.match(result.text, /开始游戏/);
  });
});
