import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { GameService } from '../src/game/service.js';
import { mirrorEvents, normalizeRoomCode, pvpBattleKey } from '../src/game/pvp.js';
import { narrateRoomFull } from '../src/game/narrator.js';
import { battleKey, type DeviceContext } from '../src/mcp/context.js';
import { registerGameTools } from '../src/mcp/tools.js';
import type { CommandRouter } from '../src/game/router.js';
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
  registerGameTools(server, { service, logger: createLogger('error'), ctx, waitTimeoutMs: 30_000 });
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
  // 从编号已经写进对局键这件事反推不方便，直接遍历不可行；
  // 让服务返回文本里的编号最稳。
  const text = service.status(host).text;
  const match = text.match(/编号(\d{4})/);
  assert.ok(match, `战况里应带编号：${text}`);
  return match[1]!;
}

describe('双人联机', () => {
  it('发起挑战拿到四位编号，并提示对手怎么接受', async () => {
    const { service, rooms } = setup();
    const result = await service.start(HOST, { mode: 'pvp' });

    assert.equal(result.battle?.mode, 'pvp');
    assert.match(result.text, /编号\d{4}/);
    assert.match(result.text, /接受挑战，编号\d{4}/);
    // 对手还没接受，不能提前播「对决开始」
    assert.doesNotMatch(result.text, /对决开始/);
    assert.equal(rooms.size, 1);
    assert.ok(rooms.byPlayer(HOST));
  });

  it('重复发起挑战时复用同一个编号', async () => {
    const { service } = setup();
    const first = await service.start(HOST, { mode: 'pvp' });
    const code = findRoom(service, HOST);
    const second = await service.start(HOST, { mode: 'pvp' });
    assert.match(second.text, new RegExp(`编号${code}`));
    assert.equal(first.battle?.id, second.battle?.id);
  });

  it('第二位玩家凭编号接受挑战，看到镜像视角的同一局', async () => {
    const { service } = setup();
    await service.start(HOST, { mode: 'pvp' });
    const code = findRoom(service, HOST);

    const joined = await service.start(GUEST, { room: code });
    assert.match(joined.text, /接下了编号/);
    assert.match(joined.text, /对决开始/);
    assert.equal(joined.battle?.player.name, '你');
    assert.equal(joined.battle?.enemy.name, '对手');
    assert.equal(joined.battle?.history.length, 0);
    assert.equal(joined.battle?.player.hp, 18);
    assert.equal(joined.battle?.enemy.hp, 14);
    // 换视角后对手没有名字，播报里不能出现「你的对手是对手」
    assert.doesNotMatch(joined.text, /你的对手是对手/);
  });

  it('语音发起挑战、语音接受挑战就能进同一局', async () => {
    const { service, rooms } = setup();
    const opened = await service.say(HOST, '共鸣对决，发起挑战');
    assert.match(opened.text, /挑战已发起，编号\d{4}/);
    const code = /编号(\d{4})/.exec(opened.text)?.[1];
    assert.ok(code, `应播报四位编号：${opened.text}`);

    const joined = await service.say(GUEST, `接受挑战，编号${code}`);
    assert.match(joined.text, new RegExp(`我接下了编号${code}的挑战`));
    assert.match(joined.text, /对决开始/);
    assert.equal(joined.battle?.mode, 'pvp');
    assert.equal(joined.battle?.player.id, 'player');
    assert.equal(rooms.size, 1);
  });

  it('旧口令「开房间」「加入房间XXXX」仍能走通', async () => {
    const { service } = setup();
    const opened = await service.say(HOST, '开房间');
    const code = /编号(\d{4})/.exec(opened.text)?.[1];
    assert.ok(code, `旧口令也应发起挑战：${opened.text}`);

    const joined = await service.say(GUEST, `加入房间${code}`);
    assert.match(joined.text, new RegExp(`接下了编号${code}`));
    assert.equal(joined.battle?.mode, 'pvp');
  });

  it('发起方出招、对手应对，双方共享同一份结算', async () => {
    const { service } = setup();
    await service.start(HOST, { mode: 'pvp' });
    const code = findRoom(service, HOST);
    await service.start(GUEST, { room: code });

    const first = await service.say(HOST, '普攻');
    assert.deepEqual(first.battle?.pending, { actor: 'player', move: 'light', damage: 3 });
    assert.equal(first.battle?.enemy.hp, 18);
    assert.match(first.text, /接招/);

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
    assert.match(hostStatus.text, /这局输了/);

    const guestStatus = service.status(GUEST);
    assert.equal(guestStatus.battle?.phase, 'victory');
    assert.match(guestStatus.text, /我赢了/);
  });

  it('发起方没等到人时出招只提示等对手', async () => {
    const { service } = setup();
    await service.start(HOST, { mode: 'pvp' });

    const result = await service.say(HOST, '普攻');
    assert.equal(result.battle?.history.length, 0);
    assert.match(result.text, /还等着对方接受/);
  });

  it('编号已被接受与编号不存在都有明确播报', async () => {
    const { service } = setup();
    await service.start(HOST, { mode: 'pvp' });
    const code = findRoom(service, HOST);
    await service.start(GUEST, { room: code });

    const full = await service.start(OTHER, { room: code });
    assert.match(full.text, /已经被接受了/);

    const missing = await service.start(OTHER, { room: '0000' });
    assert.match(missing.text, /没找到编号0000的挑战/);
  });

  it('编号容忍中文数字，格式不对时提示四位数字', async () => {
    assert.equal(normalizeRoomCode('一二三四'), '1234');
    assert.equal(normalizeRoomCode('四三二一'), '4321');
    assert.equal(normalizeRoomCode('房间 1234'), '1234');
    assert.equal(normalizeRoomCode('123'), null);
    assert.equal(normalizeRoomCode('12345'), null);

    const { service } = setup();
    const result = await service.start(GUEST, { room: '12' });
    assert.match(result.text, /四位数字/);
  });

  it('发起方发起挑战后重开：等人时复用编号，已开局则换新挑战', async () => {
    const { service, rooms, store } = setup();
    await service.start(HOST, { mode: 'pvp' });
    const firstCode = findRoom(service, HOST);
    const firstBattleId = store.get(`pvp:${firstCode}`)!.id;

    await service.start(HOST, { mode: 'pvp' });
    assert.equal(findRoom(service, HOST), firstCode);
    assert.equal(store.get(`pvp:${firstCode}`)!.id, firstBattleId);

    await service.start(GUEST, { room: firstCode });
    await service.start(HOST, { mode: 'pvp' });
    // 已开局后重开：旧房撤掉、新局重开（编号可能复用，不能按码判断）
    const newCode = findRoom(service, HOST);
    assert.notEqual(store.get(`pvp:${newCode}`)!.id, firstBattleId);
    assert.equal(rooms.size, 1);
  });

  it('挑战过期后回到普通对局流程', async () => {
    const { service, advance } = setup();
    await service.start(HOST, { mode: 'pvp' });
    advance(61_000);

    const status = service.status(HOST);
    assert.equal(status.battle, null);
    assert.match(status.text, /没有进行中的对局/);
    assert.match((await service.start(GUEST, { room: '1000' })).text, /没找到/);
  });

  it('编号格式不对、编号不存在与已被接受分别提示', async () => {
    const { service } = setup();

    assert.match((await service.start(GUEST, { room: 'abc' })).text, /四位数字/);
    assert.match((await service.start(GUEST, { room: '9999' })).text, /没找到编号9999的挑战/);

    await service.start(HOST, { mode: 'pvp' });
    const code = findRoom(service, HOST);
    await service.start(GUEST, { room: code });
    assert.match((await service.start(OTHER, { room: code })).text, /已经被接受了/);
  });

  it('发起方自己接受自己的编号只提示等待', async () => {
    const { service } = setup();
    await service.start(HOST, { mode: 'pvp' });
    const code = findRoom(service, HOST);

    assert.match((await service.start(HOST, { room: code })).text, /还等着对方接受/);
    assert.equal(findRoom(service, HOST), code);
  });

  it('挑战没等到人时出招与查战况都只提示等待', async () => {
    const { service } = setup();
    await service.start(HOST, { mode: 'pvp' });

    const acted = await service.say(HOST, '普攻');
    assert.match(acted.text, /还等着对方接受/);
    assert.equal(acted.battle?.history.length, 0);

    const status = service.status(HOST);
    assert.match(status.text, /还等着对方接受/);
    assert.match(status.text, /生命值/);
    assert.equal(service.status(GUEST).battle, null);
  });

  it('双人出招认不出或没轮到时都被挡回', async () => {
    const { service } = setup();
    await service.start(HOST, { mode: 'pvp' });
    const code = findRoom(service, HOST);
    await service.start(GUEST, { room: code });

    assert.match((await service.say(HOST, '跳个舞')).text, /没听清/);
    assert.match((await service.say(GUEST, '普攻')).text, /还没轮到我出招/);
    assert.match(service.status(GUEST).text, /第1轮/);
  });

  it('挑战超时后双方都回到无对局状态', async () => {
    const { service, advance, rooms } = setup();
    await service.start(HOST, { mode: 'pvp' });
    findRoom(service, HOST);

    advance(60_001);
    assert.match(service.status(HOST).text, /没有进行中的对局/);
    assert.match(service.status(GUEST).text, /没有进行中的对局/);
    assert.equal(rooms.size, 0);
  });

  it('挑战还在但基准对局丢了：战况、出招、接受都会提示挑战失效', async () => {
    const { service, store, rooms } = setup();

    await service.start(HOST, { mode: 'pvp' });
    const first = findRoom(service, HOST);
    store.delete(`pvp:${first}`);
    assert.match(service.status(HOST).text, /没找到编号/);
    assert.equal(rooms.size, 0);

    await service.start(HOST, { mode: 'pvp' });
    const second = findRoom(service, HOST);
    store.delete(`pvp:${second}`);
    assert.match((await service.say(HOST, '普攻')).text, /没找到编号/);
    assert.equal(rooms.size, 0);

    await service.start(HOST, { mode: 'pvp' });
    const third = findRoom(service, HOST);
    store.delete(`pvp:${third}`);
    assert.match((await service.start(GUEST, { room: third })).text, /没找到编号/);
    assert.equal(rooms.size, 0);
  });

  it('MCP 工具层能发起与接受挑战', async () => {
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
      speakerName: '',
      speakerId: '',
      anonymousId: 'anon-1',
    };
    registerGameTools(server, { service, logger: createLogger('error'), ctx, waitTimeoutMs: 30_000 });

    const start = handlers.get('game_start')!;
    const opened = await start({ mode: 'pvp' });
    const text = opened.content[0]!.text;
    assert.match(text, /编号\d{4}/);

    // 换一个设备身份接受，避免发起者自己进自己的挑战
    ctx.deviceId = 'device-b';
    ctx.agentId = 'agent-2';
    const joined = await handlers.get('game_start')!({ room: findRoom(service, HOST) });
    assert.match(joined.content[0]!.text, /接下了编号/);
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
      speakerName: '',
      speakerId: '',
      anonymousId: 'a',
    };
    const guestCtx: DeviceContext = {
      deviceId: 'device-b',
      agentId: 'agent-2',
      sessionId: 's-guest',
      display: 'voice',
      speakerName: '',
      speakerId: '',
      anonymousId: 'b',
    };
    const host = toolset(service, hostCtx);
    const guest = toolset(service, guestCtx);

    const opened = await host('game_say', { text: '共鸣对决，发起挑战' });
    const code = /编号(\d{4})/.exec(opened)?.[1]!;
    await guest('game_say', { text: `接受挑战，编号${code}` });

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

describe('双人联机的模型路由兜底', () => {
  it('轮到自己时用模型补应对；等对手时模型只给查询类选项', async () => {
    const calls: { text: string; stage: string }[] = [];
    const router: CommandRouter = {
      async resolve(text, stage) {
        calls.push({ text, stage });
        return stage === 'response' ? { kind: 'turn', action: 'guard' } : null;
      },
    };
    const { service } = setup({ router });
    await service.start(HOST, { mode: 'pvp' });
    const code = findRoom(service, HOST);
    await service.start(GUEST, { room: code });

    // 发起方先出招，随后轮到对手应对；发起方此时再说话只会拿到查询类选项
    await service.say(HOST, '普攻');
    const hostAgain = await service.say(HOST, '我稳如泰山');
    // 双人房里这句多半是对方设备的原话：只回最短事实，避免长提示再被收一遍
    assert.equal(hostAgain.text, '这一手等对手应对。');
    assert.deepEqual(calls, [{ text: '我稳如泰山', stage: 'waiting' }]);

    const guestBlock = await service.say(GUEST, '我稳如泰山');
    assert.match(guestBlock.text, /格挡/);
    assert.deepEqual(calls, [
      { text: '我稳如泰山', stage: 'waiting' },
      { text: '我稳如泰山', stage: 'response' },
    ]);
  });
});

describe('双人回合不能被自己顶掉', () => {
  it('发起方出手后自己再按防守，会被拒绝并继续等对手', async () => {
    const { service } = setup();
    await service.start(HOST, { mode: 'pvp' });
    const code = findRoom(service, HOST);
    await service.start(GUEST, { room: code });

    // 挑战随机先手，先找到轮到的一方
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

describe('语音原话兜底发起与接受挑战', () => {
  it('没有对局时直接说「共鸣对决，发起挑战」也能发起', async () => {
    const { service } = setup();
    const result = await service.say(HOST, '共鸣对决，发起挑战');
    assert.match(result.text, /挑战已发起，编号\d{4}/);
    assert.equal(result.battle?.mode, 'pvp');
  });

  it('把「接受挑战，编号1234」原话传进 action 也能接受', async () => {
    const { service } = setup();
    await service.start(HOST, { mode: 'pvp' });
    const code = findRoom(service, HOST);
    const joined = await service.say(GUEST, `接受挑战，编号${code}`);
    assert.match(joined.text, /我接下了编号/);
    assert.equal(joined.battle?.mode, 'pvp');
    assert.equal(joined.battle?.player.id, 'player');
  });

  it('game_start 把原话放在 text 里也能识别联机', async () => {
    const { service } = setup();
    const result = await service.start(HOST, { text: '咱们联机打一把' });
    assert.match(result.text, /挑战已发起，编号\d{4}/);
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

describe('挑战与席位的边界', () => {
  it('已经在挑战里的玩家能凭语音换挑战，旧挑战与那局一起撤掉', async () => {
    const { service, rooms, store } = setup();
    await service.start(HOST, { mode: 'pvp' });
    const oldCode = findRoom(service, HOST);
    await service.start(GUEST, { room: oldCode });

    await service.start(OTHER, { mode: 'pvp' });
    const newCode = findRoom(service, OTHER);
    assert.notEqual(newCode, oldCode);

    // 访客已经在房间里了：这句话原先会被当成「没听清这一手」，人还留在原地
    const moved = await service.say(GUEST, `接受挑战，编号${newCode}`);
    assert.match(moved.text, /挑战/);
    assert.equal(moved.battle?.mode, 'pvp');
    assert.equal(rooms.byPlayer(GUEST)?.code, newCode);

    // 旧房、旧局一起撤掉：房主不会对着作废的局面继续等响应
    assert.equal(rooms.get(oldCode), undefined);
    assert.equal(store.get(pvpBattleKey(oldCode)), undefined);
    assert.equal(rooms.byPlayer(HOST), undefined);
    const hostAct = await service.say(HOST, '普攻');
    assert.equal(hostAct.battle?.mode, 'solo');
  });

  it('发起方自己换到别的挑战，旧挑战与旧局一起撤掉', async () => {
    const { service, rooms, store } = setup();
    await service.start(HOST, { mode: 'pvp' });
    const oldCode = findRoom(service, HOST);
    await service.start(GUEST, { room: oldCode });

    await service.start(OTHER, { mode: 'pvp' });
    const newCode = findRoom(service, OTHER);

    // 发起方离开自己的挑战：旧挑战作废，原接受方也不再被记在那间挑战里
    const moved = await service.say(HOST, `接受挑战，编号${newCode}`);
    assert.match(moved.text, /挑战/);
    assert.equal(rooms.byPlayer(HOST)?.code, newCode);
    assert.equal(rooms.get(oldCode), undefined);
    assert.equal(store.get(pvpBattleKey(oldCode)), undefined);
    assert.equal(rooms.byPlayer(GUEST), undefined);

    // 原接受方再开口时已经不在挑战里，会按单人局重新起一局
    const stranded = await service.say(GUEST, '普攻');
    assert.equal(stranded.battle?.mode, 'solo');
  });

  it('换挑战失败时原来的挑战与对局一点不动', async () => {
    const { service, rooms, store } = setup();
    await service.start(HOST, { mode: 'pvp' });
    const code = findRoom(service, HOST);
    await service.start(GUEST, { room: code });
    const battleBefore = store.get(pvpBattleKey(code));
    assert.ok(battleBefore);

    // 编号不存在
    const missing = await service.say(GUEST, '接受挑战，编号9999');
    assert.match(missing.text, /没找到编号9999的挑战/);
    assert.equal(rooms.byPlayer(GUEST)?.code, code);
    assert.equal(store.get(pvpBattleKey(code)), battleBefore);

    // 目标房已经满员
    await service.start(OTHER, { mode: 'pvp' });
    const otherCode = findRoom(service, OTHER);
    const fourth = 'device-d#agent-4';
    await service.start(fourth, { room: otherCode });
    const full = await service.say(GUEST, `接受挑战，编号${otherCode}`);
    assert.match(full.text, /已经被接受了/);
    assert.equal(rooms.byPlayer(GUEST)?.code, code);
    assert.equal(store.get(pvpBattleKey(code)), battleBefore);
  });

  it('双人挑战里问大招次数只播局面，不动对局', async () => {
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

  it('接受方带着上一局的补账换挑战，补账不能跟到新挑战里', async () => {
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
    const moved = await service.say(GUEST, `接受挑战，编号${newCode}`);
    assert.equal(rooms.byPlayer(GUEST)?.code, newCode);
    assert.match(moved.text, /挑战/);
    // 换挑战时旧挑战的补账要跟着清掉，不能把上一局的结算念到新挑战对手身上
    assert.equal(echo.size, 0);
    const later = await service.say(GUEST, '战况如何');
    assert.doesNotMatch(later.text, /刚才那一手/);
  });

  it('发起方拿自己的编号不会把自己登记成接受方', async () => {
    const { service, rooms } = setup();
    await service.start(HOST, { mode: 'pvp' });
    const code = findRoom(service, HOST);

    const again = await service.say(HOST, `接受挑战，编号${code}`);
    assert.match(again.text, /还等着对方接受/);
    const room = rooms.get(code);
    assert.ok(room);
    assert.equal(room.guestKey, null);
  });

  it('房间满提示分段回灌与明确否定都不动现有挑战，补账照常送达', async () => {
    const echo = new EchoStore({ ttlMs: 60_000 });
    const { service, rooms, store } = setup({ echo });
    await service.start(HOST, { mode: 'pvp' });
    const code = findRoom(service, HOST);
    await service.start(GUEST, { room: code });

    // 先打一手完整结算，给房主留一条补账：挑战若被撤掉，这条也一起没了
    await service.say(HOST, '普攻');
    assert.match((await service.say(GUEST, '格挡')).text, /我格挡/);
    const key = pvpBattleKey(code);
    const battleBefore = store.get(key);
    assert.ok(battleBefore);
    assert.equal(echo.size, 1);

    // 装置的缓存里还留着房间满提示，按逗号切碎后逐段当「玩家原话」回灌
    const parts = narrateRoomFull(code)
      .split(/[，,。！？]/)
      .map((part) => part.trim())
      .filter((part) => part.length > 0);
    assert.ok(parts.length >= 2, `房间满提示应能分段：${narrateRoomFull(code)}`);
    for (const part of parts) {
      const echoed = await service.say(HOST, part);
      assert.equal(echoed.battle?.id, battleBefore.id, `${part} 撤掉了当前对局`);
    }
    // 归属、对局与补账一点没动：没有换房，也没有把对手那间房撤掉
    assert.equal(rooms.byPlayer(HOST)?.code, code);
    assert.equal(rooms.byPlayer(GUEST)?.code, code);
    assert.equal(store.get(key), battleBefore);
    assert.equal(echo.size, 1);

    // 明确否定照旧收手，但攒着的结算要在这句里补给他
    const negated = await service.say(HOST, '不要发起挑战');
    assert.match(negated.text, /刚才那一手/);
    assert.match(negated.text, /没打出去/);
    assert.equal(store.get(key), battleBefore);
    assert.equal(rooms.byPlayer(GUEST)?.code, code);
    assert.equal(echo.size, 0);

    // 带编号的否定同样不能真去换房
    const declined = await service.say(HOST, `不要接受挑战，编号${code}`);
    assert.match(declined.text, /没打出去/);
    assert.equal(rooms.byPlayer(HOST)?.code, code);
    assert.equal(store.get(key), battleBefore);

    // 否定词表认不出的挑战说法也要收住：修复前这两句会真去换房 / 真重开双人房
    for (const text of [`不接受挑战，编号${code}`, '别发起挑战']) {
      const refused = await service.say(HOST, text);
      assert.match(refused.text, /没打出去/, `${text} 没有收住：${refused.text}`);
      assert.equal(rooms.byPlayer(HOST)?.code, code, `${text} 把房主换到了别的房间`);
      assert.equal(rooms.byPlayer(GUEST)?.code, code, `${text} 把对手移出了房间`);
      assert.equal(store.get(key), battleBefore, `${text} 撤掉了当前对局`);
      assert.equal(refused.battle?.id, battleBefore.id);
    }
  });
});
