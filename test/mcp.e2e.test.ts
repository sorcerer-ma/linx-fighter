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
import { McpTestClient } from './helpers/mcp-client.js';

/**
 * MCP 协议端到端测试：完全按灵犀平台的真实调用方式验证链路。
 * 平台调用顺序：GET /mcp 建 SSE → 收 endpoint → POST /mcp/message 发 JSON-RPC → 响应从 SSE 回来，
 * 并且每次调用都带 X-Linx-Device-Id / X-Linx-Agent-Id / X-Linx-Session-Id 头。
 */

const DEVICE_A = 'device-a';
const DEVICE_B = 'device-b';
const AGENT_ID = 'agent-1';

let server: Server;
let baseUrl = '';
const clients: McpTestClient[] = [];

function newBattleStore(): BattleStore {
  return new BattleStore({ ttlMs: 60_000 });
}

before(async () => {
  const logger = createLogger('error');
  const store = newBattleStore();
  const rooms = new RoomStore({ ttlMs: 60_000 });
  const service = new GameService({ store, rooms, logger, random: () => 0 });
  // 测试里固定开一台随机端口；配置只关心日志与调试开关
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
  for (const client of clients) client.close();
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
});

function headers(deviceId: string, sessionId: string): Record<string, string> {
  return {
    'X-Linx-Device-Id': deviceId,
    'X-Linx-Agent-Id': AGENT_ID,
    'X-Linx-Session-Id': sessionId,
  };
}

async function connect(deviceId: string, sessionId: string): Promise<McpTestClient> {
  const client = await McpTestClient.connect(baseUrl, headers(deviceId, sessionId));
  clients.push(client);

  const init = await client.request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'linx-e2e', version: '1.0.0' },
  });
  assert.equal(init.error, undefined, `initialize 不应报错：${JSON.stringify(init.error)}`);
  assert.equal(init.result?.serverInfo?.name, 'linx-fighter');
  assert.match(init.result?.instructions ?? '', /灵犀对决/);

  await client.notify('notifications/initialized');
  return client;
}

async function callTool(
  client: McpTestClient,
  name: string,
  args: Record<string, unknown> = {},
  extraHeaders: Record<string, string> = {},
): Promise<any> {
  const response = await client.request('tools/call', { name, arguments: args }, extraHeaders);
  assert.equal(response.error, undefined, `tools/call 不应报错：${JSON.stringify(response.error)}`);
  return response.result;
}

function textOf(result: any): string {
  assert.equal(result?.isError ?? false, false, '工具调用不应标记为错误');
  assert.equal(result?.content?.[0]?.type, 'text');
  const reply = JSON.parse(String(result.content[0].text));
  assert.equal(reply.v, 2);
  assert.equal(result.structuredContent, undefined);
  return reply.text ?? reply.say ?? '';
}

describe('MCP 协议链路', () => {
  it('tools/list 只暴露 v2 两个工具', async () => {
    const client = await connect(DEVICE_A, 'list-session');
    const response = await client.request('tools/list');
    assert.equal(response.error, undefined);

    const names = (response.result?.tools ?? []).map((tool: { name: string }) => tool.name).sort();
    assert.deepEqual(names, ['game_say', 'wait_event']);

    const say = response.result.tools.find((tool: {name:string}) => tool.name === 'game_say');
    assert.equal(say.inputSchema.properties.text.maxLength, 200);
    assert.equal(say.inputSchema.additionalProperties, false);

    for (const tool of response.result.tools) {
      assert.ok(tool.description.length > 0, `${tool.name} 应有描述，平台模型靠它决定何时调用`);
      assert.ok(tool.inputSchema, `${tool.name} 应有 inputSchema`);
    }
  });

  it('开始游戏、出招、查看战况走完整条链路', async () => {
    const client = await connect(DEVICE_A, 'play-1');

    const start = await callTool(client, 'game_say', { text: '开始游戏' });
    assert.match(textOf(start), /对决开始/);
    assert.match(textOf(start), /守擂教头/);

    const turn1 = await callTool(client, 'game_say', { text: '攻击' });
    assert.match(textOf(turn1), /普攻/);
    assert.match(textOf(turn1), /对手普攻还没结算，我该格挡、闪避，还是承受/);

    const turn2 = await callTool(client, 'game_say', { text: 'dodge' });
    assert.match(textOf(turn2), /躲|闪/);

    const status = await callTool(client, 'game_say', { text: '战况如何' });
    assert.match(textOf(status), /第2轮/);
    assert.match(textOf(status), /生命值/);
  });

  it('招式认不出来不推进回合', async () => {
    const client = await connect(DEVICE_A, 'unknown-action');
    await callTool(client, 'game_say', { text: '开始游戏' });

    const bad = await callTool(client, 'game_say', { text: '跳个舞' });
    assert.match(textOf(bad), /没听清/);

    const status = await callTool(client, 'game_say', { text: '战况如何' });
    assert.match(textOf(status), /第1轮/);
  });

  it('同一设备重连不丢对局（设备级归属）', async () => {
    const first = await connect(DEVICE_A, 'session-reconnect-1');
    await callTool(first, 'game_say', { text: '开始游戏' });
    await callTool(first, 'game_say', { text: '攻击' });
    first.close();

    // 新会话、同设备：对局应继续
    const second = await connect(DEVICE_A, 'session-reconnect-2');
    const status = await callTool(second, 'game_say', { text: '战况如何' });
    assert.match(textOf(status), /第1轮/);
  });

  it('不同设备的对局互相隔离', async () => {
    const client = await connect(DEVICE_B, 'isolation');
    const status = await callTool(client, 'game_say', { text: '战况如何' });
    assert.match(textOf(status), /没有进行中的对局/);
  });

  it('以每次调用请求头里的设备为准，不会串对局', async () => {
    const client = await connect('device-e1', 'switch');
    await callTool(client, 'game_say', { text: '开始游戏' });
    await callTool(client, 'game_say', { text: '攻击' });

    // 同一条 SSE 连接上换成另一台设备的头：应看到那台设备自己的对局
    const other = await callTool(client, 'game_say', { text: '战况如何' }, headers('device-e2', 'switch'));
    assert.match(textOf(other), /没有进行中的对局/);

    // 换回来，原对局还在
    const back = await callTool(client, 'game_say', { text: '战况如何' });
    assert.match(textOf(back), /第1轮/);
  });

  it('没有对局时直接出招会自动开局', async () => {
    const client = await connect('device-c', 'auto-start');
    const action = await callTool(client, 'game_say', { text: '回气' });

    assert.match(textOf(action), /先开一局/);
    assert.match(textOf(action), /蓄力/);
  });

  it('玩法说明经原话工具且无需对局', async () => {
    const client = await connect('device-d', 'help');
    const help = await callTool(client, 'game_say', { text: '怎么玩' });
    assert.match(textOf(help), /普攻/);
    assert.match(textOf(help), /开始游戏/);
  });

  it('超长原话通过业务 JSON 拒绝，不截断执行攻击', async () => {
    const client = await connect('device-long', 'long-input');
    await callTool(client, 'game_say', { text: '开始游戏' });
    const before = JSON.parse((await callTool(client, 'game_say', { text: '战况如何' })).content[0].text);
    const result = await callTool(client, 'game_say', { text: '攻击' + '啊'.repeat(199) });
    const reply = JSON.parse(result.content[0].text);
    assert.equal(result.isError, undefined);assert.equal(reply.reason, 'unclear');
    assert.deepEqual(reply.you, before.you);assert.deepEqual(reply.foe, before.foe);assert.deepEqual(reply.events, []);
  });

  it('wait_event 通过相同 MCP 链路接收对手进房事实', async () => {
    const host = await connect('device-wait-host', 'wait-host');
    const opened = JSON.parse((await callTool(host, 'game_say', { text: '开房间' })).content[0].text);
    assert.equal(opened.need, 'wait_guest');
    const waiting = callTool(host, 'wait_event');
    const guest = await connect('device-wait-guest', 'wait-guest');
    await callTool(guest, 'game_say', { text: `加入房间${opened.room}` });
    const result = await waiting;const reply = JSON.parse(result.content[0].text);
    assert.equal(reply.v, 2);assert.equal(result.isError, undefined);assert.equal(reply.phase, 'battle');
    assert.ok(reply.events.some((event: { t: string }) => event.t === 'start'));
    assert.equal(result.structuredContent, undefined);
  });

  it('未知会话的 POST 返回 404', async () => {
    const response = await fetch(`${baseUrl}/mcp/message?sessionId=not-exist`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    assert.equal(response.status, 404);
    const body = (await response.json()) as { error?: { message?: string } };
    assert.match(body.error?.message ?? '', /会话/);
  });

  it('调试接口可直接验证玩法链路', async () => {
    const start = await fetch(`${baseUrl}/debug/start?device=debug-1`, { method: 'POST' });
    const startBody = (await start.json()) as { ok: boolean; text: string };
    assert.equal(startBody.ok, true);
    assert.match(startBody.text, /对决开始/);

    const action = await fetch(`${baseUrl}/debug/action?device=debug-1`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: '攻击' }),
    });
    const actionBody = (await action.json()) as { ok: boolean; text: string };
    assert.match(actionBody.text, /普攻/);
  });

  it('game_say 一个工具走完开局、出招、战况与玩法', async () => {
    const client = await connect('device-say', 'say-routing');

    const start = await callTool(client, 'game_say', { text: '开始游戏' });
    assert.match(textOf(start), /对决开始/);

    // 「公鸡」是 ASR 对「攻击」的常见误识别，透传原话后服务端仍要能出招
    const hit = await callTool(client, 'game_say', { text: '公鸡' });
    assert.match(textOf(hit), /普攻/);

    const status = await callTool(client, 'game_say', { text: '战况如何' });
    assert.match(textOf(status), /第1轮/);
    assert.match(textOf(status), /生命值/);

    const help = await callTool(client, 'game_say', { text: '怎么玩' });
    assert.match(textOf(help), /普攻/);

    const miss = await callTool(client, 'game_say', { text: '今天天气不错' });
    assert.match(textOf(miss), /没听清/);
  });

  it('game_say 开房间与加入房间走通双人联机', async () => {
    const host = await connect('device-say-host', 'say-pvp-host');
    const opened = await callTool(host, 'game_say', { text: '开房间' });
    const room = /房间(\d{4})/.exec(textOf(opened))?.[1];
    assert.ok(room, `应播报四位房间号：${textOf(opened)}`);

    const guest = await connect('device-say-guest', 'say-pvp-guest');
    const joined = await callTool(guest, 'game_say', { text: `加入房间${room}` });
    assert.match(textOf(joined), /房间/);

    // 两边看到的是同一局的镜像视角：加入者先手
    const guestStatus = await callTool(guest, 'game_say', { text: '战况如何' });
    assert.match(textOf(guestStatus), /第1轮/);

    const hostStatus = await callTool(host, 'game_say', { text: '战况如何' });
    assert.match(textOf(hostStatus), /第1轮/);
  });
});

