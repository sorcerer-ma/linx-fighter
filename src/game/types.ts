/**
 * 游戏数据模型。
 *
 * 这里只定义“框架需要的数据形状”，具体数值、命中判定、伤害公式等规则
 * 属于后续待补的玩法机制（见 docs/game-design.md）。
 */

/** 招式标识。后续新增技能时在这里加，并同步 game/actions.ts 的别名表 */
export type ActionId = 'attack' | 'dodge' | 'recover';

export type BattlePhase = 'battle' | 'victory' | 'defeat';

/** 战斗单位：玩家与对手共用同一套基础属性 */
export interface Fighter {
  id: 'player' | 'enemy';
  name: string;
  hp: number;
  maxHp: number;
  /** 气：用于技能消耗与战术选择，具体消耗规则待定 */
  qi: number;
  maxQi: number;
}

/** 单回合记录。玩法定稿后在这里追加结算明细（伤害、命中、闪避结果等） */
export interface TurnRecord {
  turn: number;
  playerAction: ActionId;
  createdAt: number;
}

/** 一场对局。服务端持有唯一事实来源，客户端只负责播报 */
export interface Battle {
  id: string;
  /** 随机种子，固定后可以复现同一场对局，方便调试与单测 */
  seed: number;
  /** 已经进行到第几回合，从 1 开始 */
  turn: number;
  phase: BattlePhase;
  player: Fighter;
  enemy: Fighter;
  /** 最近若干回合的指令记录 */
  history: TurnRecord[];
  startedAt: number;
  updatedAt: number;
}

/** 结算结果：新状态 + 可以直接朗读的一段播报 */
export interface ActionResult {
  battle: Battle;
  narration: string;
}
