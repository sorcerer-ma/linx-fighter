import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createBattle } from '../src/game/engine.js';
import type { Command } from '../src/game/command.js';
import type { CommandRouter, RouterStage } from '../src/game/router.js';
import { pvpBattleKey } from '../src/game/pvp.js';
import { narrateEnded, narrateNoBattle, narrateWaitRespond, narrateWaitTimeout, narrateWaitTurn } from '../src/game/narrator.js';
import { GameService, type GameServiceDeps } from '../src/game/service.js';
import type { BattleAI } from '../src/game/types.js';
import { createLogger } from '../src/log.js';
import { BattleStore } from '../src/store/battles.js';
import { EchoStore } from '../src/store/echoes.js';
import { RoomStore } from '../src/store/rooms.js';

const KEY = 'device-a#agent-1';

function setup(overrides: Partial<GameServiceDeps> = {}) {
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

describe('游戏服务', () => {
  it('开局生成对局与初始属性', async () => {
    const { service } = setup();
    const result = await service.start(KEY);

    assert.ok(result.battle);
    assert.equal(result.battle.round, 1);
    assert.equal(result.battle.phase, 'battle');
    assert.equal(result.battle.firstMover, 'player');
    assert.equal(result.battle.active, 'player');
    assert.equal(result.battle.player.hp, 14);
    assert.equal(result.battle.player.maxHp, 14);
    assert.equal(result.battle.player.ap, 3);
    assert.equal(result.battle.enemy.hp, 18);
    assert.equal(result.battle.enemy.name, '守擂教头');
    assert.deepEqual(result.battle.history, []);
    assert.match(result.text, /对决开始/);
    assert.match(result.text, /守擂教头/);
    assert.match(result.text, /我先手/);
  });

  it('开局可以指定对手名字', async () => {
    const { service } = setup();
    const result = await service.start(KEY, { opponent: '阿青' });
    assert.equal(result.battle?.enemy.name, '阿青');
    assert.match(result.text, /阿青/);
  });

  it('出招推进回合并记录战报，应对阶段再结算', async () => {
    const { service } = setup();
    await service.start(KEY);

    const first = await service.say(KEY, '普攻');
    assert.equal(first.battle?.round, 1);
    assert.equal(first.battle?.history.length, 1);
    assert.equal(first.battle?.history[0]?.actor, 'player');
    assert.equal(first.battle?.history[0]?.action, 'light');
    assert.deepEqual(first.battle?.pending, { actor: 'enemy', move: 'light', damage: 3 });
    assert.equal(first.battle?.player.ap, 2);
    assert.equal(first.battle?.enemy.hp, 17);
    assert.match(first.text, /我普攻，对手格挡，掉1点生命值，剩17/);
    assert.match(first.text, /对手普攻还没结算，我该格挡、闪避，还是承受/);

    const second = await service.say(KEY, '格挡');
    assert.equal(second.battle?.round, 2);
    assert.equal(second.battle?.pending, null);
    assert.equal(second.battle?.active, 'player');
    assert.equal(second.battle?.player.hp, 13);
    assert.equal(second.battle?.player.ap, 3);
    assert.equal(second.battle?.history.length, 2);
    assert.match(second.text, /格挡/);
  });

  it('招式认不出来时不改对局、只提示可选说法', async () => {
    const { service } = setup();
    await service.start(KEY);

    const result = await service.say(KEY, '跳舞');
    assert.equal(result.battle?.round, 1);
    assert.equal(result.battle?.history.length, 0);
    assert.match(result.text, /没听清/);
    assert.match(result.text, /普攻/);
  });

  it('没有对局时直接出招会自动开局', async () => {
    const { service } = setup();
    const result = await service.say(KEY, '我要攻击');

    assert.equal(result.battle?.round, 1);
    assert.equal(result.battle?.history.length, 1);
    assert.match(result.text, /先开一局/);
    assert.match(result.text, /普攻/);
  });

  it('不同设备的对局互不影响', async () => {
    const { service } = setup();
    await service.start(KEY);
    await service.say(KEY, '普攻');

    const other = service.status('device-b#agent-1');
    assert.equal(other.battle, null);
    assert.match(other.text, /没有进行中的对局/);

    const mine = service.status(KEY);
    assert.equal(mine.battle?.round, 1);
  });

  it('已结束的对局不再接受出招', async () => {
    const { service, store } = setup();
    const started = await service.start(KEY);
    store.set(KEY, { ...started.battle!, phase: 'victory' });

    const result = await service.say(KEY, '攻击');
    assert.equal(result.battle?.phase, 'victory');
    assert.equal(result.battle?.history.length, 0);
    assert.match(result.text, /我赢了/);
  });

  it('念唤出指令时先回念一句再播报回合', async () => {
    const { service } = setup();
    await service.start(KEY);

    const result = await service.say(KEY, '共鸣斩破军');
    assert.equal(result.battle?.history.length, 1);
    assert.match(result.text, /你朗声喝道：「共鸣斩破军」/);
    assert.match(result.text, /普攻/);
  });

  it('战败与未知状态都有对应播报', async () => {
    const { service, store } = setup();
    const battle = (await service.start(KEY)).battle!;

    store.set(KEY, { ...battle, phase: 'defeat' });
    assert.match((await service.say(KEY, '攻击')).text, /这局输了/);

    store.set(KEY, { ...battle, phase: 'unknown' as typeof battle.phase });
    assert.match((await service.say(KEY, '攻击')).text, /这一局已经结束/);
  });

  it('待应对阶段出主动招式会被挡回', async () => {
    const { service } = setup();
    await service.start(KEY);
    await service.say(KEY, '普攻');

    const result = await service.say(KEY, '攻击');
    assert.equal(result.battle?.round, 1);
    assert.deepEqual(result.battle?.pending, { actor: 'enemy', move: 'light', damage: 3 });
    assert.match(result.text, /格挡、闪避或承受/);
  });

  it('能量不足与能量已满都不会改对局', async () => {
    const { service, store } = setup();
    const battle = createBattle({ now: 1_000_000, seed: 0, firstMover: 'player' });

    store.set(KEY, { ...battle, player: { ...battle.player, ap: 1 } });
    const low = await service.say(KEY, '强攻');
    assert.equal(low.battle?.player.ap, 1);
    assert.equal(low.battle?.history.length, 0);
    assert.match(low.text, /我只有1点能量，强攻要2点/);

    store.set(KEY, { ...battle, player: { ...battle.player, ap: 5 } });
    const full = await service.say(KEY, '蓄力');
    assert.equal(full.battle?.player.ap, 5);
    assert.match(full.text, /已经满了/);
  });

  it('对手先手时开局先亮出它的招式', async () => {
    const { service } = setup({ random: () => 0.5 });
    const started = await service.start(KEY);

    assert.equal(started.battle?.firstMover, 'enemy');
    assert.deepEqual(started.battle?.pending, { actor: 'enemy', move: 'heavy', damage: 5 });
    assert.match(started.text, /对手先手/);
    assert.match(started.text, /强攻/);

    const responded = await service.say(KEY, '闪避');
    assert.equal(responded.battle?.pending, null);
    assert.equal(responded.battle?.active, 'player');
    // 首个主动阶段不恢复能量：3 - 1（闪避）= 2
    assert.equal(responded.battle?.player.ap, 2);
    assert.match(responded.text, /我躲开啦/);
  });

  it('玩法说明不需要对局', async () => {
    const { service } = setup();
    const result = service.help();
    assert.equal(result.battle, null);
    assert.match(result.text, /普攻/);
    assert.match(result.text, /开始游戏/);
  });
});

describe('模型路由兜底', () => {
  it('规则认不出时由模型补出主动招与应对招', async () => {
    const calls: { text: string; stage: RouterStage }[] = [];
    const router: CommandRouter = {
      async resolve(text, stage) {
        calls.push({ text, stage });
        return stage === 'active' ? { kind: 'turn', action: 'heavy' } : { kind: 'turn', action: 'guard' };
      },
    };
    const { service } = setup({ router });
    await service.start(KEY);

    const first = await service.say(KEY, '给我狠狠地来一下');
    assert.equal(first.battle?.history[0]?.action, 'heavy');
    assert.equal(first.battle?.pending?.actor, 'enemy');

    const second = await service.say(KEY, '稳住别慌');
    assert.equal(second.battle?.history[1]?.response, 'guard');
    assert.match(second.text, /格挡/);
    assert.deepEqual(calls, [
      { text: '给我狠狠地来一下', stage: 'active' },
      { text: '稳住别慌', stage: 'response' },
    ]);
  });

  it('模型异常或认不出时回退为没听清，不推进回合', async () => {
    const broken: CommandRouter = {
      async resolve() {
        throw new Error('upstream down');
      },
    };
    const { service } = setup({ router: broken });
    await service.start(KEY);

    const result = await service.say(KEY, '随便说一句');
    assert.match(result.text, /没听清/);
    assert.equal(result.battle?.round, 1);
    assert.equal(result.battle?.history.length, 0);

    const quiet: CommandRouter = { async resolve() { return null; } };
    const quietService = setup({ router: quiet }).service;
    quietService.start(KEY);
    assert.match((await quietService.say(KEY, '再来一句')).text, /没听清/);
  });

  it('没有对局时只给开局类选项，认不出也不会随便开局', async () => {
    const stages: RouterStage[] = [];
    const router: CommandRouter = {
      async resolve(_text, stage) {
        stages.push(stage);
        return null;
      },
    };
    const { service, store } = setup({ router });

    const result = await service.say(KEY, '今天天气不错');
    // 没有对局时进 none 阶段：菜单里没有招式，模型也给不出这一手
    assert.deepEqual(stages, ['none']);
    assert.match(result.text, /没听清/);
    assert.equal(result.battle, null);
    assert.equal(store.get(KEY), undefined);
  });
});

describe('统一入口与局面快照', () => {
  const KEY_B = 'device-b#agent-1';

  it('战况问句只播当前局面，不推进回合', async () => {
    const { service } = setup();
    await service.start(KEY);

    const result = await service.say(KEY, '战况如何');
    assert.equal(result.battle?.round, 1);
    assert.equal(result.battle?.history.length, 0);
    assert.match(result.text, /第1轮/);
  });

  it('问蓄力要几回合不会把能量真的蓄上', async () => {
    const { service, store } = setup();
    await service.start(KEY);
    const before = store.get(KEY);
    assert.ok(before);

    for (const text of ['回满能量要几回合', '补满能量要几回合', '回能量要几轮']) {
      const result = await service.say(KEY, text);
      assert.match(result.text, /第1轮/);
      assert.equal(store.get(KEY), before, `「${text}」不该改动对局`);
    }
    assert.equal(before.player.ap, 3);
    assert.equal(before.history.length, 0);
    assert.equal(before.pending, null);
  });

  it('玩法问句不需要对局', async () => {
    const { service } = setup();
    const result = await service.say(KEY, '怎么玩');
    assert.equal(result.battle, null);
    assert.match(result.text, /普攻/);
  });

  it('开局句真的开局，开房句真的开房', async () => {
    const { service, rooms } = setup();

    const solo = await service.say(KEY, '来一局');
    assert.equal(solo.battle?.mode, 'solo');
    assert.match(solo.text, /对决开始/);

    const pvp = await service.say(KEY, '开房间');
    const code = /房间(\d{4})/.exec(pvp.text)?.[1];
    assert.ok(code, `应播报四位房间号：${pvp.text}`);
    assert.equal(rooms.byPlayer(KEY)?.code, code);
  });

  it('招式照常结算，认不出的句子不推进', async () => {
    const { service } = setup();
    await service.start(KEY);

    // 「公鸡」是 ASR 对「攻击」的常见误识别，必须仍能出招
    const hit = await service.say(KEY, '公鸡');
    assert.equal(hit.battle?.history.length, 1);
    assert.match(hit.text, /普攻/);

    const miss = await service.say(KEY, '今天天气不错');
    assert.equal(miss.battle?.history.length, 1);
    assert.match(miss.text, /没听清/);
  });

  it('双人房里两位玩家的快照互为镜像', async () => {
    const { service } = setup();
    const opened = await service.say(KEY, '开房间');
    const code = /房间(\d{4})/.exec(opened.text)?.[1]!;
    // 对手还没进来：房主快照要告诉界面「等对手」，而不是「轮到你出招」
    assert.equal(service.snapshot(KEY)?.state.waiting, true);

    await service.say(KEY_B, `加入房间${code}`);

    const host = service.snapshot(KEY);
    assert.equal(host?.state.waiting, false, '对手进来后不再等待');
    const guest = service.snapshot(KEY_B);
    assert.equal(host?.room, code);
    assert.equal(guest?.room, code);
    assert.equal(host?.state.side, 'player');
    assert.equal(guest?.state.side, 'enemy');
    assert.equal(host?.state.you.hp, guest?.state.opponent.hp);
    assert.equal(host?.state.opponent.hp, guest?.state.you.hp);
    assert.equal(host?.state.firstMover === 'player', guest?.state.firstMover === 'enemy');
    // 取快照不改动对局
    assert.equal(host?.state.round, service.snapshot(KEY)?.state.round);
  });

  it('不在任何对局里时快照为 null', () => {
    const { service } = setup();
    assert.equal(service.snapshot(KEY), null);
  });
});

describe('双人补账播报', () => {
  const KEY_B = 'device-b#agent-1';

  it('对手应完的那一手，等出手方下次开口补上，且只补一次', async () => {
    const { service } = setup();
    const opened = await service.say(KEY, '开房间');
    const code = /房间(\d{4})/.exec(opened.text)?.[1]!;
    await service.say(KEY_B, `加入房间${code}`);

    const attack = await service.say(KEY, '强攻');
    assert.match(attack.text, /接招/);

    // 对手应招时出手方不在场：这一声只念给应对方
    const response = await service.say(KEY_B, '格挡');
    assert.match(response.text, /格挡/);
    assert.doesNotMatch(response.text, /刚才那一手/);

    const catchUp = await service.say(KEY, '战况如何');
    assert.match(catchUp.text, /^刚才那一手。/);
    assert.match(catchUp.text, /我强攻，对手格挡，掉3点生命值，剩15/);
    assert.match(catchUp.text, /第1轮/);

    // 补过一次就不再重复
    const again = await service.say(KEY, '战况如何');
    assert.doesNotMatch(again.text, /刚才那一手/);
  });

  it('对手蓄力也补在他自己的下一句话里', async () => {
    const { service } = setup();
    const opened = await service.say(KEY, '开房间');
    const code = /房间(\d{4})/.exec(opened.text)?.[1]!;
    await service.say(KEY_B, `加入房间${code}`);

    await service.say(KEY, '蓄力');
    const guestTurn = await service.say(KEY_B, '普攻');
    assert.match(guestTurn.text, /^刚才那一手。对手凝神蓄力，能量涨到4。/);
    assert.match(guestTurn.text, /我出普攻，接招！等对手应对/);
  });

  it('换局后不把上一局的结果补到新对局里', async () => {
    const { service } = setup();
    const opened = await service.say(KEY, '开房间');
    const code = /房间(\d{4})/.exec(opened.text)?.[1]!;
    await service.say(KEY_B, `加入房间${code}`);
    await service.say(KEY, '强攻');
    await service.say(KEY_B, '格挡');

    // 房主改开单人局：房间被撤，欠着的那一条也要跟着清掉
    const restarted = await service.say(KEY, '来一局');
    assert.equal(restarted.battle?.mode, 'solo');
    const status = await service.say(KEY, '战况如何');
    assert.doesNotMatch(status.text, /刚才那一手/);
  });

  it('终局也把最后那一手交代清楚', async () => {
    const { service, store } = setup();
    const opened = await service.say(KEY, '开房间');
    const code = /房间(\d{4})/.exec(opened.text)?.[1]!;
    await service.say(KEY_B, `加入房间${code}`);

    // 把房主生命值摆到 1：访客这一手直接收尾
    const key = pvpBattleKey(code);
    const canonical = store.get(key);
    assert.ok(canonical);
    store.set(key, { ...canonical, player: { ...canonical.player, hp: 1 } });

    await service.say(KEY, '蓄力'); // 房主先手，蓄力后轮到访客
    await service.say(KEY_B, '普攻');
    const finisher = await service.say(KEY, '承受');
    assert.match(finisher.text, /这局输了/);

    const catchUp = await service.say(KEY_B, '战况如何');
    assert.match(catchUp.text, /^刚才那一手。/);
    assert.match(catchUp.text, /我普攻，对手承受，掉3点生命值，剩0/);
    assert.match(catchUp.text, /我赢了/);
  });

  it('有屏客户端取走补账但不念出来，下次也不会再补', async () => {
    const { service } = setup();
    const opened = await service.say(KEY, '开房间');
    const code = /房间(\d{4})/.exec(opened.text)?.[1]!;
    await service.say(KEY_B, `加入房间${code}`);
    await service.say(KEY, '强攻');
    await service.say(KEY_B, '格挡');

    // 网页自己能画局面，不需要把错过的结算念一遍
    const silent = await service.say(KEY, '战况如何', { catchUp: false });
    assert.doesNotMatch(silent.text, /刚才那一手/);
    assert.match(silent.text, /第1轮/);

    // 队列已经被取走，换回语音终端也不会补旧账
    const voice = await service.say(KEY, '战况如何');
    assert.doesNotMatch(voice.text, /刚才那一手/);
  });

  it('单人局的播报里不出现补账', async () => {
    const { service } = setup();
    await service.start(KEY);
    await service.say(KEY, '普攻');
    const status = await service.say(KEY, '战况如何');
    assert.doesNotMatch(status.text, /刚才那一手/);
  });
});

/** 让出一轮事件循环，等异步流程真正跑到「等模型」那一步 */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** 可手动放行的命令路由：模拟「模型还没回，局面已经变了」 */
function gatedIntent(): { resolver: CommandRouter; release(id: 'light' | null): void } {
  let release: ((id: 'light' | null) => void) | null = null;
  const resolver: CommandRouter = {
    resolve() {
      return new Promise((resolve) => {
        release = (id) => resolve(id ? { kind: 'turn', action: id } : null);
      });
    },
  };
  return {
    resolver,
    release(id) {
      assert.ok(release, '模型应该已经被问过一次');
      release(id);
    },
  };
}

/** 可手动放行的命令路由：放行时给出模型判出的命令，用来挂住开局、开房这类非招式命令 */
function gatedCommand(): { resolver: CommandRouter; release(command: Command | null): void } {
  let release: ((command: Command | null) => void) | null = null;
  const resolver: CommandRouter = {
    resolve() {
      return new Promise((resolve) => {
        release = (command) => resolve(command);
      });
    },
  };
  return {
    resolver,
    release(command) {
      assert.ok(release, '模型应该已经被问过一次');
      release(command);
    },
  };
}

describe('异步与状态的边界', () => {
  const HOST = 'device-b#agent-1';
  const GUEST = 'device-c#agent-2';
  const roomCodeOf = (text: string): string => {
    const code = /房间(\d{4})/.exec(text)?.[1];
    assert.ok(code, `播报里应带房间号：${text}`);
    return code;
  };

  it('问句、否定、一句两招都不执行，也不动对局', async () => {
    const { service, store } = setup();
    await service.start(KEY);
    const before = store.get(KEY);
    assert.ok(before);
    // 攒满能量、留着大招：这类句子最容易被识别成「真放一招」
    store.set(KEY, { ...before, player: { ...before.player, ap: 5 } });
    const armed = store.get(KEY);
    assert.ok(armed);

    const asked = await service.say(KEY, '我的大招还剩几次');
    assert.match(asked.text, /能量/);
    assert.equal(store.get(KEY), armed);

    // 走统一入口也一样：这句话归成战况，不落进出招
    const askedViaSay = await service.say(KEY, '我要放几次大招');
    assert.match(askedViaSay.text, /能量/);
    assert.equal(store.get(KEY), armed);

    const negated = await service.say(KEY, '不要大招');
    assert.match(negated.text, /没打出去/);
    assert.equal(store.get(KEY), armed);

    const ambiguous = await service.say(KEY, '大招还是强攻');
    assert.match(ambiguous.text, /两种招式/);
    assert.equal(store.get(KEY), armed);
    assert.equal(armed.player.ap, 5);
    assert.equal(armed.player.ultLeft, 1);
  });

  it('没有对局时，否定句不会顺手开一局', async () => {
    const { service, store } = setup();

    const negated = await service.say(KEY, '先不打');
    assert.equal(store.get(KEY), undefined);
    assert.match(negated.text, /没听清这一手/);

    const ambiguous = await service.say(KEY, '大招还是强攻');
    assert.equal(store.get(KEY), undefined);
    assert.match(ambiguous.text, /没听清这一手/);
  });

  it('玩法问句从出招入口进来也只回说明', async () => {
    const { service, store } = setup();
    await service.start(KEY);
    const before = store.get(KEY);

    const asked = await service.say(KEY, '怎么出招');
    assert.match(asked.text, /普攻/);
    assert.equal(asked.battle, null);
    assert.equal(store.get(KEY), before);
  });

  it('同一玩家的两次出招按提交顺序结算', async () => {
    const { service, store } = setup();
    await service.start(KEY);

    // 先出手，再应对同一轮对手那一击：两次请求同时进来也要按顺序结算
    const [first, second] = await Promise.all([service.say(KEY, '普攻'), service.say(KEY, '格挡')]);
    assert.match(first.text, /普攻/);
    assert.match(second.text, /格挡/);
    // 两回合都完整结算了：没有一手被顶掉，也没有卡在「等对手应对」
    assert.equal(store.get(KEY)?.history.length, 2);
  });

  it('模型还在想的时候进了房间，旧的这一手不再结算', async () => {
    const intent = gatedIntent();
    const { service, store, rooms } = setup({ router: intent.resolver });

    await service.start(KEY);
    const opened = await service.start(HOST, { mode: 'pvp' });
    const code = roomCodeOf(opened.text);

    const pending = service.say(KEY, '上去揍他');
    await tick();
    // 模型还没回，玩家先凭语音进了房间
    await service.say(KEY, `加入房间${code}`);
    intent.release('light');

    const stale = await pending;
    assert.match(stale.text, /局面已经变了/);
    // 旧单人局已经随着进房清掉，没有把那一手写到房间的局面上
    assert.equal(store.get(KEY), undefined);
    assert.equal(rooms.byPlayer(KEY)?.code, code);
    assert.deepEqual(store.get(pvpBattleKey(code))?.history, []);
  });

  it('房主重开时，还在等模型的旧一手不会写进新局', async () => {
    const intent = gatedIntent();
    const { service, store, rooms } = setup({ router: intent.resolver });

    const opened = await service.start(HOST, { mode: 'pvp' });
    const code = roomCodeOf(opened.text);
    await service.start(GUEST, { room: code });
    const key = pvpBattleKey(code);
    const before = store.get(key);
    assert.ok(before);

    const pending = service.say(HOST, '上去揍他');
    await tick();
    // 房主改口再开一间：旧房连那局一起撤掉
    await service.say(HOST, '开房');
    intent.release('light');

    const stale = await pending;
    assert.match(stale.text, /局面已经变了/);

    const current = store.get(key);
    assert.ok(current);
    assert.deepEqual(current.history, []);
    assert.equal(rooms.get(code)?.guestKey, null);
  });

  it('重开排在模型返回之前，旧局那一手不会落到新局', async () => {
    // 第一次让对手应对时挂起，后面直接硬吃：串起「旧局出招占着事务、重开排在后面」的交错，
    // 万一旧局那一手真落了新局，也不会在这里挂死，而是被下面的断言抓住
    const gate: { release: (() => void) | null } = { release: null };
    const ai: BattleAI = {
      chooseAction: () => 'light',
      chooseResponse() {
        if (gate.release) return 'take';
        return new Promise((resolve) => {
          gate.release = () => resolve('take');
        });
      },
    };
    const intent = gatedIntent();
    const { service, store } = setup({ router: intent.resolver, ai });
    await service.start(KEY);
    const before = store.get(KEY);
    assert.ok(before);

    // 1. 一句只有模型认得的话进来，模型还在想（这一步不占事务）
    const pending = service.say(KEY, '上去揍他');
    await tick();

    // 2. 普攻拿到事务，卡在等对手应对
    const attack = service.say(KEY, '普攻');
    await tick();

    // 3. 重开排在普攻后面：旧局这时还在，模型返回时校验旧局是能过的
    const restart = service.say(KEY, '开始游戏');
    await tick();
    assert.equal(store.get(KEY)?.id, before.id);

    // 4. 模型这才回来：这一手只能排在重开之后执行，必须作废
    intent.release('light');
    assert.ok(gate.release);
    gate.release();

    const stale = await pending;
    await attack;
    const restarted = await restart;

    assert.match(stale.text, /局面已经变了/);
    assert.match(restarted.text, /对决开始/);

    const fresh = store.get(KEY);
    assert.ok(fresh);
    assert.notEqual(fresh.id, before.id);
    // 新局不背旧局的账：没有那条战报，也没有把能量从 3 扣到 2
    assert.deepEqual(fresh.history, []);
    assert.equal(fresh.player.ap, 3);
    assert.equal(fresh.round, 1);
  });

  it('模型返回时对局已经过期，不会拿这一手另开一局', async () => {
    const intent = gatedIntent();
    const { service, store, advance } = setup({ router: intent.resolver });
    await service.start(KEY);

    const pending = service.say(KEY, '上去揍他');
    await tick();
    // 等模型的时间里对局过期：这句话说的是已经不在的那一局
    advance(60_001);
    intent.release('light');

    const stale = await pending;
    assert.match(stale.text, /局面已经变了/);
    // 带着招式也不能顺手开一局：玩家说的不是新局
    assert.equal(store.get(KEY), undefined);
  });

  it('重开已经完成之后，旧路由返回的开局不会把新局再重置一次', async () => {
    const intent = gatedCommand();
    const { service, store } = setup({ router: intent.resolver });
    await service.start(KEY);
    const before = store.get(KEY);
    assert.ok(before);

    // 一局打完，「我还想接着玩」规则认不出，交给模型
    store.set(KEY, { ...before, phase: 'victory' as const });
    const pending = service.say(KEY, '我还想接着玩');
    await tick();

    // 玩家等不及，自己重开并出了一招：新局已经有了一条战报
    const restarted = await service.say(KEY, '开始游戏');
    assert.match(restarted.text, /对决开始/);
    await service.say(KEY, '普攻');
    const played = store.get(KEY);
    assert.ok(played);
    assert.ok(played.history.length > 0);

    // 旧路由这才回来：它认出的开局不能再执行，否则刚打的那一手会被清掉
    intent.release({ kind: 'start' });
    const stale = await pending;
    assert.match(stale.text, /局面已经变了/);

    const after = store.get(KEY);
    assert.ok(after);
    assert.equal(after.id, played.id);
    assert.equal(after.history.length, played.history.length);
  });

  it('等模型期间进了别人的房间，旧路由返回的开局不会把那间房撤掉', async () => {
    const intent = gatedCommand();
    const { service, store, rooms } = setup({ router: intent.resolver });

    const opened = await service.start(HOST, { mode: 'pvp' });
    const code = roomCodeOf(opened.text);
    const key = pvpBattleKey(code);
    const battleId = store.get(key)?.id;
    assert.ok(battleId);

    const pending = service.say(GUEST, '我还想接着玩');
    await tick();
    // 模型还没回，玩家先凭语音进了朋友的房间
    await service.say(GUEST, `加入房间${code}`);
    assert.equal(rooms.byPlayer(GUEST)?.code, code);

    // 旧路由返回的开局会走 dropRoom：核对不过就不能执行，两个人都还能接着打
    intent.release({ kind: 'start' });
    const stale = await pending;
    assert.match(stale.text, /局面已经变了/);

    assert.equal(rooms.get(code)?.guestKey, GUEST);
    assert.equal(store.get(key)?.id, battleId);
  });

  it('等模型期间进了别人的房间，旧路由返回的开房也不会把那间房撤掉', async () => {
    const intent = gatedCommand();
    const { service, store, rooms } = setup({ router: intent.resolver });

    const opened = await service.start(HOST, { mode: 'pvp' });
    const code = roomCodeOf(opened.text);
    const key = pvpBattleKey(code);
    const battleId = store.get(key)?.id;
    assert.ok(battleId);

    const pending = service.say(GUEST, '咱们一起玩吧');
    await tick();
    await service.say(GUEST, `加入房间${code}`);
    assert.equal(rooms.byPlayer(GUEST)?.code, code);

    intent.release({ kind: 'open-room' });
    const stale = await pending;
    assert.match(stale.text, /局面已经变了/);

    assert.equal(rooms.get(code)?.guestKey, GUEST);
    assert.equal(store.get(key)?.id, battleId);
  });
});

describe('规则外问答', () => {
  // 模型路由把这句话判成「规则外」，随后交给语言模型作答
  const askRouter: CommandRouter = {
    async resolve(text) {
      return { kind: 'ask', text };
    },
  };

  it('交给语言模型回答，不推进对局、不记战报', async () => {
    const asked: string[] = [];
    const chat = {
      async answer(question: string): Promise<string | null> {
        asked.push(question);
        return '今天多云，傍晚有雨。';
      },
    };
    const { service, store } = setup({ router: askRouter, chat });
    const started = await service.start(KEY);
    const before = store.get(KEY);
    assert.ok(before);

    const result = await service.say(KEY, '今天天气怎么样？');
    assert.deepEqual(asked, ['今天天气怎么样？']);
    assert.equal(result.text, '今天多云，傍晚有雨。');
    // 对局原样保留：不扣能量、不推进轮次、不加战报
    assert.deepEqual(store.get(KEY), before);
    assert.ok(before === store.get(KEY));
    assert.deepEqual(result.battle?.history, started.battle?.history);
  });

  it('还没开局时也能问答，不会顺手开一局', async () => {
    const chat = { async answer(): Promise<string | null> { return '今天多云。'; } };
    const { service, store } = setup({ router: askRouter, chat });
    const asked = await service.say(KEY, '今天天气怎么样？');
    assert.equal(asked.text, '今天多云。');
    assert.equal(asked.battle, null);
    assert.equal(store.get(KEY), undefined);
  });

  it('没配问答模型时回固定话术，对局同样不动', async () => {
    const { service, store } = setup({ router: askRouter });
    await service.start(KEY);
    const before = store.get(KEY);

    const result = await service.say(KEY, '讲个笑话');
    assert.match(result.text, /暂时答不上来/);
    assert.ok(before === store.get(KEY));
  });

  it('模型返回空或抛异常时都回固定话术，不把错误抛给玩家', async () => {
    const empty = setup({ router: askRouter, chat: { async answer() { return null; } } });
    await empty.service.start(KEY);
    assert.match((await empty.service.say(KEY, '现在几点')).text, /暂时答不上来/);

    const broken = setup({
      router: askRouter,
      chat: {
        async answer(): Promise<string | null> {
          throw new Error('boom');
        },
      },
    });
    await broken.service.start(KEY);
    const result = await broken.service.say(KEY, '你是谁');
    assert.match(result.text, /暂时答不上来/);
    assert.equal(result.battle?.round, 1);
  });
});

describe('打完一局之后', () => {
  it('规则外问答照常回答，对局原样留着', async () => {
    const stages: RouterStage[] = [];
    const router: CommandRouter = {
      async resolve(text, stage) {
        stages.push(stage);
        return { kind: 'ask', text };
      },
    };
    const asked: string[] = [];
    const chat = {
      async answer(question: string): Promise<string | null> {
        asked.push(question);
        return '讲一个：包子和面条打架，包子被打得满身是馅。';
      },
    };
    const { service, store } = setup({ router, chat });
    await service.start(KEY);
    const before = store.get(KEY);
    assert.ok(before);
    // 一局已经打完：不重开、不过期之前都停在这个状态
    const ended = { ...before, phase: 'victory' as const };
    store.set(KEY, ended);

    const result = await service.say(KEY, '讲个笑话');
    // 结束状态照样进路由，但菜单里只有查询、玩法、开局和闲聊
    assert.deepEqual(stages, ['ended']);
    assert.deepEqual(asked, ['讲个笑话']);
    assert.equal(result.text, '讲一个：包子和面条打架，包子被打得满身是馅。');
    // 问答不取补账、不推进、不改写
    assert.ok(store.get(KEY) === ended);
  });

  it('模型认出「再来一局」之后真的重开', async () => {
    const router: CommandRouter = {
      async resolve(_text, stage) {
        return stage === 'ended' ? { kind: 'start' } : null;
      },
    };
    const { service, store } = setup({ router });
    await service.start(KEY);
    const before = store.get(KEY);
    assert.ok(before);
    store.set(KEY, { ...before, phase: 'defeat' as const });

    const result = await service.say(KEY, '我还想接着玩');
    assert.match(result.text, /对决开始/);

    const fresh = store.get(KEY);
    assert.ok(fresh);
    assert.notEqual(fresh.id, before.id);
    assert.equal(fresh.phase, 'battle');
    assert.deepEqual(fresh.history, []);
    assert.equal(fresh.player.ap, 3);
  });

  it('结束状态仍然不出招', async () => {
    // 模型不按菜单来也要挡住：结束局不接受任何招式
    const router: CommandRouter = {
      async resolve() {
        return { kind: 'turn', action: 'ult' };
      },
    };
    const { service, store } = setup({ router });
    await service.start(KEY);
    const before = store.get(KEY);
    assert.ok(before);
    const ended = { ...before, player: { ...before.player, ap: 4 }, phase: 'victory' as const };
    store.set(KEY, ended);

    const result = await service.say(KEY, '给他来个大的');
    assert.match(result.text, /我赢了/);
    assert.match(result.text, /开始游戏/);
    assert.ok(store.get(KEY) === ended);
  });
});

describe('挂起等对手', () => {
  const HOST = 'device-h#agent-1';
  const GUEST = 'device-g#agent-2';

  /** 等一个本该立刻返回的结果：超时就说明挂住了，直接判失败，别把用例拖住 */
  function immediate<T>(promise: Promise<T>, ms = 200): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`应该在 ${ms}ms 内返回，实际挂住了`)), ms);
      promise.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  }

  /** 开一间双人房，返回播报里的四位房间号 */
  async function openRoom(service: GameService): Promise<string> {
    const opened = await service.say(HOST, '开房间');
    const code = /房间(\d{4})/.exec(opened.text)?.[1];
    assert.ok(code, `应播报四位房间号：${opened.text}`);
    return code;
  }

  it('房主出完招挂起，访客应招后带着这一手的结算醒来', async () => {
    const echo = new EchoStore();
    const { service } = setup({ echo });
    const code = await openRoom(service);
    await service.say(GUEST, `加入房间${code}`);
    await service.say(HOST, '强攻');

    const pending = service.wait(HOST, { timeoutMs: 1000 });
    // 请求已经挂在这一局上，等访客应招
    assert.equal(echo.waitingOn(HOST), true);
    assert.equal(echo.waiting, 1);

    const response = await service.say(GUEST, '格挡');
    assert.match(response.text, /格挡/);

    const woken = await immediate(pending);
    assert.match(woken.text, /我强攻，对手格挡，掉3点生命值，剩15/);
    // 挂起等来的结果当场就念，不能带补账前缀
    assert.doesNotMatch(woken.text, /刚才那一手/);
    assert.equal(woken.battle?.pending, null);
    assert.equal(woken.battle?.history.length, 1);
    assert.equal(echo.waiting, 0);

    // 这一手已经念过，下次开口不再补一遍
    const later = await service.say(HOST, '战况如何');
    assert.doesNotMatch(later.text, /刚才那一手/);
  });

  it('房主开房后挂起，访客进房间后醒来先说人到了再报开局', async () => {
    const echo = new EchoStore();
    const { service } = setup({ echo });
    const code = await openRoom(service);

    const pending = service.wait(HOST, { timeoutMs: 1000 });
    assert.equal(echo.waitingOn(HOST), true);

    await service.start(GUEST, { room: code });

    const woken = await immediate(pending);
    assert.match(woken.text, /^对手进房间了。/);
    assert.match(woken.text, /对决开始/);
    assert.equal(echo.waiting, 0);
    assert.equal(woken.battle?.mode, 'pvp');
  });

  it('等满时长说一句对手还没出手，补账仍留在队列里', async () => {
    const { service } = setup();
    const code = await openRoom(service);
    await service.say(GUEST, `加入房间${code}`);
    await service.say(HOST, '强攻');

    const timedOut = await service.wait(HOST, { timeoutMs: 20 });
    assert.equal(timedOut.text, narrateWaitTimeout('opponent'));

    // 超时不算失败：访客应完的这一手还要留着，等房主下次开口补上
    await service.say(GUEST, '格挡');
    const catchUp = await service.say(HOST, '战况如何');
    assert.match(catchUp.text, /^刚才那一手。/);
    assert.match(catchUp.text, /我强攻，对手格挡，掉3点生命值，剩15/);
  });

  it('房间里没人进来时超时，说的是对手还没进房间', async () => {
    const { service } = setup();
    await openRoom(service);

    const timedOut = await service.wait(HOST, { timeoutMs: 20 });
    assert.equal(timedOut.text, narrateWaitTimeout('guest'));
  });

  it('轮到自己出招时不挂起，直接提醒出招', async () => {
    const { service } = setup();
    await service.start(HOST);

    const result = await immediate(service.wait(HOST, { timeoutMs: 5000 }));
    assert.equal(result.text, narrateWaitTurn());
    assert.equal(result.battle?.round, 1);
  });

  it('对手已经出招等应招时不挂起，直接提醒应招', async () => {
    const { service } = setup();
    await service.start(HOST);
    // 单人局：我出招后对手这一手已经锁定，该我应招，没有可等的东西
    await service.say(HOST, '普攻');

    const result = await immediate(service.wait(HOST, { timeoutMs: 5000 }));
    assert.equal(result.text, narrateWaitRespond());
    assert.equal(result.battle?.pending?.actor, 'enemy');
  });

  it('没有对局时不挂起，回一句没有对局', async () => {
    const { service } = setup();

    const result = await immediate(service.wait('device-x#agent-9', { timeoutMs: 5000 }));
    assert.equal(result.text, narrateNoBattle());
    assert.equal(result.battle, null);
  });

  it('对局已经结束时不挂起，播结束语', async () => {
    const { service, store } = setup();
    const started = await service.start(HOST);
    assert.ok(started.battle);
    store.set(HOST, { ...started.battle, phase: 'victory' });
    const ended = store.get(HOST);
    assert.ok(ended);

    const result = await immediate(service.wait(HOST, { timeoutMs: 5000 }));
    assert.equal(result.text, narrateEnded(ended));
    assert.match(result.text, /我赢了/);
  });

  it('传进来的 signal 已经取消时立刻返回，不占着请求', async () => {
    const { service } = setup();
    const code = await openRoom(service);
    await service.say(GUEST, `加入房间${code}`);
    await service.say(HOST, '强攻');

    const controller = new AbortController();
    controller.abort();

    const result = await immediate(service.wait(HOST, { timeoutMs: 5000, signal: controller.signal }));
    // 平台已经断开：这一手没有结果，回一句收尾文案，别静默
    assert.equal(result.text, narrateWaitTimeout('opponent'));
  });
});
