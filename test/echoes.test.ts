import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { EchoStore } from '../src/store/echoes.js';

function setup(ttlMs = 1000) {
  let now = 1_000_000;
  const store = new EchoStore({ ttlMs, now: () => now });
  return {
    store,
    advance(ms: number): void {
      now += ms;
    },
  };
}

describe('补账消息', () => {
  it('取走即清空，补过一次不会重复', () => {
    const { store } = setup();
    store.push('device-a#agent-1', '你一记强攻，对手格挡');
    assert.deepEqual(store.take('device-a#agent-1'), ['你一记强攻，对手格挡']);
    assert.deepEqual(store.take('device-a#agent-1'), []);
    assert.equal(store.size, 0);
  });

  it('连着错过几手按顺序攒着', () => {
    const { store } = setup();
    store.push('k', '第一手');
    store.push('k', '第二手');
    assert.deepEqual(store.take('k'), ['第一手', '第二手']);
  });

  it('只补给自己，别人的消息不受影响', () => {
    const { store } = setup();
    store.push('a', '给 a');
    store.push('b', '给 b');
    assert.deepEqual(store.take('a'), ['给 a']);
    assert.deepEqual(store.take('b'), ['给 b']);
  });

  it('过期的消息不再补', () => {
    const { store, advance } = setup(1000);
    store.push('k', '旧的一手');
    advance(1001);
    assert.deepEqual(store.take('k'), []);
  });

  it('clear 与 sweep 能回收', () => {
    const { store, advance } = setup(1000);
    store.push('a', 'x');
    store.push('b', 'y');
    store.clear('a');
    assert.equal(store.size, 1);
    advance(1001);
    assert.equal(store.sweep(), 1);
    assert.equal(store.size, 0);
  });
});
