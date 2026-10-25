import { SandboxAgent } from './agent.js';
import type { GameReply } from '../../src/game/protocol.js';
import type { ReplyRejectionReason } from './reply-check.js';
import { randomUUID } from 'node:crypto';
import type { BattleState } from '../../src/game/state.js';
import type { Logger } from '../../src/log.js';
import { LinxMcpClient, UpstreamError, type McpDisplay, type McpTrace, type ToolInfo } from './mcp.js';

/**
 * 沙箱对游戏服务的全部依赖都收在这里：
 * - say：把玩家原话交给 MCP 工具 game_say，再把局面查回来；
 * - state：只读局面，给 CLI 和页面兜底用；
 * - tools：工具清单，给调试面板用。
 *
 * 每次 say 新建一个 MCP 客户端：服务端是无状态的，
 * 这样两次调用之间不会串身份，trace 也只属于这一轮。
 */
export interface SandboxClientOptions {
  agent?: SandboxAgent;
  upstream: string;
  agentId: string;
  timeoutMs: number;
  logger: Logger;
  /** 页面是 screen（不补账），脚本模拟硬件时传 voice */
  display?: McpDisplay;
}

/** 状态接口与 SSE 共用的局面载荷 */
export interface BattleSnapshot {
  device: string;
  agent: string;
  room: string | null;
  battle: BattleState | null;
}

export interface SayResult {
  ok: boolean;
  protocol?: GameReply;
  sourceBattleId?: string | null;
  silent: boolean;
  validationReason?: ReplyRejectionReason;
  reply: string;
  isError: boolean;
  tool: string;
  deviceId: string;
  agentId: string;
  sessionId: string;
  state: BattleSnapshot | null;
  trace: McpTrace;
  sourceReply?: string;
  rewriteStatus?: string;
  expressionError?: string;
  error?: string;
}

export class SandboxClient {
  constructor(private readonly options: SandboxClientOptions) {}

  get agentMode(): 'relay' | 'compatibility' { return this.options.agent ? 'relay' : 'compatibility'; }

  /** No protocol interpretation or tool selection occurs before game_say. */
  async say(deviceId: string, text: string, options: { signal?: AbortSignal } = {}): Promise<SayResult> {
    return this.invoke(deviceId, 'game_say', text, options);
  }
  async wait(deviceId: string, options: { signal?: AbortSignal } = {}): Promise<SayResult> {
    return this.invoke(deviceId, 'wait_event', '', options);
  }
  private async invoke(deviceId: string, tool: 'game_say' | 'wait_event', text: string, options: { signal?: AbortSignal }): Promise<SayResult> {
    const sessionId = `s-${randomUUID().slice(0, 8)}`;
    const mcp = new LinxMcpClient({
      upstream: this.options.upstream, deviceId, agentId: this.options.agentId,
      sessionId, timeoutMs: this.options.timeoutMs, logger: this.options.logger, display: this.options.display,
    });
    const base = { tool, deviceId, agentId: this.options.agentId, sessionId };
    try {
      options.signal?.throwIfAborted();
      await mcp.initialize(options);
      const agent = this.options.agent ?? new SandboxAgent('');
      const outcome = tool === 'wait_event' ? await agent.wait(mcp, options) : await agent.run(text, mcp, options);
      const state = await this.state(deviceId).catch(() => null);
      const cancelled = options.signal?.aborted === true;
      const stale = state !== null && outcome.battleId !== undefined && outcome.battleId !== (state.battle?.battleId ?? null);
      const trace = mcp.takeTrace();
      const validationReason = 'validationReason' in outcome ? outcome.validationReason : undefined;
      const rewriteStatus = cancelled ? 'cancelled' : stale ? 'stale' : outcome.rewriteStatus;
      this.options.logger.info('沙箱转发', {
        deviceId, requestId: sessionId, rewriteStatus, validationReason,
        expressionError: 'expressionError' in outcome ? outcome.expressionError : undefined,
        isError: outcome.isError, round: state?.battle?.round ?? 0, room: state?.room, tool, ms: trace.ms,
      });
      return { ok: true, ...base, reply: stale || cancelled ? '' : outcome.text, protocol: outcome.reply,
        sourceBattleId:outcome.battleId, silent:outcome.silent || stale || cancelled, validationReason,
        isError: outcome.isError, sourceReply:outcome.sourceText, rewriteStatus,
        expressionError:'expressionError' in outcome && typeof outcome.expressionError === 'string' ? outcome.expressionError : undefined, state, trace };
    } catch {
      const cancelled = options.signal?.aborted === true;
      this.options.logger.warn('沙箱工具结果未确认', { deviceId, requestId:sessionId, tool, cancelled });
      return { ok:false, ...base, silent:cancelled, reply:cancelled ? '' : '这一手结果未确认，我先核实局面。',
        isError:true, state:null, trace:mcp.takeTrace(), error:cancelled ? 'cancelled' : 'upstream_unreachable' };
    }
  }

  /** 只读局面；上游不可用时抛错，由调用方决定怎么提示 */
  async state(deviceId: string): Promise<BattleSnapshot> {
    const url = new URL('/state', this.options.upstream);
    url.searchParams.set('device', deviceId);
    url.searchParams.set('agent', this.options.agentId);

    const response = await fetch(url, { signal: AbortSignal.timeout(Math.min(this.options.timeoutMs, 3000)) });
    if (!response.ok) throw new UpstreamError(`状态查询失败：HTTP ${response.status}`, 'protocol_error');

    const body = (await response.json()) as {
      device?: string;
      agent?: string;
      room?: string | null;
      battle?: BattleState | null;
    };
    return {
      device: body.device ?? deviceId,
      agent: body.agent ?? this.options.agentId,
      room: body.room ?? null,
      battle: body.battle ?? null,
    };
  }

  async tools(): Promise<ToolInfo[]> {
    const mcp = new LinxMcpClient({
      upstream: this.options.upstream,
      // 探测工具清单不需要真实玩家身份，用固定占位，避免在别人对局上留下痕迹
      deviceId: 'sandbox-probe',
      agentId: this.options.agentId,
      sessionId: `s-${randomUUID().slice(0, 8)}`,
      timeoutMs: this.options.timeoutMs,
      logger: this.options.logger,
      display: this.options.display,
    });
    await mcp.initialize();
    return mcp.listTools();
  }

  /** 上游健康检查：给 /api/health 与调试面板用 */
  async health(): Promise<{ reachable: boolean; battles: number | null; rooms: number | null }> {
    try {
      const response = await fetch(new URL('/health', this.options.upstream), {
        signal: AbortSignal.timeout(Math.min(this.options.timeoutMs, 3000)),
      });
      if (!response.ok) return { reachable: false, battles: null, rooms: null };
      const body = (await response.json()) as { battles?: number; rooms?: number };
      return { reachable: true, battles: body.battles ?? null, rooms: body.rooms ?? null };
    } catch {
      return { reachable: false, battles: null, rooms: null };
    }
  }
}
