import type { GameReply, ProtocolEvent } from '../../src/game/protocol.js';

export type ReplyRejectionReason = 'empty' | 'format' | 'length' | 'number' | 'ownership' | 'winner' | 'stage' | 'certainty' | 'pending' | 'event_start' | 'event_room' | 'event_charge' | 'event_hit' | 'event_end' | 'event_timeout' | 'event_chant' | 'event_round' | 'text';
const numeral: Record<string, number> = { 零:0, 一:1, 二:2, 两:2, 三:3, 四:4, 五:5, 六:6, 七:7, 八:8, 九:9 };
function normalize(text: string, facts: GameReply): string {
  const named = facts.foe?.name ? text.split(facts.foe.name).join('对手') : text;
  return named.replace(/我方/g, '我').replace(/对方|敌方|敌人/g, '对手')
    .replace(/[零一二两三四五六七八九十]+(?=点|次|轮|回合)/g, value => {
      if (value.includes('十')) { const [tens, ones] = value.split('十'); return String((tens ? numeral[tens] ?? 0 : 1) * 10 + (ones ? numeral[ones] ?? 0 : 0)); }
      return String(numeral[value] ?? value);
    });
}
function asserted(text: string, pattern: RegExp): boolean {
  return pattern.test(text.replace(/(?:没能|没有|不能|未能|没|未|不)(?:命中|击中|打中|挡住|躲开|闪开|获胜|赢了|放出去|放出|释放|出手|生效)/g, ''));
}
function winner(text: string): 'you' | 'foe' | undefined {
  if (/我(?:输了|败了|失败)|对手(?:赢了|获胜|胜利)|我被(?:击倒|打败)/.test(text)) return 'foe';
  if (/对手(?:输了|败了|失败|认输)|我(?:赢了|赢啦|获胜|胜利)|我(?:把|将)?对手(?:击倒|打倒|击败)|我(?:击倒|打倒|击败)了?对手/.test(text)) return 'you';
}
function numbers(value: unknown, result = new Set<number>()): Set<number> {
  if (typeof value === 'number') result.add(value);
  else if (value && typeof value === 'object') for (const item of Object.values(value)) numbers(item, result);
  return result;
}
function eventKept(event: ProtocolEvent, text: string): boolean {
  const actor = event.t === 'hit' || event.t === 'charge' ? event.by === 'you' ? '我' : '对手' : '';
  switch (event.t) {
    case 'room': case 'join': return text.includes(event.code);
    case 'start': return (text.includes('对手') || text.includes(event.foe)) && (event.first === 'you' ? /我.{0,8}(?:先|出手)|(?:先手|先攻).{0,4}我/.test(text) : /对手.{0,8}(?:先|出手)|(?:先手|先攻).{0,4}对手/.test(text));
    case 'charge': return new RegExp(actor + '.{0,14}(?:蓄力|能量)').test(text) && text.includes(String(event.ap));
    case 'hit': {
      const defender = event.by === 'you' ? '对手' : '我';
      if (!(event.dmg === 0 && event.miss) && !text.includes(String(event.dmg))) return false;
      if (!new RegExp(actor + '.{0,12}(?:攻|打|击|冲击)|' + defender + '.{0,12}(?:挨|受|掉|伤|躲|闪|挡)').test(text)) return false;
      if (event.crit && !/暴击/.test(text)) return false;
      if (event.r === 'guard' && !/格挡|挡下|挡住|举盾/.test(text)) return false;
      if (event.r === 'dodge' && event.miss && (!new RegExp(defender + '.{0,8}(?:躲开|闪开|避开)').test(text) || /没(?:能)?躲开|闪避失败/.test(text))) return false;
      if (event.r === 'dodge' && !event.miss && !/没(?:能)?躲开|未躲开|闪避失败|躲晚/.test(text)) return false;
      if (event.forced && !/没(?:有)?能量|能量(?:不够|耗尽)|只能硬/.test(text)) return false;
      return true;
    }
    case 'end': return winner(text) === event.win;
    case 'timeout': return /等|还没|尚未/.test(text);
    case 'chant': return text.includes(event.text);
    case 'round': return event.bonus === 0 || /伤害|加成|更疼|更强/.test(text);
  }
}
const eventReason: Record<ProtocolEvent['t'], ReplyRejectionReason> = {
  start:'event_start', room:'event_room', join:'event_room', charge:'event_charge', hit:'event_hit', end:'event_end', timeout:'event_timeout', chant:'event_chant', round:'event_round',
};

/** Limited factual guard, not a proof of arbitrary natural-language semantics.
 * Optional snapshot facts need not all be spoken. Stage invitations have no
 * phrase whitelist: natural requests like “告诉我打哪招” remain free expression. */
export function replyRejectionReason(candidate: string, facts: GameReply): ReplyRejectionReason | undefined {
  if (facts.silent) return candidate === '' ? undefined : 'format';
  if (!candidate.trim()) return 'empty';
  if (candidate.length > Math.max(120, (facts.text?.length ?? 0) + 30)) return 'length';
  if (/^[\s]*[{[]/.test(candidate)) return 'format';
  const text = normalize(candidate, facts);
  const allowed = numbers({ you:facts.you, foe:facts.foe, round:facts.round, pending:facts.pending, deny:facts.deny, events:facts.events });
  if (facts.room) allowed.add(Number(facts.room));
  // Normalize rule text and the candidate symmetrically: ‘每局一次’ is the
  // same authoritative count as ‘每局1次’, not an invented resource.
  const referenceText = normalize(facts.text ?? '', facts);
  for (const n of referenceText.match(/\d+/g) ?? []) allowed.add(Number(n));
  const factualText = text.replace(/再(?:告诉我|说|讲|重复)(?:1次|一遍)/g, '重说');
  for (const match of factualText.matchAll(/\d+/g)) if (!allowed.has(Number(match[0]))) return 'number';
  const forfeit = facts.events?.find((e):e is Extract<ProtocolEvent,{t:'end'}>=>e.t==='end' && e.cause==='forfeit');
  const escapeClaims = text.replace(/(?:没有|没|并未|未|不)(?:逃跑|逃走|认输)/g,'');
  if (/逃跑|逃走|认输/.test(escapeClaims)) {
    if (!forfeit) return 'event_end';
    for (const match of escapeClaims.matchAll(/(我|对手)(?:(?!我|对手|你)[^，。！？;；]){0,10}(?:逃跑|逃走|认输)/g)) {
      if ((match[1]==='我'?'you':'foe') === forfeit.win) return 'ownership';
    }
  }
  if (forfeit && /击倒|打倒/.test(escapeClaims)) return 'event_end';
  const expectedWinner = facts.phase === 'victory' ? 'you' : facts.phase === 'defeat' ? 'foe' : undefined;
  if (expectedWinner ? winner(text) !== expectedWinner : winner(text) !== undefined) return 'winner';
  // “我掉了3点生命值” is damage, not a claim about remaining hp.
  for (const match of text.matchAll(/(我|对手)(?:现在|目前|还)?(?:有|剩|剩下|还有|还剩|还剩下)\s*(\d+)点?(生命值|能量)/g)) {
    const unit = match[1] === '我' ? facts.you : facts.foe;
    if (!unit || Number(match[2]) !== (match[3] === '能量' ? unit.ap : unit.hp)) return 'ownership';
  }
  for (const match of text.matchAll(/(我|对手)(\d+)点(生命值|能量)/g)) {
    const unit = match[1] === '我' ? facts.you : facts.foe;
    if (!unit || Number(match[2]) !== (match[3] === '能量' ? unit.ap : unit.hp)) return 'ownership';
  }
  const hits = (facts.events ?? []).filter((event): event is Extract<ProtocolEvent,{t:'hit'}> => event.t === 'hit');
  if (!hits.some(event => event.crit) && /暴击/.test(text) && !/没有暴击|没暴击|不算暴击/.test(text)) return 'event_hit';
  for (const match of text.matchAll(/(我|对手)(?:的)?(?:现在|目前)?(生命值|能量)(?:现在|目前)?(?:是|为|有|剩下|还有|还剩)?\s*(\d+)点?/g)) {
    const unit = match[1] === '我' ? facts.you : facts.foe;
    if (!unit || Number(match[3]) !== (match[2] === '能量' ? unit.ap : unit.hp)) return 'ownership';
  }
  for (const match of text.matchAll(/(我|对手)(?:的)?(?:(普攻|普通攻击|强攻|强化攻击|大招|共鸣冲击))?(?:打中|击中|命中|攻击|打)(了)?(我|对手)/g)) {
    const by = match[1] === '我' ? 'you' : 'foe';
    const target = match[4] === '我' ? 'you' : 'foe';
    const label = match[2];
    const mv = label ? /普攻|普通攻击/.test(label) ? 'light' : /强攻|强化攻击/.test(label) ? 'heavy' : 'ult' : undefined;
    if (by === target || !hits.some(event => event.by === by && (mv === undefined || event.mv === mv))) return 'ownership';
  }
  for (const match of text.matchAll(/(我|对手)(?:的)?(普攻|普通攻击|强攻|强化攻击|大招|共鸣冲击).{0,4}(?:打中|击中|命中|砸中|释放了)/g)) {
    const by = match[1] === '我' ? 'you' : 'foe';
    const mv = /普攻|普通攻击/.test(match[2]!) ? 'light' : /强攻|强化攻击/.test(match[2]!) ? 'heavy' : 'ult';
    if (!hits.some(event => event.by === by && event.mv === mv) && !(facts.pending?.by === by && facts.pending.mv === mv && mv === 'ult' && !/命中|击中|打中|砸中/.test(match[0]))) return 'event_hit';
  }
  for (const match of text.matchAll(/(我|对手)(?:受了|受到|受伤|挨了|掉了?|损失了?)(\d+)点?(?:生命值|伤害)?/g)) {
    const target = match[1] === '我' ? 'you' : 'foe';
    if (!hits.some(event => event.by !== target && event.dmg === Number(match[2]))) return 'ownership';
  }
  if (facts.ok === false && asserted(text, /命中|击中|打中|放出去|放出|释放了|出手了|生效了/)) return 'certainty';
  if (facts.pending && !hits.length && asserted(text, /命中|击中|打中|击倒/)) return 'pending';
  if (facts.need === 'wait_guest' && /开打|对决开始|轮到我|我该怎么做/.test(text)) return 'stage';
  if (facts.need === 'wait_foe' && /轮到我|该我出招|我该怎么做/.test(text)) return 'stage';
  if (facts.need === 'move' && /该对手出招|轮到对手出招|等对手(?:出招|应对|加入)/.test(text)) return 'stage';
  if (facts.need === 'respond' && /该我出招|轮到我出招|等对手出招/.test(text)) return 'stage';
  if (facts.need === 'none' && expectedWinner && /该我出招|轮到我|我该怎么做/.test(text)) return 'stage';
  if (facts.reason === 'unknown' && /没生效|没打出去|再(?:说|来|试).*(?:招|攻击)/.test(text)) return 'certainty';
  if (facts.reason === 'unclear' && !/没听清|没听懂|重说|再说|再告诉|没认出/.test(text)) return 'certainty';
  for (const event of facts.events ?? []) if (!eventKept(event, text)) return eventReason[event.t];
  if (facts.text) for (const value of referenceText.match(/\d+/g) ?? []) if (!text.includes(value)) return 'text';
  return undefined;
}
export function checkReply(candidate: string, facts: GameReply): boolean {
  return replyRejectionReason(candidate, facts) === undefined;
}
