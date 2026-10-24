import type { Presentation } from '../../src/game/presentation.js';

/** Deliberately limited checks, not a general natural-language proof. Ambiguous
 * number ownership is rejected; paraphrases that pass still need human QA. */
function normalize(text:string):string {
  const digits:Record<string,string>={一:'1',二:'2',两:'2',三:'3',四:'4',五:'5',六:'6',七:'7',八:'8',九:'9',零:'0'};
  return text.replace(/[一二两三四五六七八九零](?=次|点|轮)/g,n=>digits[n]!)
    .replace(/我方/g,'我').replace(/对方|敌方|敌人/g,'对手');
}
function numbers(text:string, details:Presentation):string[] {
  let owner='?'; const values:string[]=[];
  const name=details.facts.opponentName;
  const normalized=normalize(name && name!=='对手' ? text.split(name).join('对手') : text)
    // A request to repeat once is conversational wording, not a battle resource.
    .replace(/再(?:说|告诉我|讲|重复)(?:1次|一遍)/g,'重说');
  for(const match of normalized.matchAll(/对手|我|[。！？；]|\d+(?:\.\d+)?/g)) {
    const token=match[0];
    if(token==='我'||token==='对手')owner=token;
    else if(/[。！？；]/.test(token))owner='?';
    else {
      const tail=normalized.slice(match.index!+token.length);
      const before=normalized.slice(Math.max(0,match.index!-3),match.index);
      values.push((/^(轮|回合)/.test(tail)||/房间$/.test(before)?'?':owner)+':'+token);
    }
  }
  return values.sort();
}
function winner(text:string):string|null {
  const t=normalize(text);
  if(/我(?:被击倒|输了|败了|失败)|对手(?:赢了|获胜|胜利)/.test(t))return 'opponent';
  if(/我(?:赢了|获胜|胜利)|对手被我击倒/.test(t))return 'you';
  return null;
}
export function checkReply(source:string,candidate:string,details:Presentation):boolean {
  if(!candidate.trim()||candidate.length>Math.max(60,source.length+20))return false;
  if(JSON.stringify(numbers(source,details))!==JSON.stringify(numbers(candidate,details)))return false;
  if(details.kind==='retry' && details.facts.next!=='start' && !/没听清|没听懂|听不清|重说|再说|再告诉|没认出/.test(candidate))return false;
  if(details.certainty==='not-applied'){
    // An acknowledged rejection/retry must not turn into an executed action.
    const success=/(?:命中|击中|打中|挡住|躲开|释放了|出手了|获胜|赢了)/;
    const positive=(s:string)=>s.replace(/(?:没能|没有|不能|未能|没|未|不)(?:命中|击中|打中|挡住|躲开|释放了|出手了|获胜|赢了)/g,'');
    if(!success.test(positive(source)) && success.test(positive(candidate)))return false;
  }
  const expected=details.facts.phase==='victory'?'you':details.facts.phase==='defeat'?'opponent':winner(source);
  if(expected && winner(candidate)!==expected)return false;
  if(details.facts.phase==='battle' && !winner(source) && winner(candidate))return false;
  const attacks=details.facts.events.filter(e=>e.type==='attack');
  if(attacks.length===1){
    const event=attacks[0]!;
    const defender=event.side==='player'?'对手':'我';
    const t=normalize(candidate);
    if(event.dodged && (!new RegExp(defender+'.{0,8}(躲开|闪开|避开)').test(t)||/没(?:能)?躲开|闪避失败/.test(t)))return false;
    if(!event.dodged && event.response==='dodge' && !/没(?:能)?躲开|未躲开|闪避失败/.test(t))return false;
    if(event.guarded && !/格挡|挡下|挡住|举盾/.test(t))return false;
  }
  const next=details.facts.next;
  if(next==='ended' && /该我出招|轮到我|请指挥我|我该怎么做/.test(candidate))return false;
  if(next==='wait-join' && /对决开始|开打|该我出招|轮到我|我该怎么做/.test(candidate))return false;
  if(next==='start' && /(?:轮到|该)我(?:出招|格挡)|等对手(?:加入|应对)/.test(candidate))return false;
  if(next==='act' && /该我出招|轮到我|请指挥我/.test(source) && !/该我|轮到我|指挥我|听你(?:的|指挥)|我(?:来|接着).*出招|我该怎么做|你(?:来)?(?:定|指挥|决定)/.test(candidate))return false;
  if(['wait-opponent','wait-response'].includes(next) && /等对手/.test(source) && (!/等.*(?:对手|对方)/.test(candidate)||/该我出招|轮到我/.test(candidate)))return false;
  if(next==='respond' && details.kind!=='retry' && /格挡|闪避|应对/.test(source) && !/格挡|闪避|应对|承受/.test(candidate))return false;
  if(details.facts.events.some(e=>e.type==='pending') && !attacks.length && !/命中|击倒/.test(source) && /命中|击倒/.test(candidate))return false;
  return true;
}
