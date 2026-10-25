import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  availableActiveActions,
  availableResponseActions,
  isUltimateReady,
} from '../src/game/rules.js';

describe('招式可用性', () => {
  it('按当前能量筛主动招式，满能量不能再蓄力', () => {
    const fighter = (ap: number, ultLeft = 1) => ({ ap, maxAp: 5, ultLeft });
    assert.deepEqual(availableActiveActions(fighter(0)), ['charge']);
    assert.deepEqual(availableActiveActions(fighter(1)), ['light', 'charge']);
    assert.deepEqual(availableActiveActions(fighter(2)), ['light', 'heavy', 'charge']);
    assert.deepEqual(availableActiveActions(fighter(3)), ['light', 'heavy', 'charge']);
    assert.deepEqual(availableActiveActions(fighter(4)), ['light', 'heavy', 'ult', 'charge']);
    assert.deepEqual(availableActiveActions(fighter(5)), ['light', 'heavy', 'ult']);
  });

  it('大招用完后不再列入可选招式', () => {
    assert.deepEqual(availableActiveActions({ ap: 5, maxAp: 5, ultLeft: 0 }), ['light', 'heavy']);
  });

  it('应对按能量筛选，承受永远可选', () => {
    assert.deepEqual(availableResponseActions({ ap: 0 }), ['take']);
    assert.deepEqual(availableResponseActions({ ap: 1 }), ['guard', 'dodge', 'take']);
    assert.deepEqual(availableResponseActions({ ap: 5 }), ['guard', 'dodge', 'take']);
  });

  it('大招就绪要求能量足够且本局还有次数', () => {
    assert.equal(isUltimateReady({ ap: 3, ultLeft: 1 }), false);
    assert.equal(isUltimateReady({ ap: 4, ultLeft: 1 }), true);
    assert.equal(isUltimateReady({ ap: 5, ultLeft: 1 }), true);
    assert.equal(isUltimateReady({ ap: 5, ultLeft: 0 }), false);
  });
});
