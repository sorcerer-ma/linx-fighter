import { ACTIONS, matchAction, matchActionIds } from './actions.js';
import { looksLikeAssistantEcho } from './crosstalk.js';
import { parseRoomCodePhrase, wantsJoinRoom, wantsOpenRoom } from './pvp.js';
import type { ActionId } from './types.js';

/** 去空白与标点、英文转小写：关键词匹配只看字面，标点与大小写不参与判断 */
export function compactText(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[\s，,。．.!！?？、"“”'‘’：:；;～~…·]/g, '');
}

/**
 * 一句话读出来的命令。
 *
 * 平台侧模型只转写原话，判断全在服务端，所以「这句话到底想干什么」必须只判一次：
 * 这里给出带类型的结果，后续分派只看 kind，不再回头重解析同一句话。
 * 规则匹配优先；规则认不出时返回 route，交给模型路由判断是哪一类命令。
 */
/** 落到结算上的这一手：规则直接认出来的，或命令路由判出来的 */
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
  | { kind: 'leave-room' }
  | { kind: 'join-room'; code: string }
  | { kind: 'refused'; why: RefuseReason }
  /** 串音/回灌：这句话不是冲本机说的，只回极短应答，不推进对局 */
  | { kind: 'echo' }
  /** 规则外的问题：本地播报答不了，原话交给语言模型 */
  | { kind: 'ask'; text: string }
  /** 本地规则没定下来：原话交给模型路由，由它决定是哪一类 */
  | { kind: 'route'; question: boolean };

/** 不执行的原因：明确说不打，或一句话有多个操作／编号 */
export type RefuseReason = 'negated' | 'ambiguous';

/** 拦下这一手的原因：明确说不打、点了两招，或是在问而不是出手 */
type BlockReason = 'query' | RefuseReason;

/** 问玩法：命中就回说明，不出招 */
const HELP_RULES = ['怎么玩', '怎么打', '怎么出招', '怎么操作', '怎么用', '怎么放', '怎么赢', '才能赢', '玩法', '规则', '帮助', '教我', '说明一下'];

/**
 * 问战况：推荐生命值/能量；旧资源说法仅作输入兼容，命中后只播新术语，不改数值。
 *
 * 招式在战况之前判定，所以「回能量」「攒点能量」会先被 actions.ts 认成蓄力；
 * 这里的裸「能量」只兜住「能量」「能量够不够」这类查询。
 */
const STATUS_RULES = [
  '战况', '局面', '什么情况', '生命值', '能量', '多少血', '还剩', '剩多少', '几次',
  '真气', '行动点', '第几轮', '几回合', '谁赢', '我赢了', '轮到',
];

/** 明确说「开始」的整句；单字「开」不算，避免误判 */
const START_EXACT = ['开始', '开始吧', '开打', '开战', '开局', '来一局', '打一局', '开一局', '重开', '再来一局', '重新开始'];

/** 开局意图的长句说法；发起挑战、联机这类由 wantsOpenRoom 先判成 open-room */
const START_RULES = ['开始游戏', '开始对战'];

/**
 * 「回能量」是在蓄力，不是在查战况。
 * 别名表不再展开「回点/补满/攒满」十几种写法，用「动词 + 能量」兜住；
 * 带疑问、回合数的句子会先被 blockReason 拦成查询，不会走到这里。
 */
const CHARGE_ENERGY = /(?:回|攒|补|蓄|聚|存|加)[^，。！？]{0,2}能量/;

/**
 * 招式名词：剥「他的攻击」这类名词短语时用，和执行词表同一份来源。
 * 单字说法不参与：「他的打」拼不通，反而会把「打他」剥成空句子。
 */
const MOVE_NOUNS = [
  ...new Set(
    Object.values(ACTIONS).flatMap((meta) => [meta.label, ...meta.aliases, ...meta.mentions, ...meta.asrErrors]),
  ),
]
  .filter((term) => term.length >= 2)
  .sort((a, b) => b.length - a.length)
  .map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  .join('|');

/** 叙述对手时的主语：对手的几种叫法，以及与它对位的第三人称代词 */
const OPPONENT_SUBJECTS = '对手|对面|对方';
/** 带上「他/她/它」：语音里很少一直说「对手」，说「格挡他的攻击」才是日常说法 */
const OPPONENT_ANY_SUBJECTS = `${OPPONENT_SUBJECTS}|他|她|它`;
/** 不带「的」也认的主动四招：词表收窄，免得把「对手回能量还是强攻」剥成一句 */
const ACTIVE_MOVES = '普攻|强攻|大招|蓄力';
/** 子句起点：句首或上一句的标点之后；ASR 插进来的空白要认 */
const CLAUSE_START = '(?:^|[，,。！!？?；;、])\\s*';

/**
 * 叙述对手的子句：「对手放大招，」「他攻击，」不是本机的招。
 * 统计歧义与选招只看剥掉之后自己那半句，否则玩家自报应对会被对手的招式带成「两种招式」。
 * 剥四种形态：
 * - 以对手为主语、以标点收尾的完整子句；「他」开头也算，但必须真的在句首或逗号后面，
 *   免得把「我要攻击他，然后格挡」里的打击对象当成主语，剥掉他点的第二招；
 * - 「对手强攻」这类紧挨着的主动四招；
 * - 「对手的攻击」「他的大招」这类带「的」的名词短语，招式名词取全词表；
 * - 「这次攻击」这类指回对手这一手的指示说法。
 * 没有标点的「对手回能量还是强攻」不剥：谁出招本来就没说清，留着让歧义判定拦下。
 *
 * 目标介词后面的「对手」不算叙述：那里是我这一手打向谁，不是那句话的主语。
 * 「我要对对手强攻」剥掉就成了没人称的「我要对」，既读不出招式、也数不出两种招式。
 */
const OPPONENT_CLAUSE = new RegExp(
  [
    `${CLAUSE_START}(?:他|她|它)[^，,。！!？?；;、]*[，,。！!？?；;、]`,
    `(?:${OPPONENT_SUBJECTS})[^，,。！!？?；;、]*[，,。！!？?；;、]`,
    `(?:${OPPONENT_SUBJECTS})的?(?:${ACTIVE_MOVES})`,
    `(?:${OPPONENT_ANY_SUBJECTS})的(?:${MOVE_NOUNS})`,
    `(?:这|刚才那)(?:次|一下|一击|一波|一手)(?:的)?(?:${MOVE_NOUNS})`,
  ].join('|'),
  'g',
);

/**
 * 目标介词：多字介词（朝着、冲着、对着、向着）与 ASR 插进来的空白都要认，
 * 「我要朝着对手强攻」「我要对 对手普攻」里的「对手」同样是打击对象，不能剥。
 * 单靠定长后顾只能看一个字符，「着」或空格就把判断让过去了，所以改看匹配位置之前的原文。
 */
const TARGET_PREPOSITION = /(?:对|向|朝|冲|跟|和|与|给|把|替|帮|为|同)(?:着)?\s*$/;

/**
 * 去掉叙述对手的部分，只留玩家自己那半句。
 * 匹配串没有捕获组，replacer 的第二、三个参数才是偏移与整段原文。
 */
function withoutOpponent(raw: string): string {
  return raw.replace(OPPONENT_CLAUSE, (match, offset, source) =>
    TARGET_PREPOSITION.test(source.slice(0, offset)) ? match : ' ',
  );
}

/** 反问式疑问：玩家在商量要不要出手，不是已经决定出手 */
const QUESTION_RULES = ['能不能', '可不可以', '要不要', '该不该', '是不是', '够不够'];

/**
 * 查询口吻的词：带这些词的句子先不执行，交给模型分到「查战况 / 问玩法 / 规则外」。
 *
 * 只收问法与查询词，不判断问的是游戏内还是游戏外——那一步由模型做（见 router.ts），
 * 这里只保证问句不会因为含招式词就被当作出招。
 */
const QUESTION_MARKERS = [
  '吗', '呢', '多少', '几次', '几回合', '几轮', '多久', '几点', '几号', '星期几',
  '还剩', '剩多少', '剩几次', '还有几', '还有多少', '第几轮',
  '为什么', '为啥', '怎么', '如何', '什么', '谁', '哪',
  '帮我算', '帮我查', '算一下',
];

/**
 * 否定/收手：玩家明确说了不打，不能替他出手。
 *
 * 只收多字说法，不认单个「别」：「特别」「区别」「告别」里的「别」都不是否定。
 */
const NEGATE_RULES = [
  '不要', '不用', '不想', '不打算', '不打', '不出', '不攻', '不放',
  '别打', '别出', '别放', '别动', '甭', '算了', '住手', '停手', '别急', '取消',
];

/** 带「别」但不是否定的词：判定前先剔掉，「特别强的攻击」仍是正常出招 */
const NEGATE_FALSE_POSITIVES = ['特别', '区别', '告别', '别的', '分别'];

/**
 * 退出对局的同义说法。
 *
 * 单人局在玩家嘴里常被叫「训练」「练习」，平台也可能把「结束这局」原样转下来；
 * 只认「退出挑战/退出房间」会让退出指令落空，对局一直挂在战斗态。
 */
const LEAVE_INTENT = /(?:退出(?:挑战|房间|训练|练习|对战|对局|战斗)|(?:结束|关闭|取消)(?:掉)?(?:(?:这|本|当前)(?:一)?局|一?局)?(?:训练|练习|对战|对局|战斗))/;

/** 房间类退出：只撤房间，单人局按平台提示词的承诺保持不动 */
const ROOM_EXIT = /^(?:我要|我想|请|帮我|现在|先)?退出(?:挑战|房间)(?:吧|了|啊)?$/;

/** 训练类退出：单人局没有房间记录，说完就要真正结束，不然屏幕一直停在战斗态 */
const TRAINING_EXIT = /^(?:我要|我想|请|帮我|现在|先)?(?:退出(?:训练|练习|对战|对局|战斗)|(?:结束|关闭|取消)(?:掉)?(?:(?:这|本|当前)(?:一)?局|一?局)?(?:训练|练习|对战|对局|战斗))(?:吧|了|啊)?$/;


/**
 * 挑战动词前面的否定：「不接受挑战」「别发起挑战」「不联机」……
 *
 * 挑战入口会撤掉玩家现有那一局（换房、重开双人房），所以这几句必须收住。
 * 只认否定词紧挨着挑战动词的说法，不把裸「别/不」当成全局否定：
 * 「别担心，发起挑战吧」「不用怕，联机吧」仍然是要发起挑战。
 * 动词与 pvp.ts 里的开房口令保持一致，改口令时两边一起看。
 */
const CHALLENGE_NEGATION =
  /(?:不要|不用|不想|不打算|甭|算了|不|别)(?:再|去|要|想|用)?(?:(?:退出|结束|关闭|取消)(?:挑战|房间|训练|练习|对战|对局|战斗)|发起挑战|接受挑战|加入(?:双人)?(?:挑战|房间|对局|对战)|进房|挑战你|挑战|联机|开房|开个?房|建个?房|创建房|组队|一起打)/;

/** Courtesy clauses are not cancelled game commands; single 别 is never global. */
function negatedOperation(raw: string): boolean {
  const clauses=raw.split(/[，,。！!；;\n]/).filter(clause=>!/^(?:别担心|不用怕|不要怕|别着急|别急)$/.test(clause.trim()));
  const meaningful=clauses.some(clause=>clause.trim()) ? clauses.join('，') : raw;
  const text=negatableText(compactText(meaningful));
  if (includesAny(text,NEGATE_RULES) || CHALLENGE_NEGATION.test(text)) return true;
  for(const prefix of text.matchAll(/(?:不|别)(?:(?:现在|马上|立刻|直接|帮我|替我|给我|让你|叫你|再|去|要|想|用|说|念)){0,3}/g)) {
    const rest=text.slice(prefix.index!+prefix[0].length);
    const action=Object.values(ACTIONS).some(meta=>[meta.id,meta.label,...meta.aliases,...meta.mentions,...meta.asrErrors,...meta.chants].some(term=>term.length>1?rest.startsWith(compactText(term)):rest===term));
    if (action || /^(?:(?:退出|结束|关闭|取消)(?:挑战|房间|训练|练习|对战|对局|战斗)|发起挑战|接受(?:双人)?挑战|加入(?:双人)?(?:挑战|房间?|对局|对战)|进房|联机|开个?房|建个?房|创建房|组队|一起打)/.test(rest) || [...START_EXACT,...START_RULES].some(term=>rest.startsWith(term))) return true;
  }
  return false;
}
function isQuestion(raw: string,text: string): boolean {
  return /[?？]/.test(raw) || includesAny(text,QUESTION_RULES) || includesAny(text,QUESTION_MARKERS) || /是否|能否|可否/.test(text);
}
function mutatingKinds(raw: string,text: string,hasCode: boolean): Set<string> {
  const kinds=new Set(matchActionIds(raw).map(id=>'turn:'+id));
  if (CHARGE_ENERGY.test(text)) kinds.add('turn:charge');
  if (wantsJoinRoom(text) || hasCode) kinds.add('join');
  const withoutJoin=text.replace(/(?:接受|加入)(?:双人)?(?:挑战|房间?|对局|对战)|进房(?:间)?/g,'');
  if (wantsOpenRoom(withoutJoin)) kinds.add('create');
  if (LEAVE_INTENT.test(text)) kinds.add('leave');
  if (START_EXACT.includes(text) || includesAny(text,START_RULES) || raw.split(/[，,。;；\n]/).some(part=>START_EXACT.includes(compactText(part))) || /(?:先|再|然后|接着|并且|并|和)(?:重开|重新开始|开始游戏)/.test(text)) kinds.add('start');
  return kinds;
}

function includesAny(text: string, rules: string[]): boolean {
  return rules.some((rule) => text.includes(rule));
}

/**
 * 剔除会误伤否定的词：句首的反问（「要不要」里的「不要」）和「特别/区别」这类词。
 * 否定判断与挑战否定共用这一份清洗，免得两处口径不一样。
 */
function negatableText(text: string): string {
  return [...NEGATE_FALSE_POSITIVES, ...QUESTION_RULES].reduce(
    (rest, word) => rest.split(word).join(''),
    text,
  );
}

/**
 * 这句话该不该落在招式上。
 *
 * 先识别绑定操作的否定，再收集招式歧义与查询标志：
 * 「能不能放大招」既含「能不能」又含「不能」，否定词清洗会移除反问词组，避免把问法当否定；
 * 「要不要放大招」同理不会被词组中的「不要」截走。
 */
function blockReason(raw: string, text: string): BlockReason | null {
  if (!text) return null;
  // 问号要在 compact 之前判断：compact 会把标点一起抹掉
  const asked = /[?？]/.test(raw);

  // 否定绑定明确操作，单独的礼貌安抚子句不取消后面的肯定指令。
  if (negatedOperation(raw)) return 'negated';

  // 一句话点到两种招式，分不清要放哪一招，宁可让玩家重说。
  // 提及词表比执行词表宽：收窄后「猛攻」「公鸡」不再直接执行，但仍算点到强攻/普攻。
  const mentioned = new Set(matchActionIds(raw));
  // 「回能量」不在招式表里，但也是在蓄力：和另一招并提时同样要重说
  if (CHARGE_ENERGY.test(text)) mentioned.add('charge');
  if (mentioned.size > 1) return 'ambiguous';

  // 问句一律不执行：带问号、疑问说法或查询口吻的句子先交给模型路由，
  // 由它分到「查战况 / 问玩法 / 规则外」——问句绝不落到出招分支。
  if (asked || includesAny(text, QUESTION_RULES) || includesAny(text, QUESTION_MARKERS)) return 'query';

  return null;
}

/**
 * 把一句玩家原话读成命令，只认一次。
 *
 * 判定顺序按「意图强度」排：回灌 → 帮助 → 明确否定/取消 → 问句 → 多操作与多编号歧义 → 明确生命周期/招式 → 战况/开局 → 模型。
 * 几个容易踩的点：
 * - 明确否定必须在生命周期执行前拦下：说「不要接受挑战，编号1234」是要收手，不能真去换房或重开双人房；
 * - 其他否定句不提前：排在问玩法之后，免得「不打了，怎么重新开始」从玩法说明变成一句拒绝；
 * - 挑战问句只查询：即使带完整编号，也不能直接加入或创建；
 * - 玩法问句在发起挑战与歧义之前：「双人怎么玩」「普攻和强攻怎么用」问的是规则，不能顺手开一局，也不该判成多招式歧义；
 * - 问句必须在招式之前：「我的大招还剩几次」带招式词，但只是问；
 * - 战况与开局不含招式词，放在招式后面判断不会抢走出招。
 */
export function readCommand(raw: string): Command {
  const text = compactText(raw);

  // 回灌判定最先做：平台会把我们的播报也转成一句「玩家原话」送回来，
  // 这类句子哪怕含招式和编号，也不能当新指令执行。
  if (text && looksLikeAssistantEcho(raw)) return { kind: 'echo' };

  // 判断出招前先剥掉叙述对手的子句，只留玩家自己那一手
  const own = withoutOpponent(raw);
  const ownText = compactText(own);
  const block = blockReason(own, ownText);

  const identifier=parseRoomCodePhrase(raw);
  const lifecycle=wantsJoinRoom(text) || wantsOpenRoom(text) || LEAVE_INTENT.test(text);

  // Read-only intent precedes every mutation, including a supplied room code.
  if (text && includesAny(text,HELP_RULES)) return {kind:'help'};
  if (block==='negated') return {kind:'refused',why:'negated'};
  if (isQuestion(own,ownText)) {
    if (!lifecycle && includesAny(text,STATUS_RULES)) return {kind:'status'};
    return {kind:'route',question:true};
  }
  const sequential=own.split(/然后|接着|同时|并且|再/).filter(part=>mutatingKinds(part,compactText(part),false).size>0).length>1;
  if (identifier.ambiguous || block==='ambiguous' || sequential || mutatingKinds(own,ownText,!!identifier.code).size>1) return {kind:'refused',why:'ambiguous'};

  // A bare identifier is neither a fresh action nor cross-request join context.
  if (/^(?:(?:挑战)?编号|房间号?)?[0-9０-９零〇一幺二两三四五六七八九十百千万萬壹贰貳叁參肆伍陆陸柒捌玖拾佰仟兩]+$/.test(text)) return {kind:'route',question:true};
  if (LEAVE_INTENT.test(text)) {
    // 单说「退出训练」「结束这局」就是退出；带上房间号或其他动作才算歧义
    // 房间、训练、整局都是同一个意思：投降并退出当前对局
    if (ROOM_EXIT.test(text) || TRAINING_EXIT.test(text)) return {kind:'leave-room'};
    return {kind:'refused',why:'ambiguous'};
  }
  if (identifier.code) return {kind:'join-room',code:identifier.code};
  if (wantsJoinRoom(text)) return {kind:'join-room',code:''};
  if (wantsOpenRoom(text)) return {kind:'open-room'};

  const match = ownText ? matchAction(own) : null;
  if (match) return { kind: 'turn', action: match.id, chant: match.chant };

  // 同样只认自己那半句：「对手回能量」是在描述对手，不是本机蓄力
  if (ownText && CHARGE_ENERGY.test(ownText)) return { kind: 'turn', action: 'charge' };

  if (text && includesAny(text, STATUS_RULES)) return { kind: 'status' };

  if (text && (START_EXACT.includes(text) || includesAny(text, START_RULES))) return { kind: 'start' };

  return { kind: 'route', question: false };
}
