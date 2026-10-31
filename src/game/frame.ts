/**
 * 视角化局面：平台事实与设备画面共同的派生源。
 *
 * 服务端里同一场对局有两种形态：基准对局（`Battle`）与按座位镜像后的快照
 * （`BattleState`）。这里把两者统一成「我方 / 对手」视角的只读局面，事实与
 * 屏幕画面都只从这份局面派生，避免两边各写一遍「这一手算什么」的判断。
 *
 * 本模块只做归一，不产生任何玩法事实，也不依赖 HTTP、MCP 或播报。
 */

import type { ActionId, Battle, BattlePhase, ResponseMove, Side } from './types.js';
import type { BattleState, HistoryEntryState } from './state.js';

/** 视角内的一方资源；name 保留给事实里的对手名 */
export interface FrameFighter {
  name: string;
  hp: number;
  maxHp: number;
  ap: number;
  maxAp: number;
  ultLeft: number;
}

/** 一条已结算战报；只保留事实与画面都需要的字段 */
export interface FrameTurn {
  round: number;
  actor: Side;
  action: ActionId;
  response?: ResponseMove;
  damage?: number;
  crit?: boolean;
  dodged?: boolean;
  guarded?: boolean;
}

/** 视角化局面：`you` 是本次请求的视角方，`active`/`actor` 也按这个视角写 */
export interface BattleFrame {
  round: number;
  /** 对局形态：双人房两边各一块屏，单人局只有本人这一块屏 */
  mode: 'solo' | 'pvp';
  phase: BattlePhase;
  /** 现在轮到谁主动出手（视角内） */
  active: Side;
  /** 已锁定、等应对的攻击；只保留出手方，伤害等细节由规则层负责 */
  pending: { actor: Side } | null;
  /** 四位挑战编号；单人局为 null */
  room: string | null;
  you: FrameFighter;
  opponent: FrameFighter;
  history: FrameTurn[];
  updatedAt: number;
}

function toFighter(source: FrameFighter): FrameFighter {
  return {
    name: source.name,
    hp: source.hp,
    maxHp: source.maxHp,
    ap: source.ap,
    maxAp: source.maxAp,
    ultLeft: source.ultLeft,
  };
}

/** 战报归一：基准对局与快照只差中文标签，事实与画面都用不上 */
export function turnOf(entry: FrameTurn | HistoryEntryState): FrameTurn {
  return {
    round: entry.round,
    actor: entry.actor,
    action: entry.action,
    ...(entry.response === undefined ? {} : { response: entry.response }),
    ...(entry.damage === undefined ? {} : { damage: entry.damage }),
    ...(entry.crit === undefined ? {} : { crit: entry.crit }),
    ...(entry.dodged === undefined ? {} : { dodged: entry.dodged }),
    ...(entry.guarded === undefined ? {} : { guarded: entry.guarded }),
  };
}

/** 基准对局 → 视角化局面（调用方已按座位镜像） */
export function frameOfBattle(battle: Battle): BattleFrame {
  return {
    round: battle.round,
    mode: battle.mode,
    phase: battle.phase,
    active: battle.active,
    pending: battle.pending ? { actor: battle.pending.actor } : null,
    room: null,
    you: toFighter(battle.player),
    opponent: toFighter(battle.enemy),
    history: battle.history.map(turnOf),
    updatedAt: battle.updatedAt,
  };
}

/** 镜像后的快照 → 视角化局面；快照本身就是「我方」视角 */
export function frameOfState(state: BattleState): BattleFrame {
  return {
    round: state.round,
    mode: state.mode,
    phase: state.phase,
    active: state.active,
    pending: state.pending ? { actor: state.pending.actor } : null,
    room: state.room,
    you: toFighter(state.you),
    opponent: toFighter(state.opponent),
    history: state.history.map(turnOf),
    updatedAt: state.updatedAt,
  };
}
