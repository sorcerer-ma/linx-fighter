import type { SandboxAgent } from './agent.js';
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
  reply: string;
  isError: boolean;
  tool: string;
  deviceId: string;
  agentId: string;
  sessionId: string;
  state: BattleSnapshot | null;
  trace: McpTrace;
  error?: string;
}

export class SandboxClient {
  constructor(private readonly options: SandboxClientOptions) {}

  get agentMode(): 'agent' | 'compatibility' { return this.options.agent ? 'agent' : 'compatibility'; }

  /** Agent selects a tool; legacy direct mode remains explicitly labelled. */
  async say(deviceId: string, text: string): Promise<SayResult> {
    const sessionId = `s-${randomUUID().slice(0, 8)}`;
    const mcp = new LinxMcpClient({
      upstream: this.options.upstream,
      deviceId,
      agentId: this.options.agentId,
      sessionId,
      timeoutMs: this.options.timeoutMs,
      logger: this.options.logger,
      display: this.options.display,
    });

    const base = { tool: this.options.agent ? 'agent' : 'game_say', deviceId, agentId: this.options.agentId, sessionId };
    try {
      await mcp.initialize();
      const outcome = this.options.agent
        ? await this.options.agent.run(deviceId + '#' + this.options.agentId, text, mcp)
        : {tool:'game_say',...await mcp.callTool('game_say', { text })};
      const { text: reply, isError } = outcome;
      // 局面只是展示用：查不到不影响这一句播报
      const state = await this.state(deviceId).catch(() => null);
      const trace = mcp.takeTrace();
      this.options.logger.info('沙箱转发', {
        deviceId,
        text: text.slice(0, 40),
        reply: reply.slice(0, 40),
        isError,
        round: state?.battle?.round ?? 0,
        room: state?.room,
        tool: outcome.tool,
        ms: trace.ms,
      });
      return { ok: true, reply, isError, ...base, tool:outcome.tool, state, trace };
    } catch (error) {
      const message = error instanceof UpstreamError ? error.message : error instanceof Error ? error.message : String(error);
      const trace = mcp.takeTrace();
      this.options.logger.warn('沙箱Agent或工具调用失败', { deviceId, error: message, ms: trace.ms });
      return {
        ok: false,
        reply: this.options.agent ? 'Agent或工具调用失败，结果未确认，请先核实战况。' : `沙箱连不上游戏服务（${this.options.upstream}），先确认那边在跑。`,
        isError: true,
        ...base,
        state: null,
        trace,
        error: this.options.agent ? 'agent_or_tool_failed' : 'upstream_unreachable',
      };
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
