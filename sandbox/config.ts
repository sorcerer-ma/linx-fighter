import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LogLevel } from '../src/config.js';

/**
 * 沙箱配置：只从环境变量取，不读 .env。
 * 沙箱是开发工具，默认值要能直接跑起来：本机游戏服务 + 8100 端口。
 */
export const SANDBOX_VERSION = '0.1.0';

export interface SandboxTls {
  cert: string;
  key: string;
}

export interface SandboxAgentConfig {
  model?: string;
  baseUrl?: string;
  apiKey?: string;
  promptPath: string;
}

export interface SandboxConfig {
  agent: SandboxAgentConfig;
  /** 固定本机语音服务桥接，不接受任意上游 URL。 */
  ttsBridge?: boolean;
  port: number;
  host: string;
  /** 游戏服务地址：MCP 调用与状态查询都走它 */
  upstream: string;
  /** 冒充的智能体 ID，进 X-Linx-Agent-Id */
  agentId: string;
  /** 强制指定页面用的状态流地址；不填则按页面 Host 推导 */
  eventsUrl?: string;
  /** 单次 MCP 请求超时：命令路由与对手决策都在服务端，要留够余量 */
  timeoutMs: number;
  logLevel: LogLevel;
  /**
   * 沙箱冒充的载体形态：screen=有屏页面（不补账播报），voice=模拟无屏硬件（保留补账）。
   * 进 X-Linx-Display 请求头。
   */
  display: 'voice' | 'screen';
  tls?: SandboxTls;
  /** 静态页目录 */
  publicDir: string;
}

const LOG_LEVELS: LogLevel[] = ['debug', 'info', 'warn', 'error'];

function parseDisplay(raw: string | undefined): 'voice' | 'screen' {
  return raw?.trim().toLowerCase() === 'voice' ? 'voice' : 'screen';
}

function parseInteger(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) ? value : fallback;
}

export function loadSandboxConfig(env: NodeJS.ProcessEnv = process.env): SandboxConfig {
  const level = (env.LOG_LEVEL ?? '').trim().toLowerCase();
  const logLevel = (LOG_LEVELS as string[]).includes(level) ? (level as LogLevel) : 'info';

  const cert = env.SANDBOX_TLS_CERT?.trim();
  const key = env.SANDBOX_TLS_KEY?.trim();

  return {
    ttsBridge: env.SANDBOX_TTS_BRIDGE === 'local',
    agent: {
      model: env.SANDBOX_AGENT_MODEL?.trim() || undefined,
      baseUrl: env.SANDBOX_AGENT_BASE_URL?.trim() || undefined,
      apiKey: env.SANDBOX_AGENT_API_KEY?.trim() || undefined,
      promptPath: resolve(dirname(fileURLToPath(import.meta.url)), '../config/linx-agent-prompt.md'),
    },
    port: Math.max(1, Math.min(65535, parseInteger(env.SANDBOX_PORT, 8100))),
    host: env.SANDBOX_HOST?.trim() || '0.0.0.0',
    upstream: (env.SANDBOX_UPSTREAM?.trim() || 'http://127.0.0.1:8000').replace(/\/+$/, ''),
    agentId: env.SANDBOX_AGENT_ID?.trim() || 'linx-sandbox',
    eventsUrl: env.SANDBOX_EVENTS_URL?.trim() || undefined,
    timeoutMs: Math.max(1000, Math.min(30_000, parseInteger(env.SANDBOX_MCP_TIMEOUT_MS, 10_000))),
    logLevel,
    display: parseDisplay(env.SANDBOX_DISPLAY),
    tls: cert && key ? { cert, key } : undefined,
    publicDir: resolve(dirname(fileURLToPath(import.meta.url)), 'public'),
  };
}
