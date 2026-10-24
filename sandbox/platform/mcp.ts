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

  async initialize(): Promise<void> {
    const result = (await this.rpc('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'linx-sandbox', version: SANDBOX_VERSION },
    })) as { serverInfo?: { name?: string; version?: string } } | undefined;

    const name = result?.serverInfo?.name;
    const version = result?.serverInfo?.version;
    this.server = name ? { name, version: version ?? '' } : null;

    // 协议要求初始化后再发一条通知；无状态服务不回内容，失败也不影响调用
    await this.notify('notifications/initialized');
  }

  async listTools(): Promise<ToolInfo[]> {
    const result = (await this.rpc('tools/list')) as
      | { tools?: Array<{ name?: string; title?: string; description?: string }> }
      | undefined;
    return (result?.tools ?? [])
      .filter((tool): tool is { name: string; title?: string; description?: string } => typeof tool.name === 'string')
      .map((tool) => ({ name: tool.name, title: tool.title, description: tool.description }));
  }

  /** 调一个工具，返回可直接朗读的文本 */
  async callTool(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
    const result = (await this.rpc('tools/call', { name, arguments: args }, name)) as
      | { content?: Array<{ type?: string; text?: string }>; isError?: boolean }
      | undefined;

    const text = (result?.content ?? [])
      .filter((item) => item.type === 'text' && typeof item.text === 'string')
      .map((item) => item.text)
      .join('\n')
      .trim();

    return { text: text || '（游戏服务没有返回内容）', isError: result?.isError === true };
  }

  private async rpc(method: string, params?: unknown, tool?: string): Promise<unknown> {
    const id = this.nextId++;
    const body: Record<string, unknown> = { jsonrpc: '2.0', id, method };
    if (params !== undefined) body.params = params;

    const { status, message } = await this.post(body, { method, tool });
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
  private async notify(method: string): Promise<void> {
    try {
      await this.post({ jsonrpc: '2.0', method }, { method });
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
  ): Promise<{ status: number; message: unknown }> {
    const startedAt = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);

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
        ? `请求超时（${this.options.timeoutMs}ms）`
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
        aborted ? `游戏服务响应超时（${this.options.timeoutMs}ms）` : `连不上游戏服务：${message}`,
        'unreachable',
      );
    } finally {
      clearTimeout(timer);
    }
  }
}
