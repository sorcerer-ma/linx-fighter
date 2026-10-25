/** 补账消息默认保留多久（毫秒）：与对局默认存活时间一致，玩家一直不开口就跟着过期 */
export const ECHO_TTL_MS = 30 * 60 * 1000;

export interface EchoStoreOptions {
  ttlMs?: number;
  now?: () => number;
}

/** 挂起等播报的参数 */
export interface EchoWaitOptions {
  /** 最多挂多久（毫秒）；到点按「还没有新播报」返回，不算失败 */
  timeoutMs: number;
  /** 平台断开或取消这次请求时提前收摊，别把等待位一直占着 */
  signal?: AbortSignal;
}

/** 排队等播报的取件人：先挂上的先拿，拿到就退出队列 */
type EchoWaiter = (lines: string[] | null) => void;

/**
 * 挂起的结果：
 * - 字符串数组：等到的那几手（可能为空数组，表示「有新动静但没有要补的播报」）；
 * - null：到时间或被取消，期间什么都没发生。
 */
export type EchoWaitResult = string[] | null;

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
 * 同一个队列还兼两份差：平台模型调用 wait_event 时把请求挂在这里等（见 wait），
 * 播报一进来就交给最早挂着的那个请求；没人挂着就继续攒着，下次开口照样补。
 *
 * 单实例内存实现，和 BattleStore 一样，要多实例时换成 Redis 即可，调用方不用改。
 */
export class EchoStore {
  private readonly entries = new Map<string, EchoEntry>();
  /** 每位玩家挂着的取件人，按挂上的先后排队 */
  private readonly waiters = new Map<string, EchoWaiter[]>();
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
    // 有请求正挂在这一局上：立刻把这条交出去，不必等它超时
    this.wake(sessionKey);
    this.sweep();
  }

  /** 取走并清空：只补一次，重复问战况不会反复念 */
  take(sessionKey: string): string[] {
    const entry = this.entries.get(sessionKey);
    if (!entry) return [];
    this.entries.delete(sessionKey);
    return this.now() - entry.updatedAt > this.ttlMs ? [] : entry.lines;
  }

  /**
   * 挂起等这位玩家的下一条播报，这就是 wait_event 停住的地方。
   *
   * 平台调工具后请求先不返回：这里登记成取件人挂着，对手一有播报就由 push 唤醒
   * （见 wake），把这一手交出去。已经攒着的结果立刻返回；超时或被取消返回 null，
   * 让调用方回一句「对手还没动静」。没人挂着时播报继续留在队列里等下次开口。
   */
  wait(sessionKey: string, options: EchoWaitOptions): Promise<EchoWaitResult> {
    const queued = this.take(sessionKey);
    if (queued.length > 0) return Promise.resolve(queued);

    const timeoutMs = Math.max(0, options.timeoutMs);
    if (timeoutMs === 0 || options.signal?.aborted) return Promise.resolve(null);

    return new Promise<EchoWaitResult>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (lines: string[] | null): void => {
        if (timer) clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
        this.drop(sessionKey, finish);
        resolve(lines);
      };
      const onAbort = (): void => finish(null);
      timer = setTimeout(() => finish(null), timeoutMs);
      options.signal?.addEventListener('abort', onAbort, { once: true });

      const list = this.waiters.get(sessionKey);
      if (list) list.push(finish);
      else this.waiters.set(sessionKey, [finish]);
    });
  }

  /**
   * 告诉挂着的请求「这一局有动静了」，但不带播报内容。
   *
   * 对手刚锁定攻击、等着这边应招时就该用这个：这一手还没结算完，补账会变成复述，
   * 但请求不能干等到超时，让它醒来自己看一眼最新局面再说。
   */
  nudge(sessionKey: string): void {
    this.release(sessionKey, []);
  }

  /** 换局、退房时清掉，避免把上一局的结果补到新对局里；挂着等的请求就此醒来收摊 */
  clear(sessionKey: string): void {
    this.entries.delete(sessionKey);
    this.release(sessionKey, []);
  }

  /** 整串摘掉再逐个唤醒：收件人从队列里删自己时不该踩到正在遍历的数组 */
  private release(sessionKey: string, lines: string[]): void {
    const list = this.waiters.get(sessionKey);
    if (!list || list.length === 0) return;
    this.waiters.delete(sessionKey);
    for (const waiter of [...list]) waiter(lines);
  }

  /** 有播报进来：交给最早挂着的那个请求，其余继续等下一手 */
  private wake(sessionKey: string): void {
    const waiter = this.waiters.get(sessionKey)?.[0];
    if (!waiter) return;
    const lines = this.take(sessionKey);
    // 取出来发现已经过期：这一手不补，人也继续挂着等下一手
    if (lines.length === 0) return;
    waiter(lines);
  }

  /** 把取件人从等待队列里摘掉：拿到播报、超时或被取消时都要走这里 */
  private drop(sessionKey: string, waiter: EchoWaiter): void {
    const list = this.waiters.get(sessionKey);
    if (!list) return;
    const index = list.indexOf(waiter);
    if (index >= 0) list.splice(index, 1);
    if (list.length === 0) this.waiters.delete(sessionKey);
  }

  /** 现在有多少个请求挂在这里：日志与排查用 */
  get waiting(): number {
    let total = 0;
    for (const list of this.waiters.values()) total += list.length;
    return total;
  }

  /** 有没有请求挂在这位玩家身上：对手进房间这种一次性事件靠它决定要不要主动叫醒 */
  waitingOn(sessionKey: string): boolean {
    return (this.waiters.get(sessionKey)?.length ?? 0) > 0;
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
