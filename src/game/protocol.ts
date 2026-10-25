import { actionLabel } from './actions.js';
import { ATTACKS, RESPONSES } from './rules.js';
import type { ActionId, Battle, BattleEvent, Side } from './types.js';

/** Complete JSON responses are bounded at transport, never truncated. */
export const MAX_REPLY_BYTES = 16 * 1024;
export const PROTOCOL_REPLY_MAX_BYTES = MAX_REPLY_BYTES;
export type ProtocolSide = 'you' | 'foe';
export type ProtocolNeed = 'move' | 'respond' | 'wait_guest' | 'wait_foe' | 'none';
export type ProtocolReason =
  | 'unclear' | 'negated' | 'ambiguous' | 'wrong_stage' | 'no_ap' | 'no_ult'
  | 'waiting' | 'ended' | 'room_missing' | 'room_full' | 'room_bad' | 'failed' | 'unknown';
export type ProtocolEvent =
  | { t: 'start'; foe: string; first: ProtocolSide }
  | { t: 'room' | 'join'; code: string }
  | { t: 'round'; n: number; bonus: number }
  | { t: 'charge'; by: ProtocolSide; ap: number }
  | {
      t: 'hit'; by: ProtocolSide; mv: 'light' | 'heavy' | 'ult';
      r: 'guard' | 'dodge' | 'take'; dmg: number;
      miss?: true; crit?: true; forced?: true;
    }
  | { t: 'end'; win: ProtocolSide; cause?: 'forfeit' }
  | { t: 'timeout'; what: 'guest' | 'foe' }
  | { t: 'chant'; text: string };

export interface GameReply {
  v: 2;
  ok: boolean;
  silent?: true;
  /** Absent for silence or a fault whose state cannot be obtained. */
  phase?: 'idle' | 'room' | 'battle' | 'victory' | 'defeat';
  need?: ProtocolNeed;
  mode?: 'solo' | 'pvp';
  room?: string;
  round?: number;
  you?: { hp: number; maxHp: number; ap: number; maxAp: number; ult: number };
  foe?: { name: string; hp: number; maxHp: number; ap: number; ult: number };
  pending?: { by: ProtocolSide; mv: 'light' | 'heavy' | 'ult'; dmg: number };
  choices?: string[];
  deny?: { mv: ActionId; need?: number; short?: number };
  events?: ProtocolEvent[];
  text?: string;
  say?: string;
  reason?: ProtocolReason;
}

export function protocolSide(side: Side): ProtocolSide {
  return side === 'player' ? 'you' : 'foe';
}

/** Pending is a state, never an already resolved hit. */
export function protocolEvents(events: readonly BattleEvent[]): ProtocolEvent[] {
  return events.flatMap((event): ProtocolEvent[] => {
    switch (event.type) {
      case 'round-start': return [{ t: 'round', n: event.round, bonus: event.bonus }];
      case 'charge': return [{ t: 'charge', by: protocolSide(event.side), ap: event.ap }];
      case 'attack': return [{
        t: 'hit', by: protocolSide(event.side), mv: event.move,
        r: event.response, dmg: event.damage,
        ...(event.dodged ? { miss: true as const } : {}),
        ...(event.crit ? { crit: true as const } : {}),
        ...(event.forced ? { forced: true as const } : {}),
      }];
      case 'end': return [{ t: 'end', win: protocolSide(event.winner) }];
      case 'pending': return [];
    }
  });
}

interface ReplyOptions {
  room?: string | null;
  waiting?: boolean;
  events?: ProtocolEvent[];
  say?: string;
  text?: string;
  reason?: ProtocolReason;
  action?: ActionId;
  silent?: boolean;
}

export function protocolReply(battle: Battle | null, options: ReplyOptions = {}): GameReply {
  if (options.silent) return { v: 2, ok: true, silent: true };
  const reply: GameReply = {
    v: 2, ok: !options.reason,
    phase: battle ? (options.waiting ? 'room' : battle.phase) : 'idle',
    need: 'none', events: options.events ?? [],
    ...(options.reason ? { reason: options.reason } : {}),
    ...(options.text !== undefined ? { text: options.text } : { say: options.say ?? '我在，想怎么做？' }),
  };
  if (options.room) { reply.mode = 'pvp'; reply.room = options.room; }
  if (!battle) return reply;
  if (options.waiting) { reply.need = 'wait_guest'; return reply; }
  reply.mode = battle.mode;
  reply.round = battle.round;
  reply.you = {
    hp: battle.player.hp, maxHp: battle.player.maxHp,
    ap: battle.player.ap, maxAp: battle.player.maxAp, ult: battle.player.ultLeft,
  };
  reply.foe = {
    name: battle.enemy.name, hp: battle.enemy.hp, maxHp: battle.enemy.maxHp,
    ap: battle.enemy.ap, ult: battle.enemy.ultLeft,
  };
  reply.need = battle.phase !== 'battle' ? 'none'
    : battle.pending ? (battle.pending.actor === 'player' ? 'wait_foe' : 'respond')
      : battle.active === 'player' ? 'move' : 'wait_foe';
  if (battle.pending) {
    reply.pending = { by: protocolSide(battle.pending.actor), mv: battle.pending.move, dmg: battle.pending.damage };
  }
  if (reply.need === 'move') {
    reply.choices = [
      ...Object.values(ATTACKS)
        .filter(a => a.apCost <= battle.player.ap && (a.id !== 'ult' || battle.player.ultLeft > 0))
        .map(a => a.label),
      ...(battle.player.ap < battle.player.maxAp ? ['蓄力'] : []),
    ];
  }
  if (reply.need === 'respond') {
    reply.choices = (Object.keys(RESPONSES) as (keyof typeof RESPONSES)[])
      .filter(a => RESPONSES[a].apCost <= battle.player.ap).map(actionLabel);
  }
  if (options.action && (options.reason === 'no_ap' || options.reason === 'no_ult')) {
    const action = options.action;
    const need = action in ATTACKS ? ATTACKS[action as keyof typeof ATTACKS].apCost
      : action in RESPONSES ? RESPONSES[action as keyof typeof RESPONSES].apCost : 0;
    reply.deny = { mv: action, ...(options.reason === 'no_ap' ? { need, short: Math.max(0, need - battle.player.ap) } : {}) };
  }
  return reply;
}

/** Only a successful empty long-poll timeout may continue without speech.
 * A timeout mixed with a real event is never discarded. */
export function isEmptyWaitTimeout(reply: GameReply): boolean {
  return reply.v === 2 && reply.ok && !reply.silent && !reply.text
    && (reply.need === 'wait_guest' || reply.need === 'wait_foe')
    && !!reply.events?.length && reply.events.every(event => event.t === 'timeout'
      && event.what === (reply.need === 'wait_guest' ? 'guest' : 'foe'));
}
