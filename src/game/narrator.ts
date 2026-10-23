import { actionLabel, actionLabels } from './actions.js';
import type { ActionId, Battle } from './types.js';

/**
 * 播报文案。
 *
 * 这些文字会被平台侧大模型原样朗读给玩家，所以：
 * - 用口语，不用 Markdown、不用列表符号；
 * - 每次只说一两句，避免语音播报太长；
 * - 机制未定稿前不要承诺具体伤害数值，避免和后续规则冲突。
 */

function fighterLine(battle: Battle): string {
  const { player, enemy } = battle;
  return `你 气血 ${player.hp}/${player.maxHp}、真气 ${player.qi}/${player.maxQi}；${enemy.name} 气血 ${enemy.hp}/${enemy.maxHp}、真气 ${enemy.qi}/${enemy.maxQi}。`;
}

/** 开局播报 */
export function narrateBattleStart(battle: Battle): string {
  return [
    `对决开始，你的对手是${battle.enemy.name}。`,
    fighterLine(battle),
    `说「攻击」「闪避」或者「回气」出第一手。当前还是框架演示：招式会被记录并推进回合，伤害结算还没接入。`,
  ].join('\n');
}

/** 没有对局、临时开局的提示，会拼在回合播报前面 */
export function narrateAutoStart(battle: Battle): string {
  return `没有进行中的对局，先给你开了一局，对手是${battle.enemy.name}。\n`;
}

/** 单回合播报 */
export function narrateTurn(battle: Battle, action: ActionId): string {
  return [`第 ${battle.turn} 回合，你出了「${actionLabel(action)}」。`, fighterLine(battle)].join('\n');
}

/** 玩家念出唤出指令：先回念一句，紧接着是这一回合的播报 */
export function narrateChant(chant: string): string {
  return `你朗声喝道：「${chant}」。\n`;
}

/** 战况播报 */
export function narrateStatus(battle: Battle): string {
  const last = battle.history[battle.history.length - 1];
  const tail = last ? `上一手是「${actionLabel(last.playerAction)}」。` : '还没有出过手。';
  return [`第 ${battle.turn} 回合，对局进行中。`, fighterLine(battle), tail].join('\n');
}

/** 认不出招式：不消耗回合，只提示可选招式 */
export function narrateUnknownAction(battle: Battle | null): string {
  const options = actionLabels().join('、');
  if (!battle) return `没听清是哪一招。可以说${options}，或者先说「开始游戏」。`;
  return `没听清是哪一招，可以说${options}。这一手没有生效，当前还是第 ${battle.turn} 回合。`;
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
    '灵犀对决是回合制对决：你说指令，角色出招，招式有攻击、闪避、回气。',
    '直接说招式名就能出招，也可以念唤出指令，比如「共鸣斩破军」；说「战况如何」看双方状态，说「开始游戏」开新的一局。',
  ].join('\n');
}
