/**
 * 冒烟脚本：对着已在运行的 MCP 服务跑一遍真实调用链（initialize → tools/call）。
 * 用法：node --import tsx scripts/smoke.ts http://127.0.0.1:8787
 */
import { McpTestClient } from '../test/helpers/mcp-client.js';

const baseUrl = process.argv[2] ?? 'http://127.0.0.1:8000';
const headers = {
  'X-Linx-Device-Id': 'smoke-device',
  'X-Linx-Agent-Id': 'smoke-agent',
  'X-Linx-Session-Id': 'smoke-session',
};

const client = await McpTestClient.connect(baseUrl, headers);

const init = await client.request('initialize', {
  protocolVersion: '2024-11-05',
  capabilities: {},
  clientInfo: { name: 'linx-smoke', version: '1.0.0' },
});
console.log('serverInfo:', init.result?.serverInfo);
await client.notify('notifications/initialized');

const tools = await client.request('tools/list');
console.log('tools:', tools.result?.tools?.map((tool: { name: string }) => tool.name).join(', '));

async function call(name: string, args: Record<string, unknown> = {}): Promise<void> {
  const response = await client.request('tools/call', { name, arguments: args });
  console.log(`\n--- ${name} ---\n${response.result?.content?.[0]?.text}`);
}

await call('game_start');
await call('game_action', { action: '攻击' });
await call('game_action', { action: '回气' });
await call('game_status');
await call('game_help');

client.close();
