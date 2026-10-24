import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BattleTransactions, SerialQueue } from '../src/game/serialize.js';

/** 让出一轮事件循环，模拟一次异步等待（等模型、等对手决策） */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('对局排队', () => {
  it('同一把钥匙上的任务按提交顺序跑完再跑下一个', async () => {
    const queue = new SerialQueue();
    const order: string[] = [];

    const first = queue.run('battle-1', async () => {
      order.push('第一手开始');
      await tick();
      order.push('第一手结算');
    });
    const second = queue.run('battle-1', () => {
      order.push('第二手开始');
    });

    await Promise.all([first, second]);
    assert.deepEqual(order, ['第一手开始', '第一手结算', '第二手开始']);
  });

  it('不同钥匙的任务互不等待', async () => {
    const queue = new SerialQueue();
    const started: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const slow = queue.run('battle-1', async () => {
      started.push('第一局');
      await gate;
    });
    const quick = queue.run('battle-2', () => {
      started.push('第二局');
    });

    await tick();
    assert.deepEqual(started, ['第一局', '第二局']);
    release();
    await Promise.all([slow, quick]);
  });

  it('前一个任务失败不会卡住队列，错误仍抛给它的调用方', async () => {
    const queue = new SerialQueue();

    await assert.rejects(
      queue.run('battle-1', () => {
        throw new Error('第一手炸了');
      }),
      /第一手炸了/,
    );

    assert.equal(
      await queue.run('battle-1', () => '第二手照常跑'),
      '第二手照常跑',
    );
  });

  it('跑完把钥匙收掉，不会越攒越多', async () => {
    const queue = new SerialQueue();
    assert.equal(queue.size, 0);

    await Promise.all([queue.run('a', () => 1), queue.run('b', () => 2)]);
    assert.equal(queue.size, 0);
  });
});

describe('对局事务', () => {
  /** 内存替身：只要 get/set，和真实存储的对象身份语义一致 */
  function storeOf(initial: Record<string, number> = {}) {
    const data = new Map<string, number>(Object.entries(initial));
    const writes: string[] = [];
    return {
      data,
      writes,
      get: (key: string) => data.get(key),
      set: (key: string, value: number) => {
        writes.push(key);
        data.set(key, value);
      },
    };
  }

  it('读到排队开始时的那一局，写回后同一轮还能接着读', async () => {
    const store = storeOf({ 'battle-1': 1 });
    const tx = new BattleTransactions(store);

    const seen = await tx.run('battle-1', (handle) => {
      const first = handle.load();
      handle.commit(2);
      return [first, handle.load()];
    });

    assert.deepEqual(seen, [1, 2]);
    assert.equal(store.get('battle-1'), 2);
  });

  it('中途被别人换过对局就作废写回，且自报已经变了', async () => {
    const store = storeOf({ 'battle-1': 1 });
    const tx = new BattleTransactions(store);

    const result = await tx.run('battle-1', async (handle) => {
      await tick();
      // 模拟同一把钥匙之外换局（换房、房主重开）：存储里换成了新对象
      store.set('battle-1', 99);
      return { alive: handle.alive(), committed: handle.commit(2) };
    });

    assert.deepEqual(result, { alive: false, committed: false });
    assert.equal(store.get('battle-1'), 99);
  });

  it('进队列时那一局已经没了也能照常给结论', async () => {
    const store = storeOf();
    const tx = new BattleTransactions(store);

    assert.equal(await tx.run('battle-1', (handle) => handle.load()), null);
    // 没有旧快照时写入就是新建，不被判成冲突
    assert.equal(await tx.run('battle-1', (handle) => handle.commit(7)), true);
    assert.equal(store.get('battle-1'), 7);
  });

  it('只排队的任务与读改写在同一条链上，不会互相穿插', async () => {
    const store = storeOf({ 'battle-1': 1 });
    const tx = new BattleTransactions(store);
    const order: string[] = [];

    const playing = tx.run('battle-1', async (handle) => {
      order.push(`读到 ${handle.load()}`);
      await tick();
      handle.commit(2);
      order.push('结算写回');
    });
    const restart = tx.runExclusive('battle-1', () => {
      order.push(`重开读到 ${store.get('battle-1')}`);
    });

    await Promise.all([playing, restart]);
    assert.deepEqual(order, ['读到 1', '结算写回', '重开读到 2']);
  });
});
