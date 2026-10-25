import { MAX_REPLY_BYTES, type GameReply } from '../../src/game/protocol.js';
import type { Logger } from '../../src/log.js';
import { SANDBOX_VERSION } from '../config.js';

/**
 * 手写的 MCP 客户端（JSON-RPC over Streamable HTTP）。
 *
 * 为什么不用 SDK：沙箱要的东西很窄——initialize、tools/list、tools/call，
 * 而且每个请求的原文都要能抓下来给调试面板看。手写一份无状态客户端，
 * 比把 SDK 的会话状态塞进沙箱更好排查，也不会把平台侧的协议细节藏起来。
 */
export interface ToolInfo {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

/** 一条 JSON-RPC 往返，供调试面板展示 */
export interface McpTraceEntry {
  method: string;
  tool?: string;
  status: number;
  ms: number;
  request: unknown;
  response: unknown;
  error?: string;
}

export interface McpTrace {
  ms: number;
  requests: McpTraceEntry[];
}

export type UpstreamErrorCode = 'unreachable' | 'protocol_error';

/** 上游游戏服务不可用：网络、超时、协议错误都归到这里 */
export class UpstreamError extends Error {
  constructor(
    message: string,
    readonly code: UpstreamErrorCode,
  ) {
    super(message);
    this.name = 'UpstreamError';
  }
}

/** 载体形态：页面有屏，自己看得到局面；脚本模拟硬件时用 voice（保留补账播报） */
export type McpDisplay = 'voice' | 'screen';

export interface McpClientOptions {
  upstream: string;
  deviceId: string;
  agentId: string;
  sessionId: string;
  timeoutMs: number;
  logger: Logger;
  /** 默认 screen：沙箱的主用途是有屏的页面 */
  display?: McpDisplay;
}

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: number | string | null;
  result?: unknown;
  error?: { code?: number; message?: string };
}

/** 把响应体解析成 JSON-RPC 消息：兼容普通 JSON 与 SSE（老传输会回 event-stream） */
function parseRpcBody(raw: string, contentType: string): unknown {
  const text = raw.trim();
  if (!text) return null;

  if (contentType.includes('text/event-stream')) {
    // SSE 响应里每条消息是「data: {...}」；取第一条带 result / error 的
    for (const line of text.split('\n')) {
      const data = line.startsWith('data:') ? line.slice(5).trim() : '';
      if (!data) continue;
      try {
        const parsed = JSON.parse(data) as JsonRpcMessage;
        if (parsed && typeof parsed === 'object' && ('result' in parsed || 'error' in parsed)) return parsed;
      } catch {
        // 不是完整 JSON 就当没看见，继续找下一行
      }
    }
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new UpstreamError('游戏服务返回了无法解析的响应', 'protocol_error');
  }
}

export class LinxMcpClient {
  private nextId = 1;
  private readonly trace: McpTraceEntry[] = [];
  private readonly startedAt = Date.now();
  private server: { name: string; version: string } | null = null;

  constructor(private readonly options: McpClientOptions) {}

  /** 上游自报的服务名与版本，供调试面板显示 */
  get serverInfo(): { name: string; version: string } | null {
    return this.server;
  }

  /** 取走这一轮的全部请求记录（含耗时） */
  takeTrace(): McpTrace {
    return { ms: Date.now() - this.startedAt, requests: this.trace.slice() };
  }

  async initialize(options: { signal?: AbortSignal } = {}): Promise<void> {
    const result = (await this.rpc('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'linx-sandbox', version: SANDBOX_VERSION },
    }, undefined, options)) as { serverInfo?: { name?: string; version?: string } } | undefined;

    const name = result?.serverInfo?.name;
    const version = result?.serverInfo?.version;
    this.server = name ? { name, version: version ?? '' } : null;

    // 协议要求初始化后再发一条通知；无状态服务不回内容，失败也不影响调用
    await this.notify('notifications/initialized', options);
  }

  async listTools(): Promise<ToolInfo[]> {
    const result = (await this.rpc('tools/list')) as
      | { tools?: Array<{ name?: string; title?: string; description?: string; inputSchema?: Record<string, unknown> }> }
      | undefined;
    return (result?.tools ?? [])
      .filter((tool): tool is { name: string; title?: string; description?: string; inputSchema?: Record<string, unknown> } => typeof tool.name === 'string')
      .map((tool) => ({ name: tool.name, title: tool.title, description: tool.description, inputSchema: tool.inputSchema }));
  }

  /** v2 text 内容是事实 JSON，绝不作为话术直接朗读。 */
  async callTool(name: string, args: Record<string, unknown>, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<{ reply: GameReply; isError: boolean; battleId?: string | null }> {
    const result = await this.rpc('tools/call', { name, arguments: args }, name, options) as
      { content?: Array<{ type?: string; text?: string }>; isError?: boolean; _meta?: Record<string, unknown> } | undefined;
    const content = result?.content;
    if (!content || content.length !== 1 || content[0]?.type !== 'text' || typeof content[0]?.text !== 'string') {
      throw new UpstreamError('游戏服务没有返回单个事实 JSON', 'protocol_error');
    }
    const isError = result?.isError === true;
    // Faults cannot bind an invented null battle identity to an existing battle.
    const battleId = isError ? undefined : result?._meta?.['linx/battleId'];
    if (battleId !== undefined && battleId !== null && typeof battleId !== 'string') invalid();
    return { reply: decodeReply(content[0].text), isError, battleId: battleId as string | null | undefined };
  }

  private async rpc(method: string, params?: unknown, tool?: string, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<unknown> {
    const id = this.nextId++;
    const body: Record<string, unknown> = { jsonrpc: '2.0', id, method };
    if (params !== undefined) body.params = params;

    const { status, message } = await this.post(body, { method, tool }, options);
    if (status >= 400) {
      throw new UpstreamError(`游戏服务返回 HTTP ${status}`, 'protocol_error');
    }
    if (Array.isArray(message)) {
      throw new UpstreamError('游戏服务返回了批量响应，沙箱只支持单条消息', 'protocol_error');
    }
    const reply = message as JsonRpcMessage | null;
    if (!reply || typeof reply !== 'object') {
      throw new UpstreamError('游戏服务没有返回 JSON-RPC 响应', 'protocol_error');
    }
    if (reply.error) {
      throw new UpstreamError(`游戏服务返回错误：${reply.error.message ?? '未知错误'}`, 'protocol_error');
    }
    return reply.result;
  }

  /** 通知没有 id，也不该有响应体；服务端回 202 时不当作失败 */
  private async notify(method: string, options: { signal?: AbortSignal } = {}): Promise<void> {
    try {
      await this.post({ jsonrpc: '2.0', method }, { method }, options);
    } catch (error) {
      this.options.logger.debug('初始化通知未送达，继续调用', {
        method,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async post(
    body: Record<string, unknown>,
    label: { method: string; tool?: string },
    options: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<{ status: number; message: unknown }> {
    const startedAt = Date.now();
    const controller = new AbortController();
    const timeoutMs = options.timeoutMs ?? this.options.timeoutMs;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const cancel = () => controller.abort(options.signal?.reason);
    options.signal?.addEventListener('abort', cancel, { once: true });
    if (options.signal?.aborted) cancel();

    try {
      const response = await fetch(`${this.options.upstream}/mcp`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'X-Linx-Device-Id': this.options.deviceId,
          'X-Linx-Agent-Id': this.options.agentId,
          'X-Linx-Session-Id': this.options.sessionId,
          'X-Linx-Display': this.options.display ?? 'screen',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      const raw = await response.text();
      const message = parseRpcBody(raw, response.headers.get('content-type') ?? '');
      this.trace.push({
        method: label.method,
        tool: label.tool,
        status: response.status,
        ms: Date.now() - startedAt,
        request: body,
        response: message,
      });
      return { status: response.status, message };
    } catch (error) {
      const aborted = error instanceof Error && error.name === 'AbortError';
      const message = aborted
        ? `请求超时（${timeoutMs}ms）`
        : error instanceof Error
          ? error.message
          : String(error);
      this.trace.push({
        method: label.method,
        tool: label.tool,
        status: 0,
        ms: Date.now() - startedAt,
        request: body,
        response: null,
        error: message,
      });
      throw new UpstreamError(
        aborted ? `游戏服务响应超时（${timeoutMs}ms）` : `连不上游戏服务：${message}`,
        'unreachable',
      );
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', cancel);
    }
  }
}

/** One versioned schema, no text or presentation guessing. */
export function decodeReply(text: string): GameReply {
  if (Buffer.byteLength(text, 'utf8') > MAX_REPLY_BYTES) invalid();
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new UpstreamError('游戏事实不是有效 JSON', 'protocol_error'); }
  if (!record(value) || value.v !== 2 || typeof value.ok !== 'boolean') invalid();
  const reply = value as Record<string, unknown>;
  if (reply.silent === true) return reply as unknown as GameReply;
  const unknownWithoutSnapshot = reply.reason === 'unknown' && reply.phase === undefined && reply.need === undefined;
  if (!unknownWithoutSnapshot && !['idle','room','battle','victory','defeat'].includes(String(reply.phase))) invalid();
  if (!unknownWithoutSnapshot && !['move','respond','wait_guest','wait_foe','none'].includes(String(reply.need))) invalid();
  if (reply.mode !== undefined && reply.mode !== 'solo' && reply.mode !== 'pvp') invalid();
  if (reply.round !== undefined && !nonnegative(reply.round)) invalid();
  if (['battle','victory','defeat'].includes(String(reply.phase)) && (!reply.you || !reply.foe || !reply.mode)) invalid();
  if (typeof reply.text !== 'string' && typeof reply.say !== 'string') invalid();
  if (!Array.isArray(reply.events) || !reply.events.every(validEvent)) invalid();
  if (reply.ok === false && !['unclear','negated','ambiguous','wrong_stage','no_ap','no_ult','waiting','ended','room_missing','room_full','room_bad','failed','unknown'].includes(String(reply.reason))) invalid();
  if (reply.text !== undefined && typeof reply.text !== 'string') invalid();
  if (reply.say !== undefined && typeof reply.say !== 'string') invalid();
  if (reply.room !== undefined && (typeof reply.room !== 'string' || !/^\d{4}$/.test(reply.room))) invalid();
  for (const key of ['you','foe']) {
    if (reply[key] !== undefined) {
      const fighter = reply[key];
      if (!record(fighter) || !['hp','maxHp','ap','ult'].every(n => nonnegative(fighter[n]))) invalid();
      if (key === 'you' && !nonnegative(fighter.maxAp)) invalid();
      if (key === 'foe' && typeof fighter.name !== 'string') invalid();
    }
  }
  if (reply.deny !== undefined) {
    if (!record(reply.deny) || !['light','heavy','ult','guard','dodge','take','charge'].includes(String(reply.deny.mv))) invalid();
    if (reply.deny.need !== undefined && !nonnegative(reply.deny.need)) invalid();
    if (reply.deny.short !== undefined && !nonnegative(reply.deny.short)) invalid();
  }
  if (reply.pending !== undefined && (!record(reply.pending) || !side(reply.pending.by) || !move(reply.pending.mv) || !nonnegative(reply.pending.dmg))) invalid();
  if (reply.choices !== undefined && (!Array.isArray(reply.choices) || !reply.choices.every(c => typeof c === 'string'))) invalid();
  return reply as unknown as GameReply;
}
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function nonnegative(value: unknown): boolean { return typeof value === 'number' && Number.isInteger(value) && value >= 0; }
function side(value: unknown): boolean { return value === 'you' || value === 'foe'; }
function move(value: unknown): boolean { return ['light','heavy','ult'].includes(String(value)); }
function validEvent(event: unknown): boolean {
  if (!record(event)) return false;
  switch (event.t) {
    case 'start': return typeof event.foe === 'string' && side(event.first);
    case 'room': case 'join': return typeof event.code === 'string' && /^\d{4}$/.test(event.code);
    case 'round': return nonnegative(event.n) && nonnegative(event.bonus);
    case 'charge': return side(event.by) && nonnegative(event.ap);
    case 'hit': return side(event.by) && move(event.mv) && ['guard','dodge','take'].includes(String(event.r)) && nonnegative(event.dmg)
      && ['miss','crit','forced'].every(key => event[key] === undefined || event[key] === true);
    case 'end': return side(event.win) && (event.cause === undefined || event.cause === 'forfeit');
    case 'timeout': return event.what === 'guest' || event.what === 'foe';
    case 'chant': return typeof event.text === 'string';
    default: return false;
  }
}
function invalid(): never { throw new UpstreamError('游戏事实不符合 MCP v2 契约', 'protocol_error'); }
