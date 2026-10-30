import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  deriveHud,
  HUD_TRANSIENT_MS,
  hudPayload,
  idleHud,
  type HudState,
} from '../src/game/hud.js';
import type { BattleState, HistoryEntryState } from '../src/game/state.js';

const NOW = 1_700_000_000_000;

/** 造一份玩家视角快照；默认满血 3 能量、轮到自己主动、没有待应对 */
function state(patch: Partial<BattleState> = {}): BattleState {
  const base: BattleState = {
    battleId: 'b1',
    room: '1234',
    mode: 'pvp',
    side: 'player',
    phase: 'battle',
    round: 1,
    active: 'player',
    firstMover: 'player',
    pending: null,
    waiting: false,
    you: { name: '我', hp: 14, maxHp: 14, ap: 3, maxAp: 5, ultLeft: 1 },
    opponent: { name: '对手', hp: 14, maxHp: 14, ap: 3, maxAp: 5, ultLeft: 1 },
    winner: null,
    history: [],
    updatedAt: NOW,
  };
  return { ...base, ...patch };
}

function history(patch: Partial<HistoryEntryState>): HistoryEntryState {
  return { round: 1, actor: 'player', action: 'light', actionLabel: '普攻', ...patch };
}

describe('待命帧', () => {
  it('不在对局里只给待命表情，资源置零', () => {
    const hud = idleHud(NOW);
    assert.equal(hud.battle, false);
    assert.equal(hud.expression, 'neutral');
    assert.equal(hud.hp, 0);
    assert.equal(hud.maxHp, 1, 'max_hp 不能为 0，设备会拿它做除数');
    assert.equal(hud.cue, null);
    assert.equal(hud.seq, 0);
  });

  it('没有对局时第一次派生得到 seq=1，之后再拉不涨帧号', () => {
    const first = deriveHud(null, null, NOW);
    assert.equal(first.seq, 1);
    const second = deriveHud(null, first, NOW + 10);
    assert.equal(second.seq, 1, '局面没变就不该涨帧号');
    assert.equal(second.cue, null);
  });
});

describe('对局中的表情', () => {
  it('轮到自己、没有战报时显示待命，生命与能量来自自己视角', () => {
    const hud = deriveHud(state({ you: { name: '我', hp: 9, maxHp: 14, ap: 2, maxAp: 5, ultLeft: 1 } }), null, NOW);
    assert.equal(hud.battle, true);
    assert.equal(hud.expression, 'neutral');
    assert.equal(hud.hp, 9);
    assert.equal(hud.maxHp, 14);
    assert.equal(hud.energy, 2);
    assert.equal(hud.maxEnergy, 5);
    assert.equal(hud.room, '1234');
    assert.equal(hud.holdMs, 0);
  });

  it('胜利与失败按阶段给表情，且不会自动回落', () => {
    const win = deriveHud(state({ phase: 'victory' }), null, NOW);
    assert.equal(win.expression, 'victory');
    assert.equal(win.cue, 'victory');
    assert.equal(win.holdMs, 0);
    const lose = deriveHud(state({ phase: 'defeat' }), null, NOW);
    assert.equal(lose.expression, 'defeat');
    assert.equal(lose.cue, 'defeat');
  });

  it('自己出手后短时显示进攻，过了窗口回到待命', () => {
    const battle = state({ history: [history({ actor: 'player', action: 'heavy', actionLabel: '强攻' })] });
    const fresh = deriveHud(battle, null, NOW);
    assert.equal(fresh.expression, 'attack');
    assert.equal(fresh.cue, 'attack');
    assert.equal(fresh.holdMs, HUD_TRANSIENT_MS);

    const stale = deriveHud(battle, fresh, NOW + HUD_TRANSIENT_MS + 1);
    assert.equal(stale.expression, 'neutral');
    assert.equal(stale.cue, null, '回落待命不发声');
  });

  it('对手命中自己显示受击，格挡与闪避各有表情', () => {
    const hurt = deriveHud(state({ history: [history({ actor: 'enemy', action: 'light', actionLabel: '普攻', damage: 3 })] }), null, NOW);
    assert.equal(hurt.expression, 'hurt');
    const guard = deriveHud(state({ history: [history({ actor: 'enemy', action: 'light', actionLabel: '普攻', response: 'guard', guarded: true })] }), null, NOW);
    assert.equal(guard.expression, 'guard');
    assert.equal(guard.cue, 'guard');
    const dodge = deriveHud(state({ history: [history({ actor: 'enemy', action: 'light', actionLabel: '普攻', response: 'dodge', dodged: true })] }), null, NOW);
    assert.equal(dodge.expression, 'dodge');
    assert.equal(dodge.cue, 'dodge');
  });

  it('自己进攻被对手闪避仍然算进攻表情', () => {
    const hud = deriveHud(state({ history: [history({ actor: 'player', action: 'light', actionLabel: '普攻', response: 'dodge', dodged: true })] }), null, NOW);
    assert.equal(hud.expression, 'attack');
  });

  it('等待对手加入时只显示待命', () => {
    const hud = deriveHud(state({ waiting: true }), null, NOW);
    assert.equal(hud.expression, 'neutral');
    assert.equal(hud.waiting, true);
  });
});

describe('大招徽记三态', () => {
  const ready = state({ you: { name: '我', hp: 14, maxHp: 14, ap: 4, maxAp: 5, ultLeft: 1 } });

  it('轮到自己、能量够且没有待应对时才显示可释放', () => {
    assert.equal(deriveHud(ready, null, NOW).ult, 1);
    const hud = deriveHud(ready, null, NOW);
    assert.equal(hud.expression, 'ultready');
    assert.equal(hud.cue, 'ult');
    assert.equal(hud.holdMs, 0);
  });

  it('轮到对手或还需要应对时不显示可释放', () => {
    assert.equal(deriveHud({ ...ready, active: 'enemy' }, null, NOW).ult, 0);
    assert.equal(deriveHud({ ...ready, pending: { actor: 'enemy', move: 'light', moveLabel: '普攻', damage: 3 } }, null, NOW).ult, 0);
    assert.equal(deriveHud({ ...ready, phase: 'victory' }, null, NOW).ult, 0);
  });

  it('本局次数用完统一显示已用，和轮到谁无关', () => {
    const spent = { ...ready, you: { ...ready.you, ultLeft: 0 }, active: 'enemy' as const };
    assert.equal(deriveHud(spent, null, NOW).ult, 2);
  });

  it('能量不够时是未就绪而不是已用', () => {
    const low = { ...ready, you: { ...ready.you, ap: 2 } };
    assert.equal(deriveHud(low, null, NOW).ult, 0);
  });
});

describe('帧号与音效', () => {
  it('同一局面重复拉取不涨帧号、不重复播音效', () => {
    const battle = state();
    const first = deriveHud(battle, null, NOW);
    const second = deriveHud(battle, first, NOW + 200);
    assert.equal(second.seq, first.seq);
    assert.equal(second.cue, null);
  });

  it('生命值变化涨帧但不播音效（表情没变）', () => {
    const first = deriveHud(state(), null, NOW);
    const hurt = deriveHud(
      state({ you: { name: '我', hp: 8, maxHp: 14, ap: 3, maxAp: 5, ultLeft: 1 } }),
      first, NOW,
    );
    assert.equal(hurt.seq, first.seq + 1);
    assert.equal(hurt.cue, null);
    assert.equal(hurt.hp, 8);
  });

  it('表情变化时给一次音效，后续帧不再重复', () => {
    const first = deriveHud(state(), null, NOW);
    const attack = deriveHud(state({ history: [history({ actor: 'player', action: 'light', actionLabel: '普攻' })] }), first, NOW);
    assert.equal(attack.cue, 'attack');
    const again = deriveHud(state({ history: [history({ actor: 'player', action: 'light', actionLabel: '普攻' })] }), attack, NOW + 100);
    assert.equal(again.cue, null);
    assert.equal(again.seq, attack.seq);
  });
});

describe('下发字段', () => {
  it('用固件约定的下划线字段名', () => {
    const hud: HudState = deriveHud(state({ you: { name: '我', hp: 5, maxHp: 14, ap: 4, maxAp: 5, ultLeft: 0 } }), null, NOW);
    const payload = hudPayload(hud);
    assert.equal(payload.ok, true);
    assert.equal(payload.expression, hud.expression);
    assert.equal(payload.hp, 5);
    assert.equal(payload.max_hp, 14);
    assert.equal(payload.energy, 4);
    assert.equal(payload.max_energy, 5);
    assert.equal(payload.ult, 2);
    assert.equal(payload.seq, hud.seq);
    assert.equal(payload.hold_ms, hud.holdMs);
    assert.equal(payload.battle, true);
    assert.equal(payload.room, '1234');
  });
});
