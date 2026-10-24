/**
 * v0.2 玩法数值表。
 *
 * 这里只放可调参数与读取它们的纯函数；结算流程在 engine.ts。
 * 每个取值和调整理由都要同步写进 docs/game-design.md，避免数值散落。
 */

import type { AttackMove, ResponseMove } from './types.js';

/** 对局规则常量 */
export const RULES = {
  /** 先手初始气血 */
  firstHp: 14,
  /** 后手初始气血：先手先动手，后手用 4 点气血换回一点劣势 */
  secondHp: 18,
  /** 双方初始行动点 */
  initialAp: 3,
  /** 行动点上限，蓄力不能超过 */
  maxAp: 5,
  /** 自己后续每个主动阶段恢复的行动点（第一段不回） */
  apRegen: 2,
  /** 大招每局次数 */
  ultUses: 1,
  /** 从第几轮开始加伤害 */
  bonusStartRound: 3,
  /** 每轮累加的伤害加成 */
  bonusRamp: 2,
} as const;

export interface AttackSpec {
  id: AttackMove;
  label: string;
  apCost: number;
  /** 基础伤害，实际伤害还要叠加当轮加成、暴击与格挡减免 */
  damage: number;
  critChance: number;
  /** 对方选择闪避时的闪避成功率 */
  dodgeChance: number;
}

/** 三种攻击的数值，顺序即界面里的推荐顺序 */
export const ATTACKS: Record<AttackMove, AttackSpec> = {
  light: { id: 'light', label: '普攻', apCost: 1, damage: 3, critChance: 0.2, dodgeChance: 0.5 },
  heavy: { id: 'heavy', label: '强攻', apCost: 2, damage: 5, critChance: 0.2, dodgeChance: 0.5 },
  ult: { id: 'ult', label: '大招', apCost: 4, damage: 9, critChance: 0.4, dodgeChance: 0.3 },
};

export interface ResponseSpec {
  label: string;
  apCost: number;
  /** 格挡固定的伤害减免 */
  reduction: number;
}

/** 三种应对方式 */
export const RESPONSES: Record<ResponseMove, ResponseSpec> = {
  guard: { label: '格挡', apCost: 1, reduction: 2 },
  dodge: { label: '闪避', apCost: 1, reduction: 0 },
  take: { label: '承受', apCost: 0, reduction: 0 },
};

/** 暴击额外伤害 */
export const CRIT_BONUS = 2;

/** 蓄力一次回复的行动点（受 maxAp 限制） */
export const CHARGE_AP = 1;

/**
 * 当轮伤害加成：第 1、2 轮为 0，第 3 轮起每轮 +2。
 * 作用是给长时间对峙加压力：双方都拖，伤害只会越来越高。
 */
export function roundDamageBonus(round: number): number {
  if (round < RULES.bonusStartRound) return 0;
  return (round - RULES.bonusStartRound + 1) * RULES.bonusRamp;
}
