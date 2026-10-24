import type { Battle } from './types.js';

/**
 * 进程内按键串行队列与对局事务。
 *
 * 命令路由与对手决策都是异步的：一次「读局面 → 等模型 → 写回」的窗口里，
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

/** 读写对局的最小接口；BattleStore 天然满足，单测可以传一个内存替身 */
export interface BattleSource {
  get(key: string): Battle | undefined;
  set(key: string, battle: Battle): void;
}

/** 日志只在丢弃写回时用一句话，接口窄一点，方便单测 */
export interface TxLogger {
  info(message: string, fields?: Record<string, unknown>): void;
}

/**
 * 排队期间的对局句柄。
 *
 * 业务拿到的不是存储本身，而是一个只属于这一轮读改写的入口：
 * 读到的是排队开始时的那一局，写回要过 `commit`，对不上就作废。
 */
export interface BattleTx {
  /** 对局键 */
  readonly key: string;
  /** 进队列时的那一局；已经没了（换房、过期）就是 null */
  load(): Battle | null;
  /** 还是不是同一局：等模型回来之后先查一次，变了就别白等结算 */
  alive(): boolean;
  /** 写回结算结果；不是同一局就丢弃并返回 false，绝不覆盖别人刚写进去的新局面 */
  commit(battle: Battle): boolean;
}

/**
 * 对局事务：把「排队 + 读快照 + 校验 + 写回」收成一处。
 *
 * 有了它，业务层不再手写 `store.get` / `store.set` / 版本比对，
 * 也就不会再出现「谁忘了校验」这类补丁式的漏洞。
 */
export class BattleTransactions {
  private readonly queue = new SerialQueue();
  private readonly store: BattleSource;
  private readonly logger?: TxLogger;

  constructor(store: BattleSource, logger?: TxLogger) {
    this.store = store;
    this.logger = logger;
  }

  /**
   * 只排队，不给对局句柄。
   *
   * 开局、清场这类工作也要和出招排在同一条链上（否则刚开的局可能被上一手盖掉），
   * 但它们不读改写对局，借同一把钥匙的锁就够了。
   */
  runExclusive<T>(key: string, task: () => T | Promise<T>): Promise<T> {
    return this.queue.run(key, task);
  }

  /** 排队 + 读改写句柄；同一把钥匙上的结算严格按顺序发生 */
  run<T>(key: string, task: (tx: BattleTx) => T | Promise<T>): Promise<T> {
    return this.queue.run(key, () => {
      let snapshot = this.store.get(key) ?? null;
      const tx: BattleTx = {
        key,
        load: () => snapshot,
        alive: () => (this.store.get(key) ?? null) === snapshot,
        commit: (battle) => {
          if ((this.store.get(key) ?? null) !== snapshot) {
            this.logger?.info('局面已变，丢弃这次写回', { key });
            return false;
          }
          this.store.set(key, battle);
          // 同一轮里接着提交（比如开局后立刻结算）也要能认出自己刚写的那一版
          snapshot = battle;
          return true;
        },
      };
      return task(tx);
    });
  }
}
