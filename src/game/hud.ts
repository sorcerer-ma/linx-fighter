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

/** 与设计文档「八种表情」一一对应，也是固件表情资源的文件名 */
export type HudExpression =
  | 'neutral'
  | 'attack'
  | 'hurt'
  | 'guard'
  | 'dodge'
  | 'ultready'
  | 'victory'
  | 'defeat';

/** 短时表情的展示时长：进攻、受击、格挡、闪避这类瞬间动作过后回到待命 */
export const HUD_TRANSIENT_MS = 2500;

/** 表情对应的音效名（与固件 main/assets/common 下的 ogg 同名）；待命不发声 */
const CUE_OF: Record<HudExpression, string | null> = {
  neutral: null,
  attack: 'attack',
  hurt: 'hurt',
  guard: 'guard',
  dodge: 'dodge',
  ultready: 'ult',
  victory: 'victory',
  defeat: 'defeat',
};

/** 大招徽记：0=未就绪（空心断弧），1=可释放（实心+气焰），2=本局已用（斜划） */
export type HudUltState = 0 | 1 | 2;

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
    cue: null,
    seq: 0,
    holdMs: 0,
    updatedAt,
  };
}

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
function transientExpression(facts: Facts, now: number): HudExpression | null {
  if (!facts.lastTurn || !facts.updatedAt) return null;
  if (now - facts.updatedAt > HUD_TRANSIENT_MS) return null;
  const turn = facts.lastTurn;
  if (isAttack(turn)) return 'attack';
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
function ultState(facts: Facts): HudUltState {
  if ((facts.you?.ultimateRemaining ?? 0) <= 0) return 2;
  return facts.next === 'act' && facts.you?.ultimateReady ? 1 : 0;
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

  const expression = expressionOf(facts, now);
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
    ult: ultState(facts),
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
    cue: hud.cue,
    seq: hud.seq,
    hold_ms: hud.holdMs,
    updated_at: hud.updatedAt,
  };
}
