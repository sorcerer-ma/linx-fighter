/**
 * JEV 决策版对手 AI：每次出招、每次应对都请 JEV 做一道选择题。
 *
 * 与本地决策模型（enemy.ts）的分工：
 * - 合法选项由本地按行动点、大招次数先过滤，模型不会拿到做不到的选项；
 * - 模型只输出「选哪个 + 置信度」，不产出数值、不改对局状态；
 * - 超时、网络失败、返回值非法或选项越界，一律退回本地决策模型，保证回合不卡住；
 * - 置信度与概率只记日志，不作为拒绝依据（JEV 的 confidence 通常只有 0.3–0.5）。
 *
 * 注意：接上这个实现后，同一局面不再保证复现（依赖模型返回），
 * 仿真对拍与单测仍使用注入的本地 AI，不依赖网络。
 */

import type { Logger } from '../log.js';
import { ENEMY_AI } from './enemy.js';
import { ATTACKS, CRIT_BONUS, RESPONSES, RULES } from './rules.js';
import type {
  ActionId,
  ActionView,
  ActiveActionId,
  AttackMove,
  BattleAI,
  ResponseMove,
  ResponseView,
  TurnRecord,
} from './types.js';

/** OpenRouter 上的 JEV 决策模型 */
export const DEFAULT_ENEMY_MODEL = 'typesafe/jev-1.13';

const JEV_ENDPOINT = 'https://openrouter.ai/api/alpha/decisions';

const MOVE_LABELS: Record<AttackMove, string> = {
  light: '普攻',
  heavy: '强攻',
  ult: '大招',
};

/** 七种招式的短名，战报里给模型看 */
const ACTION_LABELS: Record<ActionId, string> = {
  light: '普攻',
  heavy: '强攻',
  ult: '大招',
  charge: '蓄力',
  guard: '格挡',
  dodge: '闪避',
  take: '硬扛',
};

/** 最近几条战报放进题干；太多会稀释关键信息 */
const HISTORY_LIMIT = 6;

export interface JevEnemyOptions {
  apiKey: string;
  model?: string;
  /** 单次决策超时；超时立刻回退本地，避免拖住整次工具调用 */
  timeoutMs?: number;
  /** 单测注入，生产用全局 fetch */
  fetchImpl?: typeof fetch;
  logger?: Pick<Logger, 'info' | 'warn' | 'debug'>;
  /** 回退用的本地决策模型，默认 ENEMY_AI */
  fallback?: BattleAI;
}

interface JevAnswer {
  answers?: {
    move?: {
      choice?: unknown;
      confidence?: unknown;
      probabilities?: unknown;
    };
  };
  usage?: { cost?: unknown };
}

interface ChoiceQuestion {
  instructions: string;
  criteria: Record<string, string>;
}

/** 当前行动点下合法的主动招式；顺序固定，便于日志与断言 */
export function legalActiveActions(view: ActionView): ActiveActionId[] {
  const actions: ActiveActionId[] = [];
  if (view.self.ap >= ATTACKS.light.apCost) actions.push('light');
  if (view.self.ap >= ATTACKS.heavy.apCost) actions.push('heavy');
  if (view.self.ap >= ATTACKS.ult.apCost && view.self.ultLeft > 0) actions.push('ult');
  if (view.self.ap < RULES.maxAp) actions.push('charge');
  return actions;
}

/** 当前行动点下合法的应对方式；没有真气时只能承受 */
export function legalResponses(view: ResponseView): ResponseMove[] {
  const responses: ResponseMove[] = [];
  if (view.self.ap >= RESPONSES.guard.apCost) responses.push('guard');
  if (view.self.ap >= RESPONSES.dodge.apCost) responses.push('dodge');
  responses.push('take');
  return responses;
}

/** 一条战报的口语化描述：谁出的手、对方怎么接、结果如何 */
export function describeHistory(record: TurnRecord): string {
  const actor = record.actor === 'enemy' ? '你' : '玩家';
  const action = ACTION_LABELS[record.action];
  if (!record.response) return `第${record.round}轮 ${actor}${action}`;
  const defender = record.actor === 'enemy' ? '玩家' : '你';
  if (record.dodged) return `第${record.round}轮 ${actor}${action}，${defender}闪开`;
  const crit = record.crit ? '暴击' : '';
  const damage = record.damage ?? 0;
  return `第${record.round}轮 ${actor}${action}，${defender}${ACTION_LABELS[record.response]}，${crit}掉${damage}`;
}

/** 玩家出招与应对的计数，让模型直接看到习惯 */
export function historySummary(history: readonly TurnRecord[]): string {
  const active = new Map<string, number>();
  const responses = new Map<string, number>();
  for (const record of history) {
    if (record.actor === 'player') {
      active.set(record.action, (active.get(record.action) ?? 0) + 1);
    } else if (record.response) {
      responses.set(record.response, (responses.get(record.response) ?? 0) + 1);
    }
  }
  const activeText = (['light', 'heavy', 'ult', 'charge'] as const)
    .filter((id) => (active.get(id) ?? 0) > 0)
    .map((id) => `${ACTION_LABELS[id]}${active.get(id)}`)
    .join('、');
  const responseText = (['guard', 'dodge', 'take'] as const)
    .filter((id) => (responses.get(id) ?? 0) > 0)
    .map((id) => `${ACTION_LABELS[id]}${responses.get(id)}`)
    .join('、');
  const parts: string[] = [];
  if (activeText) parts.push(`主动 ${activeText}`);
  if (responseText) parts.push(`应对 ${responseText}`);
  return parts.length > 0 ? `玩家习惯：${parts.join('；')}。` : '';
}

/** 最近战报与习惯统计，拼成题干的补充行 */
function historyLines(history: readonly TurnRecord[]): string[] {
  if (history.length === 0) return [];
  const lines = [`最近战报：${history.slice(-HISTORY_LIMIT).map(describeHistory).join('；')}。`];
  const summary = historySummary(history);
  if (summary) lines.push(summary);
  return lines;
}

/** 主动阶段的题干：把双方数值、最近战报与习惯写进 state，选项只列合法招式 */
export function activeQuestion(view: ActionView): { state: string; question: ChoiceQuestion } {
  const { bonus, round, self, enemy } = view;
  const criteria: Record<string, string> = {
    light: `普攻：消耗 ${ATTACKS.light.apCost} 点真气，造成 ${ATTACKS.light.damage + bonus} 点伤害；暴击率 20%（再多 ${CRIT_BONUS} 点），对手闪避率 50%。`,
    heavy: `强攻：消耗 ${ATTACKS.heavy.apCost} 点真气，造成 ${ATTACKS.heavy.damage + bonus} 点伤害；暴击率 20%（再多 ${CRIT_BONUS} 点），对手闪避率 50%。`,
    ult: `大招：消耗 ${ATTACKS.ult.apCost} 点真气，造成 ${ATTACKS.ult.damage + bonus} 点伤害；暴击率 40%（再多 ${CRIT_BONUS} 点），对手闪避率 30%；整局只剩 ${self.ultLeft} 次。`,
    charge: `蓄力：本回合不出手，真气 +1（当前 ${self.ap}，上限 ${RULES.maxAp}）。`,
  };

  return {
    state: [
      `第 ${round} 轮，当前伤害加成 +${bonus}。`,
      `你（守擂方）：气血 ${self.hp}，真气 ${self.ap}，大招剩 ${self.ultLeft} 次。`,
      `玩家：气血 ${enemy.hp}，真气 ${enemy.ap}。`,
      ...historyLines(view.history),
    ].join(' '),
    question: {
      instructions:
        '你是守擂教头，正在和玩家对战。结合双方数值、最近战报与玩家习惯，预判玩家下一步，只从给出的选项里选一招，目标是最大化胜率。',
      criteria,
    },
  };
}

/** 应对阶段的题干：说明这一击的伤害与概率 */
export function responseQuestion(view: ResponseView): { state: string; question: ChoiceQuestion } {
  const { bonus, round, self, attacker, move, damage, critChance, dodgeChance } = view;
  const criteria: Record<string, string> = {
    guard: `格挡：消耗 ${RESPONSES.guard.apCost} 点真气，本次伤害减 ${RESPONSES.guard.reduction}；预计掉 ${Math.max(0, damage - RESPONSES.guard.reduction)} 点。`,
    dodge: `闪避：消耗 ${RESPONSES.dodge.apCost} 点真气，有 ${Math.round(dodgeChance * 100)}% 概率完全躲开；躲不掉就吃满伤害。`,
    take: `承受：不消耗真气，直接掉 ${damage} 点伤害。`,
  };

  return {
    state: [
      `第 ${round} 轮，当前伤害加成 +${bonus}。`,
      `你（守擂方）：气血 ${self.hp}，真气 ${self.ap}。`,
      `玩家：气血 ${attacker.hp}，真气 ${attacker.ap}。`,
      `玩家刚锁定${MOVE_LABELS[move]}，基础伤害 ${damage}；暴击率 ${Math.round(critChance * 100)}%（再多 ${CRIT_BONUS} 点），你的闪避成功率 ${Math.round(dodgeChance * 100)}%。`,
      ...historyLines(view.history),
    ].join(' '),
    question: {
      instructions:
        '你是守擂教头，正在和玩家对战。结合双方数值、最近战报与玩家习惯，只从给出的应对里选一个，先保证别被打死，再考虑省真气。',
      criteria,
    },
  };
}

/** 解析 JEV 返回；export 出来给单测用。choice 必须落在本地过滤后的合法选项内 */
export function parseEnemyDecision(payload: unknown, legal: readonly string[]): string | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const answer = (payload as JevAnswer).answers?.move;
  if (typeof answer !== 'object' || answer === null) return null;
  const choice = answer.choice;
  return typeof choice === 'string' && legal.includes(choice) ? choice : null;
}

export function createJevEnemyAI(options: JevEnemyOptions): BattleAI {
  const model = options.model ?? DEFAULT_ENEMY_MODEL;
  const timeoutMs = options.timeoutMs ?? 1200;
  const fetchImpl = options.fetchImpl ?? fetch;
  const fallback = options.fallback ?? ENEMY_AI;

  async function ask(
    kind: 'action' | 'response',
    state: string,
    question: ChoiceQuestion,
    legal: readonly string[],
  ): Promise<string | null> {
    const startedAt = Date.now();
    // 只把做得到的选项发给模型，避免它选中非法招式再被丢掉
    const criteria = Object.fromEntries(
      Object.entries(question.criteria).filter(([key]) => legal.includes(key)),
    );
    try {
      const response = await fetchImpl(JEV_ENDPOINT, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${options.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          state: { kind, situation: state },
          questions: {
            move: {
              type: 'choice',
              instructions: question.instructions,
              criteria,
            },
          },
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) {
        options.logger?.warn('对手决策返回异常状态，回退本地决策', { status: response.status, kind });
        return null;
      }
      const payload = await response.json();
      const choice = parseEnemyDecision(payload, legal);
      const usage = (payload as JevAnswer).usage;
      const answer = (payload as JevAnswer).answers?.move as { confidence?: unknown } | undefined;
      const confidence = typeof answer?.confidence === 'number'
        ? Number(answer.confidence.toFixed(3))
        : undefined;
      if (!choice) {
        options.logger?.info('对手决策未采纳，回退本地', { kind, confidence });
        return null;
      }
      options.logger?.info('对手决策调用完成', {
        kind,
        choice,
        confidence,
        latencyMs: Date.now() - startedAt,
        cost: typeof usage?.cost === 'number' ? usage.cost : undefined,
      });
      return choice;
    } catch (error) {
      options.logger?.warn('对手决策调用失败，回退本地决策', {
        kind,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  return {
    async chooseAction(view) {
      const legal = legalActiveActions(view);
      const { state, question } = activeQuestion(view);
      const choice = await ask('action', state, question, legal);
      if (choice) return choice as ActiveActionId;
      return fallback.chooseAction(view);
    },

    async chooseResponse(view) {
      const legal = legalResponses(view);
      const { state, question } = responseQuestion(view);
      const choice = await ask('response', state, question, legal);
      if (choice) return choice as ResponseMove;
      return fallback.chooseResponse(view);
    },
  };
}
