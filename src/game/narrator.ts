import { actionLabel, activeActionLabels, responseActionLabels } from './actions.js';
import { ATTACKS, RESPONSES } from './rules.js';
import {
  isAttackMove,
  otherSide,
  type ActionId,
  type AttackMove,
  type Battle,
  type BattleEvent,
  type ResponseMove,
  type Side,
  type TurnRejection,
} from './types.js';

/**
 * 播报文案：本方伙伴以第一人称「我」向玩家自述。
 *
 * 这些文字会被平台侧原样朗读给玩家，所以：
 * - 说话的是伙伴：「我」指本方伙伴，「你」指指挥它的玩家，另一方战斗角色统一叫「对手」；
 * - 用口语，不用 Markdown、列表符号或括号补充；
 * - 每次最多两句、尽量 60 字内，先说事实，再说下一步；
 * - 数值只说玩家需要知道的：掉了多少生命值、还剩多少、能量与大招剩几次。
 */

/** 攻击的短称呼，放在第一人称句子里用 */
const ATTACK_NAME: Record<AttackMove, string> = {
  light: '普攻',
  heavy: '强攻',
  ult: '大招',
};

/** 视角里的自称：自己永远是「我」，另一方叫「对手」 */
function sideName(side: Side): string {
  return side === 'player' ? '我' : '对手';
}

/** 大招次数的口语说法 */
function times(count: number): string {
  return count === 1 ? '一次' : `${count}次`;
}

/**
 * 句末标点归一：只在拼装时补一个「。」，
 * 但句子里已经以 ！ 或 ？ 收尾时不再补，避免念出「！。」。
 */
function joinLines(lines: string[]): string {
  let text = '';
  for (const line of lines) {
    const part = line.trim();
    if (!part) continue;
    if (text && !/[。．.!！?？]$/.test(text)) text += '。';
    text += part;
  }
  if (!text) return '';
  return /[。．.!！?？]$/.test(text) ? text : `${text}。`;
}

/** 补账时逐句拼接：去掉每句自带的句末标点，避免重复 */
function sentence(text: string): string {
  return text.replace(/[。．.!！?？]+$/g, '').trim();
}

/** 双方生命值与能量；数字全部来自服务端结算 */
export function fighterLine(battle: Battle): string {
  const { player, enemy } = battle;
  return `我${player.hp}点生命值、${player.ap}点能量，对手${enemy.hp}点生命值、${enemy.ap}点能量`;
}

/** 本局大招剩余次数：查询应直接答出数字 */
function ultLine(battle: Battle): string {
  const mine = battle.player.ultLeft;
  const theirs = battle.enemy.ultLeft;
  if (mine > 0 && theirs > 0) return `我还剩${times(mine)}大招，对手还剩${times(theirs)}大招`;
  if (mine > 0) return `我还剩${times(mine)}大招，对手的已经用掉`;
  if (theirs > 0) return `我的大招已经用掉，对手还剩${times(theirs)}大招`;
  return '双方的大招都已经用掉';
}

/** 主动阶段：蓄力 */
function chargeSentence(ap: number, side: Side): string {
  return `${sideName(side)}凝神蓄力，能量涨到${ap}`;
}

/** 已经锁定、等待应对方出手的攻击 */
function pendingSentence(move: AttackMove, actor: Side): string {
  if (actor === 'enemy') return `对手${ATTACK_NAME[move]}还没结算，我该格挡、闪避，还是承受？`;
  return `我出${ATTACK_NAME[move]}，接招！等对手应对`;
}

/**
 * 同上，但我方已出手时压成一句。
 *
 * 「接招！等对手应对」本身是两句，和战况的资源句拼在一起会变成三句；
 * 战况与开局要留出两句预算，这里只报「已出手、等对手应对」。
 */
function ownPendingSentence(move: AttackMove): string {
  return `我出${ATTACK_NAME[move]}了，等对手应对`;
}

/** 一次攻击结算后的句子 */
function attackSentence(event: Extract<BattleEvent, { type: 'attack' }>, expressive = false): string {
  const attacker = sideName(event.side);
  const target = sideName(otherSide(event.side));
  const verb = (expressive ? '使出' : '') + ATTACK_NAME[event.move];
  const loss = expressive ? '损失' : '掉';
  const left = expressive ? '还剩' : '剩';
  if (event.dodged) {
    // 闪避成功是防守方的感受，站在被躲的一边只听结果
    return event.side === 'player' ? `我${verb}，对手闪开了` : `对手${verb}，我躲开啦！`;
  }

  const crit = event.crit ? '暴击' : '';
  const hpLeft = Math.max(0, event.targetHp);
  if (event.response === 'guard') {
    return `${attacker}${verb}${crit}，${target}格挡，${loss}${event.damage}点生命值，${left}${hpLeft}`;
  }
  if (event.response === 'dodge') {
    // 闪避失败吃的是全额伤害，不能写成「擦中」
    return `${attacker}${verb}${crit}，${target}没躲开，${loss}${event.damage}点生命值，${left}${hpLeft}`;
  }
  const take = event.forced ? `${target}没能量，只能硬扛` : `${target}承受`;
  return `${attacker}${verb}${crit}，${take}，${loss}${event.damage}点生命值，${left}${hpLeft}`;
}

/** 终局一句 */
function endSentence(winner: Side): string {
  return winner === 'player' ? '我赢了，击倒对手啦' : '我被击倒了，这局输了';
}

/** 下一手该谁：没有待应对时，玩家不用再问一次 */
function turnHint(battle: Battle): string {
  return battle.active === 'player' ? '该我出招，听你的' : '等对手出招';
}

/**
 * 把一次结算的事件转成播报：最多两句。
 * 事件顺序即发生顺序，通常是一方的出手 + 另一方的出手或待应对。
 *
 * 补账只复述已经发生的结算，不再说「该谁出招」——那句话在补账时已经过时，
 * 当前这一回合的下一步会由本次回复给出。
 *
 * 单人局没有屏幕看血条：每回合都把这边的生命值与能量顺口报出来，
 * 玩家不用为了看状态专门问一次「战况」。
 */
export function narrateTurn(battle: Battle, events: BattleEvent[], options: { hint?: boolean; expressive?: boolean } = {}): string {
  const lines: string[] = [];
  let rampNoticed = false;
  let locked = false;
  let winner: Side | null = null;

  for (const event of events) {
    if (event.type === 'charge') {
      lines.push(chargeSentence(event.ap, event.side));
    } else if (event.type === 'attack') {
      lines.push(attackSentence(event, options.expressive));
    } else if (event.type === 'pending') {
      locked = true;
      lines.push(pendingSentence(event.move, event.side));
    } else if (event.type === 'end') {
      winner = event.winner;
    } else if (event.type === 'round-start' && event.round === 3 && !rampNoticed) {
      rampNoticed = true;
      lines.push('第三轮开始，攻击伤害每轮加2');
    }
  }

  // 终局：保留一条过程播报，再接胜负；两句话必须放得下
  if (winner) return joinLines([lines[0] ?? '', endSentence(winner)]);
  if (lines.length === 0) return narrateStatus(battle);

  const shown = lines.slice(0, 2);
  const soloState = battle.mode === 'solo' ? `我${battle.player.hp}点生命值、${battle.player.ap}点能量` : '';
  // 局面还在继续：没有待应对时补一句该谁出手，玩家不必再问
  if (options.hint !== false && !battle.pending && !locked) {
    const hint = soloState ? `${soloState}，${turnHint(battle)}` : turnHint(battle);
    const second = shown[1];
    if (second === undefined) {
      shown.push(hint);
    } else {
      // 前一句可能以 ！ 收尾（闪避成功），先去掉标点再用逗号并进去，避免念出「！，」
      const merged = `${second.replace(/[。．.!！?？]+$/g, '')}，${hint}`;
      // 两句都放不下时保留结算事实，宁可少一句提示
      if (merged.length <= 60) shown[1] = merged;
      else if (options.expressive) return narrateTurn(battle,events,{...options,expressive:false});
    }
  } else if (soloState && options.hint !== false) {
    // 该我应对时状态并进问句，避免多出一句：「我9点生命值、2点能量，对手强攻还没结算…」
    const last = shown.length - 1;
    shown[last] = `${soloState}，${shown[last]}`;
  }
  return joinLines(shown);
}

/** 开局播报：对手、先手、初始生命值，一句话说清 */
export function narrateBattleStart(battle: Battle): string {
  const first = battle.firstMover === 'player' ? '我先手' : '对手先手';
  const foe = battle.enemy.name === '对手' ? '对手' : battle.enemy.name;
  // 联机换视角后对手没有名字，统一叫「对手」，别再念成「你的对手是对手」
  const opponent = foe === '对手' ? '' : `你的对手是${foe}，`;
  return `对决开始，${opponent}${first}，我${battle.player.hp}点生命值，${foe}${battle.enemy.hp}点生命值。`;
}

/** 单人开局：局面加下一手，恰好两句 */
export function narrateOpening(battle: Battle): string {
  const next = battle.pending
    ? battle.pending.actor === 'player'
      ? ownPendingSentence(battle.pending.move)
      : pendingSentence(battle.pending.move, battle.pending.actor)
    : battle.active === 'player'
      ? '该我出招，说普攻、强攻、大招或蓄力，听你的'
      : turnHint(battle);
  return joinLines([narrateBattleStart(battle), next]);
}

/** 没有对局、临时开局的提示，会拼在回合播报前面 */
export function narrateAutoStart(battle: Battle): string {
  return `没有进行中的对局，先开一局，对手是${battle.enemy.name}。`;
}

/** 玩家念出唤出指令：先回念一句，紧接着是这一回合的播报 */
export function narrateChant(chant: string): string {
  return `你朗声喝道：「${chant}」。`;
}

/** 战况播报：轮次、双方生命值与能量、大招次数，再提示下一步 */
export function narrateStatus(battle: Battle, options: { waiting?: boolean; expressive?: boolean } = {}): string {
  if (battle.phase !== 'battle') return narrateEnded(battle);
  const lines = [`${options.expressive ? '现在是第' : '第'}${battle.round}轮，${fighterLine(battle)}，${ultLine(battle)}`];
  if (battle.pending) {
    // 战况只有两句预算：我方已出手时用单句说法
    lines.push(
      battle.pending.actor === 'player'
        ? ownPendingSentence(battle.pending.move)
        : pendingSentence(battle.pending.move, battle.pending.actor),
    );
  } else if (!options.waiting) {
    lines.push(turnHint(battle));
  }
  return joinLines(lines);
}

/** 双人联机：挑战已发起，等对方凭编号接受 */
export function narrateRoomCreated(code: string): string {
  return `挑战已发起，编号${code}。让对方说「接受挑战，编号${code}」就能进来`;
}

/** 双人联机：成功接下挑战 */
export function narrateRoomJoined(code: string): string {
  return `我接下了编号${code}的挑战，对面就是另一位玩家`;
}

/** 双人联机：挑战还没等到人接受 */
export function narrateWaitingRoom(code: string): string {
  return `编号${code}还等着对方接受，说「接受挑战，编号${code}」就能进来`;
}

/** 双人联机：编号不存在或已过期 */
export function narrateRoomMissing(code: string): string {
  return `没找到编号${code}的挑战，确认四位数编号再试一次`;
}

/** 双人联机：挑战已经有人接下 */
export function narrateRoomFull(code: string): string {
  return `编号${code}已经被接受了，自己发起挑战，或者换一个编号`;
}

/** 双人联机：编号格式不对 */
export function narrateRoomInvalid(): string {
  return '编号要四位数字，再说一遍试试';
}

/**
 * 这句话不像是在出招：否定与歧义都不执行，只说清为什么没出手。
 *
 * 查询不走这里——它直接播当前局面，让玩家听见生命值、能量与大招次数。
 */
export function narrateActionBlocked(reason: 'negated' | 'ambiguous'): string {
  return reason === 'negated'
    ? '这一手我没打出去，听着像先不动手。想出手就直接说招式。'
    : '这句话里提到了两种招式，我没敢替你选。一次只说一种。';
}

/** 异步等待期间局面已经变了：这次识别作废，让玩家对着新局重说 */
export function narrateStaleAction(): string {
  return '这一手没生效，局面已经变了。重新说一次要出的招。';
}

/** 认不出招式：不消耗回合，只提示当前阶段能说什么 */
/**
 * 串音回灌：这句话不是冲我说的（多半是伙伴自己的播报又被装置收了一遍）。
 * 只回一个字表示「听见了」，不复读、不推进对局、不扣资源。
 */
export function narrateEcho(): string {
  return '嗯。';
}

/**
 * 双人联机：这一声不是本轮该本机说的。
 *
 * 两台设备靠近时，另一方的指令会被本机收走；长提示会被装置再收一遍、再回灌，
 * 所以这里只给一句最短的事实，不催、不复述。
 */
export function narrateOtherDeviceTurn(): string {
  return '还没轮到我出招。';
}

/** 双人联机：本机已经出招、正等对手应对；同样只回一句最短事实 */
export function narrateOtherDeviceWaiting(): string {
  return '这一手等对手应对。';
}

/**
 * 严格模式的座位口令：只报了口令、没说招式。
 * 这里唯一的用处是自报座位，让两台机器旁边的玩家听出是哪台在应答。
 */
export function narrateSeatListening(seatWord: string): string {
  return `${seatWord}这边，我在听，说招式就行。`;
}

export function narrateUnknownAction(battle: Battle | null): string {
  if (battle?.pending && battle.mode === 'pvp' && battle.pending.actor === 'player') {
    return narrateOtherDeviceWaiting();
  }
  // 双人房里轮到对手出招：这句话多半不是本机玩家说的，别再用长提示回灌回去
  if (battle?.mode === 'pvp' && battle.phase === 'battle' && !battle.pending && battle.active !== 'player') {
    return narrateOtherDeviceTurn();
  }
  if (battle?.pending) {
    return `没听清这一手，我还没应对。可以说${responseActionLabels().join('、')}。`;
  }
  if (battle && battle.active !== 'player') {
    return '还没轮到我出招，等对手先动。';
  }
  return `没听清这一手，我还没出招。可以说${activeActionLabels().join('、')}。`;
}

/** 招式要的能量：播报里要给具体数字，玩家才知道差多少 */
function apCostOf(action: ActionId): number {
  if (isAttackMove(action)) return ATTACKS[action].apCost;
  if (action === 'charge') return 0;
  return RESPONSES[action as ResponseMove].apCost;
}

/** 不合法操作：说清楚为什么没生效，再给一条路 */
export function narrateRejection(battle: Battle, rejection: TurnRejection): string {
  switch (rejection.reason) {
    case 'ended':
      return narrateEnded(battle);
    case 'waiting-opponent':
      // 双人联机里这句多半来自对方设备：只回最短事实，别把长提示再送进对方麦克风
      return battle.mode === 'pvp' ? narrateOtherDeviceWaiting() : '我已经出招了，这一手等对手应对。';
    case 'wrong-stage':
      if (battle.pending) return '对手这一手还没结算，我只能格挡、闪避或承受。';
      if (battle.active === 'player') return '该我出招了，可以说普攻、强攻、大招或蓄力。';
      return battle.mode === 'pvp' ? narrateOtherDeviceTurn() : '还没轮到我出招，等对手先动。';
    case 'insufficient-ap': {
      const label = actionLabel(rejection.action);
      const cost = apCostOf(rejection.action);
      // 应对阶段不能建议蓄力，只能承受；主动阶段才谈得上先攒能量
      const next = battle.pending ? '现在只能承受，硬吃这一下' : '可以先蓄力，或者换一招';
      return `我只有${battle.player.ap}点能量，${label}要${cost}点。${next}。`;
    }
    case 'no-ult':
      return '我的大招这一局用过了，换一招吧。';
    case 'full-ap':
      return '我能量已经满了，不用再蓄力，直接出招。';
  }
}

/** 对局已经结束：一句结果，一句重开方式 */
export function narrateEnded(battle: Battle): string {
  const result =
    battle.phase === 'victory' ? '我赢了，击倒对手啦' : battle.phase === 'defeat' ? '我被击倒了，这局输了' : '这一局已经结束';
  return joinLines([result, '说「开始游戏」可以再来一局']);
}

/** 规则外的问题暂时答不上来：没配语言模型或调用失败，给一句台阶，不打断对局 */
export function narrateOutsideUnavailable(): string {
  return '这个我暂时答不上来。游戏里的事，随时问我。';
}

/** 还没有对局 */
export function narrateNoBattle(): string {
  return '现在没有进行中的对局。说「开始游戏」，我陪你练一局。';
}

/** 玩法说明 */
export function narrateHelp(): string {
  return joinLines([
    '轮到我主动时，说普攻、强攻、大招或蓄力；对手出招后，我按你的话格挡、闪避或承受',
    '念唤出指令也能出招，说「开始游戏」开局、说「战况如何」查状态',
  ]);
}

/**
 * 补账播报：把玩家不在场时错过的结算补念一遍。
 * 双人局里另一方的应对在对方回合结算，出手方听不到，只能等他下次开口时补上。
 */
export function narrateCatchUp(lines: string[]): string {
  // 结构上一个人最多错过两次结算；真攒多了也只补最近两段，播报太长反而听不清
  return `刚才那一手。${lines.slice(-2).map(sentence).join('。')}。`;
}
