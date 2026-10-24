/** 补账消息默认保留多久（毫秒）：与对局默认存活时间一致，玩家一直不开口就跟着过期 */
export const ECHO_TTL_MS = 30 * 60 * 1000;

export interface EchoStoreOptions {
  ttlMs?: number;
  now?: () => number;
}

interface EchoEntry {
  lines: string[];
  updatedAt: number;
}

/**
 * 双人联机的补账消息。
 *
 * 一方出招后，出手方这一轮的播报只能停在「等对手应对」；另一个人的应对要在
 * 他自己的回合里结算，结果只念给了应对方。这段错过的过程先存在这里，等出手方
 * 下次开口时补一句，免得无屏设备上整段静音。
 *
 * 单实例内存实现，和 BattleStore 一样，要多实例时换成 Redis 即可，调用方不用改。
 */
export class EchoStore {
  private readonly entries = new Map<string, EchoEntry>();
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(options: EchoStoreOptions = {}) {
    this.ttlMs = options.ttlMs ?? ECHO_TTL_MS;
    this.now = options.now ?? Date.now;
  }

  /** 记一条待补的播报；取走前攒着，不会因为连说几句就丢 */
  push(sessionKey: string, line: string): void {
    const entry = this.entries.get(sessionKey);
    if (entry) {
      entry.lines.push(line);
      entry.updatedAt = this.now();
    } else {
      this.entries.set(sessionKey, { lines: [line], updatedAt: this.now() });
    }
    this.sweep();
  }

  /** 取走并清空：只补一次，重复问战况不会反复念 */
  take(sessionKey: string): string[] {
    const entry = this.entries.get(sessionKey);
    if (!entry) return [];
    this.entries.delete(sessionKey);
    return this.now() - entry.updatedAt > this.ttlMs ? [] : entry.lines;
  }

  /** 换局、退房时清掉，避免把上一局的结果补到新对局里 */
  clear(sessionKey: string): void {
    this.entries.delete(sessionKey);
  }

  /** 清理过期消息，返回清理数量 */
  sweep(): number {
    let removed = 0;
    for (const [key, entry] of this.entries) {
      if (this.now() - entry.updatedAt > this.ttlMs) {
        this.entries.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  get size(): number {
    return this.entries.size;
  }
}
