/**
 * 硬件 HUD 状态：把服务端的权威事实翻译成「精灵屏幕要显示什么」。
 *
 * 固件不认识生命值、能量这些玩法概念，只认表情名、数值和一个音效名。
 * 这里不再直接读对局对象，而是把 [事实](presentation.ts) 投影成一帧画面：
 * 平台演绎与屏幕画面读同一份事实，避免两边各写一遍「这一手算什么」的判断。
 */

import type { BattleState } from './state.js';
import { frameOfState, type FrameTurn } from './frame.js';
import { factsOf, type Facts } from './presentation.js';
import { isUltimateReady } from './rules.js';

/** 与设计文档「八种表情」一一对应，也是固件表情资源的文件名 */
export type HudExpression =
  | 'neutral'
  | 'charge'
  | 'attack'
  | 'heavy'
  | 'hurt'
  | 'guard'
  | 'dodge'
  | 'ultready'
  | 'victory'
  | 'defeat';

/** 短时表情的展示时长：进攻、受击、格挡、闪避这类瞬间动作过后回到待命 */
/** 对局结束后结局定格多久，之后屏幕收回待命（用户选定的 B 口径） */
export const HUD_ENDED_HOLD_MS = 6000;

export const HUD_TRANSIENT_MS = 2500;

/** 表情对应的音效名（与固件 main/assets/common 下的 ogg 同名）；待命不发声 */
const CUE_OF: Record<HudExpression, string | null> = {
  neutral: null,
  charge: null,
  attack: 'attack',
  heavy: 'attack',
  hurt: 'hurt',
  guard: 'guard',
  dodge: 'dodge',
  ultready: 'ult',
  victory: 'victory',
  defeat: 'defeat',
};

/** 大招徽记：0=未就绪（空心断弧），1=可释放（实心+气焰），2=本局已用（斜划） */
export type HudUltState = 0 | 1 | 2;

/** 一侧玩家的资源；屏幕同一行既画生命值又画 5 个闪电 */
export interface HudResources {
  hp: number;
  maxHp: number;
  energy: number;
  maxEnergy: number;
  ult: HudUltState;
}

/** 下发给设备的一帧 HUD（字段名与固件 cJSON 解析保持一致） */
export interface HudState {
  /** 是否在对局中；false 时设备只显示待命表情，不显示资源 */
  battle: boolean;
  room: string | null;
  waiting: boolean;
  /** 这是第几轮；与事实的 round 同源，方便日志对齐「这是哪一手的画面」 */
  round: number;
  expression: HudExpression;
  hp: number;
  maxHp: number;
  energy: number;
  maxEnergy: number;
  ult: HudUltState;
  /** 对面玩家的资源；等对手加入或没有对局时为 null，屏幕只画自己那一行 */
  opponent: HudResources | null;
  /** 对局形态：双人房上排画对手、单人局上排画自己（看屏的人是本人） */
  mode: 'solo' | 'pvp' | null;
  /** 本帧需要播放的音效名；只在表情变化时给一次，null 表示不发声 */
  cue: string | null;
  /** 单调递增的帧号；同一次设备会话里每次变化 +1 */
  seq: number;
  /** 短时表情的保持时长（毫秒）；0 表示不会自动回落 */
  holdMs: number;
  updatedAt: number;
}

/** 不在对局里时的待命帧；资源置零，设备据此隐藏资源条 */
export function idleHud(updatedAt: number): HudState {
  return {
    battle: false,
    room: null,
    waiting: false,
    round: 0,
    expression: 'neutral',
    hp: 0,
    maxHp: 1,
    energy: 0,
    maxEnergy: 5,
    ult: 0,
    opponent: null,
    mode: null,
    cue: null,
    seq: 0,
    holdMs: 0,
    updatedAt,
  };
}

/** 同一回合里我方出手后对手又还手时：先亮自己这一手，再交回对手动作 */
export const HUD_ACTION_HOLD_MS = 1600;

/** 主动阶段的三种攻击都由「进攻」表情代表 */
function isAttack(turn: FrameTurn): boolean {
  return turn.actor === 'player' && (turn.action === 'light' || turn.action === 'heavy' || turn.action === 'ult');
}

/**
 * 最近一条战报读瞬间表情。
 *
 * 事实里没有逐条时间戳，用对局的 updatedAt 当「最后一次变化」的时间；
 * 超过展示窗口就不再播瞬间表情，避免开局回看旧战报时重放。
 */
function ownActionExpression(turn: FrameTurn): HudExpression | null {
  if (turn.actor !== 'player') return null;
  if (turn.action === 'charge') return 'charge';
  if (turn.action === 'heavy') return 'heavy';
  return isAttack(turn) ? 'attack' : null;
}

function transientExpression(facts: Facts, now: number): HudExpression | null {
  if (!facts.lastTurn || !facts.updatedAt) return null;
  const age = now - facts.updatedAt;
  if (age > HUD_TRANSIENT_MS) return null;
  // 同一回合里我先出手、对手随后还手（例如蓄力后被反击）：
  // 前 1.6 秒仍播我自己的动作，之后再切到对手造成的受击/格挡/闪避
  if (age <= HUD_ACTION_HOLD_MS) {
    // 战报是「我出手 → 对手还手」成对出现的；回合号每手都会加一，不能用回合号配对
    const [prev, last] = facts.recentTurns ?? [];
    const mine = prev && last && last === facts.lastTurn && prev.actor === 'player' ? prev : null;
    const own = mine ? ownActionExpression(mine) : null;
    if (own) return own;
  }
  const turn = facts.lastTurn;
  // 我方出手：蓄力、重击、普攻各自一张表情（用户要求区分轻/重击）
  const own = ownActionExpression(turn);
  if (own) return own;
  // 对手的出手要按我方的应对来读：闪避成功、格挡、挨打
  if (turn.actor === 'enemy') {
    if (turn.dodged) return 'dodge';
    if (turn.response === 'guard') return 'guard';
    return 'hurt';
  }
  return null;
}

/** 决定这一帧表情：胜负 > 瞬间动作 > 大招就绪 > 待命 */
function expressionOf(facts: Facts, now: number): HudExpression {
  if (facts.next === 'wait-join') return 'neutral';
  if (facts.phase === 'victory') return 'victory';
  if (facts.phase === 'defeat') return 'defeat';
  const transient = transientExpression(facts, now);
  if (transient) return transient;
  // next==='act' 已经包含「轮到我主动、没有待应对、不是等对手加入」
  if (facts.next === 'act' && facts.you?.ultimateReady) return 'ultready';
  return 'neutral';
}

/** 大招徽记三态：本局次数用完优先显示「已用」 */
function ultState(fighter: { ultimateRemaining: number; energy: number } | undefined, ready: boolean): HudUltState {
  if (!fighter || fighter.ultimateRemaining <= 0) return 2;
  return ready ? 1 : 0;
}

/** 对面玩家的资源：等对手加入（facts.opponent 缺省）时返回 null */
function opponentOf(facts: Facts): HudResources | null {
  const foe = facts.opponent;
  if (!foe) return null;
  return {
    hp: foe.hp,
    maxHp: foe.maxHp,
    energy: foe.energy,
    maxEnergy: foe.maxEnergy,
    ult: ultState({ ultimateRemaining: foe.ultimateRemaining, energy: foe.energy }, isUltimateReady({ ap: foe.energy, ultLeft: foe.ultimateRemaining })),
  };
}

/** 对面资源逐项比较；一方没有对手时只比「都没有」 */
function sameOpponent(a: HudResources | null, b: HudResources | null): boolean {
  if (!a || !b) return a === b;
  return a.hp === b.hp && a.maxHp === b.maxHp && a.energy === b.energy
    && a.maxEnergy === b.maxEnergy && a.ult === b.ult;
}

/** 两帧是否等价：只有等价才不涨帧号、不重复播音效 */
function sameFrame(a: HudState, b: HudState): boolean {
  return a.battle === b.battle
    && a.room === b.room
    && a.waiting === b.waiting
    && a.round === b.round
    && a.expression === b.expression
    && a.hp === b.hp
    && a.maxHp === b.maxHp
    && a.energy === b.energy
    && a.maxEnergy === b.maxEnergy
    && a.ult === b.ult
    && sameOpponent(a.opponent, b.opponent)
    && a.mode === b.mode
    && a.holdMs === b.holdMs;
}

/**
 * 把一局事实投影成下发给设备的一帧。
 *
 * `previous` 是同一设备上一帧，用来决定帧号与是否播音效：
 * 表情没变就不播，避免每次轮询都把同一段音效重放一遍。
 */
export function hudFromFacts(facts: Facts | null, previous: HudState | null, now = Date.now()): HudState {
  if (!facts || !facts.you) {
    const idle = idleHud(facts?.updatedAt ?? now);
    const same = previous !== null && sameFrame(previous, idle);
    return { ...idle, seq: previous ? previous.seq + (same ? 0 : 1) : 1 };
  }

  // 结局定格：先让人看清胜利/失败，再自动把屏幕收回「只显示表情」
  if (facts.phase === 'victory' || facts.phase === 'defeat') {
    const endedAt = facts.updatedAt ?? now;
    if (now - endedAt >= HUD_ENDED_HOLD_MS) {
      const idle = idleHud(endedAt);
      const same = previous !== null && sameFrame(previous, idle);
      return { ...idle, seq: previous ? previous.seq + (same ? 0 : 1) : 1 };
    }
  }

  const expression = expressionOf(facts, now);
  // 大招就绪：只有轮到自己主动、且事实判定可释放时才算「可点」
  const youReady = facts.next === 'act' && facts.you.ultimateReady;
  const holdMs = expression === 'victory' || expression === 'defeat' || expression === 'ultready' || expression === 'neutral'
    ? 0
    : HUD_TRANSIENT_MS;
  const frame: HudState = {
    battle: true,
    room: facts.room ?? null,
    waiting: facts.next === 'wait-join',
    round: facts.round ?? 0,
    expression,
    hp: facts.you.hp,
    maxHp: facts.you.maxHp,
    energy: facts.you.energy,
    maxEnergy: facts.you.maxEnergy,
    ult: ultState({ ultimateRemaining: facts.you.ultimateRemaining, energy: facts.you.energy }, youReady),
    opponent: opponentOf(facts),
    mode: facts.mode ?? null,
    cue: null,
    seq: 0,
    holdMs,
    updatedAt: facts.updatedAt ?? now,
  };
  const changed = previous === null || !sameFrame(previous, frame);
  // 音效跟着表情走：只有表情真的换了才给 cue，并且待命没有音效
  frame.cue = previous === null || previous.expression !== expression ? CUE_OF[expression] : null;
  frame.seq = previous ? previous.seq + (changed ? 1 : 0) : 1;
  return frame;
}

/**
 * 从对局快照派生一帧；内部先归一成事实再投影。
 *
 * 保留这个入口是为了页面、测试与旧调用点：语义与设备通道完全一致。
 */
export function deriveHud(state: BattleState | null, previous: HudState | null, now = Date.now()): HudState {
  const facts = state
    ? factsOf(frameOfState(state), { kind: 'status', waiting: state.waiting })
    : factsOf(null, { kind: 'status' });
  return hudFromFacts(facts, previous, now);
}

/** 设备工具返回的 JSON：字段名直接用固件里约定的下划线风格 */
export function hudPayload(hud: HudState): Record<string, unknown> {
  return {
    ok: true,
    battle: hud.battle,
    room: hud.room,
    waiting: hud.waiting,
    round: hud.round,
    expression: hud.expression,
    hp: hud.hp,
    max_hp: hud.maxHp,
    energy: hud.energy,
    max_energy: hud.maxEnergy,
    ult: hud.ult,
    mode: hud.mode,
    opponent: hud.opponent
      ? {
          hp: hud.opponent.hp,
          max_hp: hud.opponent.maxHp,
          energy: hud.opponent.energy,
          max_energy: hud.opponent.maxEnergy,
          ult: hud.opponent.ult,
        }
      : null,
    cue: hud.cue,
    seq: hud.seq,
    hold_ms: hud.holdMs,
    updated_at: hud.updatedAt,
  };
}
