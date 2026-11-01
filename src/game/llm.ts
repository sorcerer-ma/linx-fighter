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
import { Agent as HttpAgent, request as httpRequest } from 'node:http';
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https';

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

/**
 * 跨回合复用的连接池：决策网关通常在境外，新建连接要付一次 TCP + TLS（实测约 0.7s），
 * 复用后每回合只付一次推理时间；地址是 http 时走对应的 agent。
 */
const httpsAgent = new HttpsAgent({ keepAlive: true, keepAliveMsecs: 60_000, maxSockets: 16 });
const httpAgent = new HttpAgent({ keepAlive: true, keepAliveMsecs: 60_000, maxSockets: 16 });

interface RawResponse {
  status: number;
  text: string;
}

/** 走连接池发 HTTP POST；传输失败返回 null，由调用方回退 */
function postRaw(
  url: string,
  headers: Record<string, string>,
  body: string,
  timeoutMs: number,
): Promise<RawResponse | null> {
  return new Promise((resolve) => {
    const target = new URL(url);
    const isHttps = target.protocol === 'https:';
    const request = isHttps ? httpsRequest : httpRequest;
    const req = request(
      target,
      {
        method: 'POST',
        headers: { ...headers, 'Content-Length': Buffer.byteLength(body) },
        agent: isHttps ? httpsAgent : httpAgent,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }),
        );
      },
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`timeout after ${timeoutMs}ms`)));
    req.on('error', () => resolve(null));
    req.end(body);
  });
}

/** 走连接池发一个 JSON POST；返回解析后的负载，失败返回 null */
async function postWithKeepAlive(
  options: LlmOptions,
  url: string,
  path: string,
  body: unknown,
): Promise<unknown | null> {
  const startedAt = Date.now();
  const raw = await postRaw(
    url,
    {
      Authorization: `Bearer ${options.apiKey}`,
      'Content-Type': 'application/json',
    },
    JSON.stringify(body),
    options.timeoutMs,
  );
  if (raw === null) {
    options.logger?.warn('模型调用失败', { path, error: 'transport error' });
    return null;
  }
  if (raw.status < 200 || raw.status >= 300) {
    options.logger?.warn('模型返回异常状态', { path, status: raw.status });
    return null;
  }
  try {
    const payload: unknown = JSON.parse(raw.text);
    options.logger?.debug('模型调用完成', {
      path,
      latencyMs: Date.now() - startedAt,
      ...readUsage(payload),
    });
    return payload;
  } catch {
    options.logger?.warn('模型返回无法解析', { path });
    return null;
  }
}

/** 发一个 JSON POST；任何失败都吞掉并返回 null，细节写日志 */
async function post(options: LlmOptions, path: string, body: unknown): Promise<unknown | null> {
  const url = `${options.baseUrl ?? DEFAULT_BASE_URL}${path}`;
  // 测试注入的 fetch 走原路径；生产默认用连接池复用连接
  if (!options.fetchImpl) {
    return postWithKeepAlive(options, url, path, body);
  }
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
