import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Logger } from '../log.js';
import type { GameService, ServiceResult } from '../game/service.js';
import { battleKey, type DeviceContext } from './context.js';
import { encodeReply, unknownReply } from './reply.js';

export interface ToolDependencies {
  service: GameService;
  logger: Logger;
  /** 当前 MCP 连接对应的设备上下文，POST 调用时会先刷新 */
  ctx: DeviceContext;
  /** wait_event 挂起时长（毫秒）；装配层传入配置值，缺省交给服务按上限兜底 */
  waitTimeoutMs?: number;
}
const speakerField = z.string().trim().min(1).max(20).optional()
  .describe('由平台声纹填入的说话人称呼；没有就不传，不要自己编。仅用于门禁，不决定对局身份');

// SDK 会先执行 Zod 校验。长度放在公开 JSON Schema 元数据中，处理器再按
// Unicode 字符计数拒绝，才能返回业务 unclear，而非 SDK 的非 JSON 错误；绝不截断原话。
const sayInput = z.object({
  text: z.string().meta({ minLength: 1, maxLength: 200 })
    .describe('玩家原话，一字不改，不总结、不补上下文；1～200 字，超长不会执行'),
  speaker: speakerField,
}).strict();

/** 单行日志里的原话上限，与公开 schema 的 200 字对齐；超长的非法输入不该把日志撑爆 */
const LOG_TEXT_LIMIT = 200;

/** 日志用的原话：正常原样保留，超长才截断并标出真实字数；交给服务的原话永不截断 */
function logText(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  const chars = [...text];
  return chars.length > LOG_TEXT_LIMIT
    ? `${chars.slice(0, LOG_TEXT_LIMIT).join('')}…（共 ${chars.length} 字）`
    : text;
}

/** 一次工具调用的入参：原话只有 game_say 有，speaker 是平台本次给出的声纹元数据 */
interface InvokeInput {
  text?: string;
  speaker?: string;
}

/** v2 只暴露原话入口与等待；游戏事实来自服务，不从播报文案反推。 */
export function registerGameTools(server: McpServer, deps: ToolDependencies): void {
  const { service, logger, ctx } = deps;
  const invoke = async (
    tool: string, input: InvokeInput,
    run: (key: string, speaker: string | undefined) => ServiceResult | Promise<ServiceResult>,
  ) => {
    const argumentSpeaker = input.speaker?.trim() || undefined;
    const headerSpeaker = ctx.speakerName.trim() || undefined;
    const conflict = Boolean(argumentSpeaker && headerSpeaker && argumentSpeaker !== headerSpeaker);
    const currentSpeaker = argumentSpeaker ?? headerSpeaker;
    // speakerSource 用来说明这个名字来自工具参数还是请求头；冲突时两者都不可信。
    const speakerSource = conflict ? 'conflict' : argumentSpeaker ? 'argument' : headerSpeaker ? 'header' : undefined;
    // 在 await 之前捕获身份；同一连接的其他请求不能改变这次调用的归属。
    const key = battleKey(ctx);
    try {
      // 原话与说话人只进日志，用于核对平台交来的 ASR 内容与声纹归属。
      logger.info('工具调用', {
        tool, sessionKey: key, deviceId: ctx.deviceId, agentId: ctx.agentId,
        text: logText(input.text), speaker: currentSpeaker, speakerSource,
      });
      if (conflict) {
        logger.warn('说话人参数与请求头冲突，本次静默', {
          tool, sessionKey: key, argumentSpeaker, headerSpeaker,
        });
      }
      // Conflicting current metadata is untrusted. Never reuse a previous tool argument.
      const result: ServiceResult = conflict
        ? {text:'',battle:null,reply:{v:2,ok:true,silent:true}}
        : await run(key, currentSpeaker);
      if (!result.reply) throw new Error('MissingProtocolReply');
      const text = encodeReply(result.reply);
      logger.info('工具返回', {
        tool, sessionKey: key, version: result.reply.v, ok: result.reply.ok,
        reason: result.reply.reason, silent: result.reply.silent === true,
        phase: result.reply.phase, eventCount: result.reply.events?.length ?? 0,
      });
      return { content: [{ type: 'text' as const, text }], _meta: { 'linx/battleId': result.battle?.id ?? null } };
    } catch (error) {
      // 执行可能已经发生，不能用异常推断「没生效」或建议自动重做。
      // 不记录异常原文，防止上游错误夹带认证信息或用户原话。
      logger.error('工具调用失败', { tool, sessionKey: key, error: error instanceof Error ? error.name : 'UnknownError' });
      return {
        content: [{ type: 'text' as const, text: encodeReply(unknownReply()) }],
        isError: true, _meta: { 'linx/battleId': null },
      };
    }
  };
  server.registerTool('game_say', {
    title: '玩家说了什么',
    description: '玩家每句话原样交给游戏，不改字、不分类、不补上下文。服务端理解并执行，返回 v2 JSON 事实；只依据事实演绎，不念 JSON。silent=true 不出声；need 为 wait_guest 或 wait_foe 时，先播完即时回复，再最多调用一次 wait_event。',
    inputSchema: sayInput,
  }, async ({ text, speaker }) => invoke('game_say', { text, speaker }, (key, currentSpeaker) => {
    if (!text.trim() || [...text].length > 200) return service.invalidInput(key, {speaker:currentSpeaker});
    return service.say(key, text, { catchUp: ctx.display !== 'screen', speaker:currentSpeaker });
  }));
  server.registerTool('wait_event', {
    title: '等待对手',
    description: '仅上一条 need 为 wait_guest 或 wait_foe 时，在即时话术播放完成后调用；每轮最多一次。speaker 仅为本次平台声纹元数据，不自行编造；等待对手进房或出招；超时、取消不执行游戏动作。返回与 game_say 相同的 v2 JSON。',
    inputSchema: z.object({speaker:speakerField}).strict(),
  }, async ({speaker}, extra) => invoke('wait_event', { speaker }, (key, currentSpeaker) => service.waitEvent(key, {
    signal: extra?.signal, speaker:currentSpeaker, timeoutMs:deps.waitTimeoutMs,
  })));
}
