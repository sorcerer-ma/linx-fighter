import { isUltimateReady } from './rules.js';
import type { Battle, BattleEvent } from './types.js';

/** Additive MCP presentation contract. Facts are built from authoritative state,
 * never recovered by parsing narration. Renderings remain optional reference
 * phrasing for compatibility; they are not a whitelist for expression. */
export interface Presentation {
  version: 1;
  kind: 'status' | 'turn' | 'opening' | 'retry' | 'rejected' | 'other' | 'error';
  certainty: 'confirmed' | 'not-applied' | 'unknown';
  facts: {
    round?: number;
    phase?: Battle['phase'];
    you?: { hp:number; energy:number; ultimateRemaining:number; ultimateReady:boolean };
    opponent?: { hp:number; energy:number; ultimateRemaining:number };
    opponentName?: string;
    events: BattleEvent[];
    next: 'act' | 'respond' | 'wait-opponent' | 'wait-response' | 'wait-join' | 'ended' | 'start' | 'unspecified';
    rejection?: string;
  };
  renderings: string[];
}
export function presentation(kind: Presentation['kind'], battle: Battle | null, options: {
  events?: BattleEvent[]; waiting?: boolean; rejection?: string; renderings?: string[];
} = {}): Presentation {
  const fighter = (f: Battle['player']) => ({hp:f.hp,energy:f.ap,ultimateRemaining:f.ultLeft});
  const next = !battle ? (['status','retry','rejected'].includes(kind) ? 'start' : 'unspecified') : battle.phase !== 'battle' ? 'ended'
    : options.waiting ? 'wait-join' : battle.pending ? (battle.pending.actor === 'player' ? 'wait-response' : 'respond')
    : battle.active === 'player' ? 'act' : 'wait-opponent';
  return {version:1,kind,certainty:kind==='error'?'unknown':(kind==='rejected'||kind==='retry')?'not-applied':'confirmed',facts:{
    ...(battle ? {round:battle.round,phase:battle.phase,you:{...fighter(battle.player),ultimateReady:isUltimateReady(battle.player)},...(options.waiting?{}:{opponent:fighter(battle.enemy),opponentName:battle.enemy.name})} : {}),
    events:options.events??[],next,...(options.rejection ? {rejection:options.rejection}:{}),
  },renderings:options.renderings??[]};
}
