import {
  narratePushIdle,
  narratePushOpponentJoined,
  narratePushOpponentMove,
  narratePushUltReady,
  narratePushWaitGuest,
  narratePushWaitOpponent,
} from './narrator.js';
import { isUltimateReady } from './rules.js';
import type { BattleState } from './state.js';

/**
 * 服务端主动推送：手机页面连着 `/events` 时，伙伴不等玩家开口，
 * 在对手出招、对手进房或玩家长时间没动时先说一句。
 *
 * 这里只决定「什么时候说什么」，不碰计时器与 HTTP；每条 SSE 连接各持有一个引擎，
 * 所以重连后不会把上一条连接已经说过的提醒再补一遍。
 *
 * 推送只服务有屏客户端。平台侧仍是请求-响应，没有服务端主动播报通道，
 * 不能把这里的行为当成 MCP 通知或 v2 的等待反馈。
 */

/** 玩家该出招，却一直没出声 */
export const PUSH_IDLE_MS = 15_000;
/** 第二次催促，也用于应对阶段的唯一一次提醒 */
export const PUSH_IDLE_URGENT_MS = 40_000;
/** 玩家已经出手，等对手应对 */
export const PUSH_WAIT_MS = 30_000;
/** 房间开好，等另一位玩家加入 */
export const PUSH_GUEST_WAIT_MS = 30_000;

export type PushKind =
  | 'opponent-move'
  | 'opponent-joined'
  | 'ult-ready'
  | 'idle-turn'
  | 'idle-respond'
  | 'wait-opponent'
  | 'wait-guest';

/** 页面据此决定气泡与朗读的语气；不参与规则判断 */
export type PushTone = 'alert' | 'info' | 'wait';

export interface PushMessage {
  kind: PushKind;
  text: string;
  tone: PushTone;
  /** 服务端生成时间，页面据此排序；重连后不会重复补发 */
  at: number;
}

export interface PushEngineOptions {
  now?: () => number;
  idleMs?: number;
  urgentMs?: number;
  waitMs?: number;
  guestWaitMs?: number;
}

export interface PushEngine {
  /** 每次轮询都调用；局面没变也要调用，空闲计时才会走 */
  observe(battle: BattleState | null): PushMessage[];
}

/**
 * 局面签名：加入房间只改 `waiting`、不改对局的 `updatedAt`，
 * 所以不能只拿时间戳判断局面是否变化。
 */
function signature(battle: BattleState): string {
  const pending = battle.pending ? `${battle.pending.actor}:${battle.pending.move}` : '-';
  return [
    battle.room ?? '-',
    battle.mode,
    battle.updatedAt,
    battle.waiting ? 1 : 0,
    battle.phase,
    battle.round,
    pending,
    battle.history.length,
    battle.you.hp,
    battle.you.ap,
    battle.you.ultLeft,
    battle.opponent.hp,
    battle.opponent.ap,
    battle.opponent.ultLeft,
  ].join('|');
}

export function createPushEngine(options: PushEngineOptions = {}): PushEngine {
  const now = options.now ?? Date.now;
  const idleMs = options.idleMs ?? PUSH_IDLE_MS;
  const urgentMs = options.urgentMs ?? PUSH_IDLE_URGENT_MS;
  const waitMs = options.waitMs ?? PUSH_WAIT_MS;
  const guestWaitMs = options.guestWaitMs ?? PUSH_GUEST_WAIT_MS;

  const connectedAt = now();
  let previous: BattleState | null = null;
  let previousSignature = '';
  /** 最近一次看到局面变化的时间；空闲计时从它重新开始 */
  let changedAt = connectedAt;
  let idleKey = '';
  let idleCount = 0;
  /**
   * 已经提醒过的对手攻击。轮询可能跨过中间的空 pending：
   * 先是自己出招待应对，下一次采样时对手已经格挡并反击，
   * 所以不能只看「上一帧 pending 为空」，要认这一手本身。
   */
  let notifiedAttack = '';

  // 同一种局面只催到规定次数，局面一变就重新计数
  function resetIdle(key: string): void {
    if (idleKey === key) return;
    idleKey = key;
    idleCount = 0;
  }

  return {
    observe(battle) {
      const at = now();
      if (!battle) {
        previous = null;
        previousSignature = '';
        changedAt = at;
        idleKey = '';
        idleCount = 0;
        notifiedAttack = '';
        return [];
      }

      const current = signature(battle);
      const firstSeen = previous === null;
      const changed = !firstSeen && current !== previousSignature;
      // 首次看到局面也从现在起算：页面刚打开时不该立刻催上一局留下的空闲
      if (firstSeen || changed) changedAt = at;

      const messages: PushMessage[] = [];

      // 对手刚进房：必须是同一个双人房、同一局从「等人」切到「可以开打」。
      // waiting 变 false 也可能是玩家退房后开了单人局，不能误报「对手来了」。
      if (
        changed &&
        previous?.waiting === true &&
        previous.mode === 'pvp' &&
        battle.mode === 'pvp' &&
        previous.room !== null &&
        previous.room === battle.room &&
        previous.updatedAt === battle.updatedAt &&
        !battle.waiting &&
        battle.phase === 'battle'
      ) {
        messages.push({
          kind: 'opponent-joined',
          text: narratePushOpponentJoined(battle),
          tone: 'info',
          at,
        });
      }

      // 对手刚锁定招式：这是唯一需要玩家立刻知道的局面变化。
      // 用攻击身份而不是「上一帧 pending 为空」判断，采样跨过中间状态也不会漏。
      const attack = battle.pending?.actor === 'enemy' ? battle.pending : null;
      const pendingKey = attack
        ? `${battle.mode}:${battle.room ?? '-'}:${battle.updatedAt}:${battle.round}:${attack.move}:${attack.damage}`
        : '';
      if (firstSeen && pendingKey) notifiedAttack = pendingKey;
      if (changed && attack && pendingKey !== notifiedAttack && battle.phase === 'battle') {
        notifiedAttack = pendingKey;
        messages.push({
          kind: 'opponent-move',
          text: narratePushOpponentMove(attack.move, battle.you.ap),
          tone: 'alert',
          at,
        });
      }

      // 能量刚够大招：这是资源变化，不依赖玩家先开口；对手动作更急时先让给对手动作
      if (
        changed &&
        messages.length === 0 &&
        previous !== null &&
        battle.phase === 'battle' &&
        isUltimateReady(battle.you) &&
        !isUltimateReady(previous.you)
      ) {
        messages.push({ kind: 'ult-ready', text: narratePushUltReady(battle), tone: 'info', at });
      }

      // 空闲提醒只在战斗进行中；终局结果已经由玩家那次行动的回复播过，不重复
      if (battle.phase === 'battle') {
        const since = Math.max(battle.updatedAt, connectedAt, changedAt);
        const elapsed = at - since;

        if (battle.waiting) {
          const key = `wait-guest:${current}`;
          resetIdle(key);
          if (battle.room && idleCount === 0 && elapsed >= guestWaitMs) {
            idleCount = 1;
            messages.push({ kind: 'wait-guest', text: narratePushWaitGuest(battle.room), tone: 'wait', at });
          }
        } else if (battle.pending?.actor === 'enemy') {
          // 对手出招那一刻已经即时提醒过，这里只补一次更轻的催促
          const key = `idle-respond:${current}`;
          resetIdle(key);
          if (idleCount === 0 && elapsed >= urgentMs) {
            idleCount = 1;
            messages.push({ kind: 'idle-respond', text: narratePushIdle(battle, true), tone: 'wait', at });
          }
        } else if (!battle.pending && battle.active === 'player') {
          const key = `idle-turn:${current}`;
          resetIdle(key);
          if (idleCount === 0 && elapsed >= urgentMs) {
            // 轮询被长时间卡住时直接说重的那句，不要两条挤在一起
            idleCount = 2;
            messages.push({ kind: 'idle-turn', text: narratePushIdle(battle, true), tone: 'wait', at });
          } else if (idleCount === 0 && elapsed >= idleMs) {
            idleCount = 1;
            messages.push({ kind: 'idle-turn', text: narratePushIdle(battle, false), tone: 'wait', at });
          } else if (idleCount === 1 && elapsed >= urgentMs) {
            idleCount = 2;
            messages.push({ kind: 'idle-turn', text: narratePushIdle(battle, true), tone: 'wait', at });
          }
        } else {
          const key = `wait-opponent:${current}`;
          resetIdle(key);
          if (idleCount === 0 && elapsed >= waitMs) {
            idleCount = 1;
            messages.push({ kind: 'wait-opponent', text: narratePushWaitOpponent(), tone: 'wait', at });
          }
        }
      }

      previous = battle;
      previousSignature = current;
      return messages;
    },
  };
}
