import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SerialQueue } from '../src/game/serialize.js';

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
