import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { GameService } from '../src/game/service.js';
import { createLogger } from '../src/log.js';
import { applyRequestContext, createDeviceContext } from '../src/mcp/context.js';
import { registerGameTools } from '../src/mcp/tools.js';

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}>;

/** 只实现 registerTool 的假 server，直接拿到注册进来的处理函数 */
function registerWith(service: GameService): Map<string, ToolHandler> {
  const handlers = new Map<string, ToolHandler>();
  const fakeServer = {
    registerTool: (name: string, _definition: unknown, handler: ToolHandler) => {
      handlers.set(name, handler);
    },
  } as unknown as McpServer;

  const ctx = createDeviceContext('conn-tools');
  applyRequestContext(ctx, { 'x-linx-device-id': 'dev-tools', 'x-linx-agent-id': 'agent-tools' });
  registerGameTools(fakeServer, { service, logger: createLogger('error'), ctx });
  return handlers;
}

describe('工具层', () => {
  it('注册五个游戏工具', () => {
    const handlers = registerWith({} as GameService);
    assert.deepEqual([...handlers.keys()].sort(), ['game_action', 'game_help', 'game_say', 'game_start', 'game_status']);
  });

  it('业务异常转成可朗读的失败播报，不抛给协议层', async () => {
    const boom = (): never => {
      throw new Error('底层服务炸了');
    };
    const service = { start: boom, act: boom, status: boom, help: boom, say: boom } as unknown as GameService;
    const handlers = registerWith(service);

    for (const name of ['game_start', 'game_action', 'game_status', 'game_help', 'game_say']) {
      const result = await handlers.get(name)!({ action: '攻击', opponent: '木人', text: '攻击' });
      assert.equal(result.isError, true, `${name} 应标记为失败`);
      assert.match(result.content[0]!.text, /服务出了点问题/);
    }
  });
});
