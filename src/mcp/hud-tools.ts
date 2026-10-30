/**
 * 设备侧 MCP 工具：给硬件拉的只读 HUD 快照。
 *
 * 平台智能体用的 /mcp 仍然只有 game_say 与 wait_event；这块挂在独立的
 * /device/mcp 上，设备只读、不改对局，避免把硬件轮询混进公开工具面。
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Logger } from '../log.js';
import type { GameService } from '../game/service.js';
import type { BattleState } from '../game/state.js';
import { deriveHud, hudPayload, type HudState } from '../game/hud.js';
import { battleKey, type DeviceContext } from './context.js';

/** 长轮询的默认与上限：设备按需挂起，等不到变化也要及时返回上一帧 */
const DEFAULT_WAIT_MS = 0;
const MAX_WAIT_MS = 5000;
/** 长轮询的检查间隔：回合制变化低频，150ms 足够灵敏也不浪费 CPU */
const POLL_STEP_MS = 150;

/** 帧缓存：按对局键记住上一帧，用来算帧号与「这次要不要播音效」 */
export interface HudTrackerOptions {
  now?: () => number;
  /** 多久没被访问过就丢掉这份缓存 */
  ttlMs?: number;
  /** 缓存条目上限，防止设备编号被刷爆内存 */
  maxEntries?: number;
}

export class HudTracker {
  private readonly frames = new Map<string, HudState>();
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly maxEntries: number;

  constructor(options: HudTrackerOptions = {}) {
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? 10 * 60_000;
    this.maxEntries = options.maxEntries ?? 256;
  }

  /** 派生并记住这一帧；同一局面重复调用返回同样的帧号与 cue=null */
  update(key: string, state: BattleState | null): HudState {
    const now = this.now();
    this.prune(now);
    const hud = deriveHud(state, this.frames.get(key) ?? null, now);
    this.frames.set(key, hud);
    return hud;
  }

  /** 丢掉某个对局键的缓存；对局结束或换局时用来清掉旧表情记忆 */
  reset(key: string): void {
    this.frames.delete(key);
  }

  get size(): number {
    return this.frames.size;
  }

  private prune(now: number): void {
    for (const [key, frame] of this.frames) {
      if (now - frame.updatedAt > this.ttlMs) this.frames.delete(key);
    }
    // 仍然超限就按插入顺序丢最旧的：Map 保持插入序，重写会移到末尾
    while (this.frames.size >= this.maxEntries) {
      const oldest = this.frames.keys().next();
      if (oldest.done) return;
      this.frames.delete(oldest.value);
    }
  }
}

export interface HudToolDependencies {
  service: GameService;
  logger: Logger;
  /** 本次请求的设备上下文（每次 POST 前刷新） */
  ctx: DeviceContext;
  tracker: HudTracker;
  /**
   * 设备对局键解析：平台可能用任意 agentId 建局，固件只知道自己的 MAC。
   * 装配层用「先精确键、再按设备号找最近一局」兜底；缺省用标准身份键。
   */
  resolveKey?: (ctx: DeviceContext) => string;
}

/** 轮询一帧，等不到变化就按时返回；不推进对局、不消费补账 */
export function registerHudTools(server: McpServer, deps: HudToolDependencies): void {
  const { service, logger, ctx, tracker } = deps;
  const resolve = deps.resolveKey ?? ((c: DeviceContext) => battleKey(c));

  server.registerTool('game_hud', {
    title: '精灵屏幕状态',
    description:
      '只读拉取这台设备要显示的一帧：表情、生命值、能量、大招徽记与要播放的音效。',
    inputSchema: z.object({
      wait_ms: z.number().int().min(0).max(MAX_WAIT_MS).optional()
        .describe('长轮询挂起毫秒数：有变化会提前返回，0 表示立刻返回当前帧'),
    }).strict(),
  }, async ({ wait_ms }) => {
    const key = resolve(ctx);
    const first = tracker.update(key, readState(service, key));
    const waitMs = wait_ms ?? DEFAULT_WAIT_MS;
    let hud = first;
    if (waitMs > 0) {
      const deadline = Date.now() + waitMs;
      while (Date.now() < deadline && hud.seq === first.seq) {
        await delay(POLL_STEP_MS);
        hud = tracker.update(key, readState(service, key));
      }
    }
    logger.debug('设备拉取 HUD', {
      sessionKey: key, deviceId: ctx.deviceId, expression: hud.expression,
      seq: hud.seq, cue: hud.cue, battle: hud.battle,
    });
    return { content: [{ type: 'text' as const, text: JSON.stringify(hudPayload(hud)) }] };
  });
}

function readState(service: GameService, key: string): BattleState | null {
  return service.snapshot(key)?.state ?? null;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}
