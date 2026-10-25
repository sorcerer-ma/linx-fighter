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

describe('挂起等播报', () => {
  it('已经有攒下的播报时立即返回，并把队列清空', async () => {
    const { store } = setup();
    store.push('k', '第一手');
    store.push('k', '第二手');

    assert.deepEqual(await store.wait('k', { timeoutMs: 1000 }), ['第一手', '第二手']);
    assert.equal(store.size, 0);
    // 已经交出去的那几手，不会在下次开口时再补一遍
    assert.deepEqual(store.take('k'), []);
  });

  it('没有播报时挂起，push 唤醒并把这一手交出去', async () => {
    const { store } = setup();
    const pending = store.wait('k', { timeoutMs: 1000 });
    assert.equal(store.waiting, 1);

    store.push('k', '对手这一手格挡了');
    assert.deepEqual(await pending, ['对手这一手格挡了']);
    assert.equal(store.waiting, 0);
    assert.equal(store.size, 0);
  });

  it('超时返回 null，且不消耗队列里的播报', async () => {
    const { store } = setup();
    const pending = store.wait('k', { timeoutMs: 10 });
    assert.deepEqual(await pending, null);
    // 等待位要释放，否则后来的请求永远排在后面
    assert.equal(store.waiting, 0);

    store.push('k', '晚到的播报');
    assert.deepEqual(store.take('k'), ['晚到的播报']);
  });

  it('平台取消这次请求时返回 null 并让出等待位', async () => {
    const { store } = setup();
    const controller = new AbortController();
    const pending = store.wait('k', { timeoutMs: 1000, signal: controller.signal });

    controller.abort();
    assert.deepEqual(await pending, null);
    assert.equal(store.waiting, 0);
  });

  it('传进来的 signal 已经取消时直接返回 null，不占等待位', async () => {
    const { store } = setup();
    const controller = new AbortController();
    controller.abort();

    assert.deepEqual(await store.wait('k', { timeoutMs: 1000, signal: controller.signal }), null);
    assert.equal(store.waiting, 0);
  });

  it('nudge 让挂着的请求返回空数组，表示有动静但没有要补的播报', async () => {
    const { store } = setup();
    const pending = store.wait('k', { timeoutMs: 1000 });

    store.nudge('k');
    assert.deepEqual(await pending, []);
    assert.equal(store.waiting, 0);
    assert.equal(store.size, 0);
  });

  it('同一玩家两个 waiter 先挂先得，一次只唤醒一个', async () => {
    const { store } = setup();
    const first = store.wait('k', { timeoutMs: 1000 });
    const second = store.wait('k', { timeoutMs: 1000 });
    assert.equal(store.waiting, 2);

    store.push('k', '第一手');
    assert.deepEqual(await first, ['第一手']);
    assert.equal(store.waiting, 1);

    store.push('k', '第二手');
    assert.deepEqual(await second, ['第二手']);
    assert.equal(store.waiting, 0);
  });

  it('不同玩家各自等各自的，播报不串号', async () => {
    const { store } = setup();
    const forA = store.wait('a', { timeoutMs: 1000 });
    const forB = store.wait('b', { timeoutMs: 1000 });

    store.push('b', '给 b 的一手');
    assert.deepEqual(await forB, ['给 b 的一手']);
    assert.equal(store.waitingOn('a'), true, 'a 还在等，不能被 b 的消息叫醒');

    store.push('a', '给 a 的一手');
    assert.deepEqual(await forA, ['给 a 的一手']);
    assert.equal(store.waiting, 0);
  });

  it('clear 叫醒挂着的请求并返回空数组', async () => {
    const { store } = setup();
    const pending = store.wait('k', { timeoutMs: 1000 });
    store.push('other', '别人的旧账');

    store.clear('k');
    assert.deepEqual(await pending, []);
    assert.equal(store.waiting, 0);
    // 只清这一位玩家的：别人的队列不受影响
    assert.equal(store.size, 1);
  });

  it('waiting 与 waitingOn 反映当前的挂起情况', async () => {
    const { store } = setup();
    assert.equal(store.waiting, 0);
    assert.equal(store.waitingOn('k'), false);

    const first = store.wait('k', { timeoutMs: 1000 });
    const second = store.wait('other', { timeoutMs: 1000 });
    assert.equal(store.waiting, 2);
    assert.equal(store.waitingOn('k'), true);
    assert.equal(store.waitingOn('other'), true);
    assert.equal(store.waitingOn('nobody'), false);

    // 收摊：别把这两个等待留到用例之外
    store.clear('k');
    store.clear('other');
    assert.deepEqual(await Promise.all([first, second]), [[], []]);
    assert.equal(store.waiting, 0);
  });
});
