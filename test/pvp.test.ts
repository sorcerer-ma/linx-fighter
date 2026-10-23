import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { GameService } from '../src/game/service.js';
import { normalizeRoomCode } from '../src/game/pvp.js';
import { battleKey } from '../src/mcp/context.js';
import { registerGameTools } from '../src/mcp/tools.js';
import { createLogger } from '../src/log.js';
import { BattleStore } from '../src/store/battles.js';
import { RoomStore } from '../src/store/rooms.js';

const HOST = 'device-a#agent-1';
const GUEST = 'device-b#agent-2';
const OTHER = 'device-c#agent-3';

function setup() {
  let now = 1_000_000;
  const store = new BattleStore({ ttlMs: 60_000, now: () => now });
  const rooms = new RoomStore({ ttlMs: 60_000, now: () => now, random: () => 0 });
  const service = new GameService({
    store,
    rooms,
    logger: createLogger('error'),
    now: () => now,
    random: () => 0,
  });
  return {
    store,
    rooms,
    service,
    advance(ms: number): void {
      now += ms;
    },
  };
}

function findRoom(service: GameService, host: string): string {
  // 从房间号已经写进对局键这件事反推不方便，直接遍历不可行；
  // 让服务返回文本里的房间号最稳。
  const text = service.status(host).text;
  const match = text.match(/房间(\d{4})/);
  assert.ok(match, `战况里应带房间号：${text}`);
  return match[1]!;
}

describe('双人联机', () => {
  it('开房拿到四位房间号，并提示对手怎么加入', () => {
    const { service, rooms } = setup();
    const result = service.start(HOST, { mode: 'pvp' });

    assert.equal(result.battle?.mode, 'pvp');
    assert.match(result.text, /房间\d{4}/);
    assert.match(result.text, /加入房间\d{4}/);
    assert.equal(rooms.size, 1);
    assert.ok(rooms.byPlayer(HOST));
  });

  it('第二位玩家凭房间号加入，看到镜像视角的同一局', () => {
    const { service } = setup();
    service.start(HOST, { mode: 'pvp' });
    const code = findRoom(service, HOST);

    const joined = service.start(GUEST, { room: code });
    assert.match(joined.text, /进了房间/);
    assert.equal(joined.battle?.player.name, '你');
    assert.equal(joined.battle?.enemy.name, '对手');
    assert.equal(joined.battle?.history.length, 0);
    assert.equal(joined.battle?.player.hp, 18);
    assert.equal(joined.battle?.enemy.hp, 14);
  });

  it('房主出招、对手应对，双方共享同一份结算', () => {
    const { service } = setup();
    service.start(HOST, { mode: 'pvp' });
    const code = findRoom(service, HOST);
    service.start(GUEST, { room: code });

    const first = service.act(HOST, '普攻');
    assert.deepEqual(first.battle?.pending, { actor: 'player', move: 'light', damage: 3 });
    assert.equal(first.battle?.enemy.hp, 18);
    assert.match(first.text, /已出手/);

    const second = service.act(GUEST, '格挡');
    assert.equal(second.battle?.pending, null);
    assert.equal(second.battle?.history.length, 1);
    assert.match(second.text, /格挡/);

    const hostStatus = service.status(HOST);
    assert.equal(hostStatus.battle?.player.hp, 14);
    assert.equal(hostStatus.battle?.enemy.hp, 17);
    assert.match(hostStatus.text, /第1轮/);
    assert.match(hostStatus.text, /等对手出招/);
  });

  it('房主没等到人时出招只提示等对手', () => {
    const { service } = setup();
    service.start(HOST, { mode: 'pvp' });

    const result = service.act(HOST, '普攻');
    assert.equal(result.battle?.history.length, 0);
    assert.match(result.text, /还等着对手加入/);
  });

  it('房间满员与房间不存在都有明确播报', () => {
    const { service } = setup();
    service.start(HOST, { mode: 'pvp' });
    const code = findRoom(service, HOST);
    service.start(GUEST, { room: code });

    const full = service.start(OTHER, { room: code });
    assert.match(full.text, /已经满员/);

    const missing = service.start(OTHER, { room: '0000' });
    assert.match(missing.text, /没找到房间0000/);
  });

  it('房间号容忍中文数字，格式不对时提示四位数字', () => {
    assert.equal(normalizeRoomCode('一二三四'), '1234');
    assert.equal(normalizeRoomCode('四三二一'), '4321');
    assert.equal(normalizeRoomCode('房间 1234'), '1234');
    assert.equal(normalizeRoomCode('123'), null);
    assert.equal(normalizeRoomCode('12345'), null);

    const { service } = setup();
    const result = service.start(GUEST, { room: '12' });
    assert.match(result.text, /四位数字/);
  });

  it('房主重新开房会撤掉旧房间与旧对局', () => {
    const { service, rooms, store } = setup();
    service.start(HOST, { mode: 'pvp' });
    const oldBattleId = store.get(`pvp:${findRoom(service, HOST)}`)!.id;
    service.start(HOST, { mode: 'pvp' });
    const newCode = findRoom(service, HOST);

    assert.equal(rooms.size, 1);
    assert.notEqual(store.get(`pvp:${newCode}`)!.id, oldBattleId);
  });

  it('房间过期后回到普通对局流程', () => {
    const { service, advance } = setup();
    service.start(HOST, { mode: 'pvp' });
    advance(61_000);

    const status = service.status(HOST);
    assert.equal(status.battle, null);
    assert.match(status.text, /没有进行中的对局/);
    assert.match(service.start(GUEST, { room: '1000' }).text, /没找到/);
  });

  it('MCP 工具层能开房与加入', async () => {
    const { service, rooms } = setup();
    const handlers = new Map<string, (input: Record<string, unknown>) => Promise<{
      content: Array<{ type: string; text: string }>;
    }>>();
    const server = {
      registerTool(name: string, _definition: unknown, handler: (input: Record<string, unknown>) => Promise<{
        content: Array<{ type: string; text: string }>;
      }>) {
        handlers.set(name, handler);
      },
    } as unknown as McpServer;
    const ctx = { deviceId: 'device-a', agentId: 'agent-1', sessionId: 's-1', anonymousId: 'anon-1' };
    registerGameTools(server, { service, logger: createLogger('error'), ctx });

    const start = handlers.get('game_start')!;
    const opened = await start({ mode: 'pvp' });
    const text = opened.content[0]!.text;
    assert.match(text, /房间\d{4}/);

    // 换一个设备身份加入，避免房主自己进自己的房
    ctx.deviceId = 'device-b';
    ctx.agentId = 'agent-2';
    const joined = await handlers.get('game_start')!({ room: findRoom(service, HOST) });
    assert.match(joined.content[0]!.text, /进了房间/);
    assert.equal(rooms.size, 1);
  });
});
