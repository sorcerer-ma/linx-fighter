import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createBattle } from '../src/game/engine.js';
import type { IntentResolver, IntentStage } from '../src/game/intent.js';
import { pvpBattleKey } from '../src/game/pvp.js';
import { GameService, type GameServiceDeps } from '../src/game/service.js';
import { createLogger } from '../src/log.js';
import { BattleStore } from '../src/store/battles.js';
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
    assert.match(result.text, /你先手/);
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
    assert.match(first.text, /普攻/);
    assert.match(first.text, /已锁定/);

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
    assert.match(result.text, /你赢了/);
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
    assert.match((await service.say(KEY, '攻击')).text, /你输了/);

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
    assert.match(result.text, /只能应对/);
  });

  it('能量不足与能量已满都不会改对局', async () => {
    const { service, store } = setup();
    const battle = createBattle({ now: 1_000_000, seed: 0, firstMover: 'player' });

    store.set(KEY, { ...battle, player: { ...battle.player, ap: 1 } });
    const low = await service.say(KEY, '强攻');
    assert.equal(low.battle?.player.ap, 1);
    assert.equal(low.battle?.history.length, 0);
    assert.match(low.text, /能量不够/);

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
    assert.match(responded.text, /闪/);
  });

  it('玩法说明不需要对局', async () => {
    const { service } = setup();
    const result = service.help();
    assert.equal(result.battle, null);
    assert.match(result.text, /普攻/);
    assert.match(result.text, /开始游戏/);
  });
});

describe('意图模型兜底', () => {
  it('规则认不出时由模型补出主动招与应对招', async () => {
    const calls: { text: string; stage: IntentStage }[] = [];
    const intent: IntentResolver = {
      async resolve(text, stage) {
        calls.push({ text, stage });
        return stage === 'active' ? 'heavy' : 'guard';
      },
    };
    const { service } = setup({ intent });
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
    const broken: IntentResolver = {
      async resolve() {
        throw new Error('upstream down');
      },
    };
    const { service } = setup({ intent: broken });
    await service.start(KEY);

    const result = await service.say(KEY, '随便说一句');
    assert.match(result.text, /没听清/);
    assert.equal(result.battle?.round, 1);
    assert.equal(result.battle?.history.length, 0);

    const quiet: IntentResolver = { async resolve() { return null; } };
    const quietService = setup({ intent: quiet }).service;
    quietService.start(KEY);
    assert.match((await quietService.say(KEY, '再来一句')).text, /没听清/);
  });

  it('没有对局时不调用模型，避免随便一句就开局', async () => {
    let called = 0;
    const intent: IntentResolver = {
      async resolve() {
        called += 1;
        return 'light';
      },
    };
    const { service, store } = setup({ intent });

    const result = await service.say(KEY, '今天天气不错');
    assert.equal(called, 0);
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
    assert.match(attack.text, /已出手/);

    // 对手应招时出手方不在场：这一声只念给应对方
    const response = await service.say(KEY_B, '格挡');
    assert.match(response.text, /格挡/);
    assert.doesNotMatch(response.text, /刚才那一手/);

    const catchUp = await service.say(KEY, '战况如何');
    assert.match(catchUp.text, /^刚才那一手。/);
    assert.match(catchUp.text, /你一记强攻，对手格挡，掉3点生命值，剩15/);
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
    assert.match(guestTurn.text, /一记普攻已出手/);
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
    assert.match(finisher.text, /这一局输了/);

    const catchUp = await service.say(KEY_B, '战况如何');
    assert.match(catchUp.text, /^刚才那一手。/);
    assert.match(catchUp.text, /你一记普攻，对手硬扛，掉\d+点，剩0/);
    assert.match(catchUp.text, /你赢了/);
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

/** 可手动放行的意图模型：模拟「模型还没回，局面已经变了」 */
function gatedIntent(): { resolver: IntentResolver; release(id: 'light' | null): void } {
  let release: ((id: 'light' | null) => void) | null = null;
  const resolver: IntentResolver = {
    resolve() {
      return new Promise((resolve) => {
        release = resolve;
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
    const { service, store, rooms } = setup({ intent: intent.resolver });

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
    const { service, store, rooms } = setup({ intent: intent.resolver });

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
});
