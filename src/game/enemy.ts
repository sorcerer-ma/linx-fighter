/**
 * 对手 AI（守擂教头）：基于决策模型的效用评估。
 *
 * 主动阶段把当前合法的招式全部列出来，逐个算「期望伤害 + 击杀收益 − 能量成本 −
 * 被反打风险 − 大招期权」，取分数最高的一招；应对阶段在承受、格挡、闪避之间比较
 * 「损失生命值期望 + 被斩杀概率 + 能量成本」。
 *
 * 约束：只读 view 暴露的公开信息（双方生命值、能量、大招次数、当轮加成、已锁定攻击的
 * 伤害与概率），不碰引擎内部状态，也不产生随机数——同一局面必然做出同一选择，输出可回放。
 */

import { ATTACKS, CHARGE_AP, CRIT_BONUS, RESPONSES, RULES } from './rules.js';
import type {
  ActionView,
  ActiveActionId,
  AttackMove,
  LocalBattleAI,
  ResponseMove,
  ResponseView,
} from './types.js';

/**
 * 决策模型权重：每条都是「一句战术直觉 → 一个可调系数」，调平衡先动这里。
 */
const WEIGHTS = {
  /** 期望伤害：赢下对局的主通道，1 点期望伤害记 1 分 */
  damage: 1,
  /** 击杀概率：直接终结对局，同样概率下远比伤害值钱 */
  kill: 14,
  /** 能量基准价值：现在花掉的每一点，都少了下一轮出招或防守的选择权 */
  ap: 1.2,
  /** 能量见底时的加成：最后一点决定下轮还能不能格挡、还能不能强攻 */
  apScarce: 2,
  /** 能量接近上限时的折价：每轮只回 2 点，攒多了也会溢出 */
  apAbundant: 0.6,
  /** 空门风险：能量花光后对手打了也不用应对，伤害只能照单全收 */
  exposure: 0.5,
  /** 垂死叠加：空门且对手这一下就能打死自己，再额外记一笔 */
  lethal: 4,
  /** 大招期权：捏着大招不用的威慑与收割价值，双方生命值越健康越贵 */
  ultHold: 2.4,
  /** 蓄力空转：白丢一回合输出的代价 */
  idle: 1,
  /** 冲刺大招：蓄力后刚好够开大、且对手在大招收割线内，额外奖励这份节奏 */
  chargeToUlt: 1.4,
  /** 读招温度：越大越假设对手应对随意，越小越假设对手精于算计 */
  readTemperature: 1,
  /** 对手的保命权重：预测对手应对时，被斩杀的风险折算多少分 */
  readDeath: 8,
} as const;

/** 伤害结果分布：[[伤害, 概率], ...]，概率之和为 1 */
type Outcome = readonly [damage: number, probability: number];

/** 主动招式的枚举顺序，也是同分时的优先级：能压就压，压不动才蓄力 */
const ACTION_ORDER: readonly ActiveActionId[] = ['ult', 'heavy', 'light', 'charge'];

/** 应对的枚举顺序：同分时先选省事的一侧（承受 → 格挡 → 闪避） */
const RESPONSE_ORDER: readonly ResponseMove[] = ['take', 'guard', 'dodge'];

/** 满生命值参考值：view 里没有 maxHp，用规则里较高的初始生命值把绝对生命值折成比例 */
const FULL_HP = Math.max(RULES.firstHp, RULES.secondHp);

function chooseAction(view: ActionView): ActiveActionId {
  let best: ActiveActionId | undefined;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const action of legalActions(view)) {
    const score = action === 'charge' ? scoreCharge(view) : scoreAttack(view, action);
    if (score > bestScore) {
      best = action;
      bestScore = score;
    }
  }
  // 候选集恒非空：能量见底至少能蓄力，有一点就至少能普攻
  return best ?? 'charge';
}

function chooseResponse(view: ResponseView): ResponseMove {
  let best: ResponseMove | undefined;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const response of legalResponses(view)) {
    const score = scoreResponse(view, response);
    if (score > bestScore) {
      best = response;
      bestScore = score;
    }
  }
  // 候选集恒非空：承受永远合法
  return best ?? 'take';
}

/** 当前能量下能打出的主动招式，按优先级排列；不合法的根本不进候选 */
function legalActions(view: ActionView): ActiveActionId[] {
  const { ap, ultLeft } = view.self;
  const legal: ActiveActionId[] = [];
  for (const action of ACTION_ORDER) {
    if (action === 'charge') {
      if (ap < RULES.maxAp) legal.push(action);
      continue;
    }
    if (ap < ATTACKS[action].apCost) continue;
    if (action === 'ult' && ultLeft <= 0) continue;
    legal.push(action);
  }
  return legal;
}

/** 当前能量下能用的应对：一点都没有时只能承受 */
function legalResponses(view: ResponseView): ResponseMove[] {
  if (view.self.ap < RESPONSES.guard.apCost) return ['take'];
  return [...RESPONSE_ORDER];
}

/**
 * 攻击的效用：期望伤害 + 击杀收益 − 能量成本 − 空门风险 − 大招期权。
 *
 * 期望伤害与击杀概率按对手的应对概率加权（见 predictDefense）；
 * 击杀概率同时把后续成本与风险折掉——这一下打死对手，对局就结束了，不必再留资源。
 */
function scoreAttack(view: ActionView, move: AttackMove): number {
  const spec = ATTACKS[move];
  const raw = spec.damage + view.bonus;
  const defense = predictDefense(view, move);

  let expected = 0;
  let kill = 0;
  for (const response of RESPONSE_ORDER) {
    const probability = defense[response];
    if (probability === 0) continue;
    const outcome = summarize(
      outcomesUnder(raw, spec.critChance, spec.dodgeChance, response),
      view.enemy.hp,
    );
    expected += probability * outcome.expected;
    kill += probability * outcome.death;
  }

  const apCost = apValue(view.self.ap) * spec.apCost;
  const exposure = exposurePenalty(view, view.self.ap - spec.apCost);
  const ultOption = move === 'ult' ? ultOptionValue(view) : 0;
  const ongoing = 1 - kill;

  return WEIGHTS.damage * expected + WEIGHTS.kill * kill - ongoing * (apCost + exposure + ultOption);
}

/**
 * 蓄力的效用：白丢一回合输出，换 1 点能量。
 *
 * 平时不划算，只有「再攒这一点就能开大收割」时才是好买卖——那一点能量的价值
 * 不在本身，而在于它把大招提前了一个主动阶段。
 */
function scoreCharge(view: ActionView): number {
  const gained = Math.min(RULES.maxAp, view.self.ap + CHARGE_AP) - view.self.ap;
  let score = apValue(view.self.ap) * gained - WEIGHTS.idle;

  if (view.self.ultLeft > 0 && view.self.ap < ATTACKS.ult.apCost) {
    // 下个主动阶段的能量：蓄力的这一下 + 回合恢复能量 − 中间必然要应对一次攻击的那一点
    const defenseCost = RESPONSES.guard.apCost;
    const nextAp = Math.min(
      RULES.maxAp,
      view.self.ap + gained + RULES.apRegen - defenseCost,
    );
    if (nextAp >= ATTACKS.ult.apCost && view.enemy.hp <= ultFinishLine(view)) {
      score += WEIGHTS.chargeToUlt;
    }
  }
  return score;
}

/**
 * 应对的效用：这一下的损失生命值期望 + 被斩杀的罚分 + 花掉的能量。
 *
 * 生命值危险时「被斩杀」压倒一切；生命值安全时更愿意硬扛，把能量留给自己的进攻。
 */
function scoreResponse(view: ResponseView, response: ResponseMove): number {
  const outcome = summarize(
    outcomesUnder(view.damage, view.critChance, view.dodgeChance, response),
    view.self.hp,
  );
  const apCost = apValue(view.self.ap) * RESPONSES[response].apCost;
  return -(WEIGHTS.damage * outcome.expected + WEIGHTS.kill * outcome.death + apCost);
}

/**
 * 读招：预测对手会怎么应对这一次攻击。
 *
 * 对手没有能量时只能硬扛，伤害照单全收；有能量时，按三种应对各自的
 * 「损失生命值期望 + 被斩杀罚分 + 能量成本」算损失，再用 softmax 折成概率——
 * 温度越低越假设对手精于算计，温度越高越假设对手随手应对。
 */
function predictDefense(view: ActionView, move: AttackMove): Record<ResponseMove, number> {
  const defender = view.enemy;
  if (defender.ap === 0) return { take: 1, guard: 0, dodge: 0 };

  const spec = ATTACKS[move];
  const raw = spec.damage + view.bonus;
  const loss = (response: ResponseMove): number => {
    const outcome = summarize(
      outcomesUnder(raw, spec.critChance, spec.dodgeChance, response),
      defender.hp,
    );
    return (
      WEIGHTS.damage * outcome.expected +
      WEIGHTS.readDeath * outcome.death +
      apValue(defender.ap) * RESPONSES[response].apCost
    );
  };

  const takeLoss = loss('take');
  const guardLoss = loss('guard');
  const dodgeLoss = loss('dodge');
  const floor = Math.min(takeLoss, guardLoss, dodgeLoss);
  const takeWeight = Math.exp((floor - takeLoss) / WEIGHTS.readTemperature);
  const guardWeight = Math.exp((floor - guardLoss) / WEIGHTS.readTemperature);
  const dodgeWeight = Math.exp((floor - dodgeLoss) / WEIGHTS.readTemperature);
  const total = takeWeight + guardWeight + dodgeWeight;

  return {
    take: takeWeight / total,
    guard: guardWeight / total,
    dodge: dodgeWeight / total,
  };
}

/** 某种应对下的伤害分布：先判闪避，命中后再判暴击、再减格挡，与 engine 的结算顺序一致 */
function outcomesUnder(
  raw: number,
  critChance: number,
  dodgeChance: number,
  response: ResponseMove,
): Outcome[] {
  const reduction = response === 'guard' ? RESPONSES.guard.reduction : 0;
  const hit = (crit: boolean): number => Math.max(0, raw + (crit ? CRIT_BONUS : 0) - reduction);

  if (response === 'dodge') {
    const landed = 1 - dodgeChance;
    return [
      [0, dodgeChance],
      [hit(false), landed * (1 - critChance)],
      [hit(true), landed * critChance],
    ];
  }
  return [
    [hit(false), 1 - critChance],
    [hit(true), critChance],
  ];
}

/** 把伤害分布折成期望伤害与「这一下就打死目标」的概率 */
function summarize(outcomes: readonly Outcome[], hp: number): { expected: number; death: number } {
  let expected = 0;
  let death = 0;
  for (const [damage, probability] of outcomes) {
    expected += damage * probability;
    if (damage >= hp) death += probability;
  }
  return { expected, death };
}

/**
 * 空门风险：能量花光后，对手下一阶段的攻击没有应对可用（引擎会强制承受）。
 * 按对手最痛的一招折算；若这一下就能打死自己，再叠加一笔垂死罚分。
 */
function exposurePenalty(view: ActionView, remainingAp: number): number {
  if (remainingAp > 0) return 0;
  const threat = maxIncomingDamage(view);
  if (threat <= 0) return 0;
  return WEIGHTS.exposure * (threat + (threat >= view.self.hp ? WEIGHTS.lethal : 0));
}

/** 对手下一手最痛的一招（含当轮加成），出不起招就是 0 */
function maxIncomingDamage(view: ActionView): number {
  const { ap, ultLeft } = view.enemy;
  let best = 0;
  if (ap >= ATTACKS.light.apCost) best = Math.max(best, ATTACKS.light.damage);
  if (ap >= ATTACKS.heavy.apCost) best = Math.max(best, ATTACKS.heavy.damage);
  if (ap >= ATTACKS.ult.apCost && ultLeft > 0) best = Math.max(best, ATTACKS.ult.damage);
  return best > 0 ? best + view.bonus : 0;
}

/**
 * 大招期权：手里捏着大招本身就是威慑，随便交掉等于把收割线让出去。
 * 双方生命值越健康越值得留；对手快倒了（不差这一下）或自己快撑不住（留不住）时贬值。
 */
function ultOptionValue(view: ActionView): number {
  return WEIGHTS.ultHold * hpRatio(view.enemy.hp) * hpRatio(view.self.hp);
}

/** 大招打满（含暴击）能摸到的生命值 */
function ultFinishLine(view: ActionView): number {
  return ATTACKS.ult.damage + view.bonus + CRIT_BONUS;
}

/**
 * 能量的边际价值：存量越低越值钱。
 * 见底时这一点直接决定下轮能不能格挡或强攻；接近上限时每轮只回 2 点，多攒也会溢出。
 */
function apValue(ap: number): number {
  if (ap <= 1) return WEIGHTS.ap * WEIGHTS.apScarce;
  if (ap >= RULES.maxAp - 1) return WEIGHTS.ap * WEIGHTS.apAbundant;
  return WEIGHTS.ap;
}

/** 绝对生命值折成 0~1 的比例（view 里没有 maxHp，用满生命值参考值近似） */
function hpRatio(hp: number): number {
  return Math.max(0, Math.min(1, hp / FULL_HP));
}

export const ENEMY_AI: LocalBattleAI = { chooseAction, chooseResponse };
