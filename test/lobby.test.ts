import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { loadConfig } from '../src/config.js';
import { createBattle } from '../src/game/engine.js';
import { buildLobby, LOBBY_DEFAULT_LIMIT, type LobbySnapshot } from '../src/game/lobby.js';
import { pvpBattleKey } from '../src/game/pvp.js';
import { GameService } from '../src/game/service.js';
import type { Battle } from '../src/game/types.js';
import { createApp } from '../src/http/app.js';
import { createLogger } from '../src/log.js';
import { BattleStore } from '../src/store/battles.js';
import { RoomStore, type Room } from '../src/store/rooms.js';

/**
 * 公开大厅测试：读模型纯函数 + GET /rooms 外壳。
 *
 * 重点只有两条：页面拿到的是服务端事实（状态、轮次、时间），
 * 以及设备身份一架都不从这层漏出去。
 */

const HOST_KEY = 'e8:f6:0a:8c:56:6c#447ae9ac06ee4120b004326aca796002';
const GUEST_KEY = 'aa:bb:cc:dd:ee:ff#90f1ab2c3d4e5f60718293a4b5c6d7e8';

function roomFixture(overrides: Partial<Room> = {}): Room {
  return {
    code: '1234',
    hostKey: HOST_KEY,
    guestKey: GUEST_KEY,
    createdAt: 1_000,
    updatedAt: 1_000,
    ...overrides,
  };
}

function lobbyBattle(overrides: Partial<Battle> = {}): Battle {
  return { ...createBattle({ now: 1_000, seed: 0, mode: 'pvp' }), ...overrides };
}

function entriesOf(rooms: readonly Room[]): Array<{ key: string; battle: Battle }> {
  return rooms.map((room) => ({ key: pvpBattleKey(room.code), battle: lobbyBattle() }));
}

function lobbyOf(
  rooms: readonly Room[],
  battles: Array<{ key: string; battle: Battle }> = entriesOf(rooms),
  options: { now?: number; limit?: number } = {},
): LobbySnapshot {
  return buildLobby({ rooms, battles, now: options.now ?? 5_000, limit: options.limit });
}

describe('公开大厅读模型', () => {
  it('等待房与对战中的房各自归类，只给房间号、状态、轮次与时间', () => {
    const waiting = roomFixture({ code: '1111', guestKey: null, createdAt: 1_000, updatedAt: 1_000 });
    const playing = roomFixture({ code: '2222', createdAt: 2_000, updatedAt: 3_000 });
    const lobby = buildLobby({
      rooms: [waiting, playing],
      battles: [
        { key: 'pvp:1111', battle: lobbyBattle() },
        { key: 'pvp:2222', battle: lobbyBattle({ round: 3 }) },
      ],
      now: 5_000,
    });

    assert.equal(lobby.generatedAt, 5_000);
    assert.equal(lobby.waiting, 1);
    assert.equal(lobby.playing, 1);
    // 轮次取对局，时间取房间；字段就这四个，多一个都可能把设备号带出去
    assert.deepEqual(lobby.rooms, [
      { code: '1111', status: 'waiting', round: 1, createdAt: 1_000, updatedAt: 1_000 },
      { code: '2222', status: 'playing', round: 3, createdAt: 2_000, updatedAt: 3_000 },
    ]);
    assert.deepEqual(Object.keys(lobby.rooms[0]!).sort(), ['code', 'createdAt', 'round', 'status', 'updatedAt']);
    const raw = JSON.stringify(lobby);
    assert.equal(raw.includes(HOST_KEY), false);
    assert.equal(raw.includes(GUEST_KEY), false);
    assert.equal(raw.includes('hostKey'), false);
    assert.equal(raw.includes('guestKey'), false);
  });

  it('没有对局的房间、单人局与已分胜负的对局都不进大厅', () => {
    const rooms = [
      roomFixture({ code: '3333', guestKey: null }),
      roomFixture({ code: '4444' }),
      roomFixture({ code: '5555', guestKey: null }),
    ];
    const lobby = buildLobby({
      rooms,
      battles: [
        // 4444 已经打完，5555 输了，都没得打
        { key: 'pvp:4444', battle: lobbyBattle({ phase: 'victory' }) },
        { key: 'pvp:5555', battle: lobbyBattle({ phase: 'defeat' }) },
        // 单人局按设备键存，即使代码里混进来也不该被当成房间
        { key: HOST_KEY, battle: lobbyBattle({ mode: 'solo' }) },
      ],
      now: 5_000,
    });

    assert.deepEqual(lobby.rooms, []);
    assert.equal(lobby.waiting, 0);
    assert.equal(lobby.playing, 0);
  });

  it('等待房整体在前并按开房时间升序，对战中的房在后并按最近活动倒序', () => {
    const rooms = [
      roomFixture({ code: '2001', guestKey: GUEST_KEY, createdAt: 4_000, updatedAt: 100 }),
      roomFixture({ code: '2002', guestKey: null, createdAt: 2_000, updatedAt: 50 }),
      roomFixture({ code: '2003', guestKey: GUEST_KEY, createdAt: 3_000, updatedAt: 300 }),
      roomFixture({ code: '2004', guestKey: null, createdAt: 1_000, updatedAt: 20 }),
    ];
    const lobby = lobbyOf(rooms);

    assert.deepEqual(
      lobby.rooms.map((room) => `${room.code}:${room.status}`),
      ['2004:waiting', '2002:waiting', '2003:playing', '2001:playing'],
    );
  });

  it('同一时刻开的房、同一时刻有动作的房都用房间号兜底，轮询不会来回跳位', () => {
    const rooms = [
      roomFixture({ code: '3003', guestKey: null, createdAt: 1_000 }),
      roomFixture({ code: '3001', guestKey: null, createdAt: 1_000 }),
      roomFixture({ code: '3002', guestKey: null, createdAt: 1_000 }),
      roomFixture({ code: '3006', createdAt: 1_000, updatedAt: 2_000 }),
      roomFixture({ code: '3004', createdAt: 1_000, updatedAt: 2_000 }),
      roomFixture({ code: '3005', createdAt: 1_000, updatedAt: 2_000 }),
    ];
    const lobby = lobbyOf(rooms);

    assert.deepEqual(lobby.rooms.map((room) => room.code), ['3001', '3002', '3003', '3004', '3005', '3006']);
    assert.equal(lobby.waiting, 3);
    assert.equal(lobby.playing, 3);
  });

  it('默认最多返回 50 间房，计数只算截断后还在列表里的', () => {
    const rooms = Array.from({ length: 60 }, (_, index) =>
      roomFixture({ code: String(1_000 + index), guestKey: null, createdAt: index }),
    );
    const lobby = lobbyOf(rooms);

    assert.equal(LOBBY_DEFAULT_LIMIT, 50);
    assert.equal(lobby.rooms.length, LOBBY_DEFAULT_LIMIT);
    assert.equal(lobby.rooms[0]?.code, '1000');
    assert.equal(lobby.rooms.at(-1)?.code, '1049');
    assert.equal(lobby.waiting, 50);
    assert.equal(lobby.playing, 0);
  });

  it('显式 limit 先保等待房，0 与负数给空列表，非有限值退回默认', () => {
    const rooms = [
      roomFixture({ code: '4001', guestKey: null, createdAt: 1_000 }),
      roomFixture({ code: '4002', createdAt: 2_000, updatedAt: 2_000 }),
    ];

    const one = lobbyOf(rooms, entriesOf(rooms), { limit: 1 });
    assert.deepEqual(one.rooms.map((room) => room.code), ['4001']);
    assert.equal(one.waiting, 1);
    assert.equal(one.playing, 0);

    for (const limit of [0, -5]) {
      const empty = lobbyOf(rooms, entriesOf(rooms), { limit });
      assert.deepEqual(empty.rooms, []);
      assert.equal(empty.waiting, 0);
      assert.equal(empty.playing, 0);
    }

    const fallback = lobbyOf(rooms, entriesOf(rooms), { limit: Number.NaN });
    assert.equal(fallback.rooms.length, 2);
  });

  it('不传 now 时用当前时间生成时间戳', () => {
    const lobby = buildLobby({ rooms: [], battles: [] });
    assert.ok(Math.abs(lobby.generatedAt - Date.now()) < 5_000);
    assert.deepEqual(lobby.rooms, []);
  });
});

interface LobbyResponse extends LobbySnapshot {
  ok: boolean;
}

interface Harness {
  baseUrl: string;
  close(): Promise<void>;
}

async function startHarness(): Promise<Harness> {
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

  let server: Server | undefined;
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  const address = (server as Server).address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve) => {
        (server as Server).close(() => resolve());
      }),
  };
}

async function fetchLobby(baseUrl: string): Promise<LobbyResponse> {
  const response = await fetch(`${baseUrl}/rooms`);
  assert.equal(response.status, 200);
  return (await response.json()) as LobbyResponse;
}

async function debugStart(baseUrl: string, device: string, body: unknown): Promise<void> {
  const response = await fetch(`${baseUrl}/debug/start?device=${device}&agent=lobby-agent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  assert.equal(response.status, 200);
}

describe('公开大厅路由', () => {
  let harness: Harness;
  let roomCode = '';

  before(async () => {
    harness = await startHarness();
  });

  after(async () => {
    await harness.close();
  });

  it('空场也回结构化空列表，禁止缓存并允许跨域', async () => {
    const response = await fetch(`${harness.baseUrl}/rooms`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('access-control-allow-origin'), '*');
    const body = (await response.json()) as LobbyResponse;
    assert.equal(body.ok, true);
    assert.equal(typeof body.generatedAt, 'number');
    assert.deepEqual(body.rooms, []);
    assert.equal(body.waiting, 0);
    assert.equal(body.playing, 0);
  });

  it('开房后看到等待房，对手加入后变对战中的房，全程不带设备身份', async () => {
    await debugStart(harness.baseUrl, 'lobby-host', { mode: 'pvp' });
    const state = (await (
      await fetch(`${harness.baseUrl}/state?device=lobby-host&agent=lobby-agent`)
    ).json()) as { room: string | null };
    roomCode = state.room ?? '';
    assert.match(roomCode, /^\d{4}$/);

    const waiting = await fetchLobby(harness.baseUrl);
    const waitingEntry = waiting.rooms.find((room) => room.code === roomCode);
    assert.ok(waitingEntry);
    assert.equal(waitingEntry.status, 'waiting');
    assert.equal(waitingEntry.round, 1);
    assert.equal(waiting.waiting, 1);
    assert.equal(waiting.playing, 0);
    const waitingRaw = JSON.stringify(waiting);
    assert.equal(waitingRaw.includes('lobby-host'), false);
    assert.equal(waitingRaw.includes('lobby-agent'), false);
    assert.equal(waitingRaw.includes('hostKey'), false);
    assert.equal(waitingRaw.includes('guestKey'), false);

    await debugStart(harness.baseUrl, 'lobby-guest', { room: roomCode });
    const playing = await fetchLobby(harness.baseUrl);
    const playingEntry = playing.rooms.find((room) => room.code === roomCode);
    assert.ok(playingEntry);
    assert.equal(playingEntry.status, 'playing');
    assert.equal(playing.waiting, 0);
    assert.equal(playing.playing, 1);
    const playingRaw = JSON.stringify(playing);
    assert.equal(playingRaw.includes('lobby-host'), false);
    assert.equal(playingRaw.includes('lobby-guest'), false);
  });

  it('反复轮询大厅不推进对局，两次结果只差生成时间', async () => {
    const first = await fetchLobby(harness.baseUrl);
    const second = await fetchLobby(harness.baseUrl);
    assert.deepEqual({ ...second, generatedAt: first.generatedAt }, first);
    assert.ok(second.generatedAt >= first.generatedAt);
  });

  it('只开放 GET，写操作落到 404', async () => {
    const response = await fetch(`${harness.baseUrl}/rooms`, { method: 'POST' });
    assert.equal(response.status, 404);
  });
});
