import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { GameService } from '../src/game/service.js';
import { createLogger } from '../src/log.js';
import { applyRequestContext, createDeviceContext, type DeviceContext } from '../src/mcp/context.js';
import { registerGameTools } from '../src/mcp/tools.js';

/** 平台取消这次调用时带过来的信号：wait_event 要能提前收摊 */
interface ToolExtra {
  signal?: AbortSignal;
}

type ToolHandler = (
  args: Record<string, unknown>,
  extra?: ToolExtra,
) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}>;

/** 只实现 registerTool 的假 server，直接拿到注册进来的定义与处理函数 */
function registerWith(
  service: GameService,
  logger = createLogger('error'),
  waitTimeoutMs = 30_000,
): { handlers: Map<string, ToolHandler>; definitions: Map<string, Record<string, unknown>>; ctx: DeviceContext } {
  const handlers = new Map<string, ToolHandler>();
  const definitions = new Map<string, Record<string, unknown>>();
  const fakeServer = {
    registerTool: (name: string, definition: Record<string, unknown>, handler: ToolHandler) => {
      handlers.set(name, handler);
      definitions.set(name, definition);
    },
  } as unknown as McpServer;

  const ctx = createDeviceContext('conn-tools');
  applyRequestContext(ctx, { 'x-linx-device-id': 'dev-tools', 'x-linx-agent-id': 'agent-tools' });
  registerGameTools(fakeServer, { service, logger, ctx, waitTimeoutMs });
  return { handlers, definitions, ctx };
}

describe('工具层', () => {
  it('注册六个游戏工具', () => {
    const { handlers } = registerWith({} as GameService);
    assert.deepEqual([...handlers.keys()].sort(), [
      'game_action',
      'game_help',
      'game_say',
      'game_start',
      'game_status',
      'wait_event',
    ]);
  });

  it('每个工具都声明 speaker 参数，平台才肯把声纹结果带上', () => {
    const { definitions } = registerWith({} as GameService);
    for (const [name, definition] of definitions) {
      const schema = definition.inputSchema as Record<string, unknown>;
      assert.ok(schema.speaker, `${name} 应声明 speaker 参数`);
    }
  });

  it('参数里的说话人写回上下文并进日志', async () => {
    const records: Array<Record<string, unknown>> = [];
    const logger = {
      debug: () => {},
      info: (message: string, fields?: Record<string, unknown>) => records.push({ message, ...fields }),
      warn: () => {},
      error: () => {},
    };
    const service = {
      say: async () => ({ text: '嗯。', battle: null }),
    } as unknown as GameService;
    const { handlers, ctx } = registerWith(service, logger);

    await handlers.get('game_say')!({ text: '普攻', speaker: '小林' });

    const call = records.find((record) => record.message === '工具调用');
    assert.equal(call?.speaker, '小林');
    assert.equal(ctx.speakerName, '小林');
  });

  it('业务异常转成可朗读的失败播报，不抛给协议层', async () => {
    const boom = (): never => {
      throw new Error('底层服务炸了');
    };
    const service = {
      start: boom,
      act: boom,
      status: boom,
      help: boom,
      say: boom,
      wait: boom,
    } as unknown as GameService;
    const { handlers } = registerWith(service);

    for (const name of ['game_start', 'game_action', 'game_status', 'game_help', 'game_say', 'wait_event']) {
      const result = await handlers.get(name)!({ action: '攻击', opponent: '木人', text: '攻击' }, {});
      assert.equal(result.isError, true, `${name} 应标记为失败`);
      assert.match(result.content[0]!.text, /服务出了点问题/);
    }
  });

  it('wait_event 把服务端超时上限与平台取消信号原样交给 service.wait', async () => {
    const controller = new AbortController();
    let called: { key: string; timeoutMs: number; signal?: AbortSignal } | undefined;
    const service = {
      async wait(key: string, options: { timeoutMs: number; signal?: AbortSignal }) {
        called = { key, timeoutMs: options.timeoutMs, signal: options.signal };
        return { text: '对手出招了', battle: null };
      },
    } as unknown as GameService;
    const { handlers } = registerWith(service, undefined, 12_345);

    const result = await handlers.get('wait_event')!({}, { signal: controller.signal });

    assert.ok(called);
    // 超时由部署配置决定，不交给模型；取消信号要跟着请求走，平台断开时能提前收摊
    assert.equal(called.key, 'dev-tools#agent-tools');
    assert.equal(called.timeoutMs, 12_345);
    assert.equal(called.signal, controller.signal);
    assert.equal(result.isError, undefined);
    assert.equal(result.content[0]!.text, '对手出招了');
  });
});
