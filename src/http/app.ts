import { randomUUID } from 'node:crypto';
import express, { type NextFunction, type Request, type Response } from 'express';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { AppConfig } from '../config.js';
import type { GameService } from '../game/service.js';
import type { BattleState } from '../game/state.js';
import type { Logger } from '../log.js';
import { applyRequestContext, battleKey, createDeviceContext, type DeviceContext } from '../mcp/context.js';
import { createMcpServer } from '../mcp/server.js';
import { registerGameTools } from '../mcp/tools.js';
import type { BattleStore } from '../store/battles.js';
import type { RoomStore } from '../store/rooms.js';

export interface AppDependencies {
  config: AppConfig;
  logger: Logger;
  store: BattleStore;
  rooms: RoomStore;
  service: GameService;
}

/** 一条 SSE 连接对应一个 MCP 会话 */
interface McpSession {
  transport: SSEServerTransport;
  ctx: DeviceContext;
}

/** 局面快照轮询间隔：回合制游戏每回合只有几次变化，400ms 足够又不浪费 */
const EVENTS_POLL_MS = 400;
/** 心跳间隔：防止中间代理把空闲长连接掐掉 */
const EVENTS_HEARTBEAT_MS = 15_000;

export function createApp(deps: AppDependencies): express.Express {
  const { config, logger, store, rooms, service } = deps;
  const app = express();
  app.disable('x-powered-by');

  // 记下每一个入站请求：接入阶段用来看"平台到底有没有打过来、打的是哪个路径"
  app.use((req, res, next) => {
    const startedAt = Date.now();
    res.on('finish', () => {
      if (req.path === '/health') return;
      logger.info(res.statusCode === 404 ? '收到未知路径请求' : '收到 HTTP 请求', {
        method: req.method,
        path: req.path,
        status: res.statusCode,
        ms: Date.now() - startedAt,
        host: req.headers.host ?? '',
        contentType: req.headers['content-type'] ?? '',
      });
    });
    next();
  });

  app.use(express.json({ limit: '256kb' }));

  const sessions = new Map<string, McpSession>();

  app.get('/', (_req, res) => {
    res.json({
      service: 'linx-fighter',
      message: '灵犀对决 MCP 服务',
      endpoints: {
        sse: '/mcp',
        message: '/mcp/message',
        health: '/health',
        events: '/events',
        state: '/state',
      },
    });
  });

  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      service: 'linx-fighter',
      uptimeSeconds: Math.round(process.uptime()),
      battles: store.size,
      rooms: rooms.size,
    });
  });

  // 只读局面快照：给沙箱 CLI、调试脚本与状态流代理用，不推进对局
  app.get('/state', (req, res) => {
    const ctx = createDeviceContext(randomUUID());
    applyRequestContext(ctx, req.headers, req.query as Record<string, unknown>);
    res.set({ 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
    res.json({ ok: true, ...snapshotBody(service, ctx) });
  });

  /**
   * 手机页面只读同步局面走这里。
   *
   * 用 SSE 而不是 WebSocket：这场游戏是回合制、变化低频、事实来源在服务端，
   * 只有「服务端 → 页面」一个方向，EventSource 自带重连与心跳，够用且更省事。
   * EventSource 不能带请求头，身份从查询参数取（context 层已支持）。
   */
  app.get('/events', (req, res) => {
    const ctx = createDeviceContext(randomUUID());
    applyRequestContext(ctx, req.headers, req.query as Record<string, unknown>);

    res.status(200).set({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      'Access-Control-Allow-Origin': '*',
    });
    res.flushHeaders();

    let revision = 0;
    let lastFingerprint = '';
    // 只在快照变化时推，避免每 400ms 一次空转把手机流量打满
    const push = (force: boolean): void => {
      const snap = service.snapshot(battleKey(ctx));
      const battle = snap?.state ?? null;
      const fingerprint = JSON.stringify(battle);
      if (!force && fingerprint === lastFingerprint) return;
      lastFingerprint = fingerprint;
      revision += 1;
      const payload = {
        type: 'state',
        device: ctx.deviceId,
        agent: ctx.agentId,
        revision,
        battle,
      };
      res.write(`event: state\ndata: ${JSON.stringify(payload)}\n\n`);
    };

    push(true);
    const poll = setInterval(() => push(false), EVENTS_POLL_MS);
    const heartbeat = setInterval(() => res.write(': ping\n\n'), EVENTS_HEARTBEAT_MS);
    logger.info('状态流连接建立', {
      deviceId: ctx.deviceId,
      agentId: ctx.agentId,
      battleKey: battleKey(ctx),
    });

    const close = (): void => {
      clearInterval(poll);
      clearInterval(heartbeat);
      res.off('close', close);
      logger.info('状态流连接关闭', { deviceId: ctx.deviceId, agentId: ctx.agentId });
    };
    res.on('close', close);
    res.on('error', close);
  });

  // 平台用 GET 建立 SSE 长连接，并在后续 POST 请求里带上设备与会话头
  // /sse 是平台文档示例里的路径，一并接受，减少控制台地址写法带来的困扰
  app.get(['/mcp', '/sse'], async (req, res) => {
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

  // 新版 MCP 客户端（Streamable HTTP）会直接 POST JSON-RPC 到 /mcp，不需要先建 SSE 连接。
  // 平台校验/调用走的就是这种方式，因此这里按无状态模式处理：一个请求一个临时传输，请求结束即释放。
  app.post('/mcp', async (req, res) => {
    const ctx = createDeviceContext(randomUUID());
    applyRequestContext(ctx, req.headers, req.query as Record<string, unknown>);

    // 每条 JSON-RPC 都记下方法名与身份头：排查「谁在调、为什么状态对不上」时先看这行
    const body = req.body as
      | { method?: string; params?: { name?: string; clientInfo?: { name?: string; version?: string } } }
      | Array<{ method?: string; params?: { name?: string; clientInfo?: { name?: string; version?: string } } }>
      | undefined;
    const message = Array.isArray(body) ? body[0] : body;
    logger.info('MCP 请求', {
      method: message?.method ?? '',
      tool: message?.params?.name,
      client: message?.params?.clientInfo
        ? `${message.params.clientInfo.name ?? ''}/${message.params.clientInfo.version ?? ''}`
        : undefined,
      deviceId: ctx.deviceId,
      agentId: ctx.agentId,
      sessionId: ctx.sessionId,
    });

    const server = createMcpServer();
    registerGameTools(server, { service, logger, ctx });

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    res.on('close', () => {
      void transport.close();
      void server.close();
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      logger.error('Streamable HTTP 请求处理失败', {
        deviceId: ctx.deviceId,
        error: error instanceof Error ? error.message : String(error),
      });
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: '2.0', id: null, error: { code: -32603, message: '内部错误' } });
      }
    }
  });

  // 部分客户端结束会话时会 DELETE /mcp；无状态模式没有可销毁的会话，直接 200 让它安静收尾
  app.delete('/mcp', (_req, res) => {
    res.status(200).end();
  });

  // 老版 MCP 客户端（SSE）先 GET 建长连接，再用 POST /mcp/message 下发 JSON-RPC，响应走 SSE 通道
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

    app.post('/debug/start', async (req, res) => {
      const body = asRecord(req.body);
      const modeRaw = asText(body.mode);
      const mode = modeRaw === 'pvp' || modeRaw === 'solo' ? modeRaw : undefined;
      const room = asText(body.room) || undefined;
      const result = await service.start(debugBattleKey(req), { opponent: asText(body.opponent), mode, room });
      res.json({ ok: true, text: result.text, battle: result.battle });
    });

    app.post('/debug/action', async (req, res) => {
      const body = asRecord(req.body);
      const action = asText(body.action);
      if (!action) {
        res.status(400).json({ ok: false, error: '缺少 action 参数，例如 {"action":"攻击"}' });
        return;
      }
      const result = await service.act(debugBattleKey(req), action);
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

/** 状态流与 /state 共用的快照结构，字段与 docs/testing/sandbox.md 的契约一致 */
function snapshotBody(
  service: GameService,
  ctx: DeviceContext,
): { device: string; agent: string; room: string | null; battle: BattleState | null } {
  const snap = service.snapshot(battleKey(ctx));
  return {
    device: ctx.deviceId,
    agent: ctx.agentId,
    room: snap?.room ?? null,
    battle: snap?.state ?? null,
  };
}

/** 调试接口按 device/agent 查询参数定位对局，默认值方便本地 curl 直接跑 */
function debugBattleKey(req: Request): string {
  const ctx: DeviceContext = {
    deviceId: asText(req.query.device) || 'debug-device',
    agentId: asText(req.query.agent) || 'debug-agent',
    sessionId: '',
    display: 'voice',
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
