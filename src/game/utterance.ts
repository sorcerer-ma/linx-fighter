import { matchAction } from './actions.js';

/**
 * 玩家一句话的意图分类。
 *
 * 平台侧模型只负责转写与调用工具，不做判断，所以「战况怎么样」「怎么玩」「开一局」
 * 这些非招式语句都要在服务端认出来。判定顺序是有讲究的：
 *
 * 1. 先认「怎么玩/规则」这类问句——它们常含「出招」这种招式词，当问句处理才不会误出招；
 * 2. 再认招式——能匹配上就说明是来打这一手的，交给 act 走完整结算（含唤出指令回念）；
 * 3. 最后认战况与开局——这两类不含招式词，晚一步判断不会抢走出招。
 *
 * 认不出来的返回 unknown，由调用方兜底（通常是 act 的「没听清」提示）。
 */
export type UtteranceIntent = 'status' | 'help' | 'start' | 'unknown';

/** 去空白与标点、英文转小写：语音转写常带逗号句号，先抹平再判断 */
function compact(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[\s，,。．.!！?？、"“”'‘’：:；;～~…·]/g, '');
}

/** 问玩法：命中就回说明，不出招 */
const HELP_RULES = ['怎么玩', '怎么打', '怎么出招', '怎么操作', '怎么用', '怎么放', '怎么赢', '才能赢', '玩法', '规则', '帮助', '教我', '说明一下'];

/** 问战况：命中就播当前局面，不改数值 */
const STATUS_RULES = ['战况', '局面', '什么情况', '多少血', '还剩', '剩多少', '真气', '行动点', '第几轮', '几回合', '谁赢', '我赢了'];

/** 明确说「开始」的整句；单字「开」不算，避免误判 */
const START_EXACT = ['开始', '开始吧', '开打', '开战', '开局', '来一局', '打一局', '开一局', '重开', '再来一局', '重新开始'];

/** 开局意图的长句说法：开房、联机这类交给 act/start 里的联机逻辑，这里只负责归类 */
const START_RULES = ['开始游戏', '开始对战', '开房间', '开个房', '开房', '建房间', '新建房间', '创建房间', '联机', '双人对战'];

function includesAny(text: string, rules: string[]): boolean {
  return rules.some((rule) => text.includes(rule));
}

/**
 * 把玩家原话归一化成四类意图。
 *
 * 只做归类，不推进对局、不改任何状态；同样的输入永远得到同样的输出。
 */
export function classifyUtterance(raw: string): UtteranceIntent {
  const text = compact(raw);
  if (!text) return 'unknown';

  // 问句优先：语音里「怎么出招」很常见，不能被「出招」抢成出招
  if (includesAny(text, HELP_RULES)) return 'help';

  // 能匹配招式就是来打这一手的，交给 act 处理阶段与结算
  if (matchAction(raw)) return 'unknown';

  if (includesAny(text, STATUS_RULES)) return 'status';

  if (START_EXACT.includes(text) || includesAny(text, START_RULES)) return 'start';

  return 'unknown';
}
