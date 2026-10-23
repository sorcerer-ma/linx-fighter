import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export const SERVER_NAME = 'linx-fighter';
export const SERVER_VERSION = '0.1.0';

/**
 * 下发给平台侧模型的行为说明（MCP initialize 时返回）。
 * 写得越明确，模型越不会自己编战斗结果、也越愿意调用工具。
 */
const INSTRUCTIONS = [
  '这里是「灵犀对决」，一个回合制对战游戏的服务端。',
  '玩家用语音下指令，你负责调用工具推进对局，再把工具返回的 text 用口语念给玩家；不要复述工具名或 JSON。',
  '玩家说开始游戏、出招、看战况时，分别调用 game_start、game_action、game_status。',
  '主动阶段可以说普攻、强攻、大招、蓄力；对手出招后进入应对，只能说格挡、闪避、承受。玩家说得含糊或认不出时，照返回的错误提示重说，不要自己替玩家选招。',
  '血量、真气、回合数和胜负一律以工具返回为准，不要自行推算或编造。',
].join('\n');

/**
 * 每个 SSE 连接创建一个独立的 McpServer 实例。
 * SDK 的 McpServer 内部按连接保存协议状态，多个连接共用一个实例会串会话。
 */
export function createMcpServer(): McpServer {
  return new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: INSTRUCTIONS },
  );
}
