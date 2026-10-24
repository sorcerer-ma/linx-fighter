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
  narrateOpening,
  narrateOutsideUnavailable,
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
  narrateUnknownAction,
} from '../src/game/narrator.js';
import type { Battle, BattleEvent } from '../src/game/types.js';

function battle(firstMover: 'player' | 'enemy' = 'player', mode: 'solo' | 'pvp' = 'solo'): Battle {
  return createBattle({ now: 0, seed: 1, firstMover, mode });
}

/** 一句播报最多两句，句内不超过 60 字（数字与标点也按字符算） */
function assertSpeakable(text: string): void {
  const sentences = text.split(/[。！？]/).filter((part) => part.trim().length > 0);
  assert.ok(sentences.length <= 2, `最多两句，实际 ${sentences.length} 句：${text}`);
  for (const sentence of sentences) {
    assert.ok(sentence.length <= 60, `单句过长（${sentence.length} 字）：${sentence}`);
  }
}

describe('开局与状态播报', () => {
  it('开局用伙伴视角说清对手、先手与初始生命值', () => {
    const text = narrateBattleStart(battle());
    assert.match(text, /对决开始/);
    assert.match(text, /守擂教头/);
    assert.match(text, /我先手/);
    assert.match(text, /我14点生命值/);
    assert.match(text, /守擂教头18点生命值/);
    assertSpeakable(text);
  });

  it('对手先手时说明对手先手', () => {
    assert.match(narrateBattleStart(battle('enemy')), /对手先手/);
  });

  it('开局补一句下一手该谁，恰好两句', () => {
    const playerFirst = narrateOpening(battle());
    assert.match(playerFirst, /该我出招/);
    assert.match(playerFirst, /说普攻、强攻、大招或蓄力/);
    assertSpeakable(playerFirst);

    const enemyFirst = battle('enemy');
    enemyFirst.pending = { actor: 'enemy', move: 'heavy', damage: 5 };
    const responseFirst = narrateOpening(enemyFirst);
    assert.match(responseFirst, /对手强攻还没结算/);
    assert.match(responseFirst, /格挡、闪避，还是承受/);
    assertSpeakable(responseFirst);
  });

  it('自动开局提示会拼在回合播报前', () => {
    assert.match(narrateAutoStart(battle()), /先开一局/);
  });

  it('战况说明轮次、双方生命值与大招次数', () => {
    const text = narrateStatus(battle());
    assert.match(text, /第1轮/);
    assert.match(text, /我14点生命值/);
    assert.match(text, /对手18点生命值/);
    assert.match(text, /我还剩一次大招/);
    assert.match(text, /对手还剩一次/);
    assert.match(text, /该我出招，听你的/);
    assertSpeakable(text);
  });

  it('大招用过以后，战况用掉与剩下分开说', () => {
    const state = battle();
    state.player.ultLeft = 0;
    const text = narrateStatus(state);
    assert.match(text, /我的大招已经用掉/);
    assert.match(text, /对手还剩一次/);
  });

  it('待应对时战况提示对手的招式还没结算', () => {
    const state = battle();
    state.pending = { actor: 'enemy', move: 'heavy', damage: 5 };
    const text = narrateStatus(state);
    assert.match(text, /对手强攻还没结算/);
    assert.match(text, /格挡、闪避，还是承受/);
    assertSpeakable(text);
  });

  it('自己已出手、等对手应对时，战况不会说错方向，也不会超两句', () => {
    const state = battle('player', 'pvp');
    state.pending = { actor: 'player', move: 'light', damage: 3 };
    const text = narrateStatus(state);
    // 「接招！等对手应对」本身占两句，拼上资源句会变三句，战况这里要压成一句
    assert.match(text, /我出普攻了，等对手应对/);
    assertSpeakable(text);
  });

  it('房间还在等人时战况只报事实，不催出招', () => {
    const state = battle('player', 'pvp');
    const text = narrateStatus(state, { waiting: true });
    assert.match(text, /第1轮/);
    assert.match(text, /我14点生命值/);
    assert.doesNotMatch(text, /该我出招/);
    assertSpeakable(text);
  });

  it('双人房里战况会说明轮到谁出招', () => {
    const state = battle('player', 'pvp');
    assert.match(narrateStatus(state), /该我出招，听你的/);
    state.active = 'enemy';
    assert.match(narrateStatus(state), /等对手出招/);
  });

  it('对局结束后不再报轮次，只报胜负与重开提示', () => {
    const state = battle();
    state.phase = 'victory';
    assert.equal(narrateEnded(state), '我赢了，击倒对手啦。说「开始游戏」可以再来一局。');
    assert.equal(narrateStatus(state), narrateEnded(state));
    assertSpeakable(narrateStatus(state));

    const lost = battle();
    lost.phase = 'defeat';
    assert.equal(narrateEnded(lost), '我被击倒了，这局输了。说「开始游戏」可以再来一局。');
    assertSpeakable(narrateEnded(lost));
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
  it('蓄力用伙伴视角报能量涨到几点', () => {
    const state = battle();
    const events: BattleEvent[] = [{ type: 'charge', round: 1, side: 'player', ap: 4 }];
    assert.match(narrateTurn(state, events), /我凝神蓄力，能量涨到4/);
  });

  it('对手攻击待应对时说明还没结算、只能三选一', () => {
    const state = battle();
    const events: BattleEvent[] = [{ type: 'pending', round: 1, side: 'enemy', move: 'ult' }];
    const text = narrateTurn(state, events);
    assert.match(text, /对手大招还没结算/);
    assert.match(text, /格挡、闪避，还是承受/);
    assertSpeakable(text);
  });

  it('自己出招锁定后只说已出手，不提前宣布命中', () => {
    const state = battle('player', 'pvp');
    state.pending = { actor: 'player', move: 'heavy', damage: 5 };
    const events: BattleEvent[] = [{ type: 'pending', round: 1, side: 'player', move: 'heavy' }];
    const text = narrateTurn(state, events);
    assert.match(text, /我出强攻，接招！等对手应对/);
    assert.doesNotMatch(text, /掉\d+点生命值/);
    assertSpeakable(text);
  });

  it('格挡、闪避成功、闪避失败与承受各有说法', () => {
    const state = battle();
    const attack = (over: Partial<Extract<BattleEvent, { type: 'attack' }>>): BattleEvent[] => [
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
        ...over,
      },
    ];

    assert.match(narrateTurn(state, attack({})), /我强攻，对手格挡，掉3点生命值，剩15/);
    assert.match(narrateTurn(state, attack({ dodged: true, damage: 0 })), /我强攻，对手闪开了/);
    assert.match(
      narrateTurn(state, attack({ response: 'dodge', dodged: false, damage: 7, targetHp: 11 })),
      /对手没躲开，掉7点生命值，剩11/,
    );
    assert.match(
      narrateTurn(state, attack({ response: 'take', forced: false, damage: 5, targetHp: 13 })),
      /对手承受，掉5点生命值，剩13/,
    );
    assert.match(
      narrateTurn(state, attack({ response: 'take', forced: true, guarded: false, damage: 5, targetHp: 13 })),
      /对手没能量，只能硬扛/,
    );
  });

  it('本方受击时用我承受，闪避成功说自己躲开', () => {
    const state = battle();
    const incoming = (over: Partial<Extract<BattleEvent, { type: 'attack' }>>): BattleEvent[] => [
      {
        type: 'attack',
        round: 2,
        side: 'enemy',
        move: 'heavy',
        response: 'guard',
        dodged: false,
        crit: false,
        guarded: true,
        forced: false,
        damage: 3,
        targetHp: 11,
        ...over,
      },
    ];

    assert.match(narrateTurn(state, incoming({})), /对手强攻，我格挡，掉3点生命值，剩11/);
    assert.match(narrateTurn(state, incoming({ dodged: true, damage: 0 })), /对手强攻，我躲开啦/);
    assert.match(
      narrateTurn(state, incoming({ response: 'take', forced: false, damage: 5, targetHp: 9 })),
      /我承受，掉5点生命值，剩9/,
    );
    assert.match(
      narrateTurn(state, incoming({ response: 'take', forced: true, damage: 5, targetHp: 9 })),
      /我没能量，只能硬扛/,
    );
  });

  it('第 3 轮开头提示伤害加成，同时补上下一手', () => {
    const state = battle();
    const events: BattleEvent[] = [{ type: 'round-start', round: 3, bonus: 2 }];
    const text = narrateTurn(state, events);
    assert.match(text, /第三轮开始/);
    assert.match(text, /伤害每轮加2/);
    assert.match(text, /该我出招，听你的/);
    assertSpeakable(text);
  });

  it('没有待应对时补一句该谁出手，仍然最多两句', () => {
    const state = battle();
    const events: BattleEvent[] = [
      { type: 'charge', round: 1, side: 'player', ap: 4 },
      { type: 'round-start', round: 2, bonus: 0 },
    ];
    const text = narrateTurn(state, events);
    assert.match(text, /该我出招，听你的/);
    assertSpeakable(text);

    state.active = 'enemy';
    const waiting = narrateTurn(state, events);
    assert.match(waiting, /等对手出招/);
    assertSpeakable(waiting);
  });

  it('闪避成功那句以 ！ 收尾时，并进下一手提示不会念出「！，」', () => {
    const state = battle('player', 'pvp');
    state.active = 'enemy';
    const events: BattleEvent[] = [
      {
        type: 'attack',
        round: 2,
        side: 'enemy',
        move: 'heavy',
        response: 'dodge',
        dodged: true,
        crit: false,
        guarded: false,
        forced: false,
        damage: 0,
        targetHp: 11,
      },
    ];
    const text = narrateTurn(state, events);
    // 感叹号后面直接接下一句提示，不再补「。」或逗号
    assert.match(text, /对手强攻，我躲开啦！等对手出招/);
    assert.doesNotMatch(text, /！[，。]/);
    assertSpeakable(text);
  });

  it('补账只复述结算，不补已经过时的下一手提示', () => {
    const state = battle();
    const events: BattleEvent[] = [
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
    const replay = narrateTurn(state, events, { hint: false });
    assert.match(replay, /我强攻，对手格挡，掉3点生命值，剩15/);
    assert.doesNotMatch(replay, /听你的|等对手出招/);
    assertSpeakable(replay);
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
    assert.match(text, /我赢了，击倒对手啦/);
    assertSpeakable(text);
  });

  it('没有事件时回退成战况播报', () => {
    assert.equal(narrateTurn(battle(), []), narrateStatus(battle()));
  });
});

describe('提示与房间播报', () => {
  it('认不出招式时按阶段给可选说法，不推进对局', () => {
    const state = battle();
    const active = narrateUnknownAction(state);
    assert.match(active, /没听清这一手/);
    assert.match(active, /普攻/);
    assertSpeakable(active);

    state.pending = { actor: 'enemy', move: 'light', damage: 3 };
    const response = narrateUnknownAction(state);
    assert.match(response, /格挡/);
    assert.doesNotMatch(response, /普攻、强攻/);
    assertSpeakable(response);
  });

  it('没轮到自己出招时不会催玩家出招', () => {
    const state = battle('enemy');
    state.pending = null;
    assert.match(narrateUnknownAction(state), /还没轮到我出招/);
  });

  it('双人房里已出手的一方再开口，只提示等对手应对', () => {
    const state = battle('player', 'pvp');
    state.pending = { actor: 'player', move: 'light', damage: 3 };
    const text = narrateUnknownAction(state);
    assert.match(text, /等对手应对/);
    assertSpeakable(text);
  });

  it('六种不合法原因都有玩家能听懂的解释', () => {
    const state = battle();
    assert.match(narrateRejection(state, { reason: 'wrong-stage', action: 'light' }), /该我出招了/);
    const enemyTurn = battle();
    enemyTurn.active = 'enemy';
    assert.match(narrateRejection(enemyTurn, { reason: 'wrong-stage', action: 'light' }), /等对手先动/);
    const pending = battle();
    pending.pending = { actor: 'enemy', move: 'light', damage: 3 };
    assert.match(narrateRejection(pending, { reason: 'wrong-stage', action: 'light' }), /我只能格挡、闪避或承受/);
    assert.match(narrateRejection(state, { reason: 'waiting-opponent', action: 'guard' }), /等对手应对/);
    assert.match(narrateRejection(state, { reason: 'no-ult', action: 'ult' }), /这一局用过了/);
    assert.match(narrateRejection(state, { reason: 'full-ap', action: 'charge' }), /已经满了/);
    const ended = battle();
    ended.phase = 'defeat';
    assert.match(narrateRejection(ended, { reason: 'ended', action: 'light' }), /这局输了/);
  });

  it('能量不够时说清差多少，并给当前阶段能走的路', () => {
    const state = battle();
    state.player.ap = 1;
    const active = narrateRejection(state, { reason: 'insufficient-ap', action: 'ult' });
    assert.match(active, /我只有1点能量，大招要4点/);
    assert.match(active, /可以先蓄力/);
    assertSpeakable(active);

    state.pending = { actor: 'enemy', move: 'heavy', damage: 5 };
    const response = narrateRejection(state, { reason: 'insufficient-ap', action: 'guard' });
    assert.match(response, /格挡要1点/);
    assert.match(response, /只能承受/);
    assertSpeakable(response);
  });

  it('念唤出指令会先回念一句', () => {
    assert.equal(narrateChant('共鸣斩破军'), '你朗声喝道：「共鸣斩破军」。');
  });

  it('房间相关播报都包含四位房间号', () => {
    assert.match(narrateRoomCreated('1234'), /房间1234/);
    assert.match(narrateRoomCreated('1234'), /加入房间1234/);
    assert.match(narrateRoomJoined('1234'), /进了房间1234/);
    assert.match(narrateWaitingRoom('1234'), /还等着另一位玩家加入/);
    assert.match(narrateRoomMissing('1234'), /没找到房间1234/);
    assert.match(narrateRoomFull('1234'), /已经满员/);
    assert.match(narrateRoomInvalid(), /四位数字/);
  });
});

describe('补账播报', () => {
  it('把错过的结算串成一段，补一次就够', () => {
    const text = narrateCatchUp(['我强攻，对手格挡，掉5点生命值，剩13。']);
    assert.equal(text, '刚才那一手。我强攻，对手格挡，掉5点生命值，剩13。');
  });

  it('攒多了只补最近两段，不把播报拖长', () => {
    const text = narrateCatchUp(['第一手。', '第二手。', '第三手。']);
    assert.equal(text, '刚才那一手。第二手。第三手。');
  });
});

describe('规则外问答的兜底', () => {
  it('答不上来时给一句台阶，不打断对局', () => {
    const text = narrateOutsideUnavailable();
    assert.match(text, /暂时答不上来/);
    assert.match(text, /游戏里的事/);
    assert.doesNotMatch(text, /生命值|能量|大招/);
    assertSpeakable(text);
  });
});

describe('不该出手的表达', () => {
  it('否定与歧义都说清没出手，不报数值', () => {
    const negated = narrateActionBlocked('negated');
    assert.match(negated, /没打出去/);
    assert.doesNotMatch(negated, /生命值|能量/);
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
