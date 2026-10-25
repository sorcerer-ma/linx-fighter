import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { loadConfig } from '../src/config.js';
import { GameService } from '../src/game/service.js';
import { createApp } from '../src/http/app.js';
import { createLogger } from '../src/log.js';
import { BattleStore } from '../src/store/battles.js';
import { EchoStore } from '../src/store/echoes.js';
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
/** 挂起等播报的状态只在这里可见：断开连接后是否真的让出了等待位，只能从这里查 */
let echo: EchoStore;

before(async () => {
  const logger = createLogger('error');
  const store = new BattleStore({ ttlMs: 60_000 });
  const rooms = new RoomStore({ ttlMs: 60_000 });
  echo = new EchoStore({ ttlMs: 60_000 });
  const service = new GameService({ store, rooms, echo, logger, random: () => 0 });
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

async function callTool(name: string, args: Record<string, unknown> = {}): Promise<string> {
  const result = await rpc('tools/call', { name, arguments: args });
  assert.equal(result.status, 200, `tools/call ${name} 应返回 200，实际 ${result.status}：${result.text}`);
  const payload = JSON.parse(result.text) as {
    result?: { content?: Array<{ type: string; text: string }>; isError?: boolean };
  };
  const text = payload.result?.content?.[0]?.text ?? '';
  assert.notEqual(payload.result?.isError, true, `工具 ${name} 不应报错：${text}`);
  return text;
}

/**
 * 以指定设备身份直接发一条 tools/call，返回原始响应。
 * 长挂起的用例要让两个身份交错发起请求，不能用同一个 DEVICE。
 */
async function callAs(
  deviceId: string,
  name: string,
  args: Record<string, unknown> = {},
  id = 1,
  signal?: AbortSignal,
) {
  return fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'X-Linx-Device-Id': deviceId,
      'X-Linx-Agent-Id': AGENT_ID,
      'X-Linx-Session-Id': SESSION_ID,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }),
    signal,
  });
}

/** 以指定设备身份说一句话，返回播报文本 */
async function sayAs(deviceId: string, text: string): Promise<string> {
  const response = await callAs(deviceId, 'game_say', { text });
  assert.equal(response.status, 200, `game_say ${text} 应返回 200，实际 ${response.status}`);
  const payload = JSON.parse(await response.text()) as {
    result?: { content?: Array<{ text: string }>; isError?: boolean };
  };
  assert.notEqual(payload.result?.isError, true, `game_say ${text} 不应报错`);
  return payload.result?.content?.[0]?.text ?? '';
}

/** 轮询等条件成立：连接关闭后触发取消是异步的，不保证下一个微任务就生效 */
async function waitFor(check: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`等待条件超时（${timeoutMs}ms）`);
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

  it('tools/list 能列出六个工具（含挂起等对手）', async () => {
    const result = await rpc('tools/list');
    const payload = JSON.parse(result.text) as {
      result?: { tools?: Array<{ name: string; description?: string }> };
    };
    const tools = payload.result?.tools ?? [];
    const names = tools.map((tool) => tool.name).sort();
    assert.deepEqual(names, ['game_action', 'game_help', 'game_say', 'game_start', 'game_status', 'wait_event']);
    // 超时续挂依赖模型读得到工具描述：锁住这段提示，避免以后改丢
    const wait = tools.find((tool) => tool.name === 'wait_event');
    assert.match(wait?.description ?? '', /续挂/);
  });

  it('工具调用在多次 POST 之间共享对局状态', async () => {
    const started = await callTool('game_start', { opponent: '练功木人' });
    assert.match(started, /练功木人/);

    const acted = await callTool('game_action', { action: '普攻' });
    assert.match(acted, /我普攻，对手格挡，掉1点生命值/);
    assert.match(acted, /对手普攻还没结算，我该格挡、闪避，还是承受/);

    const status = await callTool('game_status');
    assert.match(status, /第1轮/);
  });

  it('wait_event 把请求挂在同一个 POST 上，对手出招后按原 id 回复', async () => {
    const host = 'device-wait-host';
    const guest = 'device-wait-guest';

    const say = sayAs;

    const opened = await say(host, '开房间');
    const room = /编号(\d{4})/.exec(opened)?.[1];
    assert.ok(room, `应播报四位房间号：${opened}`);
    await say(guest, `加入房间${room}`);
    await say(host, '强攻');

    // 挂起期间这次 POST 不返回；万一真挂死，3 秒上限兜底，不至于把整轮测试拖住
    let settled = false;
    const waiting = callAs(host, 'wait_event', {}, 4242, AbortSignal.timeout(3000)).finally(() => {
      settled = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(settled, false, '对手还没应招，wait_event 应该挂在同一个 POST 上');

    await say(guest, '格挡');

    const response = await waiting;
    assert.equal(response.status, 200);
    const payload = JSON.parse(await response.text()) as {
      id?: number;
      result?: { content?: Array<{ text: string }>; isError?: boolean };
    };
    assert.equal(payload.id, 4242, '长挂起的回复要带着原来那个 JSON-RPC id');
    assert.notEqual(payload.result?.isError, true);

    const woken = payload.result?.content?.[0]?.text ?? '';
    assert.match(woken, /我强攻，对手格挡，掉3点生命值，剩15/);
    // 挂起等来的这一手当场就念，不带补账前缀
    assert.doesNotMatch(woken, /刚才那一手/);
  });

  it('平台在挂起期间断开连接时，等待位当场让出来', async () => {
    const host = 'device-abort-host';
    const opened = await sayAs(host, '开房间');
    const room = /编号(\d{4})/.exec(opened)?.[1];
    assert.ok(room, `应播报四位房间号：${opened}`);

    const controller = new AbortController();
    const waiting = callAs(host, 'wait_event', {}, 7, controller.signal).catch(() => null);
    await waitFor(() => echo.waiting === 1);

    // 平台收掉这次请求：服务端要立刻收摊，否则后面每一次挂起都排在一个已经死掉的请求后面
    controller.abort();
    await waitFor(() => echo.waiting === 0);
    await waiting;
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
