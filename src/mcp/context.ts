import type { IncomingHttpHeaders } from 'node:http';

/**
 * 设备上下文。
 *
 * 灵犀平台在每次 MCP 调用时用 HTTP 头带上设备与会话信息，不放进工具入参：
 * - X-Linx-Device-Id：设备 ID
 * - X-Linx-Agent-Id：智能体 ID
 * - X-Linx-Session-Id：会话 ID（每轮对话刷新）
 *
 * 同一台设备 + 同一个智能体共享一局对局，所以对局归属键不包含会话 ID，
 * 玩家断线重连、换一轮对话，进行中的对局都不会丢。
 */
export const HEADER_DEVICE_ID = 'x-linx-device-id';
export const HEADER_AGENT_ID = 'x-linx-agent-id';
export const HEADER_SESSION_ID = 'x-linx-session-id';

export interface DeviceContext {
  deviceId: string;
  agentId: string;
  sessionId: string;
  /** 兜底标识：既没有设备头也没有会话头时（例如本地手工调试），用连接级 id 区分 */
  anonymousId: string;
}

export function createDeviceContext(anonymousId: string): DeviceContext {
  return { deviceId: '', agentId: '', sessionId: '', anonymousId };
}

function readHeader(headers: IncomingHttpHeaders, name: string): string {
  const value = headers[name];
  if (Array.isArray(value)) return value[0]?.trim() ?? '';
  return value?.trim() ?? '';
}

function readQuery(query: Record<string, unknown>, name: string): string {
  const value = query[name];
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number') return String(value);
  return '';
}

/**
 * 用请求头（以及本地调试用的查询参数）刷新上下文。
 *
 * 每次请求带回的头是这一次调用的权威身份，所以有值就覆盖：
 * 万一平台复用一个 SSE 连接给多台设备调用，也不会把对局串到别的设备上。
 * 头里没带值时才保留上一次的结果（GET 建连时可能拿不到头，POST 时才带上来）。
 */
export function applyRequestContext(
  ctx: DeviceContext,
  headers: IncomingHttpHeaders,
  query: Record<string, unknown> = {},
): void {
  const deviceId = readHeader(headers, HEADER_DEVICE_ID) || readQuery(query, 'device');
  const agentId = readHeader(headers, HEADER_AGENT_ID) || readQuery(query, 'agent');
  const sessionId = readHeader(headers, HEADER_SESSION_ID) || readQuery(query, 'session');

  if (deviceId) ctx.deviceId = deviceId;
  if (agentId) ctx.agentId = agentId;
  if (sessionId) ctx.sessionId = sessionId;
}

/** 对局归属键：同设备同智能体共享一局 */
export function battleKey(ctx: DeviceContext): string {
  if (ctx.deviceId) return `${ctx.deviceId}#${ctx.agentId || 'default'}`;
  if (ctx.sessionId) return `session:${ctx.sessionId}`;
  return `anon:${ctx.anonymousId}`;
}
