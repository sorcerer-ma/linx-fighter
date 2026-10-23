import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { loadConfig } from '../src/config.js';
import { GameService } from '../src/game/service.js';
import { createApp } from '../src/http/app.js';
import { createLogger } from '../src/log.js';
import { BattleStore } from '../src/store/battles.js';
import { RoomStore } from '../src/store/rooms.js';

/**
 * HTTP 外壳测试：路由、健康检查、旧版 SSE 通道、调试接口与兜底错误处理。
 * 核心 MCP 链路另有 streamable.test.ts 与 mcp.e2e.test.ts 覆盖，这里只补外壳分支。
 */

let server: Server;
let baseUrl = '';

before(async () => {
  const logger = createLogger('error');
  const store = new BattleStore({ ttlMs: 60_000 });
  const rooms = new RoomStore({ ttlMs: 60_000 });
  const service = new GameService({ store, rooms, logger, random: () => 0 });
  const app = createApp({
    config: { ...loadConfig({}), enableDebugEndpoints: true },
    logger,
    store,
    rooms,
    service,
  });

  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
});

describe('HTTP 外壳', () => {
  it('根路径给出服务信息与端点', async () => {
    const response = await fetch(`${baseUrl}/`);
    assert.equal(response.status, 200);
    const body = (await response.json()) as { service: string; endpoints: Record<string, string> };
    assert.equal(body.service, 'linx-fighter');
    assert.equal(body.endpoints.health, '/health');
    assert.equal(body.endpoints.message, '/mcp/message');
  });

  it('健康检查返回状态与对局数', async () => {
    const response = await fetch(`${baseUrl}/health`);
    assert.equal(response.status, 200);
    const body = (await response.json()) as { status: string; battles: number; uptimeSeconds: number };
    assert.equal(body.status, 'ok');
    assert.equal(typeof body.battles, 'number');
    assert.ok(body.uptimeSeconds >= 0);
  });

  it('未知路径返回 404 与路径', async () => {
    const response = await fetch(`${baseUrl}/unknown-path`);
    assert.equal(response.status, 404);
    const body = (await response.json()) as { error: string; path: string };
    assert.equal(body.error, 'not_found');
    assert.equal(body.path, '/unknown-path');
  });

  it('DELETE /mcp 直接 200，交给客户端安静收尾', async () => {
    const response = await fetch(`${baseUrl}/mcp`, { method: 'DELETE' });
    assert.equal(response.status, 200);
  });

  it('未知 SSE 会话与缺 sessionId 的 POST 都按 404 处理', async () => {
    for (const path of ['/mcp/message?sessionId=missing', '/mcp/message']) {
      const response = await fetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
      });
      assert.equal(response.status, 404, `${path} 应返回 404`);
      const body = (await response.json()) as { error: { code: number } };
      assert.equal(body.error.code, -32001);
    }
  });

  it('非法 JSON 由兜底错误处理转成 400', async () => {
    const response = await fetch(`${baseUrl}/mcp/message?sessionId=x`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    });
    assert.equal(response.status, 400);
    const body = (await response.json()) as { error: string };
    assert.equal(body.error, 'internal_error');
  });

  it('调试接口能开双人房并凭房间号加入', async () => {
    const opened = await fetch(`${baseUrl}/debug/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'pvp' }),
    });
    const openedBody = (await opened.json()) as { ok: boolean; text: string; battle: { code?: string; mode: string } };
    assert.equal(openedBody.ok, true);
    assert.equal(openedBody.battle.mode, 'pvp');
    const code = openedBody.text.match(/房间(\d{4})/)![1]!;

    // 换一台设备加入，避免房主自己进自己的房
    const joined = await fetch(`${baseUrl}/debug/start?device=debug-2`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ room: code }),
    });
    const joinedBody = (await joined.json()) as { ok: boolean; text: string };
    assert.match(joinedBody.text, /进了房间/);
  });

  it('关闭调试开关后不注册调试路由', async () => {
    const logger = createLogger('error');
    const store = new BattleStore({ ttlMs: 60_000 });
    const rooms = new RoomStore({ ttlMs: 60_000 });
    const service = new GameService({ store, rooms, logger });
    const app = createApp({
      config: { ...loadConfig({}), enableDebugEndpoints: false },
      logger,
      store,
      rooms,
      service,
    });
    const local = await new Promise<Server>((resolve) => {
      const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    });
    try {
      const address = local.address() as AddressInfo;
      const response = await fetch(`http://127.0.0.1:${address.port}/debug/state`);
      assert.equal(response.status, 404);
    } finally {
      await new Promise<void>((resolve) => local.close(() => resolve()));
    }
  });

  it('/sse 别名与 /mcp 一样能建立 SSE 连接', async () => {
    const controller = new AbortController();
    const response = await fetch(`${baseUrl}/sse`, {
      headers: { accept: 'text/event-stream' },
      signal: controller.signal,
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let received = '';
    try {
      while (!received.includes('event: endpoint')) {
        const { done, value } = await reader.read();
        if (done) break;
        received += decoder.decode(value, { stream: true });
      }
    } finally {
      controller.abort();
    }
    assert.match(received, /event: endpoint/);
    assert.match(received, /\/mcp\/message/);
  });

  it('调试接口可以开局、出招、查状态', async () => {
    const started = await fetch(`${baseUrl}/debug/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ opponent: '试炼傀儡' }),
    });
    const startedBody = (await started.json()) as { ok: boolean; battle: { enemy: { name: string } } };
    assert.equal(startedBody.ok, true);
    assert.equal(startedBody.battle.enemy.name, '试炼傀儡');

    const missingAction = await fetch(`${baseUrl}/debug/action`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(missingAction.status, 400);

    const acted = await fetch(`${baseUrl}/debug/action`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: '共鸣斩破军' }),
    });
    const actedBody = (await acted.json()) as { ok: boolean; text: string; battle: { round: number } };
    assert.equal(actedBody.ok, true);
    assert.equal(actedBody.battle.round, 1);
    assert.match(actedBody.text, /共鸣斩破军/);

    const status = await fetch(`${baseUrl}/debug/status`, { method: 'POST' });
    const statusBody = (await status.json()) as { battle: { round: number } };
    assert.equal(statusBody.battle.round, 1);

    const state = await fetch(`${baseUrl}/debug/state`);
    const stateBody = (await state.json()) as { key: string; battle: { round: number } };
    assert.equal(stateBody.key, 'debug-device#debug-agent');
    assert.equal(stateBody.battle.round, 1);
  });
});
