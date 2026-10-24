/**
 * 后台接口的最朴素限速：按来源做固定窗口计数，进程内 Map，重启即清空。
 *
 * 只用来防止监控页轮询把服务打过载，不做精确配额，也不引入依赖。
 */

/** 默认每来源每分钟 120 次：页面 3 秒轮询每个标签页 20 次/分，开 3 个标签也只占一半 */
export const ADMIN_RATE_LIMIT = { limit: 120, windowMs: 60_000 } as const;

export interface RateLimiterOptions {
  limit?: number;
  windowMs?: number;
  /** 便于单测注入时间 */
  now?: () => number;
  /** 最多记多少个来源；到上限先清过期，再按插入顺序淘汰最旧的，避免内存被刷爆 */
  maxKeys?: number;
}

export interface RateLimiter {
  /** 记一次并判断是否放行；超限返回 false */
  allow(key: string): boolean;
}

interface Bucket {
  count: number;
  resetAt: number;
}

export function createRateLimiter(options: RateLimiterOptions = {}): RateLimiter {
  const limit = Math.max(1, options.limit ?? ADMIN_RATE_LIMIT.limit);
  const windowMs = Math.max(1_000, options.windowMs ?? ADMIN_RATE_LIMIT.windowMs);
  const now = options.now ?? Date.now;
  const maxKeys = Math.max(16, options.maxKeys ?? 10_000);
  const buckets = new Map<string, Bucket>();

  return {
    allow(key: string): boolean {
      const at = now();
      const bucket = buckets.get(key);
      if (!bucket || bucket.resetAt <= at) {
        if (bucket) {
          // 过期重建：先删再插，挪到队尾，免得刚重置就被当成最旧的清掉
          buckets.delete(key);
        } else {
          reserve(buckets, maxKeys, at);
        }
        buckets.set(key, { count: 1, resetAt: at + windowMs });
        return true;
      }
      if (bucket.count >= limit) return false;
      bucket.count += 1;
      return true;
    },
  };
}

/** 给新来源腾位置：先清过期，仍不够就按插入顺序丢最旧的，保证桶数不超过 maxKeys */
function reserve(buckets: Map<string, Bucket>, maxKeys: number, at: number): void {
  if (buckets.size < maxKeys) return;
  sweep(buckets, at);
  while (buckets.size >= maxKeys) {
    const oldest = buckets.keys().next();
    if (oldest.done) return;
    buckets.delete(oldest.value);
  }
}

function sweep(buckets: Map<string, Bucket>, at: number): void {
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= at) buckets.delete(key);
  }
}
