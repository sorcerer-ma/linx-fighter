import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { GameService } from '../src/game/service.js';
import { createLogger } from '../src/log.js';
import { BattleStore } from '../src/store/battles.js';
import { RoomStore } from '../src/store/rooms.js';

/**
 * 说话人校验：没登记的声音不回应，已登记的也只在轮到自己时接话。
 * 名单为空时完全等于引入前行为，这条由其它用例继续兜着。
 */

const HOST = 'device-a#agent-1';
const GUEST = 'device-b#agent-2';
const SILENT = '\u200b';

function setup(speakers: string[]) {
  let now = 1_000_000;
  const store = new BattleStore({ ttlMs: 60_000, now: () => now });
  const rooms = new RoomStore({ ttlMs: 60_000, now: () => now, random: () => 0 });
  const service = new GameService({
    store,
    rooms,
    logger: createLogger('error'),
    now: () => now,
    random: () => 0,
    speakers,
  });
  return { service, store, rooms };
}

/** 静默就是什么也不播：回包只留一个读不出来的零宽字符 */
function assertSilent(text: string, hint: string): void {
  assert.equal(text, SILENT, `${hint}：应静默（实际「${text}」）`);
}

describe('说话人校验与轮次归属', () => {
  it('名单外的人说招式、查战况都不回应', async () => {
    const { service } = setup(['阿澈', '阿岚']);

    assertSilent((await service.say(HOST, '普攻', { speaker: '陌生人' })).text, '名单外的人说招');
    assertSilent(service.status(HOST, { speaker: '陌生人' }).text, '名单外的人查战况');
    // 静默不等于偷偷开局或推进
    assert.equal(service.snapshot(HOST), null);
  });

  it('没拿到名字（声纹没识别）也不回应', async () => {
    const { service } = setup(['阿澈', '阿岚']);
    assertSilent((await service.say(HOST, '普攻')).text, '没名字');
  });

  it('名单外的设备调用挂起等对手时也不回应，不会把请求占住', async () => {
    const { service } = setup(['阿澈']);
    await service.say(HOST, '开始游戏', { speaker: '阿澈' });

    const startedAt = Date.now();
    const result = await service.wait(HOST, { timeoutMs: 5000, speaker: '陌生人' });

    assertSilent(result.text, '名单外的设备等对手');
    // 没被挂住：不许挂满超时才回，否则占着连接白等
    assert.ok(Date.now() - startedAt < 500, '应立刻返回');
  });

  it('名单为空时不设限，行为和以前一样', async () => {
    const { service } = setup([]);
    const started = await service.say(HOST, '普攻');
    assert.match(started.text, /普攻|出招/);
  });

  it('单人局：开局的人认领座位，另一个人说话不回应', async () => {
    const { service } = setup(['阿澈', '阿岚']);
    await service.start(HOST, { speaker: '阿澈' });

    const mine = await service.say(HOST, '普攻', { speaker: '阿澈' });
    assert.doesNotMatch(mine.text, /^$/);
    assert.notEqual(mine.text, SILENT, '本人出手要正常播报');

    assertSilent((await service.say(HOST, '大招', { speaker: '阿岚' })).text, '别人替我说招');
  });

  it('双人房：轮到你才回应，另一边的声音一并不理', async () => {
    const { service } = setup(['阿澈', '阿岚']);
    await service.start(HOST, { mode: 'pvp', speaker: '阿澈' });
    const code = service.status(HOST, { speaker: '阿澈' }).text.match(/编号(\d{4})/)![1]!;
    await service.start(GUEST, { room: code, speaker: '阿岚' });

    // 房主先手：先由房主出招，出完之后轮到加入者应对
    const first = await service.say(HOST, '普攻', { speaker: '阿澈' });
    assert.notEqual(first.text, SILENT, '房主出招要正常播报');

    // 这一手还在等加入者应对时，阿澈替对方应对要被挡掉
    assertSilent((await service.say(HOST, '格挡', { speaker: '阿岚' })).text, '串到房主设备上');

    // 加入者用自己的座位应对则放行
    const response = await service.say(GUEST, '格挡', { speaker: '阿岚' });
    assert.notEqual(response.text, SILENT, '加入者应对要正常播报');
  });

  it('别人在对方回合插话，本机完全不回应', async () => {
    const { service } = setup(['阿澈', '阿岚']);
    await service.start(HOST, { mode: 'pvp', speaker: '阿澈' });
    const code = service.status(HOST, { speaker: '阿澈' }).text.match(/编号(\d{4})/)![1]!;
    await service.start(GUEST, { room: code, speaker: '阿岚' });

    // 开局轮到房主：加入者这边说什么都不能有反应
    assertSilent((await service.say(GUEST, '普攻', { speaker: '阿岚' })).text, '没轮到还出手');
    const mine = await service.say(HOST, '普攻', { speaker: '阿澈' });
    assert.notEqual(mine.text, SILENT, '轮到自己要说得出话');
  });

  it('同一台设备换人重开：新局重新认领座位，上一局的人被挡下', async () => {
    const { service } = setup(['阿澈', '阿岚']);
    await service.start(HOST, { speaker: '阿澈' });
    // 同一台设备换人重开：座位绑定要跟着新局走，不能还认上一局的阿澈
    await service.start(HOST, { speaker: '阿岚' });

    const replacer = await service.say(HOST, '普攻', { speaker: '阿岚' });
    assert.notEqual(replacer.text, SILENT, '新局由阿岚认领座位，应该正常播报');
    assertSilent((await service.say(HOST, '大招', { speaker: '阿澈' })).text, '上一局的阿澈不该再被认');
  });

  it('房间号复用不继承上一局席位：新局两位说话人都能重新认领', async () => {
    const { service } = setup(['阿澈', '阿岚', '阿远', '阿宁']);
    await service.start(HOST, { mode: 'pvp', speaker: '阿澈' });
    const code = service.status(HOST, { speaker: '阿澈' }).text.match(/编号(\d{4})/)![1]!;
    await service.start(GUEST, { room: code, speaker: '阿岚' });

    // 房主带人重开：旧房被撤，random 固定为 0，新房间还是同一个号码
    await service.start(HOST, { mode: 'pvp', speaker: '阿远' });
    const reused = service.status(HOST, { speaker: '阿远' }).text.match(/编号(\d{4})/)![1]!;
    assert.equal(reused, code, '房间号应被复用');
    await service.start(GUEST, { room: reused, speaker: '阿宁' });

    // 房主先手：上一局的阿澈、阿岚已作废，这一局的两个人都要正常播报
    const first = await service.say(HOST, '普攻', { speaker: '阿远' });
    assert.notEqual(first.text, SILENT, '新局房主出招要正常播报');
    const second = await service.say(GUEST, '格挡', { speaker: '阿宁' });
    assert.notEqual(second.text, SILENT, '新局加入者应对要正常播报');
  });

  it('空设备自动开局：第一句话的人绑定座位，第二个人抢不走', async () => {
    const { service } = setup(['阿澈', '阿岚']);
    const started = await service.say(HOST, '普攻', { speaker: '阿澈' });
    assert.notEqual(started.text, SILENT, '自动开局的一手要正常播报');

    assertSilent((await service.say(HOST, '格挡', { speaker: '阿岚' })).text, '自动开局后另一个人说话不该认领座位');

    const again = await service.say(HOST, '格挡', { speaker: '阿澈' });
    assert.notEqual(again.text, SILENT, '开局人应招要正常播报');
  });
});
