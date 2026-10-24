import { activeActionLabels, responseActionLabels } from './actions.js';
import type { AttackMove, Battle, BattleEvent, Side, TurnRejection } from './types.js';

/**
 * 播报文案。
 *
 * 这些文字会被平台侧原样朗读给玩家，所以：
 * - 用口语，不用 Markdown、列表符号或括号补充；
 * - 每次最多两句、尽量 60 字内；
 * - 数值只说玩家需要知道的：掉了多少生命值、还剩多少。
 */

/** 主动招式的口语前缀 */
const MOVE_VERB: Record<AttackMove, string> = {
  light: '一记普攻',
  heavy: '一记强攻',
  ult: '一记大招',
};

/** 标点归一：句末统一由拼装函数补「。」 */
function sentence(text: string): string {
  return text.replace(/[。．.!！?？]+$/g, '').trim();
}

function sideName(side: Side): string {
  return side === 'player' ? '你' : '对手';
}

/** 双方生命值与能量，最多两句里的第二句 */
export function fighterLine(battle: Battle): string {
  const { player, enemy } = battle;
  return `你生命值${player.hp}/${player.maxHp}、能量${player.ap}；${enemy.name}生命值${enemy.hp}/${enemy.maxHp}、能量${enemy.ap}`;
}

/** 开局播报：对手、先手、初始生命值，一句话说清 */
export function narrateBattleStart(battle: Battle): string {
  const first = battle.firstMover === 'player' ? '你先手' : '对手先手';
  // 联机换视角后对手没有名字，统一叫「对手」，别再念成「你的对手是对手」
  const opponent = battle.enemy.name === '对手' ? '' : `你的对手是${battle.enemy.name}，`;
  return `对决开始，${opponent}${first}，你${battle.player.hp}点生命值，他${battle.enemy.hp}点生命值。`;
}

/** 没有对局、临时开局的提示，会拼在回合播报前面 */
export function narrateAutoStart(battle: Battle): string {
  return `没有进行中的对局，先开一局，对手是${battle.enemy.name}。`;
}

/** 玩家念出唤出指令：先回念一句，紧接着是这一回合的播报 */
export function narrateChant(chant: string): string {
  return `你朗声喝道：「${chant}」。`;
}

/** 主动阶段：蓄力 */
function chargeSentence(ap: number, side: Side): string {
  return `${sideName(side)}凝神蓄力，能量涨到${ap}`;
}

/** 已锁定、等待玩家应对的攻击 */
function pendingSentence(move: AttackMove, side: Side): string {
  if (side === 'enemy') return `对手${MOVE_VERB[move]}已锁定，只能格挡、闪避或硬抗`;
  return `你${MOVE_VERB[move]}已出手，等对手应对`;
}

/** 一次攻击结算后的句子 */
function attackSentence(event: Extract<BattleEvent, { type: 'attack' }>): string {
  const attacker = sideName(event.side);
  const target = sideName(event.side === 'player' ? 'enemy' : 'player');
  const verb = MOVE_VERB[event.move];
  if (event.dodged) return `${attacker}${verb}，${target}闪开了`;

  const hpLeft = Math.max(0, event.targetHp);
  const crit = event.crit ? '暴击，' : '';
  if (event.response === 'guard') {
    return `${attacker}${verb}，${crit}${target}格挡，掉${event.damage}点生命值，剩${hpLeft}`;
  }
  if (event.response === 'dodge') {
    return `${attacker}${verb}，${crit}${target}没躲干净，擦中${event.damage}点，剩${hpLeft}`;
  }
  const take = event.forced ? '能量耗尽只能硬扛' : '硬扛';
  return `${attacker}${verb}，${crit}${target}${take}，掉${event.damage}点，剩${hpLeft}`;
}

/** 终局一句 */
function endSentence(winner: Side): string {
  return winner === 'player' ? '你击倒了对手，赢了这一局' : '你倒下了，这一局输了';
}

/**
 * 把一次结算的事件转成播报：最多两句。
 * 事件顺序即发生顺序，通常是一方的出手 + 另一方的出手或待应对。
 */
export function narrateTurn(battle: Battle, events: BattleEvent[]): string {
  const lines: string[] = [];
  let rampNoticed = false;
  let winner: Side | null = null;

  for (const event of events) {
    if (event.type === 'charge') {
      lines.push(chargeSentence(event.ap, event.side));
    } else if (event.type === 'attack') {
      lines.push(attackSentence(event));
    } else if (event.type === 'pending') {
      lines.push(pendingSentence(event.move, event.side));
    } else if (event.type === 'end') {
      winner = event.winner;
    } else if (event.type === 'round-start' && event.round === 3 && !rampNoticed) {
      rampNoticed = true;
      lines.push('第三轮开始，攻击伤害每轮加2');
    }
  }

  // 终局：保留一条过程播报，再接胜负；两句话必须放得下
  if (winner) {
    return [...lines.slice(0, 1), endSentence(winner)].join('。') + '。';
  }
  if (lines.length === 0) return narrateStatus(battle);
  return lines.slice(0, 2).join('。') + '。';
}

/** 战况播报 */
export function narrateStatus(battle: Battle): string {
  if (battle.phase !== 'battle') return narrateEnded(battle);
  const parts = [`第${battle.round}轮，${fighterLine(battle)}`];
  if (battle.pending) {
    const actor = battle.pending.actor === 'player' ? '你' : '对手';
    const move = MOVE_VERB[battle.pending.move];
    parts.push(
      battle.pending.actor === 'player'
        ? `你的${move}已出手，等对手应对`
        : `对手的${move}还等着你应对`,
    );
  } else if (battle.mode === 'pvp') {
    parts.push(battle.active === 'player' ? '轮到你出招' : '等对手出招');
  }
  return parts.slice(0, 2).join('。') + '。';
}

/** 双人联机：房间开好，等另一位玩家 */
export function narrateRoomCreated(code: string): string {
  return `房间${code}已开好，把房间号告诉另一位玩家，说「加入房间${code}」就能进来`;
}

/** 双人联机：成功加入房间 */
export function narrateRoomJoined(code: string): string {
  return `你进了房间${code}，对面是另一位玩家`;
}

/** 双人联机：房间还没等到人 */
export function narrateWaitingRoom(code: string): string {
  return `房间${code}还等着对手加入，加入后就能开打`;
}

/** 双人联机：房间号不存在或已过期 */
export function narrateRoomMissing(code: string): string {
  return `没找到房间${code}，确认四位房间号再试一次`;
}

/** 双人联机：房间已满 */
export function narrateRoomFull(code: string): string {
  return `房间${code}已经满员，自己开一局，或者换一个房间号`;
}

/** 双人联机：房间号格式不对 */
export function narrateRoomInvalid(): string {
  return '房间号要四位数字，再说一遍试试';
}

/** 双人联机：轮到谁出招，拼在回合播报后面 */
export function narrateTurnHint(battle: Battle): string {
  return battle.active === 'player' ? '轮到你出招' : '等对手出招';
}

/**
 * 这句话不像是在出招：否定与歧义都不执行，只说清为什么没出手。
 *
 * 查询不走这里——它直接播当前局面，让玩家听见生命值、能量与大招次数。
 */
export function narrateActionBlocked(reason: 'negated' | 'ambiguous'): string {
  return reason === 'negated'
    ? '这一手没打出去，你说的像是先不动手。想出手就直接说招式。'
    : '这一句话里提到了两种招式，没敢替你选。一次只说一种。';
}

/** 异步等待期间局面已经变了：这次识别作废，让玩家对着新局重说 */
export function narrateStaleAction(): string {
  return '这一手没生效，局面已经变了。重新说一次要出的招。';
}

/** 认不出招式：不消耗回合，只提示可选说法 */
export function narrateUnknownAction(battle: Battle | null): string {
  if (battle?.pending && battle.mode === 'pvp' && battle.pending.actor === 'player') {
    return '你已经出手了，等对手应对。';
  }
  const hint = battle?.pending
    ? `可以说${responseActionLabels().join('、')}`
    : `可以说${activeActionLabels().join('、')}`;
  return `没听清这一手，没有生效。${hint}。`;
}

/** 不合法操作：说清楚为什么没生效，再给一条路 */
export function narrateRejection(battle: Battle, rejection: TurnRejection): string {
  switch (rejection.reason) {
    case 'ended':
      return narrateEnded(battle);
    case 'waiting-opponent':
      return '你已经出招，这一手等对手应对。';
    case 'wrong-stage':
      if (battle.pending) return '对手已经出招，现在只能应对。可以说格挡、闪避或硬抗。';
      return battle.active === 'player'
        ? '轮到你了，主动阶段可以说普攻、强攻、大招或蓄力。'
        : '现在还没轮到你出招，等对手先动。';
    case 'insufficient-ap':
      return '能量不够，这一招没有打出去。可以先蓄力，或者换一招。';
    case 'no-ult':
      return '大招这一局已经用过了，换一招吧。';
    case 'full-ap':
      return '能量已经满了，不用再蓄力，直接出招吧。';
  }
}

/** 对局已经结束 */
export function narrateEnded(battle: Battle): string {
  const result = battle.phase === 'victory' ? '你赢了' : battle.phase === 'defeat' ? '你输了' : '这一局已经结束';
  return `${result}。说「开始游戏」可以再来一局。`;
}

/** 还没有对局 */
export function narrateNoBattle(): string {
  return '现在没有进行中的对局。说「开始游戏」就能开局。';
}

/** 玩法说明 */
export function narrateHelp(): string {
  return [
    '先手方在主动阶段说普攻、强攻、大招或蓄力；对手出招后，你只能格挡、闪避或硬抗',
    '念唤出指令也能出招，说「开始游戏」开局、说「战况如何」查状态',
  ].join('。') + '。';
}

/**
 * 补账播报：把玩家不在场时错过的结算补念一遍。
 * 双人局里另一方的应对在对方回合结算，出手方听不到，只能等他下次开口时补上。
 */
export function narrateCatchUp(lines: string[]): string {
  // 结构上一个人最多错过两次结算；真攒多了也只补最近两段，播报太长反而听不清
  return `刚才那一手。${lines.slice(-2).map(sentence).join('。')}。`;
}
