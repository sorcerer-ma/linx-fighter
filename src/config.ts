/**
 * 服务配置：全部来自环境变量，方便容器化部署。
 * 这里只做取值解析与兜底，不包含业务判断。
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

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
  /** OpenRouter API Key；为空时不启用意图模型，只用规则匹配 */
  openrouterApiKey?: string;
  /** 意图模型名，默认 google/gemma-4-26b-a4b-it */
  openrouterModel: string;
  /** 意图模型超时（毫秒），超时按没认出来处理 */
  intentTimeoutMs: number;
}

const LOG_LEVELS: LogLevel[] = ['debug', 'info', 'warn', 'error'];

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
    openrouterApiKey: env.OPENROUTER_API_KEY?.trim() || undefined,
    openrouterModel: env.OPENROUTER_MODEL?.trim() || 'google/gemma-4-26b-a4b-it',
    intentTimeoutMs: Math.max(200, Math.min(5000, parseInteger(env.INTENT_TIMEOUT_MS, 2000))),
  };
}
