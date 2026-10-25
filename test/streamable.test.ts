import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import type { GameReply } from '../src/game/protocol.js';
import { loadConfig } from '../src/config.js';
import { GameService } from '../src/game/service.js';
import { createApp } from '../src/http/app.js';
import { createLogger } from '../src/log.js';
import { BattleStore } from '../src/store/battles.js';
import { RoomStore } from '../src/store/rooms.js';

/**
 * Streamable HTTP 版 MCP 端到端测试。
 * 灵犀平台（新版客户端）直接 POST JSON-RPC 到 /mcp，不先建 SSE 连接，
 * 每次 POST 都带 X-Linx-Device-Id / X-Linx-Agent-Id 头，因此服务端必须按无状态方式处理。
 */

const DEVICE = 'device-streamable';
const AGENT_ID = 'agent-1';
const SESSION_ID = 'session-1';

let server: Server;
let baseUrl = '';

before(async () => {
  const logger = createLogger('error');
  const store = new BattleStore({ ttlMs: 60_000 });
  const rooms = new RoomStore({ ttlMs: 60_000 });
  const service = new GameService({ store, rooms, logger, random: () => 0 });
  const app = createApp({
    config: { ...loadConfig({}), enableDebugEndpoints: false },
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

/** 按平台的调用方式发一次 JSON-RPC 请求（或通知） */
async function post(body: Record<string, unknown>) {
  const response = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'X-Linx-Device-Id': DEVICE,
      'X-Linx-Agent-Id': AGENT_ID,
      'X-Linx-Session-Id': SESSION_ID,
    },
    body: JSON.stringify(body),
  });

  const text = await response.text();
  return { status: response.status, contentType: response.headers.get('content-type') ?? '', text };
}

/** 请求：带 id，期望拿到 JSON 结果 */
async function rpc(method: string, params?: unknown, id = 1) {
  return post({ jsonrpc: '2.0', id, method, params });
}

/** 通知：不带 id */
async function notify(method: string, params?: unknown) {
  return post({ jsonrpc: '2.0', method, params });
}

async function callTool(name: string, args: Record<string, unknown> = {}): Promise<GameReply> {
  const result = await rpc('tools/call', { name, arguments: args });
  assert.equal(result.status, 200, `tools/call ${name} 应返回 200，实际 ${result.status}：${result.text}`);
  const payload = JSON.parse(result.text) as {
    result?: { content?: Array<{ type: string; text: string }>; isError?: boolean };
  };
  const text = payload.result?.content?.[0]?.text ?? '';
  assert.notEqual(payload.result?.isError, true, `工具 ${name} 不应报错：${text}`);
  return JSON.parse(text) as GameReply;
}

describe('Streamable HTTP 通道', () => {
  it('initialize 返回服务信息', async () => {
    const result = await rpc('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'linx-streamable', version: '1.0.0' },
    });

    assert.equal(result.status, 200);
    const payload = JSON.parse(result.text) as { result?: { serverInfo?: { name?: string } } };
    assert.equal(payload.result?.serverInfo?.name, 'linx-fighter');
  });

  it('tools/list 能列出两个 v2 工具', async () => {
    const result = await rpc('tools/list');
    const payload = JSON.parse(result.text) as { result?: { tools?: Array<{ name: string }> } };
    const names = (payload.result?.tools ?? []).map((tool) => tool.name).sort();
    assert.deepEqual(names, ['game_say', 'wait_event']);
  });

  it('工具调用在多次 POST 之间共享对局状态', async () => {
    const started = await callTool('game_say', { text: '开始' });
    assert.equal(started.v, 2);
    assert.equal(started.phase, 'battle');
    assert.ok(started.events?.some(event => event.t === 'start'));
    const acted = await callTool('game_say', { text: '普攻' });
    assert.ok(acted.events?.some(event => event.t === 'hit' && event.by === 'you'));
    assert.equal(acted.pending?.by, 'foe');
    assert.equal(acted.need, 'respond');
    const status = await callTool('game_say', { text: '战况如何' });
    assert.equal(status.round, 1);
    assert.deepEqual(status.you, acted.you);
  });

  it('会话结束的 DELETE 请求被礼貌接受', async () => {
    const response = await fetch(`${baseUrl}/mcp`, { method: 'DELETE' });
    assert.equal(response.status, 200);
  });

  it('通知类消息返回 202 而不是报错', async () => {
    const result = await notify('notifications/initialized');
    assert.ok([200, 202].includes(result.status), `通知应被接受，实际 ${result.status}：${result.text}`);
  });
});
