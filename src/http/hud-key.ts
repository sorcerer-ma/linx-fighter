/**
 * 设备对局键解析。
 *
 * 平台的建局请求可以带任意 agentId，而固件只知道自己的设备号（MAC）。
 * 因此先按标准身份键精确命中，找不到再在「设备号#」前缀下取最近更新的一局；
 * 都没有就返回标准键，让 HUD 回到待命帧。
 */

import type { GameService } from '../game/service.js';
import type { BattleStore } from '../store/battles.js';
import { battleKey, type DeviceContext } from '../mcp/context.js';

export interface HudKeyResolverDeps {
  service: GameService;
  store: BattleStore;
}

/** 造一个解析器；装配层只需要一份，MCP 通道与 WebSocket 通道共用 */
export function createHudKeyResolver(deps: HudKeyResolverDeps): (ctx: DeviceContext) => string {
  const { service, store } = deps;
  return (ctx: DeviceContext): string => {
    const direct = battleKey(ctx);
    if (service.snapshot(direct)) return direct;
    const prefix = `${ctx.deviceId}#`;
    let latest: { key: string; at: number } | null = null;
    for (const entry of store.list()) {
      if (!entry.key.startsWith(prefix)) continue;
      if (latest === null || entry.battle.updatedAt > latest.at) {
        latest = { key: entry.key, at: entry.battle.updatedAt };
      }
    }
    return latest?.key ?? direct;
  };
}
