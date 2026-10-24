import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import type { Express } from 'express';
import { extractAdminToken, isAdminAllowed } from '../src/admin/access.js';
import { buildAdminOverview, maskDeviceKey, type AdminBattleEntry, type AdminOverview } from '../src/admin/overview.js';
import { ADMIN_PAGE_HTML, adminDeniedPage } from '../src/admin/page.js';
import { ADMIN_RATE_LIMIT, createRateLimiter } from '../src/admin/ratelimit.js';
import type { AppConfig } from '../src/config.js';
import { loadConfig } from '../src/config.js';
import { createBattle, resolveTurn } from '../src/game/engine.js';
import { GameService } from '../src/game/service.js';
import type { Battle } from '../src/game/types.js';
import { createApp } from '../src/http/app.js';
import { createLogger } from '../src/log.js';
import { BattleStore } from '../src/store/battles.js';
import { RoomStore, type Room } from '../src/store/rooms.js';

/**
 * 后台监控页测试：只读读模型、口令、限速，以及两个只读路由的实际返回。
 *
 * 页面本身不做数值判断，所以这里不重复铺规则分支，只覆盖「页面拿到的是不是服务端事实」。
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

function pvpBattle(now = 1_000): Battle {
  return createBattle({ now, seed: 0, mode: 'pvp' });
}

function overviewOf(battles: AdminBattleEntry[], rooms: Room[] = [], now = 5_000): AdminOverview {
  return buildAdminOverview({ rooms, battles, now });
}

describe('后台监控读模型', () => {
  it('双人房按房间归拢双方生命值、能量与大招，并对设备号脱敏', () => {
    const overview = overviewOf([{ key: 'pvp:1234', battle: pvpBattle() }], [roomFixture()]);
    assert.equal(overview.roomCount, 1);
    assert.equal(overview.soloCount, 0);
    assert.equal(overview.staleRooms, 0);
    assert.equal(overview.generatedAt, 5_000);
    assert.equal(overview.rooms.length, 1);

    const entry = overview.rooms[0]!;
    assert.equal(entry.code, '1234');
    assert.equal(entry.kind, 'room');
    assert.equal(entry.mode, 'pvp');
    assert.equal(entry.phase, 'battle');
    assert.equal(entry.round, 1);
    assert.equal(entry.active, 'player');
    assert.equal(entry.waiting, false);
    assert.equal(entry.pending, null);
    assert.equal(entry.winner, null);
    assert.equal(entry.updatedAt, 1_000);
    assert.equal(entry.players.length, 2);

    const [host, guest] = entry.players;
    assert.equal(host.name, '房主');
    assert.equal(host.side, 'player');
    assert.equal(host.empty, false);
    assert.equal(host.isAi, false);
    assert.equal(host.deviceKey, 'e8:f…6:6c#447a…6002');
    assert.equal(host.maxHp, 14);
    assert.equal(host.hp, 14);
    assert.equal(host.ap, 3);
    assert.equal(host.maxAp, 5);
    assert.equal(host.ultLeft, 1);

    assert.equal(guest.name, '加入者');
    assert.equal(guest.side, 'enemy');
    assert.equal(guest.isAi, false);
    assert.equal(guest.deviceKey, 'aa:b…e:ff#90f1…d7e8');

    // 完整设备号不能出现在页面数据里
    const raw = JSON.stringify(overview);
    assert.equal(raw.includes(HOST_KEY), false);
    assert.equal(raw.includes(GUEST_KEY), false);
  });

  it('房间还没人加入时标记等待，空座位没有设备号', () => {
    const overview = overviewOf([{ key: 'pvp:1234', battle: pvpBattle() }], [roomFixture({ guestKey: null })]);
    const entry = overview.rooms[0]!;
    assert.equal(entry.mode, 'pvp');
    assert.equal(entry.waiting, true);
    assert.equal(entry.players[1]!.name, '等待加入');
    assert.equal(entry.players[1]!.empty, true);
    assert.equal(entry.players[1]!.deviceKey, null);
  });

  it('攻击锁定后显示待应对招式与伤害，并把该开口的一方指向对手', async () => {
    const battle = pvpBattle();
    const { battle: locked } = await resolveTurn(battle, 'light', 2_000);
    const overview = overviewOf([{ key: 'pvp:1234', battle: locked }], [roomFixture()], 3_000);
    const entry = overview.rooms[0]!;
    assert.notEqual(entry.pending, null);
    assert.equal(entry.pending!.actor, 'player');
    assert.equal(entry.pending!.actorName, '房主');
    assert.equal(entry.pending!.move, 'light');
    assert.equal(entry.pending!.moveLabel, '普攻');
    assert.ok(entry.pending!.damage > 0);
    assert.equal(entry.active, 'enemy');
    assert.equal(entry.phase, 'battle');
  });

  it('加入者出手后，待应对的一手记在加入者名下', () => {
    const battle: Battle = {
      ...pvpBattle(),
      pending: { actor: 'enemy', move: 'heavy', damage: 5 },
    };
    const entry = overviewOf([{ key: 'pvp:1234', battle }], [roomFixture()]).rooms[0]!;
    assert.equal(entry.pending!.actor, 'enemy');
    assert.equal(entry.pending!.actorName, '加入者');
    assert.equal(entry.pending!.moveLabel, '强攻');
    assert.equal(entry.pending!.damage, 5);
    assert.equal(entry.active, 'player');
  });

  it('对局结束后带出胜者，不再高亮出手方', () => {
    const ended: Battle = { ...pvpBattle(), phase: 'victory' };
    const entry = overviewOf([{ key: 'pvp:1234', battle: ended }], [roomFixture()]).rooms[0]!;
    assert.equal(entry.phase, 'victory');
    assert.equal(entry.winner, 'player');
    assert.equal(entry.pending, null);
  });

  it('单人局单独成卡片，AI 座位没有设备号', () => {
    const battle = createBattle({ now: 1_000, seed: 0, enemyName: '试炼傀儡' });
    const overview = overviewOf([{ key: HOST_KEY, battle }]);
    assert.equal(overview.roomCount, 0);
    assert.equal(overview.soloCount, 1);
    const entry = overview.rooms[0]!;
    assert.equal(entry.code, null);
    assert.equal(entry.kind, 'solo');
    assert.equal(entry.mode, 'solo');
    assert.equal(entry.players[0]!.name, '玩家');
    assert.equal(entry.players[1]!.name, '试炼傀儡');
    assert.equal(entry.players[1]!.isAi, true);
    assert.equal(entry.players[1]!.deviceKey, null);
    assert.equal(entry.players[0]!.deviceKey, 'e8:f…6:6c#447a…6002');
  });

  it('已加入房间的玩家名下旧单人局不再展示，房间对局过期只记数', () => {
    const solo = createBattle({ now: 1_000, seed: 0 });
    const overview = buildAdminOverview({
      rooms: [roomFixture({ guestKey: null })],
      battles: [
        // 房主名下的旧单人局：已经进房间，作废
        { key: HOST_KEY, battle: solo },
        // 另一个没人管的单人局：正常展示
        { key: 'dev-0000-1111-2222#agent-3333-4444', battle: solo },
      ],
      now: 9_000,
    });
    assert.equal(overview.roomCount, 1);
    assert.equal(overview.staleRooms, 1);
    assert.equal(overview.soloCount, 1);
    assert.equal(overview.rooms.length, 1);
    assert.equal(overview.rooms[0]!.kind, 'solo');
    assert.equal(overview.rooms[0]!.players[0]!.deviceKey, 'dev-…2222#agen…4444');
  });

  it('房间按房间号升序、单人局按最近活动倒序', () => {
    const older = createBattle({ now: 1_000, seed: 0 });
    const newer = createBattle({ now: 1_000, seed: 0 });
    newer.updatedAt = 8_000;
    const overview = buildAdminOverview({
      rooms: [roomFixture({ code: '2000' }), roomFixture({ code: '1500' })],
      battles: [
        { key: 'pvp:2000', battle: pvpBattle() },
        { key: 'pvp:1500', battle: pvpBattle() },
        { key: 'x#1', battle: older },
        { key: 'y#1', battle: newer },
      ],
      now: 9_000,
    });
    assert.deepEqual(
      overview.rooms.map((entry) => entry.code),
      ['1500', '2000', null, null],
    );
    assert.equal(overview.rooms[2]!.players[0]!.deviceKey, '…#…');
  });

  it('短设备号也脱敏，长设备号只留首尾', () => {
    assert.equal(maskDeviceKey('dev#a'), 'd…v#…');
    assert.equal(maskDeviceKey('ab'), '…');
    assert.equal(maskDeviceKey('12345678#abcdefgh'), '1…8#a…h');
    assert.equal(maskDeviceKey('123456789#abcdefghij'), '1234…6789#abcd…ghij');
    assert.equal(maskDeviceKey(''), '');
  });

  it('存储枚举顺手清掉过期对局与房间，只回还活着的', () => {
    let now = 1_000;
    const store = new BattleStore({ ttlMs: 1_000, now: () => now });
    const rooms = new RoomStore({ ttlMs: 1_000, now: () => now });
    store.set('pvp:1234', pvpBattle());
    rooms.create('host#a');

    assert.equal(store.list().length, 1);
    assert.equal(store.list()[0]!.key, 'pvp:1234');
    assert.equal(rooms.list().length, 1);
    assert.match(rooms.list()[0]!.code, /^\d{4}$/);

    now = 5_000;
    assert.equal(store.list().length, 0);
    assert.equal(rooms.list().length, 0);
    assert.equal(store.size, 0);
    assert.equal(rooms.size, 0);
  });
});

describe('后台监控访问控制', () => {
  it('没配口令默认公开', () => {
    assert.equal(isAdminAllowed(undefined, ''), true);
    assert.equal(isAdminAllowed('   ', '随便什么'), true);
  });

  it('配了口令就必须一致，且不接受长度不同的值', () => {
    assert.equal(isAdminAllowed('secret', 'secret'), true);
    assert.equal(isAdminAllowed(' secret ', 'secret'), true);
    assert.equal(isAdminAllowed('secret', 'Secret'), false);
    assert.equal(isAdminAllowed('secret', ''), false);
    assert.equal(isAdminAllowed('secret', 'secre'), false);
    assert.equal(isAdminAllowed('secret', 'secret2'), false);
  });

  it('口令优先取查询参数，其次 Authorization: Bearer', () => {
    assert.equal(extractAdminToken({ query: { token: ' abc ' }, authorization: 'Bearer xyz' }), 'abc');
    assert.equal(extractAdminToken({ query: {}, authorization: 'Bearer xyz' }), 'xyz');
    assert.equal(extractAdminToken({ query: {}, authorization: 'bearer  xyz  ' }), 'xyz');
    assert.equal(extractAdminToken({ query: { token: ['a', 'b'] }, authorization: 'Basic abc' }), '');
    assert.equal(extractAdminToken({}), '');
  });

  it('配置解析支持 ADMIN_TOKEN，空白视为未配置', () => {
    assert.equal(loadConfig({ ADMIN_TOKEN: '  backstage  ' }).adminToken, 'backstage');
    assert.equal(loadConfig({}).adminToken, undefined);
    assert.equal(loadConfig({ ADMIN_TOKEN: '   ' }).adminToken, undefined);
  });
});

describe('后台监控限速', () => {
  it('同一来源超过窗口次数就拒绝，窗口过后重新计数', () => {
    let now = 0;
    const limiter = createRateLimiter({ limit: 2, windowMs: 1_000, now: () => now });
    assert.equal(limiter.allow('a'), true);
    assert.equal(limiter.allow('a'), true);
    assert.equal(limiter.allow('a'), false);
    assert.equal(limiter.allow('b'), true);
    now = 1_000;
    assert.equal(limiter.allow('a'), true);
  });

  it('来源太多时先清过期计数，避免内存无限增长', () => {
    let now = 0;
    const limiter = createRateLimiter({ limit: 1, windowMs: 1_000, maxKeys: 16, now: () => now });
    for (let index = 0; index < 16; index += 1) {
      assert.equal(limiter.allow(`ip-${index}`), true);
    }
    now = 2_000;
    // 触发清扫：上一窗口的计数都过期，新来源照常放行
    assert.equal(limiter.allow('ip-new'), true);
  });

  it('来源数到上限后淘汰最旧的桶，不会越过 maxKeys 继续长', () => {
    const now = 0;
    const limiter = createRateLimiter({ limit: 1, windowMs: 60_000, maxKeys: 16, now: () => now });
    for (let index = 0; index < 16; index += 1) {
      assert.equal(limiter.allow(`ip-${index}`), true);
    }
    // 第 17 个来源挤掉最旧的 ip-0：新来源先占位，仍在窗口内的 ip-1 继续限 1 次
    assert.equal(limiter.allow('ip-16'), true);
    assert.equal(limiter.allow('ip-16'), false);
    assert.equal(limiter.allow('ip-1'), false);
    // 被淘汰的 ip-0 已经不在 Map 里，于是被当成新来源重新放行
    assert.equal(limiter.allow('ip-0'), true);
  });

  it('默认每分钟 120 次', () => {
    let now = 0;
    const limiter = createRateLimiter({ now: () => now });
    for (let index = 0; index < ADMIN_RATE_LIMIT.limit; index += 1) {
      assert.equal(limiter.allow('ip'), true);
    }
    assert.equal(limiter.allow('ip'), false);
    now = ADMIN_RATE_LIMIT.windowMs;
    assert.equal(limiter.allow('ip'), true);
  });
});

describe('后台监控页面', () => {
  it('内嵌页面用中文术语，3 秒轮询只读接口，不引用外部资源', () => {
    assert.match(ADMIN_PAGE_HTML, /对局监控/);
    assert.match(ADMIN_PAGE_HTML, /生命值/);
    assert.match(ADMIN_PAGE_HTML, /能量/);
    assert.match(ADMIN_PAGE_HTML, /大招剩余/);
    assert.match(ADMIN_PAGE_HTML, /\/admin\/api\/rooms/);
    assert.match(ADMIN_PAGE_HTML, /3000/);
    assert.match(ADMIN_PAGE_HTML, /noindex, nofollow/);
    assert.equal(ADMIN_PAGE_HTML.includes('https://'), false);
    assert.equal(ADMIN_PAGE_HTML.includes('http://'), false);
  });

  it('口令提示页只给一句人话，并把传入文本转义', () => {
    const html = adminDeniedPage('<b>不对</b>');
    assert.match(html, /需要口令/);
    assert.equal(html.includes('<b>不对</b>'), false);
    assert.match(html, /&lt;b&gt;不对&lt;\/b&gt;/);
  });
});

interface Harness {
  app: Express;
  baseUrl: string;
  store: BattleStore;
  rooms: RoomStore;
  close(): Promise<void>;
}

async function startHarness(config: Partial<AppConfig> = {}): Promise<Harness> {
  const logger = createLogger('error');
  const store = new BattleStore({ ttlMs: 60_000 });
  const rooms = new RoomStore({ ttlMs: 60_000 });
  const service = new GameService({ store, rooms, logger, random: () => 0 });
  const app = createApp({
    config: { ...loadConfig({}), enableDebugEndpoints: true, ...config },
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
    app,
    baseUrl: `http://127.0.0.1:${address.port}`,
    store,
    rooms,
    close: () =>
      new Promise<void>((resolve) => {
        (server as Server).close(() => resolve());
      }),
  };
}

interface AdminResponse extends AdminOverview {
  ok: boolean;
}

async function fetchOverview(baseUrl: string, query = ''): Promise<AdminResponse> {
  const response = await fetch(`${baseUrl}/admin/api/rooms${query}`);
  assert.equal(response.status, 200);
  return (await response.json()) as AdminResponse;
}

describe('后台监控路由（未配置口令，默认公开）', () => {
  let harness: Harness;
  let roomCode = '';

  before(async () => {
    harness = await startHarness();
  });

  after(async () => {
    await harness.close();
  });

  it('只信任 loopback 反代，X-Forwarded-For 才不会被当成同一个人', () => {
    assert.equal(harness.app.get('trust proxy'), 'loopback');
  });

  it('GET /admin 返回内嵌页面并禁止收录', async () => {
    const response = await fetch(`${harness.baseUrl}/admin`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /text\/html/);
    assert.equal(response.headers.get('x-robots-tag'), 'noindex, nofollow');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.match(response.headers.get('content-security-policy') ?? '', /default-src 'none'/);
    const html = await response.text();
    assert.match(html, /对局监控/);
    assert.match(html, /生命值/);
  });

  it('GET /admin/api/rooms 空场也回结构化的空列表', async () => {
    const response = await fetch(`${harness.baseUrl}/admin/api/rooms`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-robots-tag'), 'noindex, nofollow');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const body = (await response.json()) as AdminResponse;
    assert.equal(body.ok, true);
    assert.equal(body.roomCount, 0);
    assert.equal(body.soloCount, 0);
    assert.deepEqual(body.rooms, []);
    assert.equal(typeof body.generatedAt, 'number');
  });

  it('开房、加入后接口按房间列出双方，且不泄露完整设备号', async () => {
    const hostStart = await fetch(
      `${harness.baseUrl}/debug/start?device=admin-host&agent=debug-agent`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'pvp' }) },
    );
    assert.equal(hostStart.status, 200);
    const hostState = (await (await fetch(`${harness.baseUrl}/state?device=admin-host&agent=debug-agent`)).json()) as {
      room: string | null;
    };
    roomCode = hostState.room ?? '';
    assert.match(roomCode, /^\d{4}$/);

    const guestStart = await fetch(
      `${harness.baseUrl}/debug/start?device=admin-guest&agent=debug-agent`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ room: roomCode }),
      },
    );
    assert.equal(guestStart.status, 200);

    const body = await fetchOverview(harness.baseUrl);
    assert.equal(body.roomCount, 1);
    const entry = body.rooms.find((item) => item.code === roomCode);
    assert.ok(entry);
    assert.equal(entry.kind, 'room');
    assert.equal(entry.waiting, false);
    assert.equal(entry.phase, 'battle');
    assert.equal(entry.players[0]!.name, '房主');
    assert.equal(entry.players[1]!.name, '加入者');
    assert.ok(entry.players[0]!.hp > 0);
    assert.ok(entry.players[1]!.hp > 0);

    const raw = JSON.stringify(body);
    assert.equal(raw.includes('admin-host#debug-agent'), false);
    assert.equal(raw.includes('admin-guest#debug-agent'), false);
    assert.match(raw, /admi…host/);
  });

  it('一方出招后接口给出待应对的招式与伤害', async () => {
    assert.ok(roomCode);
    const acted = await fetch(`${harness.baseUrl}/debug/action?device=admin-host&agent=debug-agent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: '普攻' }),
    });
    assert.equal(acted.status, 200);

    const body = await fetchOverview(harness.baseUrl);
    const entry = body.rooms.find((item) => item.code === roomCode);
    assert.ok(entry);
    assert.notEqual(entry.pending, null);
    assert.equal(entry.pending!.actorName, '房主');
    assert.equal(entry.pending!.moveLabel, '普攻');
    assert.ok(entry.pending!.damage > 0);
    assert.equal(entry.active, 'enemy');
  });

  it('页面与接口都只有 GET，写操作落到 404', async () => {
    const methodNotAllowed = await fetch(`${harness.baseUrl}/admin/api/rooms`, { method: 'DELETE' });
    assert.equal(methodNotAllowed.status, 404);
    const pagePost = await fetch(`${harness.baseUrl}/admin`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ health: 0 }),
    });
    assert.equal(pagePost.status, 404);
  });

  it('按来源限速认 X-Forwarded-For：同一来源累计、不同来源各自计数', async () => {
    const isolated = await startHarness();
    try {
      const request = (ip: string) =>
        fetch(`${isolated.baseUrl}/admin/api/rooms`, { headers: { 'x-forwarded-for': ip } });
      for (let index = 0; index < ADMIN_RATE_LIMIT.limit; index += 1) {
        assert.equal((await request('203.0.113.7')).status, 200);
      }
      // 同一来源继续打就超限
      assert.equal((await request('203.0.113.7')).status, 429);
      // 另一个来源不受影响，说明限速没有退化成全局一个桶
      assert.equal((await request('203.0.113.8')).status, 200);
    } finally {
      await isolated.close();
    }
  });

  it('监控接口按来源限速，超过每分钟上限回 429', async () => {
    const isolated = await startHarness();
    try {
      for (let index = 0; index < ADMIN_RATE_LIMIT.limit; index += 1) {
        const response = await fetch(`${isolated.baseUrl}/admin/api/rooms`);
        assert.equal(response.status, 200);
      }
      const limited = await fetch(`${isolated.baseUrl}/admin/api/rooms`);
      assert.equal(limited.status, 429);
      assert.equal(limited.headers.get('x-robots-tag'), 'noindex, nofollow');
      const body = (await limited.json()) as { ok: boolean; error: string };
      assert.equal(body.ok, false);
      assert.equal(body.error, 'rate_limited');
    } finally {
      await isolated.close();
    }
  });
});

describe('后台监控路由（配置了 ADMIN_TOKEN）', () => {
  const token = 'backstage-secret-token';
  let harness: Harness;

  before(async () => {
    harness = await startHarness({ adminToken: token, enableDebugEndpoints: false });
  });

  after(async () => {
    await harness.close();
  });

  it('不带口令返回 401，且不回显期望的口令', async () => {
    const page = await fetch(`${harness.baseUrl}/admin`);
    assert.equal(page.status, 401);
    assert.equal(page.headers.get('x-robots-tag'), 'noindex, nofollow');
    const html = await page.text();
    assert.match(html, /后台监控页需要口令/);
    assert.equal(html.includes(token), false);

    const api = await fetch(`${harness.baseUrl}/admin/api/rooms`);
    assert.equal(api.status, 401);
    const body = (await api.json()) as { ok: boolean; error: string; message: string };
    assert.equal(body.ok, false);
    assert.equal(body.error, 'unauthorized');
    assert.equal(body.message.includes(token), false);
  });

  it('口令不对也返回 401', async () => {
    for (const query of ['?token=wrong', '?token=']) {
      const response = await fetch(`${harness.baseUrl}/admin/api/rooms${query}`);
      assert.equal(response.status, 401);
    }
    const bearer = await fetch(`${harness.baseUrl}/admin/api/rooms`, {
      headers: { authorization: 'Bearer wrong-token' },
    });
    assert.equal(bearer.status, 401);
  });

  it('先限速再校验口令：错误口令也占配额，试到上限后正确口令同样被挡', async () => {
    const isolated = await startHarness({ adminToken: token, enableDebugEndpoints: false });
    try {
      for (let index = 0; index < ADMIN_RATE_LIMIT.limit; index += 1) {
        const response = await fetch(`${isolated.baseUrl}/admin/api/rooms?token=wrong`);
        assert.equal(response.status, 401);
      }
      assert.equal((await fetch(`${isolated.baseUrl}/admin/api/rooms?token=wrong`)).status, 429);
      assert.equal((await fetch(`${isolated.baseUrl}/admin/api/rooms?token=${token}`)).status, 429);
      // 页面与接口共用一个来源桶，口令正确也一起被挡
      assert.equal((await fetch(`${isolated.baseUrl}/admin?token=${token}`)).status, 429);
    } finally {
      await isolated.close();
    }
  });

  it('查询参数与 Bearer 都能通过口令校验', async () => {
    const byQuery = await fetch(`${harness.baseUrl}/admin/api/rooms?token=${token}`);
    assert.equal(byQuery.status, 200);
    const body = (await byQuery.json()) as AdminResponse;
    assert.equal(body.ok, true);

    const byBearer = await fetch(`${harness.baseUrl}/admin/api/rooms`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(byBearer.status, 200);

    const page = await fetch(`${harness.baseUrl}/admin?token=${token}`);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.equal(html.includes(token), false);
  });
});
