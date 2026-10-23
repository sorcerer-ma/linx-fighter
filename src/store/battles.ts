import type { Battle } from '../game/types.js';

export interface BattleStoreOptions {
  /** 对局空闲多久后清理（毫秒） */
  ttlMs: number;
  now?: () => number;
}

/**
 * 对局存储。框架阶段先用进程内存：
 * - 单实例部署够用，服务重启会丢失进行中的对局；
 * - 后续要多实例或重启保留，把这个类换成 Redis 实现即可，调用方不用改。
 */
export class BattleStore {
  private readonly battles = new Map<string, Battle>();
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(options: BattleStoreOptions) {
    this.ttlMs = options.ttlMs;
    this.now = options.now ?? Date.now;
  }

  /** 读取对局，已过期的顺手清掉 */
  get(sessionKey: string): Battle | undefined {
    const battle = this.battles.get(sessionKey);
    if (!battle) return undefined;
    if (this.isExpired(battle)) {
      this.battles.delete(sessionKey);
      return undefined;
    }
    return battle;
  }

  /** 写入对局，同时顺带清理过期对局 */
  set(sessionKey: string, battle: Battle): void {
    this.battles.set(sessionKey, battle);
    this.sweep();
  }

  delete(sessionKey: string): boolean {
    return this.battles.delete(sessionKey);
  }

  /** 清理过期对局，返回清理数量。每次写入顺带扫一遍，不额外起定时器 */
  sweep(): number {
    let removed = 0;
    for (const [key, battle] of this.battles) {
      if (this.isExpired(battle)) {
        this.battles.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  get size(): number {
    return this.battles.size;
  }

  private isExpired(battle: Battle): boolean {
    return this.now() - battle.updatedAt > this.ttlMs;
  }
}
