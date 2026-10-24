import type { Battle, BattleEvent } from './types.js';

/** Additive MCP presentation contract. Facts are built from authoritative state,
 * never recovered by parsing narration. Only server-authored full replies may be
 * selected by the expression model in the first implementation. */
export interface Presentation {
  version: 1;
  kind: 'status' | 'turn' | 'rejected' | 'other' | 'error';
  certainty: 'confirmed' | 'not-applied' | 'unknown';
  facts: {
    round?: number;
    phase?: Battle['phase'];
    you?: { hp:number; energy:number; ultimateRemaining:number };
    opponent?: { hp:number; energy:number; ultimateRemaining:number };
    events: BattleEvent[];
    next: 'act' | 'respond' | 'wait-opponent' | 'wait-response' | 'wait-join' | 'ended' | 'unspecified';
    rejection?: string;
  };
  renderings: string[];
}
export function presentation(kind: Presentation['kind'], battle: Battle | null, options: {
  events?: BattleEvent[]; waiting?: boolean; rejection?: string; renderings?: string[];
} = {}): Presentation {
  const fighter = (f: Battle['player']) => ({hp:f.hp,energy:f.ap,ultimateRemaining:f.ultLeft});
  const next = !battle ? 'unspecified' : battle.phase !== 'battle' ? 'ended'
    : options.waiting ? 'wait-join' : battle.pending ? (battle.pending.actor === 'player' ? 'wait-response' : 'respond')
    : battle.active === 'player' ? 'act' : 'wait-opponent';
  return {version:1,kind,certainty:kind==='error'?'unknown':kind==='rejected'?'not-applied':'confirmed',facts:{
    ...(battle ? {round:battle.round,phase:battle.phase,you:fighter(battle.player),...(options.waiting?{}:{opponent:fighter(battle.enemy)})} : {}),
    events:options.events??[],next,...(options.rejection ? {rejection:options.rejection}:{}),
  },renderings:options.renderings??[]};
}
