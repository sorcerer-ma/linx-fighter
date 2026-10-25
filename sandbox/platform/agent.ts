import { checkReply } from './reply-check.js';
import { OpenAiReplyModel } from './reply-model.js';
import type { Presentation } from '../../src/game/presentation.js';
import { readFileSync } from 'node:fs';
import type { SandboxAgentConfig } from '../config.js';

export interface AgentTools {
  callTool(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean; presentation?: Presentation }>;
}
export function loadAgentPrompt(path: string): string {
  const prompt = readFileSync(path, 'utf8').trim();
  if (!prompt) throw new Error('沙箱Agent提示词为空：' + path);
  return prompt;
}

/** Relay understanding and execution to MCP. Never retry a possibly applied turn. */
export interface ReplyModel {
  rewrite(system:string,sourceText:string,facts?:Presentation):Promise<string>;
}
export class SandboxAgent {
  constructor(readonly prompt: string, private readonly model?: ReplyModel) {}
  async run(text: string, tools: AgentTools) {
    const result = await tools.callTool('game_say', {text});
    const original = {tool:'game_say',...result,sourceText:result.text};
    const facts = result.presentation;
    if (!this.model || result.isError || !facts || facts.certainty === 'unknown'
      || !['turn','status','opening','retry','rejected'].includes(facts.kind)) {
      return {...original,rewriteStatus:'original'};
    }
    try {
      const candidate=await this.model.rewrite(this.prompt,result.text,facts);
      // Heuristic checks detect common errors; they cannot prove all semantics.
      if (!checkReply(result.text,candidate,facts)) return {...original,rewriteStatus:'fallback-invalid'};
      return {...original,text:candidate,rewriteStatus:candidate===result.text?'original':'rewritten'};
    } catch (error) {
      const expressionError=error instanceof Error && /^表达模型请求失败：HTTP \d+$/.test(error.message) ? error.message : '表达模型不可用';
      return {...original,rewriteStatus:'fallback-error',expressionError};
    }
  }
}

export function createSandboxAgent(config: SandboxAgentConfig): SandboxAgent | undefined {
  const prompt = loadAgentPrompt(config.promptPath);
  if (!config.model && !config.baseUrl && !config.apiKey) return undefined;
  if (!config.model || !config.baseUrl || !config.apiKey) throw new Error('沙箱Agent配置未完成：需要model、baseUrl和apiKey');
  return new SandboxAgent(prompt,new OpenAiReplyModel({baseUrl:config.baseUrl,model:config.model,apiKey:config.apiKey,timeoutMs:8000}));
}
