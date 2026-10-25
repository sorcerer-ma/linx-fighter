/**
 * 模型网关客户端：决策模型与语言模型使用各自传入的地址、鉴权与路径。
 *
 * 两类调用可分别连接不同网关：
 * - `/systemone`：决策模型，把「这句话对应哪一招 / 这一手怎么接」做成选择题，
 *   只回选择与概率，不产出数值；
 * - `/chat/completions`：语言模型，回一段能直接朗读的短话，用于规则外问答。
 *
 * 失败一律返回 null，由调用方回退到规则匹配、本地决策或固定话术；
 * 这里不做重试，也不把异常抛给玩家。
 */

import type { Logger } from '../log.js';

/** 默认网关根地址；换代理或自建网关时由调用方覆盖 */
export const DEFAULT_BASE_URL = 'https://api.modelink.ai/v1';

/** 决策模型：低延迟，只需要选项与概率 */
export const DEFAULT_DECISION_MODEL = 'typesafe/jev-1.14';

/** 语音问答模型：回答要短，优先低延迟 */
export const DEFAULT_CHAT_MODEL = 'deepseek/deepseek-v4-flash';

export interface LlmOptions {
  apiKey: string;
  /** 默认网关地址，测试或代理时覆盖 */
  baseUrl?: string;
  /** 决策模型路径；换网关时覆盖（默认 /systemone） */
  decisionPath?: string;
  /** 语言模型路径；换网关时覆盖（默认 /chat/completions） */
  chatPath?: string;
  timeoutMs: number;
  /** 单测注入，生产用全局 fetch */
  fetchImpl?: typeof fetch;
  logger?: Pick<Logger, 'warn' | 'debug'>;
}

/** 决策接口的一道选择题；每题一个键，回答按同一个键返回 */
export interface DecisionQuestion {
  type: 'choice';
  instructions: string;
  criteria: Record<string, string>;
}

export interface DecisionInput {
  model?: string;
  /** 原样回传给模型的对局状态，结构由调用方决定 */
  state: unknown;
  questions: Record<string, DecisionQuestion>;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** 推理开关：部分厂商的模型默认把 token 全花在思考上，正文是空的 */
export type ChatReasoning = 'off' | 'low';

export interface ChatInput {
  model?: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  reasoning?: ChatReasoning;
}

/** 把推理开关翻成 Anthropic/OpenAI 标准的 thinking 参数 */
function reasoningBody(reasoning: ChatReasoning | undefined): Record<string, unknown> {
  if (reasoning === 'off') return { thinking: { type: 'disabled' } };
  if (reasoning === 'low') return { reasoning_effort: 'low' };
  return {};
}

export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
}

function readUsage(payload: unknown): TokenUsage | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const usage = (payload as { usage?: { input_tokens?: unknown; output_tokens?: unknown } }).usage;
  if (typeof usage !== 'object' || usage === null) return undefined;
  return {
    inputTokens: typeof usage.input_tokens === 'number' ? usage.input_tokens : undefined,
    outputTokens: typeof usage.output_tokens === 'number' ? usage.output_tokens : undefined,
  };
}

/** 发一个 JSON POST；任何失败都吞掉并返回 null，细节写日志 */
async function post(options: LlmOptions, path: string, body: unknown): Promise<unknown | null> {
  const url = `${options.baseUrl ?? DEFAULT_BASE_URL}${path}`;
  const fetchImpl = options.fetchImpl ?? fetch;
  const startedAt = Date.now();
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(options.timeoutMs),
    });
    if (!response.ok) {
      options.logger?.warn('模型返回异常状态', { path, status: response.status });
      return null;
    }
    const payload = await response.json();
    options.logger?.debug('模型调用完成', {
      path,
      latencyMs: Date.now() - startedAt,
      ...readUsage(payload),
    });
    return payload;
  } catch (error) {
    options.logger?.warn('模型调用失败', {
      path,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/** 问决策模型一件事；返回原始响应，解析留给调用方 */
export async function askDecision(
  options: LlmOptions,
  input: DecisionInput,
): Promise<unknown | null> {
  return post(options, options.decisionPath ?? '/systemone', {
    model: input.model ?? DEFAULT_DECISION_MODEL,
    state: input.state,
    questions: input.questions,
  });
}

/** 让语言模型答一句；返回原始内容，清洗与截断在 chat.ts 里做 */
export async function askChat(options: LlmOptions, input: ChatInput): Promise<string | null> {
  const payload = await post(options, options.chatPath ?? '/chat/completions', {
    model: input.model ?? DEFAULT_CHAT_MODEL,
    messages: input.messages,
    temperature: input.temperature,
    max_tokens: input.maxTokens,
    ...reasoningBody(input.reasoning),
  });
  if (typeof payload !== 'object' || payload === null) return null;
  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const first = choices[0] as { message?: { content?: unknown } } | undefined;
  const content = first?.message?.content;
  return typeof content === 'string' && content.trim() !== '' ? content : null;
}
