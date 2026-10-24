/**
 * 对手 AI（守擂教头）的决策模型测试。
 *
 * 两条线：用构造的 view 钉住关键战术决策；再用 engine 跑自对弈，确认整局每一步都合法、
 * 打得完。自对弈里玩家位是改造前的启发式（已经从 src 移除，留在这里当对拍基线），
 * 随机数换成固定种子的 LCG，同一个种子必然跑出同一局。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ENEMY_AI } from '../src/game/enemy.js';
import { advanceBattle, createBattle, resolveTurn } from '../src/game/engine.js';
import { ATTACKS, CRIT_BONUS, RESPONSES, RULES, roundDamageBonus } from '../src/game/rules.js';
import type {
  ActionId,
  ActionView,
  ActiveActionId,
  AttackMove,
  Battle,
  LocalBattleAI,
  FighterView,
  ResponseMove,
  ResponseView,
  Side,
} from '../src/game/types.js';

/** 造一个主动阶段的 view：默认双方满血、3 点行动点、各留一次大招 */
function activeView(
  parts: {
    self?: Partial<FighterView>;
    enemy?: Partial<FighterView>;
    round?: number;
  } = {},
): ActionView {
  const round = parts.round ?? 1;
  return {
    round,
    bonus: roundDamageBonus(round),
    self: { hp: 18, ap: 3, ultLeft: 1, ...parts.self },
    enemy: { hp: 18, ap: 3, ultLeft: 1, ...parts.enemy },
  };
}

/** 造一个应对阶段的 view：damage 是引擎已锁定的伤害（含当轮加成） */
function responseView(
  parts: {
    self?: Partial<FighterView>;
    move?: AttackMove;
    damage?: number;
    round?: number;
  } = {},
): ResponseView {
  const move = parts.move ?? 'light';
  const spec = ATTACKS[move];
  const round = parts.round ?? 1;
  return {
    round,
    bonus: roundDamageBonus(round),
    self: { hp: 18, ap: 3, ultLeft: 1, ...parts.self },
    attacker: { hp: 18, ap: 3, ultLeft: 1 },
    move,
    damage: parts.damage ?? spec.damage + roundDamageBonus(round),
    critChance: spec.critChance,
    dodgeChance: spec.dodgeChance,
  };
}

/** 与 engine 的合法性判定一致：行动点够、大招还有次数、蓄力不超上限 */
function isLegalAction(view: ActionView, action: ActiveActionId): boolean {
  if (action === 'charge') return view.self.ap < RULES.maxAp;
  if (view.self.ap < ATTACKS[action].apCost) return false;
  return action !== 'ult' || view.self.ultLeft > 0;
}

/** 应对：承受永远合法，格挡与闪避各要 1 点行动点 */
function isLegalResponse(view: ResponseView, response: ResponseMove): boolean {
  return response === 'take' || view.self.ap >= RESPONSES[response].apCost;
}

test('主动阶段：对手进了大招收割线就开大', () => {
  // 大招 9 点，对手 5 血就算格挡也吃 7 点，必死
  assert.equal(ENEMY_AI.chooseAction(activeView({ self: { ap: 4 }, enemy: { hp: 5 } })), 'ult');
  // 当轮加成把大招推到 13 点，9 血的对手同样在收割线内
  assert.equal(ENEMY_AI.chooseAction(activeView({ self: { ap: 4 }, enemy: { hp: 9 }, round: 4 })), 'ult');
});

test('主动阶段：大招差行动点时先蓄力补上', () => {
  // 3 点行动点打不出大招，蓄力后回气正好凑够 4 点，下一轮就能收割
  assert.equal(ENEMY_AI.chooseAction(activeView({ self: { ap: 3 }, enemy: { hp: 9 } })), 'charge');
  assert.equal(ENEMY_AI.chooseAction(activeView({ self: { ap: 2 }, enemy: { hp: 9 } })), 'charge');
});

test('主动阶段：行动点见底只能蓄力', () => {
  // 0 点连普攻都出不起；1 点出击会把行动点花光，下个阶段只能白挨一下
  assert.equal(ENEMY_AI.chooseAction(activeView({ self: { ap: 0 } })), 'charge');
  assert.equal(ENEMY_AI.chooseAction(activeView({ self: { ap: 1 } })), 'charge');
});

test('主动阶段：不把行动点花光，留一点应对下一击', () => {
  // 2 点打强攻刚好清零，对手下一手没人应对；普攻能留 1 点
  assert.equal(ENEMY_AI.chooseAction(activeView({ self: { ap: 2 }, enemy: { hp: 14 } })), 'light');
  // 3 点打强攻还剩 1 点，够格挡或闪避，这时强攻才划算
  assert.equal(ENEMY_AI.chooseAction(activeView({ self: { ap: 3 }, enemy: { hp: 14 } })), 'heavy');
});

test('主动阶段：满血对峙不急着交大招', () => {
  // 对手满血时大招打不死，交了既押上 4 点行动点又丢了大招威慑
  assert.equal(ENEMY_AI.chooseAction(activeView({ self: { ap: 4 }, enemy: { hp: 14 } })), 'heavy');
  // 行动点已经满，攒不出更多，再捏着大招就是浪费，换血也要换
  assert.equal(ENEMY_AI.chooseAction(activeView({ self: { ap: 5 }, enemy: { hp: 18 } })), 'ult');
});

test('主动阶段：大招用完之后不会再选大招', () => {
  assert.equal(ENEMY_AI.chooseAction(activeView({ self: { ap: 5, ultLeft: 0 } })), 'heavy');
  assert.equal(
    ENEMY_AI.chooseAction(activeView({ self: { ap: 4, ultLeft: 0 }, enemy: { hp: 5 } })),
    'heavy',
  );
});

test('应对：普攻用格挡，强攻用闪避', () => {
  // 普攻 3 点：格挡稳定减 2，期望吃 1.4；闪避一半落空，期望 1.7，格挡更省
  assert.equal(ENEMY_AI.chooseResponse(responseView({ move: 'light', self: { hp: 14, ap: 3 } })), 'guard');
  // 强攻 5 点：格挡后仍吃 3.4，闪避折算 2.7，伤害越高越值得赌闪避
  assert.equal(ENEMY_AI.chooseResponse(responseView({ move: 'heavy', self: { hp: 14, ap: 3 } })), 'dodge');
});

test('应对：这一下会把自己打死时不硬扛', () => {
  // 3 血挨 5 点强攻：硬扛必死，格挡后只要暴击才死，闪避还有一半活路
  assert.equal(ENEMY_AI.chooseResponse(responseView({ move: 'heavy', self: { hp: 3, ap: 3 } })), 'dodge');
  // 4 血时只有暴击（20%）才致死，这时候赌闪避反而更险，格挡更稳
  assert.equal(ENEMY_AI.chooseResponse(responseView({ move: 'heavy', self: { hp: 4, ap: 3 } })), 'guard');
});

test('应对：血线安全时宁可硬扛，把行动点留给进攻', () => {
  // 只剩 1 点行动点：12 血挨一下普攻打不死，白吃这一下、把点数留给自己出手更值
  assert.equal(ENEMY_AI.chooseResponse(responseView({ move: 'light', self: { hp: 12, ap: 1 } })), 'take');
  // 同样 1 点行动点，血线掉到 5 点就赌不起了，必须格挡
  assert.equal(ENEMY_AI.chooseResponse(responseView({ move: 'light', self: { hp: 5, ap: 1 } })), 'guard');
});

test('应对：没有行动点只能承受', () => {
  for (const move of ['light', 'heavy', 'ult'] as const) {
    assert.equal(ENEMY_AI.chooseResponse(responseView({ move, self: { ap: 0 } })), 'take');
  }
});

test('确定性：同一局面永远同一选择，且不改动视图', () => {
  const view = activeView({ self: { hp: 8, ap: 2 }, enemy: { hp: 9, ap: 4 }, round: 4 });
  const viewSnapshot = structuredClone(view);
  const action = ENEMY_AI.chooseAction(view);
  assert.equal(ENEMY_AI.chooseAction(view), action);
  assert.deepEqual(view, viewSnapshot);

  const response = responseView({ move: 'heavy', self: { hp: 7, ap: 3 } });
  const responseSnapshot = structuredClone(response);
  const move = ENEMY_AI.chooseResponse(response);
  assert.equal(ENEMY_AI.chooseResponse(response), move);
  assert.deepEqual(response, responseSnapshot);
});

test('合法性：所有行动点与血量组合下都给出合法招式', () => {
  for (let round = 1; round <= 8; round += 1) {
    for (let ap = 0; ap <= RULES.maxAp; ap += 1) {
      for (const ultLeft of [0, 1]) {
        for (const hp of [1, 4, 9, 14, 18]) {
          for (const enemyHp of [1, 5, 11, 18]) {
            const view = activeView({ self: { hp, ap, ultLeft }, enemy: { hp: enemyHp, ap }, round });
            const action = ENEMY_AI.chooseAction(view);
            assert.ok(isLegalAction(view, action), `非法招式 ${action}：${JSON.stringify(view)}`);
          }
        }
      }
    }
  }
});

test('合法性：应对永远是承受、格挡、闪避里能出的那一个', () => {
  for (const move of ['light', 'heavy', 'ult'] as const) {
    for (let ap = 0; ap <= RULES.maxAp; ap += 1) {
      for (const hp of [1, 3, 6, 10, 14, 18]) {
        for (const round of [1, 4, 7]) {
          const view = responseView({ move, self: { hp, ap }, round });
          const response = ENEMY_AI.chooseResponse(view);
          assert.ok(isLegalResponse(view, response), `非法应对 ${response}：${JSON.stringify(view)}`);
        }
      }
    }
  }
});

/** 每回合最多推进多少次操作，防止 AI 兜底出岔子时死循环 */
const TURN_LIMIT = 400;

/** 改造前的启发式：从 src/game/enemy.ts 移除后留在这里当对拍基线 */
const LEGACY_ULT_FINISH_MARGIN = 2;
const LEGACY_SAVE_MARGIN = 2;

interface Risk {
  death: number;
  expected: number;
}

function risk(hp: number, outcomes: ReadonlyArray<readonly [number, number]>): Risk {
  let death = 0;
  let expected = 0;
  for (const [damage, probability] of outcomes) {
    if (damage >= hp) death += probability;
    expected += damage * probability;
  }
  return { death, expected };
}

const LEGACY_AI: LocalBattleAI = {
  chooseAction(view) {
    const { self, enemy, bonus } = view;
    const ultDamage = ATTACKS.ult.damage + bonus;
    if (self.ultLeft > 0 && enemy.hp <= ultDamage + LEGACY_ULT_FINISH_MARGIN) {
      return self.ap >= ATTACKS.ult.apCost ? 'ult' : 'charge';
    }
    return self.ap >= ATTACKS.heavy.apCost ? 'heavy' : 'light';
  },
  chooseResponse(view) {
    const { self } = view;
    if (self.ap === 0) return 'take';
    if (self.ap <= 2 && self.hp > view.damage + LEGACY_SAVE_MARGIN) return 'take';
    const guard = risk(self.hp, [
      [view.damage - RESPONSES.guard.reduction, 1 - view.critChance],
      [view.damage, view.critChance],
    ]);
    const dodge = risk(self.hp, [
      [0, view.dodgeChance],
      [view.damage, (1 - view.dodgeChance) * (1 - view.critChance)],
      [view.damage + CRIT_BONUS, (1 - view.dodgeChance) * view.critChance],
    ]);
    if (dodge.death < guard.death) return 'dodge';
    if (dodge.death > guard.death) return 'guard';
    return dodge.expected < guard.expected ? 'dodge' : 'guard';
  },
};

/** 确定性 LCG：同一颗种子跑出同一局，对拍结果可复现 */
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

/** Fighter 里只有这三项进 view，引擎的内部状态不进 AI */
function fighterView(fighter: FighterView): FighterView {
  return { hp: fighter.hp, ap: fighter.ap, ultLeft: fighter.ultLeft };
}

function playerActionView(battle: Battle): ActionView {
  return {
    round: battle.round,
    bonus: roundDamageBonus(battle.round),
    self: fighterView(battle.player),
    enemy: fighterView(battle.enemy),
  };
}

function playerResponseView(battle: Battle): ResponseView {
  const pending = battle.pending;
  assert.ok(pending, '应对阶段必须有待结算的攻击');
  const spec = ATTACKS[pending.move];
  return {
    round: battle.round,
    bonus: roundDamageBonus(battle.round),
    self: fighterView(battle.player),
    attacker: fighterView(battle.enemy),
    move: pending.move,
    damage: pending.damage,
    critChance: spec.critChance,
    dodgeChance: spec.dodgeChance,
  };
}

/**
 * 包一层合法性断言：engine 遇到非法 AI 动作会静默退回「蓄力或普攻」，
 * 光看对局跑通发现不了非法决策，必须在出口处盯住。
 */
const CHECKED_AI: LocalBattleAI = {
  chooseAction(view) {
    const action = ENEMY_AI.chooseAction(view);
    assert.ok(isLegalAction(view, action), `AI 给出非法招式 ${action}：${JSON.stringify(view)}`);
    return action;
  },
  chooseResponse(view) {
    const response = ENEMY_AI.chooseResponse(view);
    assert.ok(isLegalResponse(view, response), `AI 给出非法应对 ${response}：${JSON.stringify(view)}`);
    return response;
  },
};

test('自对弈：新 AI 与旧启发式对打 240 局，全程合法且都打得完', async () => {
  const gamesPerFirstMover = 120;
  const actionTally: Record<string, number> = {};
  const responseTally: Record<string, number> = {};
  let wins = 0;
  let total = 0;
  let totalRounds = 0;
  let totalTurns = 0;

  for (const firstMover of ['player', 'enemy'] as const satisfies readonly Side[]) {
    for (let index = 0; index < gamesPerFirstMover; index += 1) {
      const seed = 20261024 + index * 7919;
      const deps = { random: lcg(seed), ai: CHECKED_AI };
      let battle = createBattle({ now: 0, seed, firstMover });
      battle = (await advanceBattle(battle, 0, deps)).battle;

      let turns = 0;
      while (battle.phase === 'battle' && turns < TURN_LIMIT) {
        let action: ActionId;
        if (battle.pending) {
          const response = LEGACY_AI.chooseResponse(playerResponseView(battle));
          responseTally[response] = (responseTally[response] ?? 0) + 1;
          action = response;
        } else {
          action = LEGACY_AI.chooseAction(playerActionView(battle));
          actionTally[action] = (actionTally[action] ?? 0) + 1;
        }
        const result = await resolveTurn(battle, action, 0, deps);
        assert.equal(result.rejection, undefined, `第 ${seed} 局的操作 ${action} 被拒`);
        battle = result.battle;
        turns += 1;
      }

      assert.notEqual(battle.phase, 'battle', `第 ${seed} 局打了 ${TURN_LIMIT} 次还没分出胜负`);
      if (battle.phase === 'defeat') wins += 1;
      totalRounds += battle.round;
      totalTurns += turns;
      total += 1;
    }
  }

  const winRate = wins / total;
  console.log(
    `  自对弈 ${total} 局：新 AI 胜 ${wins} 局（${(winRate * 100).toFixed(1)}%），` +
      `平均 ${(totalRounds / total).toFixed(2)} 轮 / ${(totalTurns / total).toFixed(2)} 次操作`,
  );
  console.log(`  玩家位（旧启发式）招式 ${JSON.stringify(actionTally)} 应对 ${JSON.stringify(responseTally)}`);

  // 对拍基线：新 AI 至少不能比旧启发式差，否则这次替换没有意义
  assert.ok(winRate >= 0.5, `新 AI 胜率 ${(winRate * 100).toFixed(1)}%，低于旧启发式`);
  // 胜负都在十来轮内分出来，数据模型没被拖成拉锯
  assert.ok(totalRounds / total <= 12, `平均 ${(totalRounds / total).toFixed(2)} 轮，回合数异常`);
  assert.ok(totalTurns / total >= 4, '平均操作数太少，对局可能没真的打起来');
});
