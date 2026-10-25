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

  it('调试接口能发起双人挑战并凭编号接受', async () => {
    const opened = await fetch(`${baseUrl}/debug/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'pvp' }),
    });
    const openedBody = (await opened.json()) as { ok: boolean; text: string; battle: { code?: string; mode: string } };
    assert.equal(openedBody.ok, true);
    assert.equal(openedBody.battle.mode, 'pvp');
    const code = openedBody.text.match(/编号(\d{4})/)![1]!;

    // 换一台设备接受，避免发起者自己进自己的挑战
    const joined = await fetch(`${baseUrl}/debug/start?device=debug-2`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ room: code }),
    });
    const joinedBody = (await joined.json()) as { ok: boolean; text: string };
    assert.match(joinedBody.text, /接下了编号/);
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

  it('GET /state 按身份返回只读局面，并允许跨域', async () => {
    const empty = await fetch(`${baseUrl}/state?device=nobody`);
    assert.equal(empty.status, 200);
    assert.equal(empty.headers.get('access-control-allow-origin'), '*');
    const emptyBody = (await empty.json()) as { ok: boolean; device: string; battle: unknown };
    assert.equal(emptyBody.ok, true);
    assert.equal(emptyBody.device, 'nobody');
    assert.equal(emptyBody.battle, null);

    await fetch(`${baseUrl}/debug/start?device=state-dev&agent=state-agent`, { method: 'POST' });
    const filled = await fetch(`${baseUrl}/state?device=state-dev&agent=state-agent`);
    const filledBody = (await filled.json()) as {
      ok: boolean;
      device: string;
      agent: string;
      battle: { round: number; you: { hp: number } };
    };
    assert.equal(filledBody.device, 'state-dev');
    assert.equal(filledBody.agent, 'state-agent');
    assert.equal(filledBody.battle.round, 1);
    assert.ok(filledBody.battle.you.hp > 0);
  });

  it('GET /events 首帧就推当前局面，之后只在变化时推', async () => {
    await fetch(`${baseUrl}/debug/start?device=stream-dev&agent=stream-agent`, { method: 'POST' });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await fetch(`${baseUrl}/events?device=stream-dev&agent=stream-agent`, {
        signal: controller.signal,
      });
      assert.equal(response.headers.get('content-type'), 'text/event-stream; charset=utf-8');
      assert.equal(response.headers.get('access-control-allow-origin'), '*');
      assert.ok(response.body, '状态流应有响应体');

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let text = '';
      while (!text.includes('\n\n')) {
        const chunk = await reader.read();
        if (chunk.done) break;
        text += decoder.decode(chunk.value, { stream: true });
      }
      await reader.cancel();

      assert.match(text, /^event: state\n/);
      const dataLine = text.split('\n').find((line) => line.startsWith('data: '));
      assert.ok(dataLine, '应有一行 data');
      const payload = JSON.parse(dataLine.slice('data: '.length)) as {
        type: string;
        device: string;
        agent: string;
        revision: number;
        battle: { round: number };
      };
      assert.equal(payload.type, 'state');
      assert.equal(payload.device, 'stream-dev');
      assert.equal(payload.agent, 'stream-agent');
      assert.equal(payload.revision, 1);
      assert.equal(payload.battle.round, 1);
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  });

  it('GET /events 在对手进房时主动推 push', async () => {
    const opened = await fetch(`${baseUrl}/debug/start?device=push-host&agent=push-agent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'pvp' }),
    });
    const openedBody = (await opened.json()) as { text: string };
    const code = openedBody.text.match(/房间(\d{4})/)![1]!;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await fetch(`${baseUrl}/events?device=push-host&agent=push-agent`, {
        signal: controller.signal,
      });
      assert.ok(response.body, '状态流应有响应体');
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      const nextFrame = async (): Promise<string> => {
        for (;;) {
          const end = buffer.indexOf('\n\n');
          if (end >= 0) {
            const frame = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            return frame;
          }
          const chunk = await reader.read();
          if (chunk.done) throw new Error('SSE 提前结束');
          buffer += decoder.decode(chunk.value, { stream: true });
        }
      };

      // 先收下首帧，确认房主已进入「等加入」状态，再让对手进房
      const first = await nextFrame();
      assert.match(first, /^event: state/);

      const joined = await fetch(`${baseUrl}/debug/start?device=push-guest&agent=push-agent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ room: code }),
      });
      assert.equal(joined.status, 200);

      const frames: string[] = [];
      while (frames.length < 10) {
        const frame = await nextFrame();
        frames.push(frame);
        if (frame.startsWith('event: push')) break;
      }
      await reader.cancel();

      const push = frames.find((frame) => frame.startsWith('event: push'));
      assert.ok(push, `应收到 push，实际帧：${frames.join(' | ')}`);
      const dataLine = push.split('\n').find((line) => line.startsWith('data: '));
      assert.ok(dataLine, 'push 应有 data 行');
      const payload = JSON.parse(dataLine.slice('data: '.length)) as {
        type: string;
        device: string;
        agent: string;
        kind: string;
        tone: string;
        text: string;
      };
      assert.equal(payload.type, 'push');
      assert.equal(payload.device, 'push-host');
      assert.equal(payload.agent, 'push-agent');
      assert.equal(payload.kind, 'opponent-joined');
      assert.equal(payload.tone, 'info');
      assert.match(payload.text, /对手来了/);
      assert.match(payload.text, /对决开始/);
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  });
});

describe('原始报文日志', () => {
  it('debug 级别打出平台请求体，超长截断', async () => {
    const records: Array<{ message: string; fields?: Record<string, unknown> }> = [];
    const logger = {
      debug: (message: string, fields?: Record<string, unknown>) => records.push({ message, fields }),
      info: () => {},
      warn: () => {},
      error: () => {},
    };
    const store = new BattleStore({ ttlMs: 60_000 });
    const rooms = new RoomStore({ ttlMs: 60_000 });
    const app = createApp({
      config: { ...loadConfig({}), enableDebugEndpoints: true },
      logger,
      store,
      rooms,
      service: new GameService({ store, rooms, logger, random: () => 0 }),
    });
    const probe = await new Promise<Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const { port } = probe.address() as AddressInfo;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'game_status', arguments: {}, _meta: { lang_code: 'zh' } },
        }),
      });
      assert.equal(res.status, 200);
    } finally {
      await new Promise<void>((resolve) => probe.close(() => resolve()));
    }

    const raw = records.find((r) => r.message === 'MCP 原始报文');
    assert.ok(raw, '应当留下一条原始报文日志');
    const body = raw.fields?.body as { params?: { _meta?: { lang_code?: string } } };
    assert.equal(body.params?._meta?.lang_code, 'zh');
  });

  it('超长报文只留开头并标注总长度', async () => {
    const records: Array<{ message: string; fields?: Record<string, unknown> }> = [];
    const logger = {
      debug: (message: string, fields?: Record<string, unknown>) => records.push({ message, fields }),
      info: () => {},
      warn: () => {},
      error: () => {},
    };
    const store = new BattleStore({ ttlMs: 60_000 });
    const rooms = new RoomStore({ ttlMs: 60_000 });
    const app = createApp({
      config: { ...loadConfig({}), enableDebugEndpoints: true },
      logger,
      store,
      rooms,
      service: new GameService({ store, rooms, logger, random: () => 0 }),
    });
    const probe = await new Promise<Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const { port } = probe.address() as AddressInfo;
    try {
      await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: { name: 'game_say', arguments: { text: '啊'.repeat(5000) } },
        }),
      });
    } finally {
      await new Promise<void>((resolve) => probe.close(() => resolve()));
    }

    const raw = records.find((r) => r.message === 'MCP 原始报文');
    const body = raw?.fields?.body;
    assert.equal(typeof body, 'string');
    assert.match(body as string, /共 \d+ 字/);
  });
});
