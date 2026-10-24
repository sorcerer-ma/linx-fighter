import { readFileSync } from 'node:fs';
import type { SandboxAgentConfig } from '../config.js';

export interface AgentTools {
  callTool(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }>;
}
export function loadAgentPrompt(path: string): string {
  const prompt = readFileSync(path, 'utf8').trim();
  if (!prompt) throw new Error('沙箱Agent提示词为空：' + path);
  return prompt;
}

/** Relay understanding and execution to MCP. Never retry a possibly applied turn. */
export class SandboxAgent {
  constructor(readonly prompt: string) {}
  async run(text: string, tools: AgentTools) {
    const result = await tools.callTool('game_say', {text});
    // Current MCP replies contain no verifiable rendering facts. Until that
    // contract is agreed, do not submit them for an unchecked model rewrite.
    return {tool:'game_say', ...result, sourceText:result.text, rewriteStatus:'awaiting-facts' as const};
  }
}

export function createSandboxAgent(config: SandboxAgentConfig): SandboxAgent | undefined {
  const prompt = loadAgentPrompt(config.promptPath);
  if (!config.model && !config.baseUrl && !config.apiKey) return undefined;
  if (!config.model || !config.baseUrl || !config.apiKey) throw new Error('沙箱Agent配置未完成：需要model、baseUrl和apiKey');
  return new SandboxAgent(prompt);
}
