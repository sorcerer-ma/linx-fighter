import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, it } from 'node:test';
import { loadConfig } from '../src/config.js';
import { GameService } from '../src/game/service.js';
import { createApp } from '../src/http/app.js';
import { createLogger } from '../src/log.js';
import { BattleStore } from '../src/store/battles.js';
import { RoomStore } from '../src/store/rooms.js';

interface Harness {
  url: string;
  service: GameService;
  close: () => Promise<void>;
}

async function boot(): Promise<Harness> {
  const logger = createLogger('error');
  const store = new BattleStore({ ttlMs: 60_000 });
  const rooms = new RoomStore({ ttlMs: 60_000, random: () => 0 });
  const service = new GameService({ store, rooms, logger, random: () => 0 });
  const app = createApp({ config: loadConfig({}), logger, store, rooms, service });
  let server!: Server;
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url, service,
    close: () => new Promise<void>((resolve) => { server.close(() => resolve()); }),
  };
}

/** 按 Streamable HTTP 发一条 JSON-RPC；返回解析后的 JSON */
async function rpc(
  url: string, path: string, method: string, params: Record<string, unknown>, device?: string,
): Promise<Record<string, unknown>> {
  const response = await fetch(`${url}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(device ? { 'X-Linx-Device-Id': device } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  assert.equal(response.status, 200, `HTTP ${response.status}`);
  return await response.json() as Record<string, unknown>;
}

/** 从 tools/call 结果里取那行 JSON 文本 */
function textOf(result: Record<string, unknown>): Record<string, unknown> {
  const content = (result.result as { content?: Array<{ type: string; text: string }> }).content ?? [];
  assert.equal(content.length, 1);
  const block = content[0];
  assert.ok(block, '工具结果应当有 content');
  assert.equal(block.type, 'text');
  return JSON.parse(block.text) as Record<string, unknown>;
}

async function callHud(url: string, args: Record<string, unknown> = {}, device = 'dev-1'): Promise<Record<string, unknown>> {
  const reply = await rpc(url, '/device/mcp', 'tools/call', { name: 'game_hud', arguments: args }, device);
  return textOf(reply);
}

describe('设备 HUD 通道', () => {
  it('没有对局时返回待命帧', async () => {
    const h = await boot();
    try {
      const hud = await callHud(h.url);
      assert.equal(hud.ok, true);
      assert.equal(hud.battle, false);
      assert.equal(hud.expression, 'neutral');
      assert.equal(hud.seq, 1);
      assert.equal(hud.cue, null);
    } finally { await h.close(); }
  });

  it('开局后返回对局中的资源，重复拉取不涨帧号', async () => {
    const h = await boot();
    try {
      await h.service.start('dev-1#default');
      const first = await callHud(h.url);
      assert.equal(first.battle, true);
      assert.equal(first.room, null);
      assert.equal(typeof first.hp, 'number');
      assert.equal(first.max_energy, 5);

      const second = await callHud(h.url);
      assert.equal(second.seq, first.seq, '局面没变不该涨帧号');
      assert.equal(second.cue, null);
    } finally { await h.close(); }
  });

  it('平台用任意 agentId 开局时，按设备号也能找到那一局', async () => {
    const h = await boot();
    try {
      await h.service.start('dev-2#platform-agent');
      const hud = await callHud(h.url, {}, 'dev-2');
      assert.equal(hud.battle, true);
    } finally { await h.close(); }
  });

  it('长轮询在没有变化时到点返回同一帧', async () => {
    const h = await boot();
    try {
      await h.service.start('dev-3#default');
      const started = Date.now();
      const first = await callHud(h.url, {}, 'dev-3');
      const waited = await callHud(h.url, { wait_ms: 300 }, 'dev-3');
      assert.equal(waited.seq, first.seq);
      assert.ok(Date.now() - started >= 250, '长轮询应当真的挂起一会儿');
    } finally { await h.close(); }
  });

  it('设备通道只暴露 game_hud，平台通道仍只有 game_say 与 wait_event', async () => {
    const h = await boot();
    try {
      const deviceTools = await rpc(h.url, '/device/mcp', 'tools/list', {}, 'dev-1');
      const deviceNames = ((deviceTools.result as { tools: Array<{ name: string }> }).tools).map((tool) => tool.name);
      assert.deepEqual(deviceNames, ['game_hud']);

      const platformTools = await rpc(h.url, '/mcp', 'tools/list', {}, 'dev-1');
      const platformNames = ((platformTools.result as { tools: Array<{ name: string }> }).tools).map((tool) => tool.name).sort();
      assert.deepEqual(platformNames, ['game_say', 'wait_event']);
    } finally { await h.close(); }
  });
});
