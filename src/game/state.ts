import { actionLabel } from './actions.js';
import { viewAs } from './pvp.js';
import type {
  ActionId,
  AttackMove,
  Battle,
  BattleMode,
  BattlePhase,
  ResponseMove,
  Side,
  TurnRecord,
} from './types.js';

/**
 * 局面快照：给手机页面与调试工具看的只读视图。
 *
 * 和播报文案是两个出口——文案是给耳朵听的，快照是给界面画的：
 * - 快照已经按当前玩家视角镜像过，`you` 永远是自己、`opponent` 永远是对面；
 * - 招式与应对都带上中文名，界面不用再维护一份招式表。
 */
export interface FighterState {
  name: string;
  hp: number;
  maxHp: number;
  ap: number;
  maxAp: number;
  ultLeft: number;
}

/** 已锁定、等应对的攻击；actor 是打出这一手的一方（视角内） */
export interface PendingAttackState {
  actor: Side;
  move: AttackMove;
  moveLabel: string;
  damage: number;
}

/** 一条战报，字段与 TurnRecord 对齐，另外补上中文名 */
export interface HistoryEntryState {
  round: number;
  actor: Side;
  action: ActionId;
  actionLabel: string;
  response?: ResponseMove;
  responseLabel?: string;
  damage?: number;
  crit?: boolean;
  dodged?: boolean;
  guarded?: boolean;
}

/** 一场对局的界面视图 */
export interface BattleState {
  /** Authoritative identity for ignoring delayed previous-battle replies. */
  battleId: string;
  /** 四位挑战编号；单人局为 null */
  room: string | null;
  mode: BattleMode;
  /** 玩家坐在基准对局的哪一边；快照已镜像，界面不用管 */
  side: Side;
  phase: BattlePhase;
  round: number;
  /** 现在轮到谁主动出招（视角内） */
  active: Side;
  firstMover: Side;
  pending: PendingAttackState | null;
  /** 双人房已开、对手还没进来；界面据此显示「等对手加入」而不是回合提示 */
  waiting: boolean;
  you: FighterState;
  opponent: FighterState;
  /** 视角内的胜者；未结束为 null */
  winner: Side | null;
  history: HistoryEntryState[];
  updatedAt: number;
}

function fighterState(fighter: Battle['player']): FighterState {
  return {
    name: fighter.name,
    hp: fighter.hp,
    maxHp: fighter.maxHp,
    ap: fighter.ap,
    maxAp: fighter.maxAp,
    ultLeft: fighter.ultLeft,
  };
}

function historyEntry(record: TurnRecord): HistoryEntryState {
  const entry: HistoryEntryState = {
    round: record.round,
    actor: record.actor,
    action: record.action,
    actionLabel: actionLabel(record.action),
  };
  if (record.response) {
    entry.response = record.response;
    entry.responseLabel = actionLabel(record.response);
  }
  if (record.damage !== undefined) entry.damage = record.damage;
  if (record.crit !== undefined) entry.crit = record.crit;
  if (record.dodged !== undefined) entry.dodged = record.dodged;
  if (record.guarded !== undefined) entry.guarded = record.guarded;
  return entry;
}

/**
 * 生成某个玩家视角的局面快照；入参对局不会被修改。
 *
 * `waiting` 只能由上层（房间存储）告诉这里：对局本身看不出「对手还没加入」。
 */
export function battleState(
  battle: Battle,
  options: { room: string | null; side: Side; waiting?: boolean },
): BattleState {
  const view = viewAs(battle, options.side);
  return {
    battleId: battle.id,
    room: options.room,
    mode: view.mode,
    side: options.side,
    phase: view.phase,
    round: view.round,
    active: view.active,
    firstMover: view.firstMover,
    pending: view.pending
      ? {
          actor: view.pending.actor,
          move: view.pending.move,
          moveLabel: actionLabel(view.pending.move),
          damage: view.pending.damage,
        }
      : null,
    waiting: options.waiting === true && view.mode === 'pvp',
    you: fighterState(view.player),
    opponent: fighterState(view.enemy),
    winner: view.phase === 'victory' ? 'player' : view.phase === 'defeat' ? 'enemy' : null,
    history: view.history.map(historyEntry),
    updatedAt: view.updatedAt,
  };
}
