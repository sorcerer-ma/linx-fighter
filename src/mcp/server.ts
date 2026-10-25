import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export const SERVER_NAME = 'linx-fighter';
export const SERVER_VERSION = '0.2.0';

/**
 * 下发给平台侧模型的行为说明（MCP initialize 时返回）。
 * 写得越明确，模型越不会自己编战斗结果、也越愿意调用工具。
 */
const INSTRUCTIONS = [
  '这里是「灵矽对决」MCP v2，只有 game_say 与 wait_event 两个工具。',
  '玩家每句话原样调用一次 game_say，服务端理解并裁决；不要自行分类、推算或重复执行。',
  'content[].text 是单个 v2 JSON 事实对象，不是台词，不要把 JSON 念出来。依据 events、need 和明确的局面事实按伙伴人设表达；say 仅为安全兜底。',
  'silent=true 时不生成话术或播放；failed 表示明确未执行，unknown 表示结果未确认，先核实，不要求重复出招。',
  'need=wait_guest 或 wait_foe 时先播放完即时回复，再串行调用 wait_event；返回后仍需等待就续挂，每身份最多一个在途等待。纯正常timeout不发声直接续等；silent、取消或未知错误停止旧链。move/respond等玩家指挥，终局停止，不自动出招。',
  '招式选择只看 choices；大招不在 choices 时不能提示可释放，不从能量自行推算。',
  '身份来自请求头；speaker 仅由平台为本次 game_say 或 wait_event 填入，不自行编造或复用上次名字；参数与本次请求头冲突时静默。快照和 SSE 用于画界面，不能另开一条原文播报通道。',
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
