import assert from 'node:assert/strict';
import { it } from 'node:test';
import type { BattleState } from '../src/game/state.js';

// 页面纯函数是浏览器 ES 模块，测试直接按 URL 导入，不经过打包。
const { actionBarView } = await import(new URL('../sandbox/public/actions.js', import.meta.url).href);

function battle(overrides: Partial<BattleState> = {}): BattleState {
  return {
    battleId: 'test-battle', room: '1234', mode: 'pvp', side: 'player', phase: 'battle', round: 1,
    active: 'player', firstMover: 'player', pending: null, waiting: false,
    you: { name: '伙伴', hp: 14, maxHp: 14, ap: 4, maxAp: 5, ultLeft: 1 },
    opponent: { name: '对手', hp: 18, maxHp: 18, ap: 3, maxAp: 5, ultLeft: 1 },
    winner: null, history: [], updatedAt: 1, ...overrides,
  };
}

function labels(view: { buttons: Array<{ label: string }> }): string[] {
  return view.buttons.map((button) => button.label);
}

function byId(view: { buttons: Array<{ id: string }> }, id: string): any {
  return view.buttons.find((button) => button.id === id);
}

it('没有对局时不出按钮，等待房只提示等对手加入', () => {
  assert.deepEqual(actionBarView(null, {}), { mode: 'lobby', hint: '', buttons: [], utility: null });
  assert.deepEqual(actionBarView(null), { mode: 'lobby', hint: '', buttons: [], utility: null });
  const waiting = actionBarView(battle({ waiting: true }), { connected: true });
  assert.equal(waiting.mode, 'waiting');
  assert.deepEqual(waiting.buttons, []);
  assert.match(waiting.hint, /等对手加入/);
});

it('轮到主动阶段给四个中文招式按钮，按快照能量禁用不够的', () => {
  const view = actionBarView(battle(), { connected: true });
  assert.equal(view.mode, 'active');
  assert.deepEqual(labels(view), ['普攻', '强攻', '蓄力', '大招']);
  assert.deepEqual(view.buttons.map((button: any) => button.command), ['普攻', '强攻', '蓄力', '大招']);
  // 按钮自带能量消耗，页面直接标在招名后面。
  assert.deepEqual(view.buttons.map((button: any) => button.apCost), [1, 2, 0, 4]);
  // 4 点能量：普攻、强攻、蓄力可点，大招也够但本局还有次数，一起可点
  assert.deepEqual(view.buttons.map((button: any) => button.disabled), [false, false, false, false]);

  const low = actionBarView(battle({ you: { ...battle().you, ap: 3 } }), { connected: true });
  assert.deepEqual(low.buttons.map((button: any) => button.disabled), [false, false, false, true]);
  assert.equal(byId(low, 'ult').note, '需要4点能量');

  const empty = actionBarView(battle({ you: { ...battle().you, ap: 0 } }), { connected: true });
  assert.deepEqual(empty.buttons.map((button: any) => button.disabled), [true, true, false, true]);
  assert.equal(byId(empty, 'charge').disabled, false);

  const spent = actionBarView(battle({ you: { ...battle().you, ultLeft: 0 } }), { connected: true });
  assert.equal(byId(spent, 'ult').disabled, true);
  assert.equal(byId(spent, 'ult').note, '本局已用');
});

it('对手已锁定招式时给三个应对，并提示招式与伤害', () => {
  const view = actionBarView(battle({
    active: 'player',
    pending: { actor: 'enemy', move: 'heavy', moveLabel: '强攻', damage: 7 },
  }), { connected: true });
  assert.equal(view.mode, 'respond');
  assert.deepEqual(labels(view), ['格挡', '闪避', '承受']);
  assert.ok(view.hint.includes('强攻'));
  assert.ok(view.hint.includes('7'));
  assert.deepEqual(view.buttons.map((button: any) => button.disabled), [false, false, false]);

  const noAp = actionBarView(battle({
    you: { ...battle().you, ap: 0 },
    pending: { actor: 'enemy', move: 'light', moveLabel: '普攻', damage: 3 },
  }), { connected: true });
  assert.equal(byId(noAp, 'guard').disabled, true);
  assert.equal(byId(noAp, 'dodge').disabled, true);
  assert.equal(byId(noAp, 'take').disabled, false);
});

it('等待对手时按钮保留但禁用，不突然消失', () => {
  const locked = actionBarView(battle({
    pending: { actor: 'player', move: 'heavy', moveLabel: '强攻', damage: 5 },
  }), { connected: true });
  assert.equal(locked.mode, 'wait');
  assert.deepEqual(labels(locked), ['普攻', '强攻', '蓄力', '大招']);
  assert.ok(locked.buttons.every((button: any) => button.disabled));
  assert.ok(locked.hint.includes('强攻'));
  assert.ok(locked.hint.includes('等对手应对'));

  const opponentTurn = actionBarView(battle({ active: 'enemy' }), { connected: true });
  assert.equal(opponentTurn.mode, 'wait');
  assert.ok(opponentTurn.buttons.every((button: any) => button.disabled));
  assert.match(opponentTurn.hint, /对手正在行动/);
});

it('忙碌与断线时保留同一组按钮，只禁用并说明原因', () => {
  const busy = actionBarView(battle(), { busy: true, connected: true });
  assert.equal(busy.mode, 'active');
  assert.equal(busy.buttons.length, 4);
  assert.ok(busy.buttons.every((button: any) => button.disabled));
  assert.match(busy.hint, /正在等伙伴回复/);

  const offline = actionBarView(battle(), { connected: false });
  assert.equal(offline.mode, 'active');
  assert.equal(offline.buttons.length, 4);
  assert.ok(offline.buttons.every((button: any) => button.disabled));
  assert.match(offline.hint, /连接断开/);
});

it('进行中的双人局在招式网格外提供退出按钮，单人局没有', () => {
  const pvp = actionBarView(battle(), { connected: true });
  assert.equal(pvp.utility.id, 'leave');
  assert.equal(pvp.utility.label, '退出房间');
  assert.equal(pvp.utility.command, '退出房间');
  assert.match(pvp.utility.confirm, /判负/);
  assert.equal(pvp.utility.disabled, false);

  const solo = actionBarView(battle({ mode: 'solo', room: null }), { connected: true });
  assert.equal(solo.utility, null);

  const waiting = actionBarView(battle({ waiting: true }), { connected: true });
  assert.equal(waiting.utility, null);

  // 结束态双人已有「回到大厅」，不再重复给退出按钮；单人只给「再来一局」。
  const endedPvp = actionBarView(battle({ phase: 'victory' }), { connected: true });
  assert.equal(endedPvp.utility, null);
  const endedSolo = actionBarView(battle({ phase: 'defeat', mode: 'solo', room: null }), { connected: true });
  assert.equal(endedSolo.utility, null);

  // 退出入口的禁用条件跟随忙碌/断线，和招式按钮一致。
  const busy = actionBarView(battle(), { busy: true });
  assert.equal(busy.utility.disabled, true);
  const offline = actionBarView(battle(), { connected: false });
  assert.equal(offline.utility.disabled, true);
});

it('结束态双人只给回到大厅，单人给再来一局', () => {
  for (const phase of ['victory', 'defeat'] as const) {
    const pvp = actionBarView(battle({ phase }), { connected: true });
    assert.equal(pvp.mode, 'ended');
    assert.deepEqual(labels(pvp), ['回到大厅']);
    assert.equal(pvp.buttons[0].command, '退出房间');
    assert.ok(!pvp.buttons.some((button: any) => button.command === '再来一局'));

    const solo = actionBarView(battle({ phase, mode: 'solo', room: null }), { connected: true });
    assert.equal(solo.mode, 'ended');
    assert.deepEqual(labels(solo), ['再来一局']);
    assert.equal(solo.buttons[0].command, '再来一局');
  }
});

it('结束态断线时按钮保留但禁用', () => {
  const view = actionBarView(battle({ phase: 'victory' }), { connected: false });
  assert.equal(view.mode, 'ended');
  assert.equal(view.buttons.length, 1);
  assert.equal(view.buttons[0].disabled, true);
  assert.match(view.hint, /连接断开/);
});
