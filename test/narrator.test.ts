import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createBattle } from '../src/game/engine.js';
import {
  narrateActionBlocked,
  narrateAutoStart,
  narrateBattleStart,
  narrateCatchUp,
  narrateChant,
  narrateEnded,
  narrateHelp,
  narrateNoBattle,
  narrateRejection,
  narrateRoomCreated,
  narrateRoomFull,
  narrateRoomInvalid,
  narrateRoomJoined,
  narrateRoomMissing,
  narrateStaleAction,
  narrateWaitingRoom,
  narrateStatus,
  narrateTurn,
  narrateTurnHint,
  narrateUnknownAction,
} from '../src/game/narrator.js';
import type { Battle, BattleEvent } from '../src/game/types.js';

function battle(firstMover: 'player' | 'enemy' = 'player', mode: 'solo' | 'pvp' = 'solo'): Battle {
  return createBattle({ now: 0, seed: 1, firstMover, mode });
}

/** 一句播报最多两句，句内不超过 60 字（数字与标点也按字符算） */
function assertSpeakable(text: string): void {
  const sentences = text.split('。').filter((part) => part.trim().length > 0);
  assert.ok(sentences.length <= 2, `最多两句，实际 ${sentences.length} 句：${text}`);
  for (const sentence of sentences) {
    assert.ok(sentence.length <= 60, `单句过长（${sentence.length} 字）：${sentence}`);
  }
}

describe('开局与状态播报', () => {
  it('开局说清对手、先手与初始气血', () => {
    const text = narrateBattleStart(battle());
    assert.match(text, /对决开始/);
    assert.match(text, /守擂教头/);
    assert.match(text, /你先手/);
    assert.match(text, /14/);
    assert.match(text, /18/);
    assertSpeakable(text);
  });

  it('对手先手时说明对手先手', () => {
    assert.match(narrateBattleStart(battle('enemy')), /对手先手/);
  });

  it('自动开局提示会拼在回合播报前', () => {
    assert.match(narrateAutoStart(battle()), /先开一局/);
  });

  it('战况说明轮次、双方气血真气', () => {
    const text = narrateStatus(battle());
    assert.match(text, /第1轮/);
    assert.match(text, /气血14\/14/);
    assert.match(text, /真气3/);
    assertSpeakable(text);
  });

  it('待应对时战况提示对手的招式还等着应对', () => {
    const state = battle();
    state.pending = { actor: 'enemy', move: 'heavy', damage: 5 };
    assert.match(narrateStatus(state), /强攻还等着你应对/);
  });

  it('自己已出手、等对手应对时，战况不会说错方向', () => {
    const state = battle('player', 'pvp');
    state.pending = { actor: 'player', move: 'light', damage: 3 };
    assert.match(narrateStatus(state), /你的.*已出手，等对手应对/);
  });

  it('双人房里战况会说明轮到谁出招', () => {
    const state = battle('player', 'pvp');
    assert.equal(narrateTurnHint(state), '轮到你出招');
    assert.match(narrateStatus(state), /轮到你出招/);
    state.active = 'enemy';
    assert.equal(narrateTurnHint(state), '等对手出招');
    assert.match(narrateStatus(state), /等对手出招/);
  });

  it('对局结束后不再报轮次，只报胜负与重开提示', () => {
    const state = battle();
    state.phase = 'victory';
    assert.equal(narrateEnded(state), '你赢了。说「开始游戏」可以再来一局。');
    assert.equal(narrateStatus(state), narrateEnded(state));
    assertSpeakable(narrateStatus(state));
  });

  it('没有对局与玩法说明都能直接念出来', () => {
    assertSpeakable(narrateNoBattle());
    assert.match(narrateNoBattle(), /开始游戏/);
    const help = narrateHelp();
    assert.match(help, /普攻/);
    assert.match(help, /格挡/);
    assertSpeakable(help);
  });
});

describe('回合播报', () => {
  it('蓄力报真气涨到几点', () => {
    const state = battle();
    const events: BattleEvent[] = [{ type: 'charge', round: 1, side: 'player', ap: 4 }];
    assert.match(narrateTurn(state, events), /蓄力，真气涨到4/);
  });

  it('攻击待应对时说明已锁定、只能三选一', () => {
    const state = battle();
    const events: BattleEvent[] = [{ type: 'pending', round: 1, side: 'enemy', move: 'ult' }];
    const text = narrateTurn(state, events);
    assert.match(text, /大招已锁定/);
    assert.match(text, /格挡、闪避或硬抗/);
    assertSpeakable(text);
  });

  it('格挡掉血、闪避成功、闪避失败与硬扛各有说法', () => {
    const state = battle();
    const guarded: BattleEvent[] = [
      {
        type: 'attack',
        round: 1,
        side: 'player',
        move: 'heavy',
        response: 'guard',
        dodged: false,
        crit: false,
        guarded: true,
        forced: false,
        damage: 3,
        targetHp: 15,
      },
    ];
    assert.match(narrateTurn(state, guarded), /格挡，掉3点气血，剩15/);

    const dodged: BattleEvent[] = [{ ...guarded[0], dodged: true, damage: 0 } as BattleEvent];
    assert.match(narrateTurn(state, dodged), /闪开了/);

    const hitDodge: BattleEvent[] = [
      { ...guarded[0], response: 'dodge', dodged: false, damage: 7, targetHp: 11 } as BattleEvent,
    ];
    assert.match(narrateTurn(state, hitDodge), /没躲干净/);

    const forced: BattleEvent[] = [
      { ...guarded[0], response: 'take', forced: true, guarded: false, damage: 5, targetHp: 13 } as BattleEvent,
    ];
    assert.match(narrateTurn(state, forced), /真气耗尽只能硬扛/);
  });

  it('第 3 轮开头提示伤害加成', () => {
    const state = battle();
    const events: BattleEvent[] = [{ type: 'round-start', round: 3, bonus: 2 }];
    const text = narrateTurn(state, events);
    assert.match(text, /第三轮开始/);
    assert.match(text, /伤害每轮加2/);
  });

  it('终局播报保留一条过程并给出胜负，仍然最多两句', () => {
    const state = battle();
    const events: BattleEvent[] = [
      {
        type: 'attack',
        round: 4,
        side: 'player',
        move: 'ult',
        response: 'take',
        dodged: false,
        crit: false,
        guarded: false,
        forced: false,
        damage: 9,
        targetHp: 0,
      },
      { type: 'end', round: 4, winner: 'player' },
    ];
    const text = narrateTurn(state, events);
    assert.match(text, /大招/);
    assert.match(text, /赢了这一局/);
    assertSpeakable(text);
  });

  it('没有事件时回退成战况播报', () => {
    assert.equal(narrateTurn(battle(), []), narrateStatus(battle()));
  });
});

describe('提示与房间播报', () => {
  it('认不出招式时按阶段给可选说法，不推进对局', () => {
    const state = battle();
    assert.match(narrateUnknownAction(state), /普攻/);
    state.pending = { actor: 'enemy', move: 'light', damage: 3 };
    const text = narrateUnknownAction(state);
    assert.match(text, /格挡/);
    assert.doesNotMatch(text, /普攻、强攻/);
    assertSpeakable(text);
  });

  it('双人房里已出手的一方再开口，只提示等对手应对', () => {
    const state = battle('player', 'pvp');
    state.pending = { actor: 'player', move: 'light', damage: 3 };
    const text = narrateUnknownAction(state);
    assert.match(text, /已经出手/);
    assertSpeakable(text);
  });

  it('六种不合法原因都有玩家能听懂的解释', () => {
    const state = battle();
    assert.match(narrateRejection(state, { reason: 'wrong-stage', action: 'light' }), /轮到你了/);
    const enemyTurn = battle();
    enemyTurn.active = 'enemy';
    assert.match(narrateRejection(enemyTurn, { reason: 'wrong-stage', action: 'light' }), /等对手先动/);
    const pending = battle();
    pending.pending = { actor: 'enemy', move: 'light', damage: 3 };
    assert.match(narrateRejection(pending, { reason: 'wrong-stage', action: 'light' }), /只能应对/);
    assert.match(narrateRejection(state, { reason: 'waiting-opponent', action: 'guard' }), /等对手应对/);
    assert.match(narrateRejection(state, { reason: 'insufficient-ap', action: 'heavy' }), /真气不够/);
    assert.match(narrateRejection(state, { reason: 'no-ult', action: 'ult' }), /已经用过了/);
    assert.match(narrateRejection(state, { reason: 'full-ap', action: 'charge' }), /已经满了/);
    const ended = battle();
    ended.phase = 'defeat';
    assert.match(narrateRejection(ended, { reason: 'ended', action: 'light' }), /你输了/);
  });

  it('念唤出指令会先回念一句', () => {
    assert.equal(narrateChant('共鸣斩破军'), '你朗声喝道：「共鸣斩破军」。');
  });

  it('房间相关播报都包含四位房间号', () => {
    assert.match(narrateRoomCreated('1234'), /房间1234/);
    assert.match(narrateRoomCreated('1234'), /加入房间1234/);
    assert.match(narrateRoomJoined('1234'), /进了房间1234/);
    assert.match(narrateWaitingRoom('1234'), /还等着对手加入/);
    assert.match(narrateRoomMissing('1234'), /没找到房间1234/);
    assert.match(narrateRoomFull('1234'), /已经满员/);
    assert.match(narrateRoomInvalid(), /四位数字/);
  });
});

describe('补账播报', () => {
  it('把错过的结算串成一段，补一次就够', () => {
    const text = narrateCatchUp(['你一记强攻，对手格挡，掉5点气血，剩13。']);
    assert.equal(text, '刚才那一手。你一记强攻，对手格挡，掉5点气血，剩13。');
  });

  it('攒多了只补最近两段，不把播报拖长', () => {
    const text = narrateCatchUp(['第一手。', '第二手。', '第三手。']);
    assert.equal(text, '刚才那一手。第二手。第三手。');
  });
});

describe('不该出手的表达', () => {
  it('否定与歧义都说清没出手，不报数值', () => {
    const negated = narrateActionBlocked('negated');
    assert.match(negated, /没打出去/);
    assert.doesNotMatch(negated, /气血|真气/);
    assertSpeakable(negated);

    const ambiguous = narrateActionBlocked('ambiguous');
    assert.match(ambiguous, /两种招式/);
    assertSpeakable(ambiguous);
  });

  it('局面变了让玩家重说，不再复述旧结果', () => {
    const text = narrateStaleAction();
    assert.match(text, /重新说/);
    assertSpeakable(text);
  });
});
