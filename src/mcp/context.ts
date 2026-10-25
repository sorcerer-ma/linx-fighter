import type { IncomingHttpHeaders } from 'node:http';

/**
 * 设备上下文。
 *
 * 灵矽平台在每次 MCP 调用时用 HTTP 头带上设备与会话信息，不放进工具入参：
 * - X-Linx-Device-Id：设备 ID
 * - X-Linx-Agent-Id：智能体 ID
 * - X-Linx-Session-Id：会话 ID（每轮对话刷新）
 *
 * 同一台设备 + 同一个智能体共享一局对局，所以对局归属键不包含会话 ID，
 * 玩家断线重连、换一轮对话，进行中的对局都不会丢。
 *
 * - X-Linx-Display：载体有没有屏幕（`screen` / `voice`），决定要不要补账播报。
 *   平台不会带这个头，默认按语音终端处理；沙箱页面自己带 `screen`。
 *
 * 声纹识别在平台内部完成，说话人身份是否下发给工具目前没有公开文档；
 * `X-Linx-Speaker-*` 先按「带了就用、没带为空」处理，只进日志，不参与对局归属。
 * 真实的头名以线上抓到的请求为准（见 `identityHeaders`），确认后再补文档。
 */
export const HEADER_DEVICE_ID = 'x-linx-device-id';
export const HEADER_AGENT_ID = 'x-linx-agent-id';
export const HEADER_SESSION_ID = 'x-linx-session-id';
export const HEADER_DISPLAY = 'x-linx-display';
export const HEADER_SPEAKER_NAME = 'x-linx-speaker-name';
export const HEADER_SPEAKER_ID = 'x-linx-speaker-id';

/** 载体形态：有屏客户端能自己看到局面，无屏终端只能靠下一次播报补上 */
export type DisplayMode = 'voice' | 'screen';

export interface DeviceContext {
  deviceId: string;
  agentId: string;
  sessionId: string;
  /** 默认 voice：平台与硬件不会声明，保持「补账播报」的原有体验 */
  display: DisplayMode;
  /** 声纹命中时的说话人称呼；平台没下发时为空，只用于日志与排查 */
  speakerName: string;
  /** 声纹命中时的说话人编号；同上，不参与对局归属 */
  speakerId: string;
  /** 兜底标识：既没有设备头也没有会话头时（例如本地手工调试），用连接级 id 区分 */
  anonymousId: string;
}

export function createDeviceContext(anonymousId: string): DeviceContext {
  return {
    deviceId: '',
    agentId: '',
    sessionId: '',
    display: 'voice',
    speakerName: '',
    speakerId: '',
    anonymousId,
  };
}

function readHeader(headers: IncomingHttpHeaders, name: string): string {
  const value = headers[name];
  if (Array.isArray(value)) return value[0]?.trim() ?? '';
  return value?.trim() ?? '';
}

/**
 * 请求头按 latin1 解码，中文说话人称呼会变成乱码或百分号编码，这里还原成可读文本。
 *
 * 只用于日志与排查：认不出来就原样返回，绝不因为一个称呼让整次调用失败。
 */
function decodeHeaderText(raw: string): string {
  if (!raw) return '';
  if (/%[0-9a-f]{2}/i.test(raw)) {
    try {
      return decodeURIComponent(raw);
    } catch {
      // 不是合法的百分号编码，继续往下试
    }
  }
  if (/[\u0080-\u00ff]/.test(raw)) {
    const utf8 = Buffer.from(raw, 'latin1').toString('utf8');
    if (!utf8.includes('\uFFFD')) return utf8;
  }
  return raw;
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
  const display = readHeader(headers, HEADER_DISPLAY) || readQuery(query, 'display');
  const speakerName = decodeHeaderText(readHeader(headers, HEADER_SPEAKER_NAME));
  const speakerId = decodeHeaderText(readHeader(headers, HEADER_SPEAKER_ID));

  if (deviceId) ctx.deviceId = deviceId;
  if (agentId) ctx.agentId = agentId;
  if (sessionId) ctx.sessionId = sessionId;
  // 认不出的一律当语音终端，宁可多补一句，也不要让硬件静音
  if (display === 'screen' || display === 'voice') ctx.display = display;
  // 说话人跟着这一次调用走：换个说话人就该换个称呼，没带就当作没识别出来
  ctx.speakerName = speakerName;
  ctx.speakerId = speakerId;
}

/** 对局归属键：同设备同智能体共享一局 */
export function battleKey(ctx: DeviceContext): string {
  if (ctx.deviceId) return `${ctx.deviceId}#${ctx.agentId || 'default'}`;
  if (ctx.sessionId) return `session:${ctx.sessionId}`;
  return `anon:${ctx.anonymousId}`;
}

/** 这些头与业务无关，抓包时不必列出来 */
const BORING_HEADERS = new Set([
  'host',
  'connection',
  'content-length',
  'content-type',
  'accept',
  'accept-encoding',
  'accept-language',
  'accept-charset',
  'user-agent',
  'cache-control',
  'pragma',
  'origin',
  'referer',
  'content-encoding',
  'transfer-encoding',
  'expect',
  'te',
]);

/** 名字里带这些词的一律不落日志，避免把口令写进 journal */
const SECRET_HEADER = /(auth|cookie|token|secret|key|passw|signature)/i;

/**
 * 挑出请求里可能携带身份的自定义头，用来确认平台到底把哪些上下文传给了工具。
 *
 * 只留非标准头（`x-linx-*` 与平台以后新增的其它头），敏感头按名字打码。
 * 这个结果只进日志，不参与任何对局判断。
 */
export function identityHeaders(headers: IncomingHttpHeaders): Record<string, string> {
  const picked: Record<string, string> = {};
  for (const [name, raw] of Object.entries(headers)) {
    const key = name.toLowerCase();
    if (raw === undefined) continue;
    const value = Array.isArray(raw) ? raw.join(', ') : raw;
    if (SECRET_HEADER.test(key)) {
      picked[key] = '<已隐藏>';
      continue;
    }
    if (BORING_HEADERS.has(key)) continue;
    picked[key] = decodeHeaderText(value);
  }
  return picked;
}
