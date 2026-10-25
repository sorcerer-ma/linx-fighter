import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ATTACKS } from '../game/rules.js';

export const SERVER_NAME = 'linx-fighter';
export const SERVER_VERSION = '0.1.0';

/**
 * 下发给平台侧模型的行为说明（MCP initialize 时返回）。
 * 写得越明确，模型越不会自己编战斗结果、也越愿意调用工具。
 */
const INSTRUCTIONS = [
  '这里是「灵犀对决」，一个回合制对战游戏的服务端。',
  '玩家用语音下指令，你负责调用工具推进对局，再把工具返回的 text 用口语念给玩家；不要复述工具名或 JSON。',
  '玩家说的每一句话都先调用 game_say，把原话一字不改地放进 text。不要自己判断这是开局、出招还是提问，也不要自己回答游戏之外的话题：招式、查战况、问玩法、开房间、加入房间、闲聊、念诗、与游戏无关的问题，都交给服务端识别与回答。',
  `主动阶段可出普攻、强攻、蓄力；大招要${ATTACKS.ult.apCost}点能量且每局一次，只有 presentation.facts.you.ultimateReady 为 true 时才可提示玩家可以用，能量不够、次数用完或字段为 false 时都不要提。具体以工具返回文本和该字段为准。对手出招后进入应对，只能说格挡、闪避、承受。玩家说得含糊或认不出时，照返回的提示让玩家重说，不要自己替玩家选招。`,
  '生命值、能量、回合数和胜负一律以工具返回为准，不要自行推算或编造。',
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
