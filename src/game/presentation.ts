import { isUltimateReady } from './rules.js';
import type { Battle, BattleEvent } from './types.js';
import { frameOfBattle, type BattleFrame, type FrameTurn } from './frame.js';

/** Additive MCP presentation contract. Facts are built from authoritative state,
 * never recovered by parsing narration. Renderings remain optional reference
 * phrasing for compatibility; they are not a whitelist for expression. */

/** 事实里的下一步：平台只按这些字段演绎，不自行推演规则 */
export type FactsNext =
  | 'act'
  | 'respond'
  | 'wait-opponent'
  | 'wait-response'
  | 'wait-join'
  | 'ended'
  | 'start'
  | 'unspecified';

/** 事实里的我方资源；上限一起给，屏幕资源条与平台措辞都用得上 */
export interface FactsFighter {
  hp: number;
  maxHp: number;
  energy: number;
  maxEnergy: number;
  ultimateRemaining: number;
  ultimateReady: boolean;
}

/** 事实里的对手资源；等对手加入时整块省略 */
export interface FactsOpponent {
  hp: number;
  maxHp: number;
  energy: number;
  maxEnergy: number;
  ultimateRemaining: number;
}

/** 一局事实：屏幕画面与平台演绎都只读这一份 */
export interface Facts {
  round?: number;
  /** 对局形态：双人房里两块屏相对，单人局只有本人一块屏 */
  mode?: 'solo' | 'pvp';
  phase?: BattleFrame['phase'];
  room?: string;
  updatedAt?: number;
  you?: FactsFighter;
  opponent?: FactsOpponent;
  opponentName?: string;
  /** 最近一条已结算战报：屏幕据此播瞬间表情，平台也据此对齐「这是哪一手」 */
  lastTurn?: FrameTurn;
  /** 最近两手：同一回合里「我出手 → 对手还手」时，屏幕分先后播两个表情 */
  recentTurns?: FrameTurn[];
  events: BattleEvent[];
  next: FactsNext;
  rejection?: string;
}

export interface Presentation {
  version: 1;
  kind: 'status' | 'turn' | 'opening' | 'retry' | 'rejected' | 'other' | 'error';
  certainty: 'confirmed' | 'not-applied' | 'unknown';
  facts: Facts;
  renderings: string[];
}

/** 视角化局面 → 事实；没有对局时只给下一步与事件 */
export function factsOf(
  frame: BattleFrame | null,
  options: {
    kind: Presentation['kind'];
    events?: BattleEvent[];
    waiting?: boolean;
    rejection?: string;
  },
): Facts {
  const { kind } = options;
  const next: FactsNext = !frame
    ? (['status', 'retry', 'rejected'].includes(kind) ? 'start' : 'unspecified')
    : frame.phase !== 'battle'
      ? 'ended'
      : options.waiting
        ? 'wait-join'
        : frame.pending
          ? (frame.pending.actor === 'player' ? 'wait-response' : 'respond')
          : frame.active === 'player' ? 'act' : 'wait-opponent';
  const fighter = (f: BattleFrame['you']): FactsFighter => ({
    hp: f.hp,
    maxHp: f.maxHp,
    energy: f.ap,
    maxEnergy: f.maxAp,
    ultimateRemaining: f.ultLeft,
    ultimateReady: isUltimateReady(f),
  });
  const opponent = (f: BattleFrame['opponent']): FactsOpponent => ({
    hp: f.hp,
    maxHp: f.maxHp,
    energy: f.ap,
    maxEnergy: f.maxAp,
    ultimateRemaining: f.ultLeft,
  });
  const lastTurn = frame?.history.at(-1);
  return {
    ...(frame
      ? {
          round: frame.round,
          mode: frame.mode,
          phase: frame.phase,
          ...(frame.room ? { room: frame.room } : {}),
          updatedAt: frame.updatedAt,
          you: fighter(frame.you),
          ...(options.waiting
            ? {}
            : { opponent: opponent(frame.opponent), opponentName: frame.opponent.name }),
          ...(lastTurn
            ? { lastTurn, recentTurns: frame.history.slice(-2) }
            : {}),
        }
      : {}),
    events: options.events ?? [],
    next,
    ...(options.rejection ? { rejection: options.rejection } : {}),
  };
}

export function presentation(kind: Presentation['kind'], battle: Battle | null, options: {
  events?: BattleEvent[]; waiting?: boolean; rejection?: string; renderings?: string[];
} = {}): Presentation {
  return {
    version: 1,
    kind,
    certainty: kind === 'error' ? 'unknown' : (kind === 'rejected' || kind === 'retry') ? 'not-applied' : 'confirmed',
    facts: factsOf(battle ? frameOfBattle(battle) : null, {
      kind,
      events: options.events,
      waiting: options.waiting,
      rejection: options.rejection,
    }),
    renderings: options.renderings ?? [],
  };
}
