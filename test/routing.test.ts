import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { matchSpokenAction } from '../src/game/asr.js';
import type { CommandRouter, RouterStage } from '../src/game/router.js';
import { GameService, type GameServiceDeps, type SpokenMatcher } from '../src/game/service.js';
import { createLogger } from '../src/log.js';
import { BattleStore } from '../src/store/battles.js';
import { RoomStore } from '../src/store/rooms.js';

const KEY = 'device-a#agent-1';

/** 记录每一层被调用的次数：三层各管一段，谁都不该抢下一层的活 */
interface Calls {
  fuzzy: string[];
  router: { text: string; stage: RouterStage }[];
}

function setup(overrides: Partial<GameServiceDeps> = {}) {
  const calls: Calls = { fuzzy: [], router: [] };
  // 包一层真实实现：既记录有没有被调用，又不改写端侧真正认得出什么
  const fuzzy: SpokenMatcher = (text, stage) => {
    calls.fuzzy.push(stage ? `${stage}:${text}` : text);
    return matchSpokenAction(text, stage);
  };
  const router: CommandRouter = {
    async resolve(text, stage) {
      calls.router.push({ text, stage });
      return null;
    },
  };
  let now = 1_000_000;
  const store = new BattleStore({ ttlMs: 60_000, now: () => now });
  const rooms = new RoomStore({ ttlMs: 60_000, now: () => now, random: () => 0 });
  const service = new GameService({
    store,
    rooms,
    logger: createLogger('error'),
    now: () => now,
    random: () => 0,
    fuzzy,
    router,
    ...overrides,
  });
  return { service, calls, store, rooms };
}

describe('三层解析：规则 → 端侧同音 → 命令路由', () => {
  it('规则认得出的句子不进后两层', async () => {
    const { service, calls } = setup();
    await service.start(KEY);

    const result = await service.say(KEY, '普攻');

    assert.match(result.text, /普攻/);
    assert.deepEqual(calls.fuzzy, [], '规则命中就不该再猜同音');
    assert.deepEqual(calls.router, [], '规则命中就不该等模型');
  });

  it('端侧同音认得出就不等模型：公鸡 → 普攻', async () => {
    const { service, calls } = setup();
    await service.start(KEY);

    // 「公鸡」不在招式词表里，只有同音节匹配能认；模型这一步不该被叫起来
    const result = await service.say(KEY, '公鸡');

    assert.equal(result.battle?.pending?.move, 'light');
    assert.deepEqual(calls.fuzzy, ['active:公鸡']);
    assert.deepEqual(calls.router, [], '端侧已经认出来了，不能再花一次模型往返');
  });

  it('端侧只还原动作，不越过规则：开大照样要够能量', async () => {
    const { service } = setup();
    await service.start(KEY);
    const before = (await service.say(KEY, '战况')).battle!;

    const result = await service.say(KEY, '开大');

    // 初始 3 点能量，大招要 4 点：认出了是大招，但引擎照旧拒绝
    assert.match(result.text, /大招要4点/);
    assert.equal(result.battle?.pending ?? null, before.pending);
    assert.equal(result.battle?.player.ap, before.player.ap);
    assert.equal(result.battle?.history.length, before.history.length);
  });

  it('端侧认不出才交给模型，并把当前阶段带过去', async () => {
    const { service, calls } = setup();
    await service.start(KEY);

    const result = await service.say(KEY, '给他来个狠的');

    assert.match(result.text, /没听清/);
    assert.deepEqual(calls.fuzzy, ['active:给他来个狠的']);
    assert.deepEqual(calls.router, [{ text: '给他来个狠的', stage: 'active' }]);
  });

  it('问句不进端侧：问的是意思，不是出招', async () => {
    const { service, calls } = setup();
    await service.start(KEY);

    await service.say(KEY, '重机是什么意思');

    assert.equal(calls.fuzzy.length, 0, '问句不该走同音猜招');
    assert.deepEqual(calls.router, [{ text: '重机是什么意思', stage: 'question' }]);
  });

  it('等对手时端侧不猜招：那句话多半不是本机说的', async () => {
    const { service, calls } = setup();
    await service.start(KEY, { mode: 'pvp' });
    const room = service.status(KEY).text.match(/房间(\d{4})/)![1]!;
    await service.start('device-b#agent-2', { room });
    await service.say(KEY, '普攻');

    const result = await service.say(KEY, '开大');

    assert.equal(result.text, '这一手等对手应对。');
    assert.deepEqual(calls.fuzzy, [], '等待对手的阶段不猜招');
    assert.deepEqual(calls.router, [{ text: '开大', stage: 'waiting' }], '规则与端侧都不接，才轮到模型');
    // 「开大」在端侧本来能认成大招：这里没认，说明阶段限制真的生效
    assert.ok(matchSpokenAction('开大', 'active'), '前提：这句在端侧本来认得出来');
  });

  it('注掉端侧之后行为退回两层：同样一句改由模型判断', async () => {
    const { service, calls } = setup({ fuzzy: null });
    await service.start(KEY);

    const result = await service.say(KEY, '开大');

    assert.match(result.text, /没听清/);
    assert.deepEqual(calls.fuzzy, []);
    assert.deepEqual(calls.router, [{ text: '开大', stage: 'active' }]);
  });
});
