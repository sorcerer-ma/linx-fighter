import { readFileSync } from 'node:fs';
import { SandboxAgent } from '../sandbox/platform/agent.js';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { loadSandboxConfig } from '../sandbox/config.js';
import { SandboxClient } from '../sandbox/platform/client.js';
import { createSandboxServer } from '../sandbox/server.js';
import { loadConfig } from '../src/config.js';
import { GameService } from '../src/game/service.js';
import { createApp } from '../src/http/app.js';
import { createLogger } from '../src/log.js';
import { BattleStore } from '../src/store/battles.js';
import { RoomStore } from '../src/store/rooms.js';

/**
 * 沙箱端到端：真的起一个游戏服务 + 一个沙箱服务，走 HTTP 与 MCP 全链路。
 *
 * 覆盖的重点是「沙箱只是载体」——页面/CLI 说什么，沙箱原样转给 game_say，
 * 判断与结算都在游戏服务里，沙箱不复制任何规则。
 */

let gameServer: Server;
let sandboxServer: Server;
let sandboxUrl = '';

function listen(app: { listen(port: number, host: string, cb: () => void): Server }): Promise<Server> {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function urlOf(server: Server): string {
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

function sandboxFor(upstream: string): Promise<Server> {
  const config = { ...loadSandboxConfig({}), upstream, agentId: 'linx-test', timeoutMs: 3000, logLevel: 'error' as const };
  const client = new SandboxClient({
    upstream,
    agentId: config.agentId,
    timeoutMs: config.timeoutMs,
    logger: createLogger('error'),
  });
  return listen(createSandboxServer({ config, client }));
}

async function say(deviceId: string, text: string): Promise<Record<string, any>> {
  const response = await fetch(`${sandboxUrl}/api/say`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ deviceId, text }),
  });
  assert.equal(response.status, 200);
  return (await response.json()) as Record<string, any>;
}

before(async () => {
  const logger = createLogger('error');
  const store = new BattleStore({ ttlMs: 60_000 });
  const rooms = new RoomStore({ ttlMs: 60_000 });
  const service = new GameService({ store, rooms, logger, random: () => 0 });
  const gameApp = createApp({
    config: { ...loadConfig({}), enableDebugEndpoints: true },
    logger,
    store,
    rooms,
    service,
  });
  gameServer = await listen(gameApp);
  sandboxServer = await sandboxFor(urlOf(gameServer));
  sandboxUrl = urlOf(sandboxServer);
});

after(async () => {
  await new Promise<void>((resolve) => sandboxServer.close(() => resolve()));
  await new Promise<void>((resolve) => gameServer.close(() => resolve()));
});

describe('沙箱服务', () => {
  it('/api/config 给出上游地址、身份与状态流地址', async () => {
    const response = await fetch(`${sandboxUrl}/api/config`);
    const body = (await response.json()) as {
      ok: boolean;
      upstream: string;
      agentId: string;
      eventsUrl: string;
      defaultDeviceId: string;
      voice: { lang: string };
      agentMode: string;
    };

    assert.equal(body.ok, true);
    assert.equal(body.upstream, urlOf(gameServer));
    assert.equal(body.agentId, 'linx-test');
    // 纯 HTTP 页面直连游戏服务的状态流
    assert.equal(body.eventsUrl, `${urlOf(gameServer)}/events`);
    assert.match(body.defaultDeviceId, /^web-/);
    assert.equal(body.voice.lang, 'zh-CN');
    assert.equal(body.agentMode, 'compatibility');
    assert.ok(!('apiKey' in body) && !('promptPath' in body) && !('agent' in body));
  });

  it('/api/say 把原话透传给 game_say，并带回播报与局面', async () => {
    const opened = await say('web-test-1', '开房间');
    assert.equal(opened.ok, true);
    assert.equal(opened.tool, 'game_say');
    assert.equal(opened.deviceId, 'web-test-1');
    assert.equal(opened.agentId, 'linx-test');
    assert.match(String(opened.reply), /房间\d{4}/);
    assert.equal(opened.state.room, opened.state.battle.room);
    assert.equal(opened.state.battle.mode, 'pvp');
    assert.ok(Array.isArray(opened.trace.requests));
    // trace 里能看到 initialize 与 tools/call 两次调用
    const methods = (opened.trace.requests as Array<{ method: string }>).map((request) => request.method);
    assert.ok(methods.includes('initialize'));
    assert.ok(methods.includes('tools/call'));
  });

  it('/api/state 与 /api/say 看到的是同一局', async () => {
    const played = await say('web-test-2', '开始');
    assert.match(String(played.reply), /对决开始/);

    const response = await fetch(`${sandboxUrl}/api/state?deviceId=web-test-2`);
    const body = (await response.json()) as { ok: boolean; state: { battle: { round: number } } };
    assert.equal(body.ok, true);
    assert.equal(body.state.battle.round, 1);
  });

  it('/api/tools 列出服务端工具，game_say 排在最前', async () => {
    const response = await fetch(`${sandboxUrl}/api/tools`);
    const body = (await response.json()) as { ok: boolean; tools: Array<{ name: string }> };
    assert.equal(body.ok, true);
    const names = body.tools.map((tool) => tool.name);
    assert.ok(names.includes('game_say'));
    assert.equal(names[0], 'game_say');
  });

  it('/api/say 拒绝空句子', async () => {
    const response = await fetch(`${sandboxUrl}/api/say`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceId: 'web-test-3', text: '   ' }),
    });
    assert.equal(response.status, 400);
    const body = (await response.json()) as { ok: boolean; error: string };
    assert.equal(body.ok, false);
    assert.equal(body.error, 'empty_text');
  });

  it('未知 /api 路径回 JSON 404', async () => {
    const response = await fetch(`${sandboxUrl}/api/nothing`);
    assert.equal(response.status, 404);
    const body = (await response.json()) as { error: string };
    assert.equal(body.error, 'not_found');
  });

  it('上游连不上时给玩家一句能听懂的话，不抛堆栈', async () => {
    const dead = await sandboxFor('http://127.0.0.1:1');
    try {
      const response = await fetch(`${urlOf(dead)}/api/say`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ deviceId: 'web-test-4', text: '开始' }),
      });
      const body = (await response.json()) as { ok: boolean; reply: string; error: string };
      assert.equal(response.status, 200);
      assert.equal(body.ok, false);
      assert.equal(body.error, 'upstream_unreachable');
      assert.match(body.reply, /连不上游戏服务/);
    } finally {
      await new Promise<void>((resolve) => dead.close(() => resolve()));
    }
  });
});

it('原话Agent经真实MCP执行一次game_say；查询不出招、身份隔离', async () => {
  const prompt=readFileSync(loadSandboxConfig({}).agent.promptPath,'utf8');
  const agent=new SandboxAgent(prompt);
  const client=new SandboxClient({upstream:urlOf(gameServer),agentId:'agent-test',timeoutMs:3000,logger:createLogger('error'),agent});
  const start=await client.say('agent-one','开始游戏');
  assert.equal(start.tool,'game_say');assert.ok(start.state?.battle);
  const status=await client.say('agent-one','战况如何');
  assert.equal(status.tool,'game_say');assert.deepEqual(status.state?.battle?.you,start.state?.battle?.you);
  assert.equal(status.reply,status.sourceReply);assert.equal(status.rewriteStatus,'awaiting-facts');
  const calls=status.trace.requests.filter(r=>r.method==='tools/call');
  assert.equal(calls.length,1);assert.equal(calls[0]?.tool,'game_say');
  const other=await client.say('agent-two','战况如何');assert.equal(other.state?.battle,null);
});
