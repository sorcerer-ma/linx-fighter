import { randomUUID } from 'node:crypto';
import { ENEMY_AI } from './enemy.js';
import { randomAt } from './rng.js';
import { ATTACKS, CHARGE_AP, CRIT_BONUS, RESPONSES, RULES, roundDamageBonus } from './rules.js';
import {
  isActiveAction,
  isResponseAction,
  otherSide,
  type ActionId,
  type ActiveActionId,
  type Battle,
  type BattleAI,
  type BattleEvent,
  type BattleMode,
  type Fighter,
  type ResponseMove,
  type ResponseView,
  type Side,
  type TurnDeps,
  type TurnRejection,
  type TurnResult,
} from './types.js';

/** 默认对手名。后续接入对手库/关卡片段时从这里切换 */
export const DEFAULT_ENEMY_NAME = '守擂教头';

/** 战报最多保留多少条 */
const HISTORY_LIMIT = 30;

export interface CreateBattleOptions {
  /** 对手名，不填用默认对手 */
  enemyName?: string;
  now: number;
  /** 随机种子，固定后可复现同一场对局，便于调试与单测 */
  seed?: number;
  /** 先手方；不填时按种子奇偶决定，保证同一种子必然同一局面 */
  firstMover?: Side;
  /** 对局模式：双人联机时引擎不自动推进对手阶段，等另一位玩家输入 */
  mode?: BattleMode;
}

/** 结算过程中的草稿：拷贝对局后在草稿上推进，最后整体返回，保证入参不被修改 */
interface Draft {
  battle: Battle;
  events: BattleEvent[];
  rng: () => number;
  draws: { count: number };
  ai: BattleAI;
  now: number;
}

function createFighter(id: Side, name: string, hp: number): Fighter {
  return {
    id,
    name,
    hp,
    maxHp: hp,
    ap: RULES.initialAp,
    maxAp: RULES.maxAp,
    ultLeft: RULES.ultUses,
  };
}

/** 创建一场新对局。先手 14 血、后手 18 血，先手方先动 */
export function createBattle(options: CreateBattleOptions): Battle {
  const seed = options.seed ?? Math.floor(Math.random() * 0x7fffffff);
  const firstMover = options.firstMover ?? (seed % 2 === 0 ? 'player' : 'enemy');
  const playerFirst = firstMover === 'player';
  const now = options.now;

  return {
    id: randomUUID(),
    mode: options.mode ?? 'solo',
    seed,
    rngDraws: 0,
    round: 1,
    phase: 'battle',
    firstMover,
    active: firstMover,
    // 先手方在创建时就算已进入第一个主动阶段；第一个阶段不回行动点
    activePhases: { player: playerFirst ? 1 : 0, enemy: playerFirst ? 0 : 1 },
    pending: null,
    player: createFighter('player', '你', playerFirst ? RULES.firstHp : RULES.secondHp),
    enemy: createFighter(
      'enemy',
      options.enemyName?.trim() || DEFAULT_ENEMY_NAME,
      playerFirst ? RULES.secondHp : RULES.firstHp,
    ),
    history: [],
    startedAt: now,
    updatedAt: now,
  };
}

/**
 * 开局推进：如果先手是对手，就把对手的第一个主动阶段跑完，
 * 直到轮到玩家出招或应对为止。先手是玩家时原样返回。
 */
export async function advanceBattle(battle: Battle, now: number, deps: TurnDeps = {}): Promise<TurnResult> {
  if (battle.phase !== 'battle') return { battle, events: [] };
  const draft = createDraft(battle, now, deps);
  await advance(draft);
  return finishDraft(draft);
}

/**
 * 结算玩家的一次操作，返回新的对局状态（不改动入参，方便回放与单测）。
 *
 * 主动阶段只能出招或蓄力，应对阶段只能格挡、闪避或承受；
 * 操作不合法时原样返回对局并给出原因，不推进回合、不改数值、不消耗随机数。
 */
export async function resolveTurn(
  battle: Battle,
  action: ActionId,
  now: number,
  deps: TurnDeps = {},
): Promise<TurnResult> {
  if (battle.phase !== 'battle') {
    return { battle, events: [], rejection: { reason: 'ended', action } };
  }

  const draft = createDraft(battle, now, deps);
  let rejection: TurnRejection | undefined;
  if (draft.battle.pending) {
    // 视角里的 pending.actor=player 表示「自己刚出招」，此时必须等对手应对；
    // 不拦住的话攻击方能替对手把这一手结算掉，双人联机会直接卡死。
    rejection =
      draft.battle.pending.actor === 'player'
        ? { reason: 'waiting-opponent', action }
        : performResponse(draft, action);
  } else if (draft.battle.active !== 'player') {
    rejection = { reason: 'wrong-stage', action };
  } else {
    rejection = await performActive(draft, 'player', action);
  }

  if (rejection) return { battle, events: [], rejection };
  await advance(draft);
  return finishDraft(draft);
}

function createDraft(battle: Battle, now: number, deps: TurnDeps): Draft {
  const draws = { count: battle.rngDraws };
  const rng = (): number => {
    const value = deps.random ? deps.random() : randomAt(battle.seed, draws.count);
    draws.count += 1;
    return value;
  };

  const draft: Draft = {
    battle: {
      ...battle,
      activePhases: { ...battle.activePhases },
      pending: battle.pending ? { ...battle.pending } : null,
      player: { ...battle.player },
      enemy: { ...battle.enemy },
      history: [...battle.history],
    },
    events: [],
    rng,
    draws,
    ai: deps.ai ?? ENEMY_AI,
    now,
  };
  return draft;
}

function finishDraft(draft: Draft): TurnResult {
  const battle = draft.battle;
  battle.rngDraws = draft.draws.count;
  battle.updatedAt = draft.now;
  return { battle, events: draft.events };
}

/** 跑对手的主动阶段，直到轮到玩家操作或对局结束；双人联机不走 AI，直接返回 */
async function advance(draft: Draft): Promise<void> {
  for (;;) {
    const battle = draft.battle;
    if (battle.phase !== 'battle') return;
    if (battle.pending) return;
    if (battle.mode === 'pvp') return;
    if (battle.active !== 'enemy') return;

    const enemy = battle.enemy;
    let rejection = await performActive(draft, 'enemy', await draft.ai.chooseAction(actionView(draft)));
    if (rejection) {
      // 对手 AI 给出当前行动点做不了的选择时，退到一定合法的操作，避免卡死
      rejection = await performActive(draft, 'enemy', enemy.ap < enemy.maxAp ? 'charge' : 'light');
      if (rejection) return;
    }
  }
}

function actionView(draft: Draft) {
  const battle = draft.battle;
  return {
    round: battle.round,
    bonus: roundDamageBonus(battle.round),
    self: fighterView(battle.enemy),
    enemy: fighterView(battle.player),
    history: [...battle.history],
  };
}

function responseView(draft: Draft, defenderSide: Side): ResponseView {
  const battle = draft.battle;
  const pending = battle.pending;
  if (!pending) throw new Error('没有待应对的攻击');
  const spec = ATTACKS[pending.move];
  return {
    round: battle.round,
    bonus: roundDamageBonus(battle.round),
    self: fighterView(fighterOf(battle, defenderSide)),
    attacker: fighterView(fighterOf(battle, otherSide(defenderSide))),
    move: pending.move,
    damage: pending.damage,
    critChance: spec.critChance,
    dodgeChance: spec.dodgeChance,
    history: [...battle.history],
  };
}

function fighterView(fighter: Fighter) {
  return { hp: fighter.hp, ap: fighter.ap, ultLeft: fighter.ultLeft };
}

function fighterOf(battle: Battle, side: Side): Fighter {
  return side === 'player' ? battle.player : battle.enemy;
}

/** 主动阶段：蓄力或攻击。返回 undefined 表示已生效 */
async function performActive(draft: Draft, side: Side, action: ActionId): Promise<TurnRejection | undefined> {
  const battle = draft.battle;
  if (!isActiveAction(action)) return { reason: 'wrong-stage', action };

  const self = fighterOf(battle, side);
  if (action === 'charge') {
    if (self.ap >= self.maxAp) return { reason: 'full-ap', action };
    self.ap = Math.min(self.maxAp, self.ap + CHARGE_AP);
    record(draft, { round: battle.round, actor: side, action });
    draft.events.push({ type: 'charge', round: battle.round, side, ap: self.ap });
    endPhase(draft, side);
    return undefined;
  }

  const spec = ATTACKS[action];
  if (self.ap < spec.apCost) return { reason: 'insufficient-ap', action };
  if (action === 'ult' && self.ultLeft <= 0) return { reason: 'no-ult', action };

  self.ap -= spec.apCost;
  if (action === 'ult') self.ultLeft -= 1;

  // 伤害在锁定攻击时确定，防守方的选择不会改变它，也不会反过来影响出招
  battle.pending = { actor: side, move: action, damage: spec.damage + roundDamageBonus(battle.round) };

  const defenderSide = otherSide(side);
  const defender = fighterOf(battle, defenderSide);
  if (defender.ap === 0) {
    // 没有行动点就只能硬扛，不占用玩家的输入
    resolvePending(draft, 'take', true);
  } else if (side === 'player' && battle.mode === 'solo') {
    const response = normalizeResponse(await draft.ai.chooseResponse(responseView(draft, defenderSide)), defender);
    resolvePending(draft, response, false);
  } else {
    // 对手已经出手，等另一方说格挡、闪避或承受
    draft.events.push({ type: 'pending', round: battle.round, side, move: action });
  }
  return undefined;
}

/** 应对阶段：玩家对对手已经锁定的攻击做出选择 */
function performResponse(draft: Draft, action: ActionId): TurnRejection | undefined {
  const battle = draft.battle;
  const pending = battle.pending;
  if (!pending) return { reason: 'wrong-stage', action };
  if (!isResponseAction(action)) return { reason: 'wrong-stage', action };

  const defender = fighterOf(battle, otherSide(pending.actor));
  if (action !== 'take' && defender.ap < RESPONSES[action].apCost) {
    return { reason: 'insufficient-ap', action };
  }
  resolvePending(draft, action, false);
  return undefined;
}

/** 结算一次已经锁定的攻击：扣应对的行动点、判定闪避与暴击、扣血、记战报 */
function resolvePending(draft: Draft, response: ResponseMove, forced: boolean): void {
  const battle = draft.battle;
  const pending = battle.pending;
  if (!pending) return;

  const defender = fighterOf(battle, otherSide(pending.actor));
  if (response !== 'take') defender.ap -= RESPONSES[response].apCost;

  const spec = ATTACKS[pending.move];
  const dodged = response === 'dodge' && draft.rng() < spec.dodgeChance;
  let crit = false;
  let damage = 0;
  if (!dodged) {
    crit = draft.rng() < spec.critChance;
    const reduction = response === 'guard' ? RESPONSES.guard.reduction : 0;
    damage = Math.max(0, pending.damage + (crit ? CRIT_BONUS : 0) - reduction);
    // 气血夹取到 0，避免播报里念出负数；胜负仍按 <= 0 判定
    defender.hp = Math.max(0, defender.hp - damage);
  }

  battle.pending = null;
  record(draft, {
    round: battle.round,
    actor: pending.actor,
    action: pending.move,
    response,
    damage,
    crit,
    dodged,
    guarded: response === 'guard',
  });
  draft.events.push({
    type: 'attack',
    round: battle.round,
    side: pending.actor,
    move: pending.move,
    response,
    dodged,
    crit,
    guarded: response === 'guard',
    forced,
    damage,
    targetHp: defender.hp,
  });

  if (defender.hp <= 0) {
    battle.phase = pending.actor === 'player' ? 'victory' : 'defeat';
    draft.events.push({ type: 'end', round: battle.round, winner: pending.actor });
    return;
  }
  endPhase(draft, pending.actor);
}

/** 一方主动阶段结束：换边；双方都动过就进入下一轮并加伤害 */
function endPhase(draft: Draft, actor: Side): void {
  const battle = draft.battle;
  if (battle.phase !== 'battle') return;

  if (actor === battle.firstMover) {
    battle.active = otherSide(actor);
  } else {
    battle.round += 1;
    battle.active = battle.firstMover;
    draft.events.push({ type: 'round-start', round: battle.round, bonus: roundDamageBonus(battle.round) });
  }
  startActive(draft, battle.active);
}

/** 进入新的主动阶段：第一次不回行动点，之后每次恢复固定值 */
function startActive(draft: Draft, side: Side): void {
  const battle = draft.battle;
  const fighter = fighterOf(battle, side);
  if (battle.activePhases[side] > 0) {
    fighter.ap = Math.min(fighter.maxAp, fighter.ap + RULES.apRegen);
  }
  battle.activePhases[side] += 1;
}

/** 对手 AI 选了当前行动点负担不起的应对时，退到承受 */
function normalizeResponse(response: ResponseMove, defender: Fighter): ResponseMove {
  if (response === 'take') return 'take';
  return defender.ap >= RESPONSES[response].apCost ? response : 'take';
}

function record(draft: Draft, entry: Omit<Battle['history'][number], 'createdAt'>): void {
  const battle = draft.battle;
  battle.history = [...battle.history, { ...entry, createdAt: draft.now }].slice(-HISTORY_LIMIT);
}
