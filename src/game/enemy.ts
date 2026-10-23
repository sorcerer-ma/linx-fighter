/**
 * 对手 AI（守擂教头）。
 *
 * 负责两件事：自己主动阶段选什么招、被攻击时怎么应对。
 * 只用公开信息（双方气血、行动点、大招次数）决策，不偷看玩家未说出口的选择；
 * 不产生随机数，保证同一局面下的选择稳定、可回放。
 */

import { ATTACKS, CRIT_BONUS, RESPONSES } from './rules.js';
import type { ActionView, ActiveActionId, BattleAI, ResponseMove, ResponseView } from './types.js';

/** 残血收割的余量：对手血量低于「大招伤害 + 2」时，值得攒点开大 */
const ULT_FINISH_MARGIN = 2;

/** 省点的血线余量：挨这一下后还有富余，就硬扛攒行动点 */
const SAVE_MARGIN = 2;

function chooseAction(view: ActionView): ActiveActionId {
  const { self, enemy, bonus } = view;
  const ultDamage = ATTACKS.ult.damage + bonus;
  const wantsUlt = self.ultLeft > 0 && enemy.hp <= ultDamage + ULT_FINISH_MARGIN;

  if (wantsUlt) {
    if (self.ap >= ATTACKS.ult.apCost) return 'ult';
    return 'charge';
  }
  if (self.ap >= ATTACKS.heavy.apCost) return 'heavy';
  return 'light';
}

function chooseResponse(view: ResponseView): ResponseMove {
  const { self } = view;
  if (self.ap === 0) return 'take';
  // 血线安全时硬扛，把行动点留给自己的进攻
  if (self.ap <= 2 && self.hp > view.damage + SAVE_MARGIN) return 'take';
  return leastRisk(view);
}

/** 按「先避免被打死、再让期望伤害最低」挑应对，平手时优先格挡 */
function leastRisk(view: ResponseView): ResponseMove {
  const guardOutcomes: Array<[number, number]> = [
    [view.damage - RESPONSES.guard.reduction, 1 - view.critChance],
    [view.damage, view.critChance],
  ];
  const dodgeOutcomes: Array<[number, number]> = [
    [0, view.dodgeChance],
    [view.damage, (1 - view.dodgeChance) * (1 - view.critChance)],
    [view.damage + CRIT_BONUS, (1 - view.dodgeChance) * view.critChance],
  ];

  const guardRisk = risk(view.self.hp, guardOutcomes);
  const dodgeRisk = risk(view.self.hp, dodgeOutcomes);
  if (dodgeRisk.death < guardRisk.death) return 'dodge';
  if (dodgeRisk.death > guardRisk.death) return 'guard';
  return dodgeRisk.expected < guardRisk.expected ? 'dodge' : 'guard';
}

function risk(hp: number, outcomes: Array<[number, number]>): { death: number; expected: number } {
  let death = 0;
  let expected = 0;
  for (const [damage, probability] of outcomes) {
    if (damage >= hp) death += probability;
    expected += damage * probability;
  }
  return { death, expected };
}

export const ENEMY_AI: BattleAI = { chooseAction, chooseResponse };
