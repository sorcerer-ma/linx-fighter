import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createBattle, resolveTurn } from '../src/game/engine.js';
import { actionLabel } from '../src/game/actions.js';
import { battleState } from '../src/game/state.js';

/**
 * 造一局已经出过一手的对局：seed 0 → 玩家先手。
 * 单人局里对手会立刻应对并反手锁定一手，所以拿到的是「玩家可以画战报、又要应对」的局面。
 */
async function pendingBattle() {
  const now = 1_700_000_000_000;
  const battle = createBattle({ now, seed: 0 });
  const result = await resolveTurn(battle, 'light', now);
  return result.battle;
}

describe('局面快照', () => {
  it('把对局摊平成界面能直接画的字段', async () => {
    const battle = await pendingBattle();
    const state = battleState(battle, { room: '1234', side: 'player' });

    assert.equal(state.room, '1234');
    assert.equal(state.mode, 'solo');
    assert.equal(state.side, 'player');
    assert.equal(state.round, battle.round);
    assert.equal(state.you.name, battle.player.name);
    assert.equal(state.you.hp, battle.player.hp);
    assert.equal(state.opponent.name, battle.enemy.name);
    assert.equal(state.winner, null);
    // 玩家出招后对手已应对，随后对手也锁定了一手，轮到玩家应对
    assert.equal(state.pending?.actor, 'enemy');
    assert.equal(state.pending?.moveLabel, '普攻');
    assert.ok((state.pending?.damage ?? 0) > 0);
  });

  it('双人房对手没进来时标记 waiting，进来了就取消', async () => {
    const battle = await pendingBattle();
    assert.equal(battleState(battle, { room: '1234', side: 'player' }).waiting, false);

    const waiting = battleState(battle, { room: '1234', side: 'player', waiting: true });
    assert.equal(waiting.mode, 'solo', '单人局即使传了 waiting 也不该置位');
    assert.equal(waiting.waiting, false);

    const pvp = { ...battle, mode: 'pvp' as const };
    assert.equal(battleState(pvp, { room: '1234', side: 'player', waiting: true }).waiting, true);
    assert.equal(battleState(pvp, { room: '1234', side: 'player' }).waiting, false);
  });

  it('战报带中文招式名，界面不用再维护一份招式表', async () => {
    const battle = await pendingBattle();
    const state = battleState(battle, { room: null, side: 'player' });

    assert.equal(state.history.length, 1);
    const entry = state.history[0]!;
    assert.equal(entry.action, 'light');
    assert.equal(entry.actionLabel, actionLabel('light'));
    assert.ok(entry.response, '对手应对过，应记下应对招式');
    assert.equal(entry.responseLabel, actionLabel(entry.response));
    assert.equal(typeof entry.damage, 'number');
  });

  it('敌方视角整体镜像：攻守、待应对与战报一起翻转', async () => {
    const battle = await pendingBattle();
    const mine = battleState(battle, { room: '1234', side: 'player' });
    const theirs = battleState(battle, { room: '1234', side: 'enemy' });

    assert.equal(theirs.side, 'enemy');
    assert.equal(theirs.you.hp, mine.opponent.hp);
    assert.equal(theirs.opponent.hp, mine.you.hp);
    assert.equal(theirs.firstMover, mine.firstMover === 'player' ? 'enemy' : 'player');
    assert.equal(theirs.pending?.actor, mine.pending?.actor === 'player' ? 'enemy' : 'player');
    assert.equal(theirs.history[0]?.actor, mine.history[0]?.actor === 'player' ? 'enemy' : 'player');
    // 快照不动原对局
    assert.equal(battle.pending?.actor, 'enemy');
  });

  it('胜负按视角折算成 winner', async () => {
    const battle = await pendingBattle();
    assert.equal(battleState({ ...battle, phase: 'victory' }, { room: null, side: 'player' }).winner, 'player');
    assert.equal(battleState({ ...battle, phase: 'defeat' }, { room: null, side: 'player' }).winner, 'enemy');
    // 敌方视角整体翻一次：赢家的对手看到的就是输
    const asEnemy = battleState({ ...battle, phase: 'victory' }, { room: null, side: 'enemy' });
    assert.equal(asEnemy.winner, 'enemy');
  });

  it('同一份对局反复取快照结果稳定', async () => {
    const battle = await pendingBattle();
    const first = battleState(battle, { room: '1234', side: 'enemy' });
    const second = battleState(battle, { room: '1234', side: 'enemy' });
    assert.deepEqual(first, second);
  });
});
