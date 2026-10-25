import { replyRejectionReason, type ReplyRejectionReason } from './reply-check.js';
import { fallbackSpeech, parseSpeechOutput, type SpeechPlan, type SpeechRejectionReason } from './speech.js';
import { companionPrompt, resolveProfileId, type SpeechProfileId } from './profiles.js';
import { OpenAiReplyModel } from './reply-model.js';
import type { GameReply } from '../../src/game/protocol.js';
import { readFileSync } from 'node:fs';
import type { SandboxAgentConfig } from '../config.js';

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
  constructor(readonly prompt: string, private readonly model?: ReplyModel) {}
  async run(text: string, tools: AgentTools, options: AgentRequestOptions = {}): Promise<AgentOutcome> {
    const profileId = resolveProfileId(options.profileId);
    const signal = options.signal;
    return this.express('game_say', await tools.callTool('game_say', { text }, {signal}), {signal,profileId});
  }
  async wait(tools: AgentTools, options: AgentRequestOptions = {}): Promise<AgentOutcome> {
    const profileId = resolveProfileId(options.profileId);
    const signal = options.signal;
    return this.express('wait_event', await tools.callTool('wait_event', {}, {signal, timeoutMs:35_000}), {signal,profileId});
  }
  private async express(tool: string, result: { reply: GameReply; isError: boolean; battleId?: string | null }, options: { signal?: AbortSignal; profileId:SpeechProfileId }): Promise<AgentOutcome> {
    const facts = result.reply;
    const sourceText = facts.silent ? '' : facts.text ?? facts.say ?? '这一手结果未确认，我先核实局面。';
    const original = { tool, profileId:options.profileId, text: sourceText, sourceText, reply: facts, battleId:result.isError ? undefined : result.battleId, isError: result.isError, silent: facts.silent === true, speech:fallbackSpeech(sourceText) };
    if (facts.silent) return { ...original, rewriteStatus: 'silent' };
    if (options.signal?.aborted) return { ...original, text:'', silent:true, speech:fallbackSpeech(''), rewriteStatus:'cancelled' };
    if (!this.model || result.isError || facts.reason === 'unknown') return { ...original, rewriteStatus: 'original' };
    try {
      const output = await this.model.express(companionPrompt(this.prompt, options.profileId), facts, {signal:options.signal});
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
  const prompt = loadAgentPrompt(config.promptPath);
  if (!config.model && !config.baseUrl && !config.apiKey) return undefined;
  if (!config.model || !config.baseUrl || !config.apiKey) throw new Error('沙箱Agent配置未完成：需要model、baseUrl和apiKey');
  return new SandboxAgent(prompt, new OpenAiReplyModel({ baseUrl: config.baseUrl, model: config.model, apiKey: config.apiKey, timeoutMs: 8000 }));
}
