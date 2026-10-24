import { matchAction, matchActionIds } from './actions.js';
import { roomCodeFromPhrase, wantsOpenRoom } from './pvp.js';
import type { ActionId } from './types.js';

/**
 * 一句话读出来的命令。
 *
 * 平台侧模型只转写原话，判断全在服务端，所以「这句话到底想干什么」必须只判一次：
 * 这里给出带类型的结果，后续分派只看 kind，不再回头重解析同一句话。
 * 规则匹配优先；规则认不出时返回 unknown，由对局流水线决定要不要再问意图模型。
 */
/** 落到结算上的这一手：规则直接认出来的，或意图模型归一化出来的 */
export interface TurnIntent {
  action: ActionId;
  chant?: string;
}

export type Command =
  | ({ kind: 'turn' } & TurnIntent)
  | { kind: 'status' }
  | { kind: 'help' }
  | { kind: 'start' }
  | { kind: 'open-room' }
  | { kind: 'join-room'; code: string }
  | { kind: 'refused'; why: RefuseReason }
  | { kind: 'unknown' };

/** 不执行的原因：明确说不打，或一句话点了两招 */
export type RefuseReason = 'negated' | 'ambiguous';

/** 拦下这一手的原因：问句只是问，不是出手 */
type BlockReason = 'query' | RefuseReason;

/** 去空白与标点、英文转小写：语音转写常带逗号句号，先抹平再判断 */
function compact(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[\s，,。．.!！?？、"“”'‘’：:；;～~…·]/g, '');
}

/** 问玩法：命中就回说明，不出招 */
const HELP_RULES = ['怎么玩', '怎么打', '怎么出招', '怎么操作', '怎么用', '怎么放', '怎么赢', '才能赢', '玩法', '规则', '帮助', '教我', '说明一下'];

/**
 * 问战况：推荐生命值/能量；旧资源说法仅作输入兼容，命中后只播新术语，不改数值。
 *
 * 招式在战况之前判定，所以「回能量」「攒点能量」会先被 actions.ts 认成蓄力；
 * 这里的裸「能量」只兜住「能量」「能量够不够」这类查询。
 */
const STATUS_RULES = ['战况', '局面', '什么情况', '生命值', '能量', '多少血', '还剩', '剩多少', '真气', '行动点', '第几轮', '几回合', '谁赢', '我赢了'];

/** 明确说「开始」的整句；单字「开」不算，避免误判 */
const START_EXACT = ['开始', '开始吧', '开打', '开战', '开局', '来一局', '打一局', '开一局', '重开', '再来一局', '重新开始'];

/** 开局意图的长句说法：开房、联机这类还要再判一次，看是不是真的要开房 */
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
 * 这句话该不该落在招式上。
 *
 * 优先级固定为 反问式疑问 → 否定 → 多招式歧义 → 其它疑问：
 * 「能不能放大招」既含「能不能」又含「不能」，先判反问才不会被当成否定；
 * 「要不要放大招」同理，先判反问才不会被「不要」截走。
 */
function blockReason(raw: string, text: string): BlockReason | null {
  if (!text) return null;
  // 问号要在 compact 之前判断：compact 会把标点一起抹掉
  const asked = /[?？]/.test(raw);

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
 * 把一句玩家原话读成命令，只认一次。
 *
 * 判定顺序按「意图强度」排：带房间号的加入 → 问玩法 → 开房 → 不该出手 → 招式 → 战况 → 开局。
 * 几个容易踩的点：
 * - 房间语义在前：说「能不能联机」是问怎么开双人，不是问战况；
 * - 玩法问句在开房之前：「双人怎么玩」问的是规则，不能顺手开一局；
 * - 问句必须在招式之前：「我的大招还剩几次」带招式词，但只是问；
 * - 否定与歧义不执行，也不能因为这句话顺手开一局；
 * - 战况与开局不含招式词，放在招式后面判断不会抢走出招。
 */
export function readCommand(raw: string): Command {
  const text = compact(raw);

  // 带房间号的加入最明确：已经在房间里的玩家也要能凭这句话换房
  const code = text ? roomCodeFromPhrase(raw) : null;
  if (code) return { kind: 'join-room', code };

  if (text && includesAny(text, HELP_RULES)) return { kind: 'help' };

  // 语音链路常把整句话塞进参数，「开房 / 联机」这类说法在这里兜底
  if (text && wantsOpenRoom(text)) return { kind: 'open-room' };

  const block = blockReason(raw, text);
  if (block === 'negated' || block === 'ambiguous') return { kind: 'refused', why: block };
  if (block === 'query') return { kind: 'status' };

  const match = text ? matchAction(raw) : null;
  if (match) return { kind: 'turn', action: match.id, chant: match.chant };

  if (text && includesAny(text, STATUS_RULES)) return { kind: 'status' };

  if (text && (START_EXACT.includes(text) || includesAny(text, START_RULES))) return { kind: 'start' };

  return { kind: 'unknown' };
}
