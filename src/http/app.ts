import { randomUUID } from 'node:crypto';
import express, { type NextFunction, type Request, type Response } from 'express';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import type { AppConfig } from '../config.js';
import type { GameService } from '../game/service.js';
import type { Logger } from '../log.js';
import { applyRequestContext, battleKey, createDeviceContext, type DeviceContext } from '../mcp/context.js';
import { createMcpServer } from '../mcp/server.js';
import { registerGameTools } from '../mcp/tools.js';
import type { BattleStore } from '../store/battles.js';

export interface AppDependencies {
  config: AppConfig;
  logger: Logger;
  store: BattleStore;
  service: GameService;
}

/** 一条 SSE 连接对应一个 MCP 会话 */
interface McpSession {
  transport: SSEServerTransport;
  ctx: DeviceContext;
}

export function createApp(deps: AppDependencies): express.Express {
  const { config, logger, store, service } = deps;
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '256kb' }));

  const sessions = new Map<string, McpSession>();

  app.get('/', (_req, res) => {
    res.json({
      service: 'linx-fighter',
      message: '灵犀对决 MCP 服务',
      endpoints: { sse: '/mcp', message: '/mcp/message', health: '/health' },
    });
  });

  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      service: 'linx-fighter',
      uptimeSeconds: Math.round(process.uptime()),
      battles: store.size,
    });
  });

  // 平台用 GET 建立 SSE 长连接，并在后续 POST 请求里带上设备与会话头
  app.get('/mcp', async (req, res) => {
    const ctx = createDeviceContext(randomUUID());
    applyRequestContext(ctx, req.headers, req.query as Record<string, unknown>);

    const transport = new SSEServerTransport('/mcp/message', res);
    const sessionId = transport.sessionId;
    const session: McpSession = { transport, ctx };

    const server = createMcpServer();
    registerGameTools(server, { service, logger, ctx });

    sessions.set(sessionId, session);
    logger.info('SSE 连接建立', { sessionId, deviceId: ctx.deviceId, agentId: ctx.agentId });

    transport.onclose = () => {
      sessions.delete(sessionId);
      logger.info('SSE 连接关闭', { sessionId, deviceId: ctx.deviceId, agentId: ctx.agentId });
    };
    transport.onerror = (error) => {
      logger.error('SSE 传输异常', { sessionId, error: error.message });
    };

    try {
      await server.connect(transport);
    } catch (error) {
      sessions.delete(sessionId);
      logger.error('SSE 连接建立失败', {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
      if (!res.headersSent) res.status(500).end();
    }
  });

  // 平台通过 POST 下发 JSON-RPC 请求，实际响应走 SSE 通道
  app.post('/mcp/message', async (req, res) => {
    const sessionId = typeof req.query.sessionId === 'string' ? req.query.sessionId : undefined;
    const session = sessionId ? sessions.get(sessionId) : undefined;

    if (!session) {
      logger.warn('未知 MCP 会话的请求', { sessionId });
      res.status(404).json({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32001, message: '会话不存在或已关闭，请重新建立 SSE 连接' },
      });
      return;
    }

    // 平台每次调用都会带上设备头，这里刷新上下文，兼容 GET 建连时拿不到头的实现
    applyRequestContext(session.ctx, req.headers, req.query as Record<string, unknown>);
    await session.transport.handlePostMessage(req, res, req.body);
  });

  // 本地调试用 HTTP 接口，绕过 MCP 直接验证玩法链路；生产环境默认关闭
  if (config.enableDebugEndpoints) {
    app.get('/debug/state', (req, res) => {
      const key = debugBattleKey(req);
      res.json({ ok: true, key, battle: store.get(key) ?? null });
    });

    app.post('/debug/start', (req, res) => {
      const body = asRecord(req.body);
      const result = service.start(debugBattleKey(req), asText(body.opponent));
      res.json({ ok: true, text: result.text, battle: result.battle });
    });

    app.post('/debug/action', (req, res) => {
      const body = asRecord(req.body);
      const action = asText(body.action);
      if (!action) {
        res.status(400).json({ ok: false, error: '缺少 action 参数，例如 {"action":"攻击"}' });
        return;
      }
      const result = service.act(debugBattleKey(req), action);
      res.json({ ok: true, text: result.text, battle: result.battle });
    });

    app.post('/debug/status', (req, res) => {
      const result = service.status(debugBattleKey(req));
      res.json({ ok: true, text: result.text, battle: result.battle });
    });
  }

  app.use((req: Request, res: Response) => {
    res.status(404).json({ error: 'not_found', path: req.path });
  });

  // 兜底错误处理：express 5 会把 async 处理器的 reject 交给这里
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const message = error instanceof Error ? error.message : String(error);
    const status = (error as { status?: unknown }).status;
    logger.error('请求处理异常', { error: message });
    if (res.headersSent) {
      res.end();
      return;
    }
    res.status(typeof status === 'number' ? status : 500).json({ error: 'internal_error' });
  });

  return app;
}

/** 调试接口按 device/agent 查询参数定位对局，默认值方便本地 curl 直接跑 */
function debugBattleKey(req: Request): string {
  const ctx: DeviceContext = {
    deviceId: asText(req.query.device) || 'debug-device',
    agentId: asText(req.query.agent) || 'debug-agent',
    sessionId: '',
    anonymousId: 'debug',
  };
  return battleKey(ctx);
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
