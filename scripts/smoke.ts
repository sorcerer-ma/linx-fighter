/**
 * 冒烟脚本：对着已在运行的 MCP 服务跑一遍真实调用链（initialize → tools/call）。
 * 覆盖原话透传（game_say）、单人整回合与双人联机（房主开局 → 对手加入 → 各出一手）。
 * 用法：node --import tsx scripts/smoke.ts http://127.0.0.1:8787
 */
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
): Promise<string> {
  const response = await client.request('tools/call', { name, arguments: args }, extraHeaders);
  const text = (response.result?.content?.[0]?.text ?? '') as string;
  console.log(`\n--- ${name} ---\n${text}`);
  return text;
}

// 统一入口：玩家原话原样交给 game_say，由服务端判断玩法 / 开局 / 招式与误识别 / 战况
await call('game_say', { text: '怎么玩' }, talker);
await call('game_say', { text: '开始' }, talker);
await call('game_say', { text: '公鸡' }, talker);
await call('game_say', { text: '战况如何' }, talker);

// 单人：开局 → 主动出招（对手先手时先应对）→ 应对 → 战况 → 说明
const opened = await call('game_start');
if (opened.includes('对手先手')) {
  await call('game_action', { action: '格挡' });
  await call('game_action', { action: '攻击' });
} else {
  await call('game_action', { action: '攻击' });
  await call('game_action', { action: '格挡' });
}
await call('game_status');
await call('game_help');

// 双人：房主开房拿四位房间号 → 另一台设备加入 → 房主先手 → 对手应对 → 各自看战况
const created = await call('game_start', { mode: 'pvp' });
const room = created.match(/房间(\d{4})/)?.[1];
if (!room) throw new Error(`开房回应里没有 4 位房间号：${created}`);

await call('game_start', { room }, guest);
if (created.includes('对手先手')) {
  // 对手（guest）先手：guest 出招，房主应对
  await call('game_action', { action: '强攻' }, guest);
  await call('game_action', { action: '格挡' });
} else {
  await call('game_action', { action: '强攻' });
  await call('game_action', { action: '格挡' }, guest);
}
await call('game_status');
await call('game_status', {}, guest);

client.close();
