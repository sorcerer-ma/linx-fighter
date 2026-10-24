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
  opponent: z.string().trim().min(1).max(20).optional().describe('单人模式的对手名字，可不填，由系统安排'),
  mode: z
    .enum(['solo', 'pvp'])
    .optional()
    .describe('solo=和 AI 对手单挑（默认）；pvp=开双人房，等另一位玩家凭房间号加入'),
  room: z
    .string()
    .trim()
    .min(1)
    .max(12)
    .optional()
    .describe('四位房间号，填了就加入该房间，和另一位玩家对打；房主开房时会拿到房间号'),
  text: z
    .string()
    .trim()
    .min(1)
    .max(60)
    .optional()
    .describe('玩家原话（可选）：不确定该填 mode 还是 room 时把原话放这里，服务端会识别「开房间」「加入房间1234」'),
};

const actionInput = {
  action: z
    .string()
    .trim()
    .min(1)
    .describe(
      '招式：主动阶段 light=普攻、heavy=强攻、ult=大招、charge=蓄力；对手出招后 guard=格挡、dodge=闪避、take=承受。也可以直接填玩家原话，例如「闪避」或「共鸣斩破军」',
    ),
};

/**
 * 注册游戏工具。
 * 工具层只做参数形状与错误兜底，业务编排在 GameService，方便后续替换实现。
 */
export function registerGameTools(server: McpServer, deps: ToolDependencies): void {
  const { service, logger, ctx } = deps;

  // 统一包装：异常不外抛，转成玩家能听懂的一句失败播报，同时记日志
  const invoke = async (
    tool: string,
    args: Record<string, unknown>,
    run: () => ServiceResult | Promise<ServiceResult>,
  ) => {
    try {
      // 入参、身份头与返回文案都进日志：平台侧模型传了什么、系统回了什么，都能逐轮回放
      logger.info('工具调用', {
        tool,
        sessionKey: battleKey(ctx),
        deviceId: ctx.deviceId,
        agentId: ctx.agentId,
        args: previewArgs(args),
      });
      const result = await run();
      logger.info('工具返回', {
        tool,
        sessionKey: battleKey(ctx),
        text: result.text,
        round: result.battle?.round ?? 0,
        phase: result.battle?.phase ?? null,
        active: result.battle?.active ?? null,
        pending: result.battle?.pending
          ? `${result.battle.pending.actor}:${result.battle.pending.move}`
          : null,
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
      description:
        '开一局新的灵犀对决。默认和 AI 对手单挑；玩家说要「联机」「双人对战」「开房间」时必须传 mode=pvp，会开房并拿到四位房间号；另一位玩家说「加入房间1234」时传 room=1234。拿不准参数就把玩家原话放进 text。会覆盖当前未结束的对局。',
      inputSchema: startInput,
    },
    async ({ opponent, mode, room, text }) =>
      invoke('game_start', { opponent, mode, room, text }, () =>
        service.start(battleKey(ctx), { opponent, mode, room, text }),
      ),
  );

  server.registerTool(
    'game_action',
    {
      title: '出招',
      description:
        '执行玩家这一手的招式或应对。轮到玩家主动时可以用普攻、强攻、大招、蓄力；对手出招后只能格挡、闪避、承受。玩家说出这些招式的同义说法（打、躲、硬抗等）或唤出指令时也调用。玩家说「开房间」「联机」「加入房间1234」也原样传进 action，服务端会按联机处理。操作不合法时不会推进回合，返回里会说明原因并给可选说法。',
      inputSchema: actionInput,
    },
    async ({ action }) => invoke('game_action', { action }, () => service.act(battleKey(ctx), action)),
  );

  server.registerTool(
    'game_status',
    {
      title: '查看战况',
      description:
        '查看当前对局双方的气血、真气和回合数；双人房里还会说明现在轮到谁出招。玩家问「战况如何」「我还剩多少血」时调用。',
      inputSchema: {},
    },
    async () => invoke('game_status', {}, () => service.status(battleKey(ctx))),
  );

  server.registerTool(
    'game_help',
    {
      title: '玩法说明',
      description: '说明玩法与可用指令。玩家问「怎么玩」「你能做什么」时调用。',
      inputSchema: {},
    },
    async () => invoke('game_help', {}, () => service.help()),
  );
}

/** 工具入参摘要：只留短字符串，避免把整段语音原话写进日志 */
function previewArgs(args: Record<string, unknown>): Record<string, string> {
  const preview: Record<string, string> = {};
  for (const [key, value] of Object.entries(args)) {
    if (typeof value === 'string' && value.trim()) preview[key] = value.trim().slice(0, 40);
  }
  return preview;
}
