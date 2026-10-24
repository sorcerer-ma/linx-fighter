/**
 * 规则外问答：把玩家原话交给语言模型，回一句能直接朗读的短话。
 *
 * 只处理「游戏规则之外」的询问（天气、算数、常识、闲聊）。游戏内的战况、
 * 招式、能量与胜负由规则和播报回答，不经过这里，避免模型编造数值。
 *
 * 模型输出会再洗一遍：去 Markdown、压空白、截到两句 60 字内；调用失败、
 * 超时或结果为空都返回 null，由服务端回固定话术。
 */

import type { Logger } from '../log.js';
import { askChat, DEFAULT_CHAT_MODEL, type ChatReasoning } from './commandcode.js';

/** 和战斗播报同一套长度约束：一次最多两句、60 字 */
const MAX_ANSWER_CHARS = 60;

/** 交给模型的原话最多保留 200 字：语音指令通常很短，截断只为挡住极长输入 */
const QUESTION_LIMIT = 200;

/** 取出要透传的原话：去首尾空白并限长 */
export function outsideQuestion(raw: string): string {
  return raw.trim().slice(0, QUESTION_LIMIT);
}

export interface ChatAnswerer {
  /** 回答一个规则外问题；模型不可用或结果不可用时返回 null */
  answer(question: string): Promise<string | null>;
}

export interface ChatAnswererOptions {
  apiKey: string;
  model?: string;
  timeoutMs?: number;
  /** 默认官方地址，测试或代理时覆盖 */
  baseUrl?: string;
  /** 语言模型路径；换 Provider 时覆盖 */
  chatPath?: string;
  /** 推理开关：推理模型开思考会只输出思考、不回正文 */
  reasoning?: ChatReasoning;
  /** 单测注入，生产用全局 fetch */
  fetchImpl?: typeof fetch;
  logger?: Pick<Logger, 'warn' | 'debug'>;
}

/**
 * 系统提示：定角色、定口吻、定长度，并划清「不许碰对局数值」的边界。
 * 模型看不到对局状态，这里再强调一次，防止它顺着问题瞎编战况。
 */
const SYSTEM_PROMPT = [
  '你是语音对战游戏「共鸣：闻声对决」里玩家的战斗伙伴，用第一人称「我」说话。',
  '只回答与游戏规则无关的问题：闲聊、常识、算数、天气、时间都可以。',
  '游戏里的战况、招式、能量与胜负只能由游戏播报回答，绝不能编造数值或结果。',
  '口语、干脆，最多两句、60 字内；不用 Markdown、列表、表情、引号或括号补充。',
  '不知道就说不知道，不要硬编。',
].join('');

/**
 * 把模型输出洗成一句能念的话。
 *
 * - 去代码块与 Markdown 符号、压掉换行与多余空白；
 * - 去掉包裹的引号和「回答：」前缀；
 * - 最多留两句，超长截到 60 字；
 * - 没句末标点时补一个，避免念成半句。
 */
export function sanitizeChatAnswer(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const text = raw
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[*_`#>|]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^(回答|答)[:：]\s*/, '')
    .replace(/^[「『"'“”‘’]+/, '')
    .replace(/[」』"'“”‘’]+$/, '')
    .trim();
  if (!text) return null;

  const sentences = text
    .split(/(?<=[。！？!?])/)
    .map((part) => part.trim())
    .filter(Boolean)
    .slice(0, 2);
  let answer = sentences.join('');
  if (!/[。！？!?]$/.test(answer)) answer += '。';
  if (answer.length > MAX_ANSWER_CHARS) {
    answer = `${answer.slice(0, MAX_ANSWER_CHARS - 1).replace(/[，、,]$/, '')}。`;
  }
  return answer;
}

export function createChatAnswerer(options: ChatAnswererOptions): ChatAnswerer {
  const model = options.model ?? DEFAULT_CHAT_MODEL;
  const timeoutMs = options.timeoutMs ?? 3000;

  return {
    async answer(question) {
      const content = await askChat(
        {
          apiKey: options.apiKey,
          baseUrl: options.baseUrl,
          chatPath: options.chatPath,
          timeoutMs,
          fetchImpl: options.fetchImpl,
          logger: options.logger,
        },
        {
          model,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: outsideQuestion(question) },
          ],
          temperature: 0.6,
          maxTokens: 120,
          reasoning: options.reasoning,
        },
      );
      return sanitizeChatAnswer(content);
    },
  };
}
