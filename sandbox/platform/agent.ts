import { readFileSync } from 'node:fs';
import type { SandboxAgentConfig } from '../config.js';
import type { ToolInfo } from './mcp.js';

export interface AgentExchange { user: string; tool: string; reply: string }
export interface AgentChoice { tool: string; arguments: Record<string, unknown> }
/** Provider-neutral boundary. A real tool-calling protocol has not been selected. */
export interface AgentModel {
  select(input: { system: string; text: string; history: readonly AgentExchange[]; tools: ToolInfo[] }): Promise<AgentChoice | null>;
}
export interface AgentTools {
  listTools(): Promise<ToolInfo[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }>;
}
const allowed = new Set(['game_start', 'game_action', 'game_status', 'game_help']);
const actions = new Set(['light', 'heavy', 'ult', 'charge', 'guard', 'dodge', 'take']);

export function loadAgentPrompt(path: string): string {
  const prompt = readFileSync(path, 'utf8').trim();
  if (!prompt) throw new Error('沙箱Agent提示词为空：' + path);
  return prompt;
}

export class SandboxAgent {
  private readonly histories = new Map<string, AgentExchange[]>();
  constructor(private readonly prompt: string, private readonly model: AgentModel) {}

  async run(identity: string, text: string, tools: AgentTools) {
    const menu = (await tools.listTools()).filter(tool => allowed.has(tool.name));
    const history = this.histories.get(identity) ?? [];
    const choice = await this.model.select({system:this.prompt,text,history,tools:menu});
    if (!choice) return {tool:'none',text:'这句话还不明确，请说清要出招、查战况、问玩法还是开始对局。',isError:false};
    if (!menu.some(tool => tool.name === choice.tool)) throw new Error('Agent选择了不可用工具');
    if (choice.tool === 'game_action' && !actions.has(String(choice.arguments.action))) throw new Error('Agent必须使用标准招式标识');
    if (choice.tool === 'game_start' && 'text' in choice.arguments) throw new Error('Agent必须理解开局参数，不能透传原话');
    const result = await tools.callTool(choice.tool, choice.arguments);
    // Retain a short per-device context, never reinterpret the authoritative result.
    this.histories.set(identity,[...history,{user:text,tool:choice.tool,reply:result.text}].slice(-8));
    return {tool:choice.tool,...result};
  }
}

export function createSandboxAgent(config: SandboxAgentConfig, model?: AgentModel): SandboxAgent | undefined {
  const prompt = loadAgentPrompt(config.promptPath); // Startup-only single source, even in explicitly labelled compatibility mode.
  const requested = Boolean(config.model || config.baseUrl || config.apiKey || model);
  if (!requested) return undefined;
  if (!config.model || !config.baseUrl || !config.apiKey) throw new Error('沙箱Agent配置未完成：需要model、baseUrl和apiKey');
  if (!model) throw new Error('沙箱Agent尚未选择模型工具调用协议，不能启用或回退伪装Agent');
  return new SandboxAgent(prompt,model);
}
