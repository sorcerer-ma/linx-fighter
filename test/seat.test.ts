import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readCommand } from '../src/game/command.js';
import { matchSpokenAction } from '../src/game/asr.js';
import { GameService } from '../src/game/service.js';
import { screenSeat } from '../src/game/seat.js';
import { createLogger } from '../src/log.js';
import { BattleStore } from '../src/store/battles.js';
import { RoomStore } from '../src/store/rooms.js';
import type { Side } from '../src/game/types.js';

const HOST = 'device-a#agent-1';
const GUEST = 'device-b#agent-2';

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
  const text = service.status(host).text;
  const match = text.match(/房间(\d{4})/);
  assert.ok(match, `战况里应带房间号：${text}`);
  return match[1]!;
}

/** 开一桌双人房：房主红方、加入者蓝方，两人都就位但还没人出招 */
async function openTable(overrides: Partial<ConstructorParameters<typeof GameService>[0]> = {}) {
  const { service, advance } = setup(overrides);
  await service.start(HOST, { mode: 'pvp' });
  const code = findRoom(service, HOST);
  await service.start(GUEST, { room: code });
  return { service, advance, code };
}

/** 座位口令的判定是纯函数，先按矩阵把口径钉死 */
describe('座位口令的归属判定', () => {
  it('off 模式（默认）原样放行，等于引入前行为', () => {
    const screened = screenSeat('off', 'player', '蓝方大招', readCommand('蓝方大招'));
    assert.equal(screened.kind, 'pass');
    assert.ok(screened.kind === 'pass');
    assert.equal(screened.command.kind, 'turn');
  });

  it('单人局没有对方也没有座位，strict 也原样放行', () => {
    const screened = screenSeat('strict', null, '红方普攻', readCommand('红方普攻'));
    assert.equal(screened.kind, 'pass');
  });

  it('带了对方座位口令：静默丢掉，不执行也不回长提示', () => {
    for (const seat of ['player', 'enemy'] as Side[]) {
      const other = seat === 'player' ? '蓝方' : '红方';
      const screened = screenSeat('strict', seat, `${other}大招`, readCommand(`${other}大招`));
      assert.deepEqual(screened, { kind: 'silent' }, `${seat} 收到 ${other} 的话应静默`);
    }
  });

  it('带了自己的座位口令：口令只是标签，招式照样拆得出来', () => {
    const cases: Array<[string, string, string]> = [
      ['player', '红方大招', 'ult'],
      ['player', '红方普攻', 'light'],
      ['player', '红方格挡', 'guard'],
      ['enemy', '蓝方闪避', 'dodge'],
      ['enemy', '蓝方蓄力', 'charge'],
    ];
    for (const [seat, text, move] of cases) {
      const screened = screenSeat('strict', seat as Side, text, readCommand(text));
      assert.ok(screened.kind === 'pass', `${text} 应放行`);
      assert.equal(screened.command.kind, 'turn', `${text} 应读成出招`);
      assert.ok(screened.command.kind === 'turn');
      assert.equal(screened.command.action, move, `${text} 应拆出 ${move}`);
    }
  });

  it('只认端侧纠错才认得出的口语，摘掉口令后照旧能认', () => {
    // 「开大」不在招式别名里，靠 asr.ts 的简称表命中；口令不能把它挡住
    const text = '红方，开大';
    const screened = screenSeat('strict', 'player', text, readCommand(text));
    assert.ok(screened.kind === 'pass');
    assert.equal(matchSpokenAction(screened.text)?.id, 'ult', '摘掉口令的原话要能直接过端侧纠错');
  });

  it('「红方」单独说不是招式，只回一句自报座位的确认', () => {
    // 口令词本身不能被招式别名吃掉，否则「红方」会变成一次空出招
    // 规则认不出，交给模型路由；口令词本身不能被招式别名吃掉，否则会变成一次空出招
    assert.equal(readCommand('红方').kind, 'route');
    assert.equal(readCommand('蓝方').kind, 'route');

    const screened = screenSeat('strict', 'player', '红方', readCommand('红方'));
    assert.ok(screened.kind === 'say');
    assert.match(screened.text, /^红方这边/);
    // 播报纪律：一句、60 字内、无 Markdown 与表情
    assert.ok(screened.text.length <= 60);
    assert.equal((screened.text.match(/。/g) ?? []).length, 1);
    assert.doesNotMatch(screened.text, /[*_`#\p{Extended_Pictographic}]/u);
  });

  it('两个口令都在时以自己报的为准，摘干净后再读', () => {
    const screened = screenSeat('strict', 'enemy', '蓝方红方普攻', readCommand('蓝方红方普攻'));
    assert.ok(screened.kind === 'pass');
    assert.equal(screened.command.kind, 'turn');
    assert.ok(screened.command.kind === 'turn');
    assert.equal(screened.command.action, 'light');
  });
});

/** 落到对局上：替谁说清楚了，服务端才执行；说错归属当场收住 */
describe('strict 模式的串音降噪', () => {
  it('当值设备带自己的口令出招，正常推进对局', async () => {
    const { service } = await openTable({ attribution: 'strict' });
    const acted = await service.say(HOST, '红方普攻');

    assert.match(acted.text, /普攻/);
    assert.equal(acted.battle?.history.length, 0);
    assert.equal(acted.battle?.pending?.actor, 'player');
    assert.match(acted.battle?.pending?.move ?? '', /light/);
  });

  it('当值设备收到对方带口令的话：不执行、不回长句、不耗资源', async () => {
    const { service } = await openTable({ attribution: 'strict' });
    const before = (await service.say(HOST, '战况如何')).battle!;

    // 邻居设备在旁边喊「蓝方大招」，房主这台当值设备把它收了下来
    const echo = await service.say(HOST, '蓝方大招');

    assert.equal(echo.text, '', '对方的话应当静默，不能回能被再收一遍的句子');
    assert.equal(echo.battle?.history.length, before.history.length);
    assert.equal(echo.battle?.pending, null);
    assert.equal(echo.battle?.player.ap, before.player.ap);
    assert.equal(echo.battle?.player.hp, before.player.hp);
  });

  it('双方都不报座位时沿用默认仲裁：替对手喊招仍会被挡回', async () => {
    const { service } = await openTable({ attribution: 'strict' });

    // 房主当值，替对手喊一句出招：默认策略就是拒绝，且只回一句最短事实
    const stolen = await service.say(HOST, '格挡');
    assert.equal(stolen.battle?.pending, null);

    const own = await service.say(HOST, '普攻');
    assert.ok(own.battle?.pending, '当值方不带口令照常能出招');

    // 房主已经出招，此时再说一句不该推进对局
    const again = await service.say(HOST, '红方普攻');
    assert.equal(again.battle?.history.length, 0);
    assert.equal(again.text, '这一手等对手应对。');
  });

  it('off 模式完全等价基线：对方的口令被当作普通发言', async () => {
    const { service } = await openTable();
    const acted = await service.say(HOST, '蓝方大招');

    // off 下没有归属过滤，这句话照旧按招式读（能量不够，按规则拒绝而不是静默）
    assert.notEqual(acted.text, '');
    assert.match(acted.text, /能量|大招/);
    assert.equal(acted.battle?.pending, null);
  });

  it('单人局不受影响：strict 与 off 的播报完全一致', async () => {
    const strict = setup({ attribution: 'strict' });
    const off = setup();
    await strict.service.start(HOST);
    await off.service.start(HOST);

    for (const text of ['蓝方大招', '红方普攻', '我稳如泰山']) {
      const strictResult = await strict.service.say(HOST, text);
      const offResult = await off.service.say(HOST, text);
      assert.equal(strictResult.text, offResult.text, `单人局 ${text} 不应受策略影响`);
      assert.equal(strictResult.battle?.history.length, offResult.battle?.history.length);
    }
  });
});

/** 严格模式下摘掉口令之后的原话必须照常认得出来，否则带口令就等于说不出招 */
describe('严格模式下带口令的原话', () => {
  it('「红方，开大」按大招判，不是没听清', async () => {
    const { service } = await openTable({ attribution: 'strict' });
    const res = await service.say(HOST, '红方，开大');
    assert.doesNotMatch(res.text, /没听清/);
    assert.match(res.text, /大招要4点/, '应走到结算，按能量不足拒绝');
  });

  it('「红方，普攻」当值就能出招', async () => {
    const { service } = await openTable({ attribution: 'strict' });
    const res = await service.say(HOST, '红方，普攻');
    assert.equal(res.battle?.pending?.move, 'light');
  });

  it('只报座位不谈招式：回一句自报座位，不动对局', async () => {
    const { service } = await openTable({ attribution: 'strict' });
    const bare = await service.say(HOST, '红方');
    assert.match(bare.text, /红方这边，我在听/);
    assert.equal(bare.battle?.pending ?? null, null);
  });

  it('对方座位口令的句子既不执行也不提醒', async () => {
    const { service } = await openTable({ attribution: 'strict' });
    const wrong = await service.say(GUEST, '红方，开大');
    assert.equal(wrong.text, '');
    assert.equal(wrong.battle?.pending ?? null, null);
  });
});
