/**
 * 硬件 HUD 状态：把服务端的权威局面翻译成「精灵屏幕要显示什么」。
 *
 * 固件不认识生命值、能量这些玩法概念，只认表情名、数值和一个音效名；
 * 这里负责把 BattleState 派生为一份与屏幕一一对应的只读快照。
 * 页面、播报与规则都不依赖本模块，反过来这里也不产生任何玩法事实。
 */

import { isUltimateReady } from './rules.js';
import type { BattleState, HistoryEntryState } from './state.js';

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
function isAttack(entry: HistoryEntryState): boolean {
  return entry.actor === 'player' && (entry.action === 'light' || entry.action === 'heavy' || entry.action === 'ult');
}

/**
 * 最近一条战报够不够新：够新才播瞬间表情。
 *
 * 快照里没有逐条时间戳，用对局的 updatedAt 当「最后一次变化」的时间，
 * 误差最多是一次无关的等待状态刷新，可以接受。
 */
function isFresh(state: BattleState, now: number): boolean {
  return now - state.updatedAt <= HUD_TRANSIENT_MS;
}

/** 从最近一条战报读瞬间表情；不在窗口内或没有战报返回 null */
function transientExpression(state: BattleState, now: number): HudExpression | null {
  if (!isFresh(state, now)) return null;
  const entry = state.history.at(-1);
  if (!entry) return null;
  if (isAttack(entry)) return 'attack';
  // 对手的出手要按我方的应对来读：闪避成功、格挡、挨打
  if (entry.actor === 'enemy') {
    if (entry.dodged) return 'dodge';
    if (entry.response === 'guard') return 'guard';
    return 'hurt';
  }
  return null;
}

/** 当前是否应该显示「大招就绪」：轮到自己主动、没有待应对、能量够且本局还有次数 */
function isUltTurn(state: BattleState): boolean {
  return state.phase === 'battle'
    && !state.waiting
    && state.pending === null
    && state.active === 'player'
    && isUltimateReady(state.you);
}

/** 大招徽记三态：本局次数用完优先显示「已用」 */
function ultState(state: BattleState): HudUltState {
  if (state.you.ultLeft <= 0) return 2;
  return isUltTurn(state) ? 1 : 0;
}

/** 决定这一帧表情：胜负 > 瞬间动作 > 大招就绪 > 待命 */
function expressionOf(state: BattleState, now: number): HudExpression {
  if (state.waiting) return 'neutral';
  if (state.phase === 'victory') return 'victory';
  if (state.phase === 'defeat') return 'defeat';
  const transient = transientExpression(state, now);
  if (transient) return transient;
  if (isUltTurn(state)) return 'ultready';
  return 'neutral';
}

/** 两帧是否等价：只有等价才不涨帧号、不重复播音效 */
function sameFrame(a: HudState, b: HudState): boolean {
  return a.battle === b.battle
    && a.room === b.room
    && a.waiting === b.waiting
    && a.expression === b.expression
    && a.hp === b.hp
    && a.maxHp === b.maxHp
    && a.energy === b.energy
    && a.maxEnergy === b.maxEnergy
    && a.ult === b.ult
    && a.holdMs === b.holdMs;
}

/**
 * 派生下一帧 HUD；入参局面不会被修改。
 *
 * `previous` 是同一设备上一帧，用来决定帧号与是否播音效：
 * 表情没变就不播，避免每次轮询都把同一段音效重放一遍。
 */
export function deriveHud(state: BattleState | null, previous: HudState | null, now = Date.now()): HudState {
  if (!state) {
    const idle = idleHud(now);
    const same = previous !== null && sameFrame(previous, idle);
    return { ...idle, seq: previous ? previous.seq + (same ? 0 : 1) : 1 };
  }

  const expression = expressionOf(state, now);
  const holdMs = expression === 'victory' || expression === 'defeat' || expression === 'ultready' || expression === 'neutral'
    ? 0
    : HUD_TRANSIENT_MS;
  const frame: HudState = {
    battle: true,
    room: state.room,
    waiting: state.waiting,
    expression,
    hp: state.you.hp,
    maxHp: state.you.maxHp,
    energy: state.you.ap,
    maxEnergy: state.you.maxAp,
    ult: ultState(state),
    cue: null,
    seq: 0,
    holdMs,
    updatedAt: state.updatedAt,
  };
  const changed = previous === null || !sameFrame(previous, frame);
  // 音效跟着表情走：只有表情真的换了才给 cue，并且待命没有音效
  frame.cue = previous === null || previous.expression !== expression ? CUE_OF[expression] : null;
  frame.seq = previous ? previous.seq + (changed ? 1 : 0) : 1;
  return frame;
}

/** 设备工具返回的 JSON：字段名直接用固件里约定的下划线风格 */
export function hudPayload(hud: HudState): Record<string, unknown> {
  return {
    ok: true,
    battle: hud.battle,
    room: hud.room,
    waiting: hud.waiting,
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
