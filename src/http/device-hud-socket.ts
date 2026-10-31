/**
 * 设备 HUD 推送通道（WebSocket）。
 *
 * 设备只带 MAC 连上来，服务端在局面变化时主动推一帧，不再由固件轮询：
 * 表情、生命值、能量、大招徽记与要播放的音效都在这一帧里。
 * 平台智能体的 /mcp 工具面不受影响；HTTP 的 /device/mcp 保留作兜底。
 */

import { randomUUID } from 'node:crypto';
import type { IncomingMessage, Server } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import type { Logger } from '../log.js';
import type { GameService } from '../game/service.js';
import { frameOfState } from '../game/frame.js';
import { factsOf, type Facts } from '../game/presentation.js';
import { hudFromFacts, hudPayload } from '../game/hud.js';
import { HudTracker } from '../mcp/hud-tools.js';
import { applyRequestContext, createDeviceContext, type DeviceContext } from '../mcp/context.js';

/** 局面检查间隔：回合制变化低频，200ms 足够灵敏又不费 CPU */
const TICK_MS = 200;
/** 心跳间隔：设备与 nginx 中间层都有空闲超时，定期 ping 保活 */
const HEARTBEAT_MS = 25_000;

export interface DeviceHudSocketOptions {
  /** 已经 listen 的 HTTP 服务；WebSocket 升级复用同一个端口 */
  server: Server;
  service: GameService;
  logger: Logger;
  /** 设备对局键解析，与 /device/mcp 共用同一套规则 */
  resolveKey: (ctx: DeviceContext) => string;
  /** 可选的共享口令；配置后设备必须带 ?token= 才能订阅 */
  token?: string;
}

/** 挂上 /device/ws；返回的实例由调用方持有，进程退出时随之关闭 */
export function attachDeviceHudSocket(options: DeviceHudSocketOptions): WebSocketServer {
  const wss = new WebSocketServer({ server: options.server, path: '/device/ws' });
  wss.on('connection', (socket, request) => {
    startSession(options, socket, request);
  });
  return wss;
}

/** 单个设备的订阅会话：按帧号去重推送，断线即清理定时器 */
function startSession(options: DeviceHudSocketOptions, socket: WebSocket, request: IncomingMessage): void {
  const { service, logger, resolveKey } = options;
  const url = new URL(request.url ?? '/device/ws', 'http://localhost');
  const query: Record<string, unknown> = Object.fromEntries(url.searchParams.entries());
  const ctx: DeviceContext = createDeviceContext(randomUUID());
  applyRequestContext(ctx, request.headers, query);

  if (!ctx.deviceId) {
    socket.close(1008, 'device required');
    return;
  }
  if (options.token && query.token !== options.token) {
    socket.close(1008, 'invalid token');
    return;
  }

  const tracker = new HudTracker();
  // 帧号按设备递增：换局时对局键会变，按对局键重新计数会让设备把新局当旧帧丢掉
  const frameKey = `dev:${ctx.deviceId}`;
  let lastSeq = -1;
  let alive = true;

  const push = (force = false): void => {
    if (socket.readyState !== socket.OPEN) return;
    const key = resolveKey(ctx);
    const hud = tracker.update(frameKey, readFacts(service, key));
    if (!force && hud.seq === lastSeq) return;
    lastSeq = hud.seq;
    socket.send(JSON.stringify(hudPayload(hud)));
    logger.debug('设备推送 HUD', {
      sessionKey: key, deviceId: ctx.deviceId, expression: hud.expression,
      seq: hud.seq, cue: hud.cue, battle: hud.battle,
    });
  };

  // 连上先给一帧当前画面，之后只在局面变化时推
  push(true);
  const ticker = setInterval(() => { push(); }, TICK_MS);
  const heartbeat = setInterval(() => {
    if (!alive) {
      socket.terminate();
      return;
    }
    alive = false;
    try { socket.ping(); } catch { /* 连接已断，等 close 事件清理 */ }
  }, HEARTBEAT_MS);

  socket.on('pong', () => { alive = true; });
  socket.on('close', () => {
    clearInterval(ticker);
    clearInterval(heartbeat);
    logger.info('设备推送通道断开', { deviceId: ctx.deviceId });
  });
  socket.on('error', (error) => {
    logger.warn('设备推送通道异常', { deviceId: ctx.deviceId, error: String(error) });
  });
  logger.info('设备推送通道建立', { deviceId: ctx.deviceId });
}

/** 与 /device/mcp 的读法一致：没有对局就是待命帧 */
function readFacts(service: GameService, key: string): Facts | null {
  const state = service.snapshot(key)?.state ?? null;
  if (!state) return factsOf(null, { kind: 'status' });
  return factsOf(frameOfState(state), { kind: 'status', waiting: state.waiting });
}
