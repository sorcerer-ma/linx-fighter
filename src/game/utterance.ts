import { matchAction, matchActionIds } from './actions.js';

/**
 * 玩家一句话的意图分类。
 *
 * 平台侧模型只负责转写与调用工具，不做判断，所以「战况怎么样」「怎么玩」「开一局」
 * 这些非招式语句都要在服务端认出来。判定顺序是有讲究的：
 *
 * 1. 先认「怎么玩/规则」这类问句——它们常含「出招」这种招式词，当问句处理才不会误出招；
 * 2. 再把明确的问句当战况——「我的大招还剩几次」也含招式词，不先拦下来就会真的出手；
 * 3. 再认招式——能匹配上就说明是来打这一手的，交给 act 走完整结算（含唤出指令回念）；
 * 4. 最后认战况与开局——这两类不含招式词，晚一步判断不会抢走出招。
 *
 * 认不出来的返回 unknown，由调用方兜底（通常是 act 的「没听清」提示）。
 */
export type UtteranceIntent = 'status' | 'help' | 'start' | 'unknown';

/**
 * 招式拦截原因：这是问句 / 在说不打 / 一句话说了两招。
 *
 * 查询与否定都不能落到「出手」上——语音里「我的大招还剩几次」「不要大招」
 * 都带招式词，靠 matchAction 单独判断会真的把招式放出去。
 */
export type ActionBlock = 'query' | 'negated' | 'ambiguous';

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

/** 反问式疑问：玩家在商量要不要出手，不是已经决定出手 */
const QUESTION_RULES = ['能不能', '可不可以', '要不要', '该不该', '是不是', '够不够'];

/**
 * 否定/收手：玩家明确说了不打，不能替他出手。
 *
 * 只收多字说法，不认单个「别」：「特别」「区别」「告别」里的「别」都不是否定。
 */
const NEGATE_RULES = [
  '不要', '不用', '不想', '不打算', '不打', '不出', '不攻', '不放',
  '别打', '别出', '别放', '别动', '甭', '算了', '住手', '停手', '别急',
];

/** 带「别」但不是否定的词：判定前先剔掉，「特别强的攻击」仍是正常出招 */
const NEGATE_FALSE_POSITIVES = ['特别', '区别', '告别', '别的', '分别'];

/** 其它疑问：问剩余资源、问局势、问怎么办；「吗/呢」与问号兜住口语提问 */
const ASK_RULES = [
  '还剩', '剩多少', '剩几次', '还有几', '还有多少', '几次', '多少',
  '谁赢', '什么情况', '如何', '怎么办', '吗', '呢',
];

function includesAny(text: string, rules: string[]): boolean {
  return rules.some((rule) => text.includes(rule));
}

/**
 * 判断这句话该不该按招式处理。
 *
 * 返回 null 表示可以继续按招式走；否则给出拦截原因，由调用方播提示而不是出手。
 * 优先级固定为 反问式疑问 → 否定 → 多招式歧义 → 其它疑问：
 * 「能不能放大招」既含「能不能」又含「不能」，先判反问才不会被当成否定；
 * 「要不要放大招」同理，先判反问才不会被「不要」截走。
 */
export function blockAction(raw: string): ActionBlock | null {
  // 问号要在 compact 之前判断：compact 会把标点一起抹掉
  const asked = /[?？]/.test(raw);
  const text = compact(raw);
  if (!text) return null;

  if (includesAny(text, QUESTION_RULES)) return 'query';

  // 先剔掉「特别/区别/告别」这类词，再判否定，免得形容词被当成「别打」
  const negatable = NEGATE_FALSE_POSITIVES.reduce((rest, word) => rest.split(word).join(''), text);
  if (includesAny(negatable, NEGATE_RULES)) return 'negated';

  // 一句话点到两种招式，分不清要放哪一招，宁可让玩家重说
  if (matchActionIds(raw).length > 1) return 'ambiguous';

  if (asked || includesAny(text, ASK_RULES)) return 'query';

  return null;
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

  // 点了招式的问句当战况处理，别把「还剩几次」当成真出手；
  // 没点招式的问句（「能不能联机」）不改判，仍按开局走
  if (matchAction(raw) && blockAction(raw) === 'query') return 'status';

  // 能匹配招式就是来打这一手的，交给 act 处理阶段与结算；
  // 否定与歧义也落到这里，由 act 依据 blockAction 提示重说
  if (matchAction(raw)) return 'unknown';

  if (includesAny(text, STATUS_RULES)) return 'status';

  if (START_EXACT.includes(text) || includesAny(text, START_RULES)) return 'start';

  return 'unknown';
}
