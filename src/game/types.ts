/**
 * 游戏数据模型：对局状态、招式标识与结算事件。
 *
 * 服务端是唯一事实来源：命中、伤害、行动点、胜负都只在这里的数据上算，
 * 平台侧模型只负责把玩家的原话交给工具、把工具返回的文字念出来。
 */

/** 对局双方 */
export type Side = 'player' | 'enemy';

/** 主动阶段可以打出的三种攻击 */
export type AttackMove = 'light' | 'heavy' | 'ult';

/** 主动阶段能做的操作：三种攻击 + 蓄力 */
export type ActiveActionId = AttackMove | 'charge';

/** 被攻击时的三种应对：格挡、闪避、承受 */
export type ResponseMove = 'guard' | 'dodge' | 'take';

/** 玩家能说出的全部招式 */
export type ActionId = ActiveActionId | ResponseMove;

export type BattlePhase = 'battle' | 'victory' | 'defeat';

/** 战斗单位：玩家与对手共用同一套属性 */
export interface Fighter {
  id: Side;
  name: string;
  hp: number;
  maxHp: number;
  /** 行动点：出招与格挡、闪避的消耗，每轮自己的主动阶段恢复 */
  ap: number;
  maxAp: number;
  /** 本局剩余大招次数 */
  ultLeft: number;
}

/** 战斗单位的公开视图，供对手 AI 决策 */
export interface FighterView {
  hp: number;
  ap: number;
  ultLeft: number;
}

/** 一次已经锁定、等待防守方应对的攻击 */
export interface PendingAttack {
  actor: Side;
  move: AttackMove;
  /** 锁定时的伤害（已含当轮伤害加成），之后不随防守方选择变化 */
  damage: number;
}

/** 单条战报：一次主动操作，攻击会带上防守方的应对与结算结果 */
export interface TurnRecord {
  round: number;
  actor: Side;
  action: ActionId;
  response?: ResponseMove;
  damage?: number;
  crit?: boolean;
  dodged?: boolean;
  guarded?: boolean;
  createdAt: number;
}

/** 对局模式：单人（AI 对手）或双人联机（房间内两位玩家） */
export type BattleMode = 'solo' | 'pvp';

/** 一场对局。服务端持有唯一事实来源，客户端只负责播报 */
export interface Battle {
  id: string;
  mode: BattleMode;
  /** 随机种子：结算用的随机数全部由它派生，固定后可复现整局 */
  seed: number;
  /** 已经消耗的随机数个数，保证读档后继续结算仍可复现 */
  rngDraws: number;
  /** 当前第几轮，从 1 开始；双方各完成一次主动阶段算一轮 */
  round: number;
  phase: BattlePhase;
  /** 先手方，整局固定 */
  firstMover: Side;
  /** 当前轮到哪一方主动出手 */
  active: Side;
  /** 各方已经开始的主动阶段数：第一段不回行动点，之后每段恢复 */
  activePhases: Record<Side, number>;
  /** 对手已经出手、等待玩家应对的攻击 */
  pending: PendingAttack | null;
  player: Fighter;
  enemy: Fighter;
  /** 最近若干条战报 */
  history: TurnRecord[];
  startedAt: number;
  updatedAt: number;
}

/** 对手 AI 选主动招式时能看到的信息 */
export interface ActionView {
  round: number;
  /** 当轮伤害加成 */
  bonus: number;
  self: FighterView;
  enemy: FighterView;
}

/** 对手 AI 决定如何应对攻击时能看到的信息 */
export interface ResponseView {
  round: number;
  bonus: number;
  self: FighterView;
  attacker: FighterView;
  move: AttackMove;
  /** 已含当轮加成的伤害 */
  damage: number;
  critChance: number;
  dodgeChance: number;
}

/** 对手 AI：主动选招 + 被动应对，实现可替换（后续做关卡/难度时换实现即可） */
export interface BattleAI {
  chooseAction(view: ActionView): ActiveActionId;
  chooseResponse(view: ResponseView): ResponseMove;
}

/** 结算依赖：生产用 seed 派生随机数，单测与仿真可注入固定序列 */
export interface TurnDeps {
  random?: () => number;
  ai?: BattleAI;
}

export type RejectReason =
  | 'ended'
  | 'wrong-stage'
  /** 双人联机：自己已经出招，正等对手应对，不能替对手结算 */
  | 'waiting-opponent'
  | 'insufficient-ap'
  | 'no-ult'
  | 'full-ap';

/** 不合法操作：不推进对局、不改数值，只回一句提示 */
export interface TurnRejection {
  reason: RejectReason;
  action: ActionId;
}

/** 结算事件：播报层按事件组织语言，不直接读数值 */
export type BattleEvent =
  | { type: 'round-start'; round: number; bonus: number }
  | { type: 'charge'; round: number; side: Side; ap: number }
  | {
      type: 'attack';
      round: number;
      side: Side;
      move: AttackMove;
      response: ResponseMove;
      dodged: boolean;
      crit: boolean;
      guarded: boolean;
      /** 防守方没有行动点，只能硬扛 */
      forced: boolean;
      damage: number;
      targetHp: number;
    }
  | { type: 'pending'; round: number; side: Side; move: AttackMove }
  | { type: 'end'; round: number; winner: Side };

/** 一次结算的结果：新对局 + 本回合事件；不合法时 battle 原样返回 */
export interface TurnResult {
  battle: Battle;
  events: BattleEvent[];
  rejection?: TurnRejection;
}

export function isAttackMove(action: ActionId): action is AttackMove {
  return action === 'light' || action === 'heavy' || action === 'ult';
}

export function isActiveAction(action: ActionId): action is ActiveActionId {
  return action === 'charge' || isAttackMove(action);
}

export function isResponseAction(action: ActionId): action is ResponseMove {
  return action === 'guard' || action === 'dodge' || action === 'take';
}

/** 取另一侧 */
export function otherSide(side: Side): Side {
  return side === 'player' ? 'enemy' : 'player';
}
