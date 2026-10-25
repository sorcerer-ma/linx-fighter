import { createSandboxAgent } from './platform/agent.js';
import { readFileSync } from 'node:fs';
import { createServer as createHttpServer, type Server } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { networkInterfaces } from 'node:os';
import { resolve } from 'node:path';
import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { pathToFileURL } from 'node:url';
import express, { type NextFunction, type Request, type Response } from 'express';
import { createLogger } from '../src/log.js';
import { loadSandboxConfig, SANDBOX_VERSION, type SandboxConfig } from './config.js';
import { SandboxClient } from './platform/client.js';

/**
 * 沙箱 HTTP 服务：给浏览器一个「灵犀设备」页面，同时把页面上的输入转成 MCP 调用。
 *
 * 职责边界：
 * - 页面只认 /api/*，不直接碰游戏服务（除了状态流可能在页面里直连，见 eventsUrl）；
 * - 所有意图判断都在游戏服务，沙箱只做转发与展示；
 * - 多窗口多玩家靠 deviceId 区分，deviceId 由页面自己算好传进来。
 */
export interface SandboxDependencies {
  config: SandboxConfig;
  client: SandboxClient;
}

const DEVICE_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
/** 和 game_say 的入参上限保持一致，超长句子先截断，避免直接把协议错误丢给玩家 */
const MAX_TEXT_LENGTH = 120;

/** 生成一个窗口级的兜底身份；页面没带 player 参数时用 */
function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 6).padEnd(4, '0');
}

function normalizeDeviceId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return DEVICE_PATTERN.test(trimmed) ? trimmed : null;
}

/**
 * 页面用的状态流地址。
 *
 * 默认让手机直连游戏服务的 /events（EventSource 不能带请求头，身份走查询参数）；
 * 页面是 HTTPS 而游戏服务还是 HTTP 时，浏览器会拦混合内容，退化成同源代理。
 */
function eventsUrlFor(req: Request, config: SandboxConfig): string {
  if (config.eventsUrl) return config.eventsUrl;

  const upstream = new URL(config.upstream);
  const forwarded = req.headers['x-forwarded-proto'];
  const pageProtocol = (typeof forwarded === 'string' ? forwarded.split(',')[0]!.trim() : req.protocol) || 'http';
  if (pageProtocol === 'https' && upstream.protocol !== 'https:') return '/api/events';

  const host = (req.headers.host ?? '').replace(/:\d+$/, '') || upstream.hostname;
  const port = upstream.port ? `:${upstream.port}` : '';
  return `${upstream.protocol}//${host}${port}/events`;
}

/** 本机所有局域网地址，启动时打印出来方便手机直接访问 */
function lanUrls(port: number, scheme: string): string[] {
  const urls: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const info of list ?? []) {
      if (info.family === 'IPv4' && !info.internal) urls.push(`${scheme}://${info.address}:${port}`);
    }
  }
  return urls;
}

export function createSandboxServer(deps: SandboxDependencies): express.Express {
  const { config, client } = deps;
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '32kb' }));

  // 页面加载时读一次配置：地址、身份默认值、语音语言
  app.get('/api/config', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({
      ok: true,
      agentMode: client.agentMode,
      sandbox: 'linx-sandbox',
      version: SANDBOX_VERSION,
      upstream: config.upstream,
      eventsUrl: eventsUrlFor(req, config),
      agentId: config.agentId,
      defaultDeviceId: `web-${randomSuffix()}`,
      display: config.display,
      voice: { lang: 'zh-CN' },
    });
  });

  // 唯一的输入入口：页面说了一句话
  app.post('/api/say', async (req, res) => {
    const body = (req.body ?? {}) as { deviceId?: unknown; text?: unknown };
    const text = typeof body.text === 'string' ? body.text.trim().slice(0, MAX_TEXT_LENGTH) : '';
    if (!text) {
      res.status(400).json({ ok: false, reply: '没有听到内容，请再说一次。', error: 'empty_text' });
      return;
    }
    const deviceId = normalizeDeviceId(body.deviceId) ?? `web-${randomSuffix()}`;
    res.json(await client.say(deviceId, text));
  });

  // 只读局面：CLI 与调试脚本用，页面正常情况下走状态流
  app.get('/api/state', async (req, res) => {
    const deviceId = normalizeDeviceId(req.query.deviceId) ?? `web-${randomSuffix()}`;
    try {
      res.json({ ok: true, state: await client.state(deviceId) });
    } catch (error) {
      res.json({
        ok: false,
        state: null,
        error: 'upstream_unreachable',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  app.get('/api/tools', async (_req, res) => {
    try {
      res.json({ ok: true, tools: await client.tools() });
    } catch (error) {
      res.json({ ok: false, tools: [], error: 'upstream_unreachable', message: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get('/api/health', async (_req, res) => {
    const health = await client.health();
    res.json({ ok: true, upstream: config.upstream, ...health, sandbox: SANDBOX_VERSION });
  });

  // HTTPS 页面拿不到 HTTP 状态流时，页面改连这里，由沙箱原样转发上游 SSE
  app.get('/api/events', async (req, res) => {
    const upstream = new URL('/events', config.upstream);
    const device = normalizeDeviceId(req.query.device);
    if (device) upstream.searchParams.set('device', device);
    // 对局键是「设备#智能体」，代理时智能体不能丢，否则会查到另一局（甚至查不到）
    const agent = normalizeDeviceId(req.query.agent) ?? config.agentId;
    upstream.searchParams.set('agent', agent);

    const controller = new AbortController();
    req.on('close', () => controller.abort());

    try {
      const response = await fetch(upstream, {
        headers: { accept: 'text/event-stream' },
        signal: controller.signal,
      });
      if (!response.ok || !response.body) {
        res.status(502).json({ ok: false, error: 'upstream_unreachable' });
        return;
      }

      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      const stream = Readable.fromWeb(response.body as unknown as WebReadableStream<Uint8Array>);
      stream.on('error', () => res.end());
      stream.pipe(res);
    } catch {
      if (!res.headersSent) res.status(502).json({ ok: false, error: 'upstream_unreachable' });
    }
  });

  // 静态页：index.html 由页面脚本自己读 ?player=，不需要服务端渲染
  app.use(express.static(config.publicDir, { etag: false, maxAge: 0, index: 'index.html' }));

  app.use((req: Request, res: Response) => {
    if (req.path.startsWith('/api/')) {
      res.status(404).json({ ok: false, error: 'not_found', path: req.path });
      return;
    }
    res.status(404).type('text/plain').send('not found');
  });

  // 请求体不是合法 JSON 之类的问题：回一句话，不要把堆栈抛给页面
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const message = error instanceof Error ? error.message : String(error);
    const status = (error as { status?: unknown }).status;
    if (res.headersSent) {
      res.end();
      return;
    }
    res.status(typeof status === 'number' ? status : 500).json({ ok: false, error: 'sandbox_error', message });
  });

  return app;
}

/** 起服务；返回 server 便于测试里关掉 */
export function startSandbox(config: SandboxConfig, logger = createLogger(config.logLevel)): Server {
  const client = new SandboxClient({
    agent: createSandboxAgent(config.agent),
    upstream: config.upstream,
    agentId: config.agentId,
    timeoutMs: config.timeoutMs,
    logger,
    display: config.display,
  });
  const app = createSandboxServer({ config, client });

  const server = config.tls
    ? createHttpsServer({ cert: readFileSync(config.tls.cert), key: readFileSync(config.tls.key) }, app)
    : createHttpServer(app);

  server.listen(config.port, config.host, () => {
    const scheme = config.tls ? 'https' : 'http';
    logger.info('沙箱已启动', {
      local: `${scheme}://127.0.0.1:${config.port}`,
      lan: lanUrls(config.port, scheme),
      upstream: config.upstream,
      agentId: config.agentId,
      display: config.display,
      hint: '多开窗口：?player=1 / ?player=2',
    });
  });

  const close = (signal: string): void => {
    logger.info('沙箱收到退出信号', { signal });
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on('SIGINT', () => close('SIGINT'));
  process.on('SIGTERM', () => close('SIGTERM'));

  return server;
}

/** 只有直接执行这个文件才起服务；测试里 import 不会占端口 */
function isMain(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return pathToFileURL(resolve(entry)).href === import.meta.url;
}

if (isMain()) {
  startSandbox(loadSandboxConfig());
}
