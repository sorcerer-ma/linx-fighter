import { timingSafeEqual } from 'node:crypto';

/**
 * 后台监控页的口令校验。
 *
 * 默认公开：没配 ADMIN_TOKEN 时任何人可访问，方便演示现场围观；
 * 一旦配置，就必须带 `?token=` 或 `Authorization: Bearer <token>`，否则 401。
 */

/** 取口令的两个来源 */
export interface AdminTokenSources {
  query?: Record<string, unknown>;
  authorization?: string | undefined;
}

/** 从请求里取出调用方给的口令；没带就返回空串 */
export function extractAdminToken(sources: AdminTokenSources): string {
  const fromQuery = text(sources.query?.token);
  if (fromQuery) return fromQuery;
  const match = /^Bearer\s+(.+)$/i.exec(text(sources.authorization));
  return match?.[1]?.trim() ?? '';
}

/** 是否放行：没配口令默认公开；配了就常量时间比较，避免按响应时间猜口令 */
export function isAdminAllowed(expected: string | undefined, presented: string): boolean {
  const secret = expected?.trim() ?? '';
  if (!secret) return true;
  const left = Buffer.from(secret, 'utf8');
  const right = Buffer.from(presented.trim(), 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
