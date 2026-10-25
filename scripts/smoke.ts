/**
 * 冒烟脚本：对着已在运行的 MCP 服务跑一遍真实调用链（initialize → tools/call）。
 * 覆盖原话透传（game_say）、单人整回合与双人联机（房主开局 → 对手加入 → 各出一手）。
 * 用法：node --import tsx scripts/smoke.ts http://127.0.0.1:8787
 */
import type { GameReply } from '../src/game/protocol.js';
import { McpTestClient } from '../test/helpers/mcp-client.js';

const baseUrl = process.argv[2] ?? 'http://127.0.0.1:8000';
const host = {
  'X-Linx-Device-Id': 'smoke-device',
  'X-Linx-Agent-Id': 'smoke-agent',
  'X-Linx-Session-Id': 'smoke-session',
};
const guest = {
  'X-Linx-Device-Id': 'smoke-device-b',
  'X-Linx-Agent-Id': 'smoke-agent',
  'X-Linx-Session-Id': 'smoke-session',
};
// 原话透传用独立身份，免得和后面的单人/双人对局串在同一局里
const talker = {
  'X-Linx-Device-Id': 'smoke-device-say',
  'X-Linx-Agent-Id': 'smoke-agent',
  'X-Linx-Session-Id': 'smoke-session',
};

const client = await McpTestClient.connect(baseUrl, host);

const init = await client.request('initialize', {
  protocolVersion: '2024-11-05',
  capabilities: {},
  clientInfo: { name: 'linx-smoke', version: '1.0.0' },
});
console.log('serverInfo:', init.result?.serverInfo);
await client.notify('notifications/initialized');

const tools = await client.request('tools/list');
console.log('tools:', tools.result?.tools?.map((tool: { name: string }) => tool.name).join(', '));

/** 调用工具并返回玩家可读文本；extraHeaders 用于切换设备身份 */
async function call(
  name: string,
  args: Record<string, unknown> = {},
  extraHeaders: Record<string, string> = {},
): Promise<GameReply> {
  const response = await client.request('tools/call', { name, arguments: args }, extraHeaders);
  const text = (response.result?.content?.[0]?.text ?? '') as string;
  console.log(`\n--- ${name} ---\n${text}`);
  const facts = JSON.parse(text) as GameReply;
  if (facts.v !== 2) throw new Error('预期 MCP v2 事实 JSON');
  return facts;
}

// 统一入口：玩家原话原样交给 game_say，由服务端判断玩法 / 开局 / 招式与误识别 / 战况
await call('game_say', { text: '怎么玩' }, talker);
await call('game_say', { text: '开始' }, talker);
await call('game_say', { text: '公鸡' }, talker);
await call('game_say', { text: '战况如何' }, talker);

// 单人：阶段和房间号来自事实，不解析台词。
await call('game_say', { text: '开始' });
let state = await call('game_say', { text: '战况如何' });
for (let i = 0; i < 2 && state.phase === 'battle'; i++) {
  state = await call('game_say', { text: state.need === 'respond' ? '格挡' : '普攻' });
}
await call('game_say', { text: '怎么玩' });
const opened = await call('game_say', { text: '开房' });
if (!opened.room) throw new Error('开房事实缺少房间号');
const joined = await call('game_say', { text: `加入房间${opened.room}` }, guest);
if (joined.need === 'move') {
  await call('game_say', { text: '强攻' }, guest);
  await call('game_say', { text: '格挡' });
} else {
  await call('game_say', { text: '强攻' });
  await call('game_say', { text: '格挡' }, guest);
}
await call('game_say', { text: '战况如何' });
await call('game_say', { text: '战况如何' }, guest);
client.close();
