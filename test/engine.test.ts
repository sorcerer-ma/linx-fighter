import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { advanceBattle, createBattle, DEFAULT_ENEMY_NAME, resolveTurn } from '../src/game/engine.js';
import { canonicalize, viewAs } from '../src/game/pvp.js';
import { RULES, roundDamageBonus } from '../src/game/rules.js';
import type { ActionId, Battle, BattleAI, BattleEvent, TurnDeps } from '../src/game/types.js';

/** 固定随机数：0.99 永不闪避、永不暴击，便于断言确定性结果 */
const NO_LUCK = (): number => 0.99;
/** 固定随机数：0 必定闪避、必定暴击 */
const ALL_LUCK = (): number => 0;

const LOCKED: TurnDeps = { random: NO_LUCK };

function playerFirst(seed = 42): Battle {
  return createBattle({ now: 0, seed, firstMover: 'player' });
}

function enemyFirst(seed = 43): Battle {
  return createBattle({ now: 0, seed, firstMover: 'enemy' });
}

/** 执行一次操作，返回结算后的新对局（resolveTurn 不改入参） */
async function turn(battle: Battle, action: ActionId, deps: TurnDeps = LOCKED): Promise<Battle> {
  const result = await resolveTurn(battle, action, 1, deps);
  assert.equal(result.rejection, undefined, `不应被拒绝：${result.rejection?.reason}`);
  return result.battle;
}

const alwaysGuard: BattleAI = { chooseAction: () => 'light', chooseResponse: () => 'guard' };
const alwaysDodge: BattleAI = { chooseAction: () => 'light', chooseResponse: () => 'dodge' };

/** 从事件流里取第一段攻击事件，供断言使用 */
function firstAttack(events: BattleEvent[]): Extract<BattleEvent, { type: 'attack' }> {
  const event = events[0];
  assert.ok(event && event.type === 'attack', '第一条事件应为攻击结算');
  return event;
}

describe('对局初始化', () => {
  it('先手 14点生命值、后手 18点生命值，双方 3 点能量、1 次大招', async () => {
    const battle = playerFirst();
    assert.equal(battle.round, 1);
    assert.equal(battle.phase, 'battle');
    assert.equal(battle.mode, 'solo');
    assert.equal(battle.firstMover, 'player');
    assert.equal(battle.active, 'player');
    assert.equal(battle.player.hp, 14);
    assert.equal(battle.player.maxHp, 14);
    assert.equal(battle.enemy.hp, 18);
    assert.equal(battle.enemy.maxHp, 18);
    assert.equal(battle.player.ap, RULES.initialAp);
    assert.equal(battle.enemy.ap, RULES.initialAp);
    assert.equal(battle.player.ultLeft, 1);
    assert.equal(battle.enemy.ultLeft, 1);
    assert.equal(battle.enemy.name, DEFAULT_ENEMY_NAME);
    assert.deepEqual(battle.history, []);
  });

  it('后手时生命值对调，先手方先动', async () => {
    const battle = enemyFirst();
    assert.equal(battle.firstMover, 'enemy');
    assert.equal(battle.active, 'enemy');
    assert.equal(battle.player.hp, 18);
    assert.equal(battle.enemy.hp, 14);
  });

  it('同一种子与先手必然生成同一初始局面（id 与时间除外）', async () => {
    const strip = (battle: Battle) => ({
      seed: battle.seed,
      round: battle.round,
      player: battle.player,
      enemy: battle.enemy,
      firstMover: battle.firstMover,
      active: battle.active,
    });
    assert.deepEqual(strip(playerFirst(20261026)), strip(playerFirst(20261026)));
    assert.notDeepEqual(playerFirst(20261026), playerFirst(20261027));
  });

  it('先手为对手时，advanceBattle 会先把对手的主动阶段跑完', async () => {
    const result = await advanceBattle(enemyFirst(), 1, LOCKED);
    assert.equal(result.battle.pending?.actor, 'enemy');
    assert.equal(result.battle.pending?.move, 'heavy');
    assert.deepEqual(
      result.events.map((event) => event.type),
      ['pending'],
    );
  });
});

describe('主动阶段与应对结算', () => {
  it('普攻锁定伤害 3，对手 AI 格挡后掉 1 点，随后对手普攻待应对', async () => {
    const battle = playerFirst();
    const result = await resolveTurn(battle, 'light', 1, LOCKED);
    const next = result.battle;

    assert.equal(next.enemy.hp, 17);
    assert.equal(next.player.ap, 2);
    assert.equal(next.player.hp, 14);
    assert.equal(next.round, 1);

    const attack = firstAttack(result.events);
    assert.equal(attack.side, 'player');
    assert.equal(attack.move, 'light');
    assert.equal(attack.response, 'guard');
    assert.equal(attack.crit, false);
    assert.equal(attack.damage, 1);
    assert.equal(attack.targetHp, 17);

    // 对手进入主动阶段，决策模型选择普攻，锁定后等玩家格挡/闪避/承受
    assert.equal(next.pending?.actor, 'enemy');
    assert.equal(next.pending?.move, 'light');
    assert.equal(next.pending?.damage, 3);
    assert.equal(next.active, 'enemy');
    assert.deepEqual(
      result.events.map((event) => event.type),
      ['attack', 'pending'],
    );
  });

  it('应对对手普攻：格挡后掉 1 点，进入第 2 轮并按规则回复能量', async () => {
    const afterAttack = await turn(playerFirst(), 'light');
    const result = await resolveTurn(afterAttack, 'guard', 2, LOCKED);
    const next = result.battle;

    assert.equal(result.rejection, undefined);
    assert.equal(next.player.hp, 13);
    // 格挡花 1 点，第二轮开始回复 2 点
    assert.equal(next.player.ap, 3);
    assert.equal(next.round, 2);
    assert.equal(next.active, 'player');
    assert.equal(next.pending, null);
    assert.deepEqual(
      result.events.map((event) => event.type),
      ['attack', 'round-start'],
    );
    assert.equal(next.history[0]!.actor, 'player');
    assert.equal(next.history[1]!.response, 'guard');
  });

  it('暴击额外造成 2 点伤害', async () => {
    const battle = await turn(playerFirst(), 'light', { random: ALL_LUCK });
    const attack = battle.history[0]!;
    assert.equal(attack.crit, true);
    assert.equal(attack.damage, 3);
    assert.equal(battle.enemy.hp, 15);
  });

  it('闪避判定成功时不损失生命值，但照样消耗 1 点能量', async () => {
    const result = await resolveTurn(playerFirst(), 'light', 1, { random: () => 0.1, ai: alwaysDodge });
    const next = result.battle;
    const attack = firstAttack(result.events);
    assert.equal(attack.dodged, true);
    assert.equal(attack.damage, 0);
    assert.equal(next.enemy.hp, 18);
    // 闪避花 1 点，对手接着主动普攻再花 1 点
    assert.equal(next.enemy.ap, 1);
  });

  it('暴击判定在闪避失败之后，闪避失败仍可能暴击', async () => {
    // 第一抽 0.9 闪避失败，第二抽 0 判成暴击
    const values = [0.9, 0];
    const result = await resolveTurn(playerFirst(), 'light', 1, {
      random: () => values.shift() ?? 0.99,
      ai: alwaysDodge,
    });
    const attack = firstAttack(result.events);
    assert.equal(attack.dodged, false);
    assert.equal(attack.crit, true);
    assert.equal(attack.damage, 5);
    assert.equal(result.battle.enemy.hp, 13);
  });

  it('防守方没有能量时强制硬扛，不等待应对', async () => {
    const battle = playerFirst();
    battle.enemy.ap = 0;
    const result = await resolveTurn(battle, 'light', 1, LOCKED);

    const attack = firstAttack(result.events);
    assert.equal(attack.response, 'take');
    assert.equal(attack.forced, true);
    assert.equal(attack.damage, 3);
    assert.equal(result.battle.enemy.hp, 15);
    // 对手能量耗尽后会先蓄力，对局仍可继续
    assert.equal(result.battle.round, 2);
    assert.equal(result.battle.pending, null);
    assert.ok(result.events.some((event) => event.type === 'charge'));
  });

  it('格挡把这一击的伤害固定减 2，最低掉 0 点', async () => {
    const battle = playerFirst();
    const result = await resolveTurn(battle, 'light', 1, { ai: alwaysGuard, random: NO_LUCK });
    assert.equal(firstAttack(result.events).damage, 1);
  });
});

describe('能量与招式限制', () => {
  it('动作点不足时不出招、不推进回合', async () => {
    const battle = playerFirst();
    battle.player.ap = 1;
    const result = await resolveTurn(battle, 'heavy', 1, LOCKED);
    assert.equal(result.rejection?.reason, 'insufficient-ap');
    assert.equal(result.battle, battle);
    assert.equal(result.battle.round, 1);
    assert.equal(result.battle.player.ap, 1);
    assert.equal(result.battle.rngDraws, 0);
  });

  it('能量满时不能再蓄力', async () => {
    const battle = playerFirst();
    battle.player.ap = RULES.maxAp;
    const result = await resolveTurn(battle, 'charge', 1);
    assert.equal(result.rejection?.reason, 'full-ap');
    assert.equal(result.battle.player.ap, RULES.maxAp);
  });

  it('蓄力加 1 点能量并交出主动阶段', async () => {
    const result = await resolveTurn(playerFirst(), 'charge', 1);
    assert.equal(result.battle.player.ap, 4);
    assert.equal(result.events[0]!.type, 'charge');
    // 单人模式下对手接着行动
    assert.equal(result.battle.active, 'enemy');
  });

  it('一局只能开一次大招；次数用光后拒绝', async () => {
    const battle = playerFirst();
    battle.player.ap = 5;
    const spent = await resolveTurn(battle, 'ult', 1, LOCKED);
    assert.equal(spent.rejection, undefined);
    assert.equal(spent.battle.player.ultLeft, 0);
    assert.equal(spent.battle.player.ap, 1);

    const again = await resolveTurn(
      { ...spent.battle, player: { ...spent.battle.player, ap: 5 }, pending: null, active: 'player' },
      'ult',
      2,
      LOCKED,
    );
    assert.equal(again.rejection?.reason, 'no-ult');
  });

  it('第 3 轮起攻击伤害每轮加 2', async () => {
    assert.equal(roundDamageBonus(1), 0);
    assert.equal(roundDamageBonus(2), 0);
    assert.equal(roundDamageBonus(3), 2);
    assert.equal(roundDamageBonus(4), 4);

    // 双人模式不自动结算应对，能直接看到锁定伤害
    const battle = createBattle({ now: 0, seed: 1, firstMover: 'player', mode: 'pvp' });
    battle.round = 3;
    const result = await resolveTurn(battle, 'light', 1);
    assert.equal(result.battle.pending?.damage, 5);
  });
});

describe('回合与胜负', () => {
  it('操作不合法时原样返回对局，不推进回合、不消耗随机数', async () => {
    const battle = enemyFirst();
    const result = await resolveTurn(battle, 'light', 1, LOCKED);
    assert.equal(result.rejection?.reason, 'wrong-stage');
    assert.equal(result.battle, battle);
    assert.equal(result.events.length, 0);
    assert.equal(battle.rngDraws, 0);
  });

  it('对局结束后拒绝继续出招', async () => {
    const battle = playerFirst();
    battle.phase = 'victory';
    const result = await resolveTurn(battle, 'light', 1);
    assert.equal(result.rejection?.reason, 'ended');
    assert.equal(result.battle, battle);
  });

  it('把对手打到 0点生命值判胜，并写入终局事件', async () => {
    const battle = playerFirst();
    battle.enemy.hp = 1;
    const result = await resolveTurn(battle, 'light', 1, LOCKED);
    assert.equal(result.battle.phase, 'victory');
    assert.equal(result.battle.enemy.hp, 0);
    assert.ok(result.events.some((event) => event.type === 'end'));
    assert.equal(result.events.at(-1)?.type, 'end');
  });

  it('玩家被击倒判负', async () => {
    const battle = enemyFirst();
    battle.player.hp = 1;
    battle.pending = { actor: 'enemy', move: 'heavy', damage: 5 };
    const result = await resolveTurn(battle, 'take', 1, LOCKED);
    assert.equal(result.battle.phase, 'defeat');
    assert.equal(result.battle.player.hp, 0);
    assert.equal(result.events.at(-1)?.type, 'end');
  });

  it('结算不改动入参，返回新的对局对象', async () => {
    const battle = playerFirst();
    const snapshot = structuredClone(battle);
    const result = await resolveTurn(battle, 'light', 1, LOCKED);
    assert.deepEqual(battle, snapshot);
    assert.notEqual(result.battle, battle);
  });

  it('同一种子与同一输入序列必然复现同一局面', async () => {
    const play = async (battle: Battle): Promise<Battle> => {
      const a = (await resolveTurn(battle, 'light', 1, { random: () => 0.5 })).battle;
      const b = (await resolveTurn(a, 'guard', 2, { random: () => 0.5 })).battle;
      return (await resolveTurn(b, 'heavy', 3, { random: () => 0.5 })).battle;
    };
    const a = await play(playerFirst(777));
    const b = await play(playerFirst(777));
    assert.deepEqual(
      { round: a.round, hp: [a.player.hp, a.enemy.hp], ap: [a.player.ap, a.enemy.ap], rng: a.rngDraws },
      { round: b.round, hp: [b.player.hp, b.enemy.hp], ap: [b.player.ap, b.enemy.ap], rng: b.rngDraws },
    );
  });

  it('战报只保留最近 30 条', async () => {
    const battle = playerFirst();
    for (let index = 0; index < 40; index += 1) {
      battle.history.push({ round: 1, actor: 'player', action: 'light', createdAt: index });
    }
    const result = await resolveTurn(battle, 'light', 1, LOCKED);
    assert.ok(result.battle.history.length <= 30);
  });
});

describe('双人联机', () => {
  it('双人模式不自动结算应对，等另一位玩家输入', async () => {
    const canonical = createBattle({ now: 0, seed: 1, firstMover: 'player', mode: 'pvp' });
    const hostTurn = await resolveTurn(canonical, 'light', 1);
    assert.equal(hostTurn.rejection, undefined);
    assert.equal(hostTurn.battle.enemy.hp, 18);
    assert.equal(hostTurn.battle.pending?.actor, 'player');
    assert.equal(hostTurn.battle.pending?.damage, 3);
    assert.deepEqual(
      hostTurn.events.map((event) => event.type),
      ['pending'],
    );

    // 另一位玩家看到的是镜像局面：自己是 player，对手是 enemy
    const guestView = viewAs(hostTurn.battle, 'enemy');
    assert.equal(guestView.player.hp, 18);
    assert.equal(guestView.enemy.name, '对手');
    assert.equal(guestView.pending?.actor, 'enemy');
    const guestTurn = await resolveTurn(guestView, 'guard', 2);
    assert.equal(guestTurn.battle.player.hp, 17);
    assert.equal(guestTurn.battle.player.ap, 2);
    assert.equal(guestTurn.battle.round, 1);
    assert.equal(guestTurn.battle.active, 'player');

    // 写回基准视角：房主是对手，损失生命值与轮次一致
    const next = canonicalize(guestTurn.battle, 'enemy', hostTurn.battle);
    assert.equal(next.enemy.hp, 17);
    assert.equal(next.enemy.ap, 2);
    assert.equal(next.active, 'enemy');
    assert.equal(next.pending, null);
  });

  it('自己刚出招时再输入应对会被拒绝，不能替对手结算', async () => {
    const canonical = createBattle({ now: 0, seed: 1, firstMover: 'player', mode: 'pvp' });
    const hostTurn = await resolveTurn(canonical, 'light', 1);
    assert.equal(hostTurn.battle.pending?.actor, 'player');

    const again = await resolveTurn(hostTurn.battle, 'guard', 2);
    assert.equal(again.rejection?.reason, 'waiting-opponent');
    assert.equal(again.battle, hostTurn.battle);
    assert.equal(again.battle.pending?.actor, 'player');
    assert.equal(again.events.length, 0);
  });

  it('双人模式下 advanceBattle 不会代跑对手阶段', async () => {
    const battle = createBattle({ now: 0, seed: 1, firstMover: 'enemy', mode: 'pvp' });
    const result = await advanceBattle(battle, 1);
    assert.equal(result.battle.active, 'enemy');
    assert.equal(result.battle.pending, null);
    assert.deepEqual(result.events, []);
  });
});
