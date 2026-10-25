import { replyRejectionReason, type ReplyRejectionReason } from './reply-check.js';
import { fallbackSpeech, parseSpeechOutput, type SpeechPlan, type SpeechRejectionReason } from './speech.js';
import { companionPrompt, resolveProfileId, type SpeechProfileId } from './profiles.js';
import { OpenAiReplyModel } from './reply-model.js';
import type { GameReply } from '../../src/game/protocol.js';
import { WAIT_EVENT_TIMEOUT_MS_MAX } from '../../src/config.js';
import { readFileSync } from 'node:fs';
import type { SandboxAgentConfig } from '../config.js';

/** 等待要能跑满服务端上限，传输层再留 5 秒收尾，不能被客户端先掐断 */
export const WAIT_TRANSPORT_TIMEOUT_MS = WAIT_EVENT_TIMEOUT_MS_MAX + 5_000;

/** 页面等 /api/wait 的预算：再宽一点，保证服务端的超时或唤醒事实先到，页面不抢着报连接中断 */
export const PAGE_WAIT_TIMEOUT_MS = WAIT_TRANSPORT_TIMEOUT_MS + 5_000;

const NOTIFICATION_INTENTS = {
  'opponent-move':'提醒对手已经锁定出招，仍待我应对，不能宣布命中。',
  'opponent-joined':'提醒对手已接受挑战，保留开局与先手事实。',
  'ult-ready':'提醒大招资源刚够，不等于此刻能释放；依据need说明当前仍要应对或等待。',
  'idle-turn':'向玩家征求当前合法主动行动指挥，不替玩家选招。',
  'idle-respond':'提醒当前待应对，按choices征求指挥，不预告成败。',
  'wait-opponent':'确实等待对手行动，可表达期待，不向玩家索要不可执行的动作。',
  'wait-guest':'确实等待接受挑战，保留挑战编号，不宣布已经开战。',
} as const;

export interface AgentTools {
  callTool(name: string, args: Record<string, unknown>, options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<{ reply: GameReply; isError: boolean; battleId?: string | null }>;
}
export function loadAgentPrompt(path: string): string {
  const prompt = readFileSync(path, 'utf8').trim();
  if (!prompt) throw new Error('沙箱Agent提示词为空：' + path);
  return prompt;
}
export interface ReplyModel {
  express(system: string, facts: GameReply, options?: { signal?: AbortSignal }): Promise<string>;
}
export type ExpressionValidationReason = ReplyRejectionReason | SpeechRejectionReason;
export interface AgentRequestOptions { signal?:AbortSignal; profileId?:string }
export interface AgentOutcome {
  profileId:SpeechProfileId; tool:string; text:string; sourceText:string; reply:GameReply; battleId?:string|null;
  isError:boolean; silent:boolean; rewriteStatus:string; speech:SpeechPlan;
  validationReason?:ExpressionValidationReason; expressionError?:string;
}

/** Exactly one game operation. Expression cannot select or retry tools. */
export class SandboxAgent {
  constructor(readonly prompt: string, private readonly model?: ReplyModel, private readonly companionName?:string) {}
  async run(text: string, tools: AgentTools, options: AgentRequestOptions = {}): Promise<AgentOutcome> {
    const profileId = resolveProfileId(options.profileId);
    const signal = options.signal;
    return this.express('game_say', await tools.callTool('game_say', { text }, {signal}), {signal,profileId});
  }
  // 平台侧同样要等满服务端上限，传输超时比 service 的挂起上限再长一点。
  async wait(tools: AgentTools, options: AgentRequestOptions = {}): Promise<AgentOutcome> {
    const profileId = resolveProfileId(options.profileId);
    const signal = options.signal;
    return this.express('wait_event', await tools.callTool('wait_event', {}, {signal, timeoutMs:WAIT_TRANSPORT_TIMEOUT_MS}), {signal,profileId});
  }
  /** Notification facts are read-only; this path cannot invoke a game tool. */
  async notify(result: {reply:GameReply;isError:boolean;battleId?:string|null}, options:AgentRequestOptions & {notificationKind?:keyof typeof NOTIFICATION_INTENTS} = {}):Promise<AgentOutcome> {
    return this.express('notification',result,{signal:options.signal,profileId:resolveProfileId(options.profileId),notificationKind:options.notificationKind});
  }
  private async express(tool: string, result: { reply: GameReply; isError: boolean; battleId?: string | null }, options: { signal?: AbortSignal; profileId:SpeechProfileId; notificationKind?:keyof typeof NOTIFICATION_INTENTS }): Promise<AgentOutcome> {
    const facts = result.reply;
    const sourceText = facts.silent ? '' : facts.text ?? facts.say ?? '这一手结果未确认，我先核实局面。';
    const original = { tool, profileId:options.profileId, text: sourceText, sourceText, reply: facts, battleId:result.isError ? undefined : result.battleId, isError: result.isError, silent: facts.silent === true, speech:fallbackSpeech(sourceText) };
    if (facts.silent) return { ...original, rewriteStatus: 'silent' };
    if (options.signal?.aborted) return { ...original, text:'', silent:true, speech:fallbackSpeech(''), rewriteStatus:'cancelled' };
    if (!this.model || result.isError || facts.reason === 'unknown') return { ...original, rewriteStatus: 'original' };
    try {
      const output = await this.model.express(companionPrompt(this.prompt, options.profileId, this.companionName) + (options.notificationKind ? '\n【本次只读提醒目的】'+NOTIFICATION_INTENTS[options.notificationKind] : ''), facts, {signal:options.signal});
      if (options.signal?.aborted) return { ...original, text:'', silent:true, speech:fallbackSpeech(''), rewriteStatus:'cancelled' };
      const parsed = parseSpeechOutput(output);
      if (!parsed.ok) return { ...original, rewriteStatus:'fallback-invalid', validationReason:parsed.reason };
      const candidate = parsed.text;
      const validationReason = replyRejectionReason(candidate, facts);
      if (validationReason) return { ...original, rewriteStatus: 'fallback-invalid', validationReason };
      return { ...original, text: candidate, speech:parsed.speech, rewriteStatus: candidate === sourceText ? 'original' : 'rewritten' };
    } catch (error) {
      if (options.signal?.aborted) return { ...original, text:'', silent:true, speech:fallbackSpeech(''), rewriteStatus:'cancelled' };
      const expressionError = error instanceof Error && /^表达模型请求失败：HTTP \d+$/.test(error.message) ? error.message : '表达模型不可用';
      return { ...original, rewriteStatus: 'fallback-error', expressionError };
    }
  }
}

export function createSandboxAgent(config: SandboxAgentConfig): SandboxAgent | undefined {
  const prompt = loadAgentPrompt(config.promptPath).split('{{角色名字}}').join(config.companionName ?? '');
  companionPrompt(prompt,'cancan',config.companionName); // Validate this individual name at startup; never infer it from a voice.
  if (!config.model && !config.baseUrl && !config.apiKey) return undefined;
  if (!config.model || !config.baseUrl || !config.apiKey) throw new Error('沙箱Agent配置未完成：需要model、baseUrl和apiKey');
  return new SandboxAgent(prompt, new OpenAiReplyModel({ baseUrl: config.baseUrl, model: config.model, apiKey: config.apiKey, timeoutMs: 8000 }), config.companionName);
}
