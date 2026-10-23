/**
 * JEV 意图模型：把自然语言归一化成招式。
 *
 * 约束（见 AGENTS.md）：
 * - 规则匹配永远优先，这里只处理规则没认出来的句子；
 * - 模型只输出招式与置信度，不产出数值、不改对局状态；
 * - 调用失败、超时、置信度不足都当作「没认出来」，由上层提示重说。
 */

import type { Logger } from '../log.js';
import { ACTIVE_ACTIONS, RESPONSE_ACTIONS } from './actions.js';
import type { ActionId, ActiveActionId, ResponseMove } from './types.js';

/** OpenRouter 上的默认模型：官方标注为 FP8，支持 JSON Schema 输出 */
export const DEFAULT_INTENT_MODEL = 'google/gemma-4-26b-a4b-it';

/** 低于这个置信度就当没认出来，避免模型瞎猜导致玩家白丢一手 */
export const INTENT_CONFIDENCE_THRESHOLD = 0.7;

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
  logger?: Pick<Logger, 'warn'>;
}

const STAGE_MENU: Record<IntentStage, ActionId[]> = {
  active: ['light', 'heavy', 'ult', 'charge'],
  response: ['guard', 'dodge', 'take'],
};

/** 各招式的口语提示，帮模型把「猛攻」「硬扛」这类说法对齐到枚举值 */
const STAGE_HINT: Record<IntentStage, string> = {
  active: '主动阶段：light 普攻（试探、轻攻击）、heavy 强攻（重击）、ult 大招（绝招、必杀）、charge 蓄力（攒真气）',
  response: '应对阶段：guard 格挡（挡、防御）、dodge 闪避（躲开）、take 承受（硬扛、不躲）',
};

/** 解析模型返回的 JSON 内容；export 出来给单测用 */
export function parseIntentContent(
  content: string,
  stage: IntentStage,
  threshold: number = INTENT_CONFIDENCE_THRESHOLD,
): ActionId | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    // 模型偶尔会包一层代码块或加一句解释，退一步取第一个完整对象
    const start = content.indexOf('{');
    const end = content.lastIndexOf('}');
    if (start === -1 || end <= start) return null;
    try {
      parsed = JSON.parse(content.slice(start, end + 1));
    } catch {
      return null;
    }
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const record = parsed as { action?: unknown; confidence?: unknown };
  if (typeof record.confidence !== 'number' || record.confidence < threshold) return null;
  const action = record.action;
  if (typeof action !== 'string') return null;
  if (action === 'unknown') return null;
  const menu = STAGE_MENU[stage];
  return (menu as string[]).includes(action) ? (action as ActionId) : null;
}

/** 当前阶段合法的招式中，这段文本能对上的那一个；用于归一化模型输出 */
export function actionOfStage(stage: IntentStage, action: ActionId): action is ActiveActionId | ResponseMove {
  return stage === 'active'
    ? (ACTIVE_ACTIONS as ActionId[]).includes(action)
    : (RESPONSE_ACTIONS as ActionId[]).includes(action);
}

export function createIntentResolver(options: IntentResolverOptions): IntentResolver {
  const model = options.model ?? DEFAULT_INTENT_MODEL;
  const timeoutMs = options.timeoutMs ?? 2000;
  const fetchImpl = options.fetchImpl ?? fetch;

  return {
    async resolve(text, stage) {
      try {
        const response = await fetchImpl('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${options.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model,
            temperature: 0,
            max_tokens: 32,
            // 同一模型有多个 provider，语音场景优先挑延迟最低的
            provider: { sort: 'latency' },
            messages: [
              {
                role: 'system',
                content:
                  '你是语音对战游戏的意图识别器。只把玩家的话归一化成招式，不要解释、不要编数值。' +
                  `当前${STAGE_HINT[stage]}。与出招无关的话返回 unknown。` +
                  '只输出一个 JSON 对象，格式 {"action":"招式或unknown","confidence":0到1}，不要代码块、不要多余文字。',
              },
              { role: 'user', content: text },
            ],
          }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!response.ok) {
          options.logger?.warn('意图模型返回异常状态', { status: response.status, stage });
          return null;
        }
        const payload = (await response.json()) as {
          choices?: { message?: { content?: unknown } }[];
        };
        const content = payload.choices?.[0]?.message?.content;
        if (typeof content !== 'string') return null;
        const action = parseIntentContent(content, stage);
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
