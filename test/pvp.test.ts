import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { GameService } from '../src/game/service.js';
import { mirrorEvents, normalizeRoomCode, pvpBattleKey } from '../src/game/pvp.js';
import { battleKey, type DeviceContext } from '../src/mcp/context.js';
import { registerGameTools } from '../src/mcp/tools.js';
import type { IntentResolver } from '../src/game/intent.js';
import { createLogger } from '../src/log.js';
import { BattleStore } from '../src/store/battles.js';
import { EchoStore } from '../src/store/echoes.js';
import { RoomStore } from '../src/store/rooms.js';
import type { BattleEvent } from '../src/game/types.js';

const HOST = 'device-a#agent-1';
const GUEST = 'device-b#agent-2';
const OTHER = 'device-c#agent-3';

/** 按设备上下文注册一套工具处理器：测试里用它模拟两种不同载体 */
function toolset(service: GameService, ctx: DeviceContext) {
  type Handler = (input: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }> }>;
  const handlers = new Map<string, Handler>();
  const server = {
    registerTool(name: string, _definition: unknown, handler: Handler) {
      handlers.set(name, handler);
    },
  } as unknown as McpServer;
  registerGameTools(server, { service, logger: createLogger('error'), ctx });
  return async (tool: string, input: Record<string, unknown> = {}): Promise<string> => {
    const text = (await handlers.get(tool)!(input)).content[0]?.text;
    assert.ok(text);
    return text;
  };
}

function setup(overrides: Partial<ConstructorParameters<typeof GameService>[0]> = {}) {
  let now = 1_000_000;
  const store = new BattleStore({ ttlMs: 60_000, now: () => now });
  const rooms = new RoomStore({ ttlMs: 60_000, now: () => now, random: () => 0 });
  const service = new GameService({
    store,
    rooms,
    logger: createLogger('error'),
    now: () => now,
    random: () => 0,
    ...overrides,
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
  it('开房拿到四位房间号，并提示对手怎么加入', async () => {
    const { service, rooms } = setup();
    const result = await service.start(HOST, { mode: 'pvp' });

    assert.equal(result.battle?.mode, 'pvp');
    assert.match(result.text, /房间\d{4}/);
    assert.match(result.text, /加入房间\d{4}/);
    // 对手还没加入，不能提前播「对决开始」
    assert.doesNotMatch(result.text, /对决开始/);
    assert.equal(rooms.size, 1);
    assert.ok(rooms.byPlayer(HOST));
  });

  it('重复喊开房时复用同一个房间号', async () => {
    const { service } = setup();
    const first = await service.start(HOST, { mode: 'pvp' });
    const code = findRoom(service, HOST);
    const second = await service.start(HOST, { mode: 'pvp' });
    assert.match(second.text, new RegExp(`房间${code}`));
    assert.equal(first.battle?.id, second.battle?.id);
  });

  it('第二位玩家凭房间号加入，看到镜像视角的同一局', async () => {
    const { service } = setup();
    await service.start(HOST, { mode: 'pvp' });
    const code = findRoom(service, HOST);

    const joined = await service.start(GUEST, { room: code });
    assert.match(joined.text, /进了房间/);
    assert.match(joined.text, /对决开始/);
    assert.equal(joined.battle?.player.name, '你');
    assert.equal(joined.battle?.enemy.name, '对手');
    assert.equal(joined.battle?.history.length, 0);
    assert.equal(joined.battle?.player.hp, 18);
    assert.equal(joined.battle?.enemy.hp, 14);
    // 换视角后对手没有名字，播报里不能出现「你的对手是对手」
    assert.doesNotMatch(joined.text, /你的对手是对手/);
  });

  it('房主出招、对手应对，双方共享同一份结算', async () => {
    const { service } = setup();
    await service.start(HOST, { mode: 'pvp' });
    const code = findRoom(service, HOST);
    await service.start(GUEST, { room: code });

    const first = await service.say(HOST, '普攻');
    assert.deepEqual(first.battle?.pending, { actor: 'player', move: 'light', damage: 3 });
    assert.equal(first.battle?.enemy.hp, 18);
    assert.match(first.text, /已出手/);

    const second = await service.say(GUEST, '格挡');
    assert.equal(second.battle?.pending, null);
    assert.equal(second.battle?.history.length, 1);
    assert.match(second.text, /格挡/);

    const hostStatus = service.status(HOST);
    assert.equal(hostStatus.battle?.player.hp, 14);
    assert.equal(hostStatus.battle?.enemy.hp, 17);
    assert.match(hostStatus.text, /第1轮/);
    assert.match(hostStatus.text, /等对手出招/);
  });

  it('对手赢下这一局时，双方各自看到自己赢或输', async () => {
    const { service, store } = setup();
    await service.start(HOST, { mode: 'pvp' });
    const code = findRoom(service, HOST);
    await service.start(GUEST, { room: code });

    // 直接摆一个「基准视角的 player 已倒下」的终局，省去把整局打满
    const key = `pvp:${code}`;
    const canonical = store.get(key);
    assert.ok(canonical);
    store.set(key, { ...canonical, phase: 'defeat', player: { ...canonical.player, hp: 0 } });

    const hostStatus = service.status(HOST);
    assert.equal(hostStatus.battle?.phase, 'defeat');
    assert.match(hostStatus.text, /你输了/);

    const guestStatus = service.status(GUEST);
    assert.equal(guestStatus.battle?.phase, 'victory');
    assert.match(guestStatus.text, /你赢了/);
  });

  it('房主没等到人时出招只提示等对手', async () => {
    const { service } = setup();
    await service.start(HOST, { mode: 'pvp' });

    const result = await service.say(HOST, '普攻');
    assert.equal(result.battle?.history.length, 0);
    assert.match(result.text, /还等着对手加入/);
  });

  it('房间满员与房间不存在都有明确播报', async () => {
    const { service } = setup();
    await service.start(HOST, { mode: 'pvp' });
    const code = findRoom(service, HOST);
    await service.start(GUEST, { room: code });

    const full = await service.start(OTHER, { room: code });
    assert.match(full.text, /已经满员/);

    const missing = await service.start(OTHER, { room: '0000' });
    assert.match(missing.text, /没找到房间0000/);
  });

  it('房间号容忍中文数字，格式不对时提示四位数字', async () => {
    assert.equal(normalizeRoomCode('一二三四'), '1234');
    assert.equal(normalizeRoomCode('四三二一'), '4321');
    assert.equal(normalizeRoomCode('房间 1234'), '1234');
    assert.equal(normalizeRoomCode('123'), null);
    assert.equal(normalizeRoomCode('12345'), null);

    const { service } = setup();
    const result = await service.start(GUEST, { room: '12' });
    assert.match(result.text, /四位数字/);
  });

  it('房主开房后重开：等人时复用房间号，已开局则换新房间', async () => {
    const { service, rooms, store } = setup();
    await service.start(HOST, { mode: 'pvp' });
    const firstCode = findRoom(service, HOST);
    const firstBattleId = store.get(`pvp:${firstCode}`)!.id;

    await service.start(HOST, { mode: 'pvp' });
    assert.equal(findRoom(service, HOST), firstCode);
    assert.equal(store.get(`pvp:${firstCode}`)!.id, firstBattleId);

    await service.start(GUEST, { room: firstCode });
    await service.start(HOST, { mode: 'pvp' });
    // 已开局后重开：旧房撤掉、新局重开（房间号可能复用，不能按码判断）
    const newCode = findRoom(service, HOST);
    assert.notEqual(store.get(`pvp:${newCode}`)!.id, firstBattleId);
    assert.equal(rooms.size, 1);
  });

  it('房间过期后回到普通对局流程', async () => {
    const { service, advance } = setup();
    await service.start(HOST, { mode: 'pvp' });
    advance(61_000);

    const status = service.status(HOST);
    assert.equal(status.battle, null);
    assert.match(status.text, /没有进行中的对局/);
    assert.match((await service.start(GUEST, { room: '1000' })).text, /没找到/);
  });

  it('房间号格式不对、房间不存在与满员分别提示', async () => {
    const { service } = setup();

    assert.match((await service.start(GUEST, { room: 'abc' })).text, /四位数字/);
    assert.match((await service.start(GUEST, { room: '9999' })).text, /没找到房间9999/);

    await service.start(HOST, { mode: 'pvp' });
    const code = findRoom(service, HOST);
    await service.start(GUEST, { room: code });
    assert.match((await service.start(OTHER, { room: code })).text, /满员/);
  });

  it('房主自己加入自己的房间只提示等待', async () => {
    const { service } = setup();
    await service.start(HOST, { mode: 'pvp' });
    const code = findRoom(service, HOST);

    assert.match((await service.start(HOST, { room: code })).text, /还等着对手加入/);
    assert.equal(findRoom(service, HOST), code);
  });

  it('房间没等到人时出招与查战况都只提示等待', async () => {
    const { service } = setup();
    await service.start(HOST, { mode: 'pvp' });

    const acted = await service.say(HOST, '普攻');
    assert.match(acted.text, /还等着对手加入/);
    assert.equal(acted.battle?.history.length, 0);

    const status = service.status(HOST);
    assert.match(status.text, /还等着对手加入/);
    assert.match(status.text, /生命值/);
    assert.equal(service.status(GUEST).battle, null);
  });

  it('双人出招认不出或没轮到时都被挡回', async () => {
    const { service } = setup();
    await service.start(HOST, { mode: 'pvp' });
    const code = findRoom(service, HOST);
    await service.start(GUEST, { room: code });

    assert.match((await service.say(HOST, '跳个舞')).text, /没听清/);
    assert.match((await service.say(GUEST, '普攻')).text, /还没轮到你/);
    assert.match(service.status(GUEST).text, /第1轮/);
  });

  it('房间超时后双方都回到无对局状态', async () => {
    const { service, advance, rooms } = setup();
    await service.start(HOST, { mode: 'pvp' });
    findRoom(service, HOST);

    advance(60_001);
    assert.match(service.status(HOST).text, /没有进行中的对局/);
    assert.match(service.status(GUEST).text, /没有进行中的对局/);
    assert.equal(rooms.size, 0);
  });

  it('房间还在但基准对局丢了：战况、出招、加入都会提示房间失效', async () => {
    const { service, store, rooms } = setup();

    await service.start(HOST, { mode: 'pvp' });
    const first = findRoom(service, HOST);
    store.delete(`pvp:${first}`);
    assert.match(service.status(HOST).text, /没找到房间/);
    assert.equal(rooms.size, 0);

    await service.start(HOST, { mode: 'pvp' });
    const second = findRoom(service, HOST);
    store.delete(`pvp:${second}`);
    assert.match((await service.say(HOST, '普攻')).text, /没找到房间/);
    assert.equal(rooms.size, 0);

    await service.start(HOST, { mode: 'pvp' });
    const third = findRoom(service, HOST);
    store.delete(`pvp:${third}`);
    assert.match((await service.start(GUEST, { room: third })).text, /没找到房间/);
    assert.equal(rooms.size, 0);
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
    const ctx = {
      deviceId: 'device-a',
      agentId: 'agent-1',
      sessionId: 's-1',
      display: 'voice' as const,
      anonymousId: 'anon-1',
    };
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

describe('载体形态下的补账播报', () => {
  it('有屏客户端不念补账，语音终端照旧补上', async () => {
    const { service } = setup();
    const hostCtx: DeviceContext = {
      deviceId: 'device-a',
      agentId: 'agent-1',
      sessionId: 's-host',
      display: 'screen',
      anonymousId: 'a',
    };
    const guestCtx: DeviceContext = {
      deviceId: 'device-b',
      agentId: 'agent-2',
      sessionId: 's-guest',
      display: 'voice',
      anonymousId: 'b',
    };
    const host = toolset(service, hostCtx);
    const guest = toolset(service, guestCtx);

    const opened = await host('game_say', { text: '开房间' });
    const code = /房间(\d{4})/.exec(opened)?.[1]!;
    await guest('game_say', { text: `加入房间${code}` });

    // 房主出招、访客应招：欠房主一条补账
    await host('game_say', { text: '强攻' });
    await guest('game_say', { text: '格挡' });
    const hostStatus = await host('game_say', { text: '战况如何' });
    assert.doesNotMatch(hostStatus, /刚才那一手/);
    assert.match(hostStatus, /第1轮/);

    // 访客攻击、房主应招：欠访客的那条，语音终端必须补
    await guest('game_say', { text: '强攻' });
    await host('game_say', { text: '格挡' });
    const guestStatus = await guest('game_say', { text: '战况如何' });
    assert.match(guestStatus, /^刚才那一手。/);
  });
});

describe('双人联机的意图模型兜底', () => {
  it('轮到自己时用模型补应对；等对手时完全不调用模型', async () => {
    const calls: string[] = [];
    const intent: IntentResolver = {
      async resolve(text) {
        calls.push(text);
        return 'guard';
      },
    };
    const { service } = setup({ intent });
    await service.start(HOST, { mode: 'pvp' });
    const code = findRoom(service, HOST);
    await service.start(GUEST, { room: code });

    // 房主先出招，随后轮到对手应对；房主此时再说话不该惊动模型
    await service.say(HOST, '普攻');
    const hostAgain = await service.say(HOST, '我稳如泰山');
    assert.match(hostAgain.text, /已经出手/);
    assert.deepEqual(calls, []);

    const guestBlock = await service.say(GUEST, '我稳如泰山');
    assert.match(guestBlock.text, /格挡/);
    assert.deepEqual(calls, ['我稳如泰山']);
  });
});

describe('双人回合不能被自己顶掉', () => {
  it('房主出手后自己再按防守，会被拒绝并继续等对手', async () => {
    const { service } = setup();
    await service.start(HOST, { mode: 'pvp' });
    const code = findRoom(service, HOST);
    await service.start(GUEST, { room: code });

    // 房间随机先手，先找到轮到的一方
    const first = (await service.status(HOST)).battle?.active === 'player' ? HOST : GUEST;
    const second = first === HOST ? GUEST : HOST;

    const attack = await service.say(first, '强攻');
    assert.match(attack.text, /等对手应对/);
    const selfGuard = await service.say(first, '格挡');
    assert.match(selfGuard.text, /等对手应对/);
    assert.equal(selfGuard.battle?.pending?.actor, 'player');

    const defend = await service.say(second, '格挡');
    assert.match(defend.text, /格挡/);
    assert.equal(defend.battle?.pending, null);
  });
});

describe('语音原话兜底开房与加入', () => {
  it('没有对局时直接说「开个房间」也能开房', async () => {
    const { service } = setup();
    const result = await service.say(HOST, '开个房间');
    assert.match(result.text, /房间\d{4}已开好/);
    assert.equal(result.battle?.mode, 'pvp');
  });

  it('把「加入房间1234」原话传进 action 也能加入', async () => {
    const { service } = setup();
    await service.start(HOST, { mode: 'pvp' });
    const code = findRoom(service, HOST);
    const joined = await service.say(GUEST, `加入房间${code}`);
    assert.match(joined.text, /你进了房间/);
    assert.equal(joined.battle?.mode, 'pvp');
    assert.equal(joined.battle?.player.id, 'player');
  });

  it('game_start 把原话放在 text 里也能识别联机', async () => {
    const { service } = setup();
    const result = await service.start(HOST, { text: '咱们联机打一把' });
    assert.match(result.text, /房间\d{4}已开好/);
    assert.equal(result.battle?.mode, 'pvp');
  });

  it('普通开局仍走单人，不误判联机', async () => {
    const { service } = setup();
    const result = await service.start(HOST, { text: '开始游戏' });
    assert.equal(result.battle?.mode, 'solo');
  });
});

describe('结算事件镜像', () => {
  it('换视角只翻「谁做的」，伤害与损失生命值按原样', () => {
    const events: BattleEvent[] = [
      { type: 'round-start', round: 3, bonus: 4 },
      {
        type: 'attack',
        round: 3,
        side: 'enemy',
        move: 'heavy',
        response: 'guard',
        dodged: false,
        crit: true,
        guarded: true,
        forced: false,
        damage: 5,
        targetHp: 13,
      },
      { type: 'end', round: 3, winner: 'enemy' },
    ];

    assert.deepEqual(mirrorEvents(events), [
      { type: 'round-start', round: 3, bonus: 4 },
      {
        type: 'attack',
        round: 3,
        side: 'player',
        move: 'heavy',
        response: 'guard',
        dodged: false,
        crit: true,
        guarded: true,
        forced: false,
        damage: 5,
        targetHp: 13,
      },
      { type: 'end', round: 3, winner: 'player' },
    ]);
  });
});

describe('房间与席位的边界', () => {
  it('已经在房间里的玩家能凭语音换房，旧房与那局一起撤掉', async () => {
    const { service, rooms, store } = setup();
    await service.start(HOST, { mode: 'pvp' });
    const oldCode = findRoom(service, HOST);
    await service.start(GUEST, { room: oldCode });

    await service.start(OTHER, { mode: 'pvp' });
    const newCode = findRoom(service, OTHER);
    assert.notEqual(newCode, oldCode);

    // 访客已经在房间里了：这句话原先会被当成「没听清这一手」，人还留在原地
    const moved = await service.say(GUEST, `加入房间${newCode}`);
    assert.match(moved.text, /房间/);
    assert.equal(moved.battle?.mode, 'pvp');
    assert.equal(rooms.byPlayer(GUEST)?.code, newCode);

    // 旧房、旧局一起撤掉：房主不会对着作废的局面继续等响应
    assert.equal(rooms.get(oldCode), undefined);
    assert.equal(store.get(pvpBattleKey(oldCode)), undefined);
    assert.equal(rooms.byPlayer(HOST), undefined);
    const hostAct = await service.say(HOST, '普攻');
    assert.equal(hostAct.battle?.mode, 'solo');
  });

  it('房主自己换到别的房间，旧房与旧局一起撤掉', async () => {
    const { service, rooms, store } = setup();
    await service.start(HOST, { mode: 'pvp' });
    const oldCode = findRoom(service, HOST);
    await service.start(GUEST, { room: oldCode });

    await service.start(OTHER, { mode: 'pvp' });
    const newCode = findRoom(service, OTHER);

    // 房主离开自己的房间：旧房作废，原加入者也不再被记在那间房里
    const moved = await service.say(HOST, `加入房间${newCode}`);
    assert.match(moved.text, /房间/);
    assert.equal(rooms.byPlayer(HOST)?.code, newCode);
    assert.equal(rooms.get(oldCode), undefined);
    assert.equal(store.get(pvpBattleKey(oldCode)), undefined);
    assert.equal(rooms.byPlayer(GUEST), undefined);

    // 原加入者再开口时已经不在房间里，会按单人局重新起一局
    const stranded = await service.say(GUEST, '普攻');
    assert.equal(stranded.battle?.mode, 'solo');
  });

  it('换房失败时原来的房间与对局一点不动', async () => {
    const { service, rooms, store } = setup();
    await service.start(HOST, { mode: 'pvp' });
    const code = findRoom(service, HOST);
    await service.start(GUEST, { room: code });
    const battleBefore = store.get(pvpBattleKey(code));
    assert.ok(battleBefore);

    // 房间号不存在
    const missing = await service.say(GUEST, '加入房间9999');
    assert.match(missing.text, /没找到房间9999/);
    assert.equal(rooms.byPlayer(GUEST)?.code, code);
    assert.equal(store.get(pvpBattleKey(code)), battleBefore);

    // 目标房已经满员
    await service.start(OTHER, { mode: 'pvp' });
    const otherCode = findRoom(service, OTHER);
    const fourth = 'device-d#agent-4';
    await service.start(fourth, { room: otherCode });
    const full = await service.say(GUEST, `加入房间${otherCode}`);
    assert.match(full.text, /已经满员/);
    assert.equal(rooms.byPlayer(GUEST)?.code, code);
    assert.equal(store.get(pvpBattleKey(code)), battleBefore);
  });

  it('双人房里问大招次数只播局面，不动对局', async () => {
    const { service, store } = setup();
    await service.start(HOST, { mode: 'pvp' });
    const code = findRoom(service, HOST);
    await service.start(GUEST, { room: code });

    const key = pvpBattleKey(code);
    const before = store.get(key);
    assert.ok(before);
    store.set(key, { ...before, player: { ...before.player, ap: 5 } });
    const armed = store.get(key);
    assert.ok(armed);

    const asked = await service.say(HOST, '我的大招还剩几次');
    assert.match(asked.text, /能量/);
    assert.equal(store.get(key), armed);
    assert.equal(armed.player.ap, 5);
    assert.equal(armed.player.ultLeft, 1);

    const negated = await service.say(GUEST, '不要闪避');
    assert.match(negated.text, /没打出去/);
    assert.equal(store.get(key), armed);
  });

  it('加入者带着上一局的补账换房，补账不能跟到新房里', async () => {
    const echo = new EchoStore({ ttlMs: 60_000 });
    const { service, rooms } = setup({ echo });
    await service.start(HOST, { mode: 'pvp' });
    const oldCode = findRoom(service, HOST);
    await service.start(GUEST, { room: oldCode });

    // 蓄力没有待响应，轮到加入者时给他留下一条「对手凝神蓄力」的补账
    await service.say(HOST, '蓄力');
    assert.equal(echo.size, 1);

    await service.start(OTHER, { mode: 'pvp' });
    const newCode = findRoom(service, OTHER);
    const moved = await service.say(GUEST, `加入房间${newCode}`);
    assert.equal(rooms.byPlayer(GUEST)?.code, newCode);
    assert.match(moved.text, /房间/);
    // 换房时旧房的补账要跟着清掉，不能把上一局的结算念到新房对手身上
    assert.equal(echo.size, 0);
    const later = await service.say(GUEST, '战况如何');
    assert.doesNotMatch(later.text, /刚才那一手/);
  });

  it('房主拿自己的房间号不会把自己登记成加入者', async () => {
    const { service, rooms } = setup();
    await service.start(HOST, { mode: 'pvp' });
    const code = findRoom(service, HOST);

    const again = await service.say(HOST, `加入房间${code}`);
    assert.match(again.text, /还等着对手加入/);
    const room = rooms.get(code);
    assert.ok(room);
    assert.equal(room.guestKey, null);
  });
});
