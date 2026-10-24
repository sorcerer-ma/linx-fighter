/**
 * 服务配置：全部来自环境变量，方便容器化部署。
 * 这里只做取值解析与兜底，不包含业务判断。
 */

import {
  DEFAULT_CHAT_MODEL,
  DEFAULT_DECISION_MODEL,
  type ChatReasoning,
} from './game/llm.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** 座位归属策略：off 保持原行为；strict 时双人房按座位口令过滤原话 */
export type AttributionMode = 'off' | 'strict';

export interface AppConfig {
  /** HTTP 监听端口，默认 8000 */
  port: number;
  /** HTTP 监听地址，默认 0.0.0.0 */
  host: string;
  logLevel: LogLevel;
  /** 对局空闲多久后清理（毫秒） */
  battleTtlMs: number;
  /** 是否暴露 /debug/* 调试端点，生产环境建议关闭 */
  enableDebugEndpoints: boolean;
  /** 旧共享 API Key；仅未设置专用地址时允许回退，避免跨 provider 使用 */
  apiKey?: string;
  /** 旧共享根地址；专用地址未配置时回退 */
  baseUrl?: string;
  /** 决策 provider 密钥；非空时启用命令路由和 JEV 对手 */
  decisionApiKey?: string;
  /** 决策 provider 地址，独立于聊天 provider */
  decisionBaseUrl?: string;
  /** 聊天 provider 密钥；非空时启用规则外问答 */
  chatApiKey?: string;
  /** 聊天 provider 地址，独立于决策 provider */
  chatBaseUrl?: string;
  /** 决策模型路径，默认 /systemone */
  decisionPath?: string;
  /** 语言模型路径，默认 /chat/completions */
  chatPath?: string;
  /** 决策模型名，默认 typesafe/jev-1.14 */
  decisionModel: string;
  /** 规则外问答模型名，默认 deepseek/deepseek-v4-flash */
  chatModel: string;
  /** 问答模型的推理开关；推理模型不关会只输出思考、正文为空 */
  chatReasoning: ChatReasoning;
  /** 命令路由模型超时（毫秒），超时按没认出来处理 */
  routerTimeoutMs: number;
  /** 问答超时（毫秒），超时回固定话术 */
  chatTimeoutMs: number;
  /** 对手 AI：jev 走 JEV 决策接口，local 用内置决策模型；未配 Key 时自动回落 local */
  enemyAi: 'jev' | 'local';
  /** 对手单次决策超时（毫秒），超时回退本地 */
  enemyTimeoutMs: number;
  /** 座位归属策略：双人房里按座位口令把指令算到对的机器上，默认 off */
  attribution: AttributionMode;
  /**
   * 后台监控页口令；为空时 /admin 公开可见（便于现场查看局面）。
   * 配置后访问必须带 ?token= 或 Authorization: Bearer。
   */
  adminToken?: string;
  /**
   * 可以触发游戏的说话人（平台声纹的名字，逗号分隔）：未登记的声音不回应，
   * 避免环境里其他人声、噪声误触发对局。为空表示不限制。
   */
  speakers: string[];
}

const LOG_LEVELS: LogLevel[] = ['debug', 'info', 'warn', 'error'];

/** 说话人名单：逗号分隔、去空白；空串或没配都是「不设限」 */
function parseSpeakers(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/[,，]/)
    .map((name) => name.trim())
    .filter(Boolean);
}

/** 只认 off / low 两个值，写错就当没配 */
function parseChatReasoning(raw: string | undefined): ChatReasoning | undefined {
  const value = raw?.trim().toLowerCase();
  if (value === 'off' || value === 'low') return value;
  return undefined;
}

function parseAttributionMode(raw: string | undefined): AttributionMode {
  return (raw ?? '').trim().toLowerCase() === 'strict' ? 'strict' : 'off';
}

function parseInteger(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) ? value : fallback;
}

function parseBoolean(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw.trim() === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const level = (env.LOG_LEVEL ?? '').trim().toLowerCase();
  const logLevel = (LOG_LEVELS as string[]).includes(level) ? (level as LogLevel) : 'info';

  return {
    port: Math.max(1, Math.min(65535, parseInteger(env.PORT, 8000))),
    host: env.HOST?.trim() || '0.0.0.0',
    logLevel,
    battleTtlMs: Math.max(60, parseInteger(env.BATTLE_TTL_SECONDS, 1800)) * 1000,
    enableDebugEndpoints: parseBoolean(env.ENABLE_DEBUG_ENDPOINTS, env.NODE_ENV !== 'production'),
    apiKey: env.API_KEY?.trim() || undefined,
    baseUrl: env.BASE_URL?.trim() || undefined,
    decisionApiKey: env.DECISION_API_KEY?.trim() || (env.DECISION_BASE_URL?.trim() ? undefined : env.API_KEY?.trim() || undefined),
    decisionBaseUrl: env.DECISION_BASE_URL?.trim() || env.BASE_URL?.trim() || undefined,
    chatApiKey: env.CHAT_API_KEY?.trim() || (env.CHAT_BASE_URL?.trim() ? undefined : env.API_KEY?.trim() || undefined),
    chatBaseUrl: env.CHAT_BASE_URL?.trim() || env.BASE_URL?.trim() || undefined,
    decisionPath: env.DECISION_PATH?.trim() || undefined,
    chatPath: env.CHAT_PATH?.trim() || undefined,
    decisionModel: env.DECISION_MODEL?.trim() || DEFAULT_DECISION_MODEL,
    chatModel: env.CHAT_MODEL?.trim() || DEFAULT_CHAT_MODEL,
    chatReasoning: parseChatReasoning(env.CHAT_REASONING) ?? 'off',
    routerTimeoutMs: Math.max(200, Math.min(5000, parseInteger(env.ROUTER_TIMEOUT_MS, 2000))),
    chatTimeoutMs: Math.max(500, Math.min(8000, parseInteger(env.CHAT_TIMEOUT_MS, 6000))),
    enemyAi: (env.ENEMY_AI ?? '').trim().toLowerCase() === 'local' ? 'local' : 'jev',
    enemyTimeoutMs: Math.max(200, Math.min(5000, parseInteger(env.ENEMY_TIMEOUT_MS, 2000))),
    attribution: parseAttributionMode(env.ATTRIBUTION_MODE),
    adminToken: env.ADMIN_TOKEN?.trim() || undefined,
    speakers: parseSpeakers(env.ALLOWED_SPEAKERS),
  };
}
