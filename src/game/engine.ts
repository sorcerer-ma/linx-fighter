import { randomUUID } from 'node:crypto';
import type { ActionId, Battle, Fighter } from './types.js';

/** 默认对手名。后续接入对手库/关卡片段时从这里切换 */
export const DEFAULT_ENEMY_NAME = '守擂教头';

/** 初始属性。数值先给一套能跑通的占位值，定稿后替换 */
export const INITIAL_HP = 100;
export const INITIAL_QI = 100;

/** 战报最多保留多少回合 */
const HISTORY_LIMIT = 30;

export interface CreateBattleOptions {
  /** 对手名，不填用默认对手 */
  enemyName?: string;
  now: number;
  /** 随机种子，固定后可复现同一场对局，便于调试与单测 */
  seed?: number;
}

function createFighter(id: Fighter['id'], name: string): Fighter {
  return {
    id,
    name,
    hp: INITIAL_HP,
    maxHp: INITIAL_HP,
    qi: INITIAL_QI,
    maxQi: INITIAL_QI,
  };
}

/** 创建一场新对局 */
export function createBattle(options: CreateBattleOptions): Battle {
  const now = options.now;
  return {
    id: randomUUID(),
    seed: options.seed ?? Math.floor(Math.random() * 0x7fffffff),
    turn: 0,
    phase: 'battle',
    player: createFighter('player', '你'),
    enemy: createFighter('enemy', options.enemyName?.trim() || DEFAULT_ENEMY_NAME),
    history: [],
    startedAt: now,
    updatedAt: now,
  };
}

/**
 * 结算一个回合，返回新的对局状态（不改动入参，方便回放与单测）。
 *
 * TODO(玩法): 目前只推进回合、记录指令，不产生任何数值变化。
 * 具体机制接入时应在这里完成：
 * 1. 对手行动选择（简单随机 / 策略 AI，可复用 seed 保证可复现）；
 * 2. 命中判定与 miss 概率；
 * 3. 攻击伤害、闪避收益、回气回复量的数值公式；
 * 4. 血量归零后的胜负判定，把 phase 置为 victory / defeat。
 */
export function resolveTurn(battle: Battle, action: ActionId, now: number): Battle {
  const turn = battle.turn + 1;

  const history = [...battle.history, { turn, playerAction: action, createdAt: now }].slice(-HISTORY_LIMIT);

  return {
    ...battle,
    turn,
    history,
    phase: 'battle',
    updatedAt: now,
  };
}
