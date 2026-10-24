import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createBattle } from '../src/game/engine.js';
import { BattleStore } from '../src/store/battles.js';

describe('对局存储', () => {
  it('读写与删除', () => {
    let now = 1_000;
    const store = new BattleStore({ ttlMs: 1_000, now: () => now });
    const battle = createBattle({ now });

    store.set('key', battle);
    assert.equal(store.get('key')?.id, battle.id);
    assert.equal(store.size, 1);
    assert.equal(store.delete('key'), true);
    assert.equal(store.get('key'), undefined);
    assert.equal(store.size, 0);
  });

  it('过期对局读不到，并会被顺手清理', () => {
    let now = 1_000;
    const store = new BattleStore({ ttlMs: 1_000, now: () => now });
    store.set('a', createBattle({ now }));
    store.set('b', createBattle({ now }));
    assert.equal(store.size, 2);

    now += 1_001;
    assert.equal(store.get('a'), undefined, '过期对局应按不存在返回');
    assert.equal(store.size, 1, '读取时顺手删掉过期对局');
    assert.equal(store.sweep(), 1);
    assert.equal(store.size, 0);
  });
});
