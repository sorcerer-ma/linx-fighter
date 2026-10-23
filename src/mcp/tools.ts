import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Logger } from '../log.js';
import type { GameService, ServiceResult } from '../game/service.js';
import { battleKey, type DeviceContext } from './context.js';

export interface ToolDependencies {
  service: GameService;
  logger: Logger;
  /** 当前 MCP 连接对应的设备上下文，POST 调用时会先刷新 */
  ctx: DeviceContext;
}

const startInput = {
  opponent: z.string().trim().min(1).max(20).optional().describe('对手名字，可不填，由系统安排'),
};

const actionInput = {
  action: z
    .string()
    .trim()
    .min(1)
    .describe('招式：attack=攻击，dodge=闪避，recover=回气；也可以直接填玩家原话，例如「闪避」'),
};

/**
 * 注册游戏工具。
 * 工具层只做参数形状与错误兜底，业务编排在 GameService，方便后续替换实现。
 */
export function registerGameTools(server: McpServer, deps: ToolDependencies): void {
  const { service, logger, ctx } = deps;

  // 统一包装：异常不外抛，转成玩家能听懂的一句失败播报，同时记日志
  const invoke = (tool: string, run: () => ServiceResult) => {
    try {
      const result = run();
      logger.debug('工具调用完成', {
        tool,
        sessionKey: battleKey(ctx),
        turn: result.battle?.turn ?? 0,
      });
      return { content: [{ type: 'text' as const, text: result.text }] };
    } catch (error) {
      logger.error('工具调用失败', {
        tool,
        sessionKey: battleKey(ctx),
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        content: [{ type: 'text' as const, text: '服务出了点问题，这一手没有生效，请再说一次。' }],
        isError: true,
      };
    }
  };

  server.registerTool(
    'game_start',
    {
      title: '开始游戏',
      description: '开一局新的灵犀对决，会覆盖当前未结束的对局。玩家说「开始游戏」「来一局」「重新开始」时调用。',
      inputSchema: startInput,
    },
    async ({ opponent }) => invoke('game_start', () => service.start(battleKey(ctx), opponent)),
  );

  server.registerTool(
    'game_action',
    {
      title: '出招',
      description:
        '执行玩家本回合的招式，推进一个回合。玩家说出攻击、闪避、回气或它们的同义说法（打、躲、调息等）时调用。招式认不出来时不会推进回合，返回里会提示可选招式。',
      inputSchema: actionInput,
    },
    async ({ action }) => invoke('game_action', () => service.act(battleKey(ctx), action)),
  );

  server.registerTool(
    'game_status',
    {
      title: '查看战况',
      description: '查看当前对局双方的气血、真气和回合数。玩家问「战况如何」「我还剩多少血」时调用。',
      inputSchema: {},
    },
    async () => invoke('game_status', () => service.status(battleKey(ctx))),
  );

  server.registerTool(
    'game_help',
    {
      title: '玩法说明',
      description: '说明玩法与可用指令。玩家问「怎么玩」「你能做什么」时调用。',
      inputSchema: {},
    },
    async () => invoke('game_help', () => service.help()),
  );
}
