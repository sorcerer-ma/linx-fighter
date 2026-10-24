/**
 * 进程内按键串行队列。
 *
 * 意图模型与对手决策都是异步的：一次「读局面 → 等模型 → 写回」的窗口里，
 * 同一场对局的另一次请求可能已经结算完毕，旧快照写回去就把新结果盖掉了。
 * 这里把同一把钥匙上的任务排成一条链，保证对局状态只按顺序被修改；
 * 不同钥匙（不同对局）之间互不阻塞。
 *
 * 钥匙就用对局键：单人局是玩家键，双人局是 `pvp:<房间号>`。
 * 单实例内存存储够用；多实例部署时这层不够，得换成跨进程的锁。
 */
export class SerialQueue {
  private readonly tails = new Map<string, Promise<unknown>>();

  /** 排队执行；同一把钥匙上的任务严格按调用顺序跑，前一个失败不影响后一个 */
  run<T>(key: string, task: () => T | Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    // 上一位失败只是它自己没做成，队列要接着跑；它的错误仍由它自己的调用方接收
    const current = previous.then(task, task);
    this.tails.set(key, current);
    // 最后一棒跑完就把钥匙收掉，别让对局键在内存里越攒越多
    const release = (): void => {
      if (this.tails.get(key) === current) this.tails.delete(key);
    };
    void current.then(release, release);
    return current;
  }

  /** 还在排队或执行中的钥匙数量，只给单测用 */
  get size(): number {
    return this.tails.size;
  }
}
