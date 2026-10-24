/**
 * JEV 意图模型：把自然语言归一化成招式。
 *
 * 走 OpenRouter 的 JEV 决策接口（`/api/alpha/decisions`）：把「这句话对应哪一招」
 * 表达成一个 choice 选择题，模型返回选择与概率，概率就是置信度。
 *
 * 约束（见 AGENTS.md）：
 * - 规则匹配永远优先，这里只处理规则没认出来的句子；
 * - 模型只输出招式与置信度，不产出数值、不改对局状态；
 * - 调用失败、超时、置信度不足都当作「没认出来」，由上层提示重说。
 */

import type { Logger } from '../log.js';
import { ACTIVE_ACTIONS, RESPONSE_ACTIONS } from './actions.js';
import type { ActionId, ActiveActionId, ResponseMove } from './types.js';

/** OpenRouter 上的 JEV 决策模型：低延迟、按输入 token 计费 */
export const DEFAULT_INTENT_MODEL = 'typesafe/jev-1.13';

/** 低于这个置信度就当没认出来，避免模型瞎猜导致玩家白丢一手 */
export const INTENT_CONFIDENCE_THRESHOLD = 0.6;

export type IntentStage = 'active' | 'response';

export interface IntentResolver {
  /** 把一句话归一化成当前阶段合法的招式；认不出返回 null */
  resolve(text: string, stage: IntentStage): Promise<ActionId | null>;
}

export interface IntentResolverOptions {
  apiKey: string;
  model?: string;
  timeoutMs?: number;
  /** 单测注入，生产用全局 fetch */
  fetchImpl?: typeof fetch;
  logger?: Pick<Logger, 'warn' | 'debug'>;
}

const JEV_ENDPOINT = 'https://openrouter.ai/api/alpha/decisions';

const STAGE_MENU: Record<IntentStage, ActionId[]> = {
  active: ['light', 'heavy', 'ult', 'charge'],
  response: ['guard', 'dodge', 'take'],
};

/** 每个阶段的题干与选项说明；选项里固定带 none，表示「不是招式」 */
const STAGE_QUESTIONS: Record<IntentStage, { stage: string; instructions: string; criteria: Record<string, string> }> = {
  active: {
    stage: '玩家自己的出招阶段',
    instructions: '玩家说了一句语音指令，判断它对应哪个招式；与出招无关或无法判断就选 none。',
    criteria: {
      light: '普攻：试探性的轻攻击，花费 1 点能量，造成 3 点伤害。',
      heavy: '强攻：全力重击，花费 2 点能量，造成 5 点伤害。',
      ult: '大招：绝招或必杀，花费 4 点能量，造成 9 点伤害，整局只能用一次。',
      charge: '蓄力：本回合不出手，积攒 1 点能量。',
      none: '不是出招指令，或无法判断具体招式。',
    },
  },
  response: {
    stage: '对手已经出招，玩家选择如何应对',
    instructions: '玩家说了一句语音指令，判断它对应哪个应对方式；与应对无关或无法判断就选 none。',
    criteria: {
      guard: '格挡：挡下这一击，受到的伤害减 2 点。',
      dodge: '闪避：尝试躲开，有 50% 概率完全躲掉。',
      take: '承受：硬抗这一击，不格挡也不闪避。',
      none: '不是应对指令，或无法判断具体应对。',
    },
  },
};

/** JEV 返回结构；只取需要的字段，其余忽略 */
interface JeVDecisionPayload {
  answers?: {
    move?: {
      choice?: unknown;
      confidence?: unknown;
      probabilities?: unknown;
    };
  };
  usage?: { cost?: unknown };
}

/** 解析 JEV 返回；export 出来给单测用 */
export function parseIntentDecision(
  payload: unknown,
  stage: IntentStage,
  threshold: number = INTENT_CONFIDENCE_THRESHOLD,
): ActionId | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const answer = (payload as JeVDecisionPayload).answers?.move;
  if (typeof answer !== 'object' || answer === null) return null;

  const choice = answer.choice;
  if (typeof choice !== 'string' || choice === 'none') return null;

  const menu = STAGE_MENU[stage] as string[];
  if (!menu.includes(choice)) return null;

  // 优先用顶层 confidence；缺失时退回该选项的概率
  const probabilities = answer.probabilities;
  const probability =
    typeof probabilities === 'object' && probabilities !== null
      ? (probabilities as Record<string, unknown>)[choice]
      : undefined;
  const confidence =
    typeof answer.confidence === 'number'
      ? answer.confidence
      : typeof probability === 'number'
        ? probability
        : 0;
  if (confidence < threshold) return null;

  return choice as ActionId;
}

/** 当前阶段合法的招式中，这段文本能对上的那一个；用于归一化模型输出 */
export function actionOfStage(stage: IntentStage, action: ActionId): action is ActiveActionId | ResponseMove {
  return stage === 'active'
    ? (ACTIVE_ACTIONS as ActionId[]).includes(action)
    : (RESPONSE_ACTIONS as ActionId[]).includes(action);
}

export function createIntentResolver(options: IntentResolverOptions): IntentResolver {
  const model = options.model ?? DEFAULT_INTENT_MODEL;
  const timeoutMs = options.timeoutMs ?? 1500;
  const fetchImpl = options.fetchImpl ?? fetch;

  return {
    async resolve(text, stage) {
      const question = STAGE_QUESTIONS[stage];
      const startedAt = Date.now();
      try {
        const response = await fetchImpl(JEV_ENDPOINT, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${options.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model,
            state: { stage: question.stage, utterance: text },
            questions: {
              move: {
                type: 'choice',
                instructions: question.instructions,
                criteria: question.criteria,
              },
            },
          }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!response.ok) {
          options.logger?.warn('意图模型返回异常状态', { status: response.status, stage });
          return null;
        }
        const payload = await response.json();
        const action = parseIntentDecision(payload, stage);
        const usage = (payload as JeVDecisionPayload).usage;
        options.logger?.debug('意图模型调用完成', {
          stage,
          action,
          latencyMs: Date.now() - startedAt,
          cost: typeof usage?.cost === 'number' ? usage.cost : undefined,
        });
        return action && actionOfStage(stage, action) ? action : null;
      } catch (error) {
        options.logger?.warn('意图模型调用失败，回退到规则匹配', {
          stage,
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      }
    },
  };
}
