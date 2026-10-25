import { ACTIONS } from './actions.js';
import { syllableOf } from './pinyin.js';
import type { ActionId } from './types.js';
import { isActiveAction, isResponseAction } from './types.js';

/**
 * 端侧 ASR 容错：把平台转写错的招式说法尽量还原成招式标识。
 *
 * 平台把「强攻」转成「重机」、把「格挡」转成「可党」这类同音/近音错字时，
 * 规则词表直接 miss，玩家只能反复重说。这一层在服务端补两步：
 * 1. 洗文本（去标点、去「我要/给我/狠狠」这类口语填充）；
 * 2. 音节级比较：同音算 0、声母/韵母混淆或鼻音韵尾脱落算 0.5、其它算 1。
 *
 * 原则是「宁可认不出，也不认错」：错配会消耗能量和回合，比回一句「没听清」更糟。
 * 因此只接受整句就是某个说法、整句以某个说法开头/结尾、或等长且只差一处轻微混淆；
 * 单字别名（打、躲、防）只参与精确匹配，不做任何近音扩展。
 *
 * 不处理的两类：
 * - 唤出咒语：原文要回念给玩家听，交给 actions.ts 的 matchAction；
 * - 语义级错识别（「蓄力」被转成「幸运」）与疑问/否定：同音规则无从判断，由命令路由模型与
 *   command.ts 的疑问、否定拦截兜底。调用方应先跑 command.ts 的拦截，再问这一层。
 */

/** 音节距离阈值：整句所有音节的距离之和不能超过它，等于只容一处声母/韵母混淆或韵尾脱落 */
const MAX_SYLLABLE_COST = 0.5;

/** 一个说法最长保留的字符数，超长说明是整句而不是招式说法，不做近音比较 */
const MAX_FUZZY_LENGTH = 6;

/** 全角转半角、转小写、抹掉空白与标点：ASR 转写常带句号和空格 */
export function normalizeAsr(raw: string): string {
  return raw
    // 全角 ASCII（！到 ～）逐字转半角，语音链路常返回全角标点与字母
    .replace(/[\uFF01-\uFF5E]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xfee0))
    .replace(/\u3000/g, ' ')
    .toLowerCase()
    .replace(/[\s，,。．.!！?？、"“”'‘’：:；;～~…·（）()【】「」『』《》〈〉\-—_、]/g, '');
}

/** 句首填充：自称、请求、发起动作的口头语；单字项都不与招式说法首字冲突（如「出招」的「出」不在此列） */
const HEAD_FILLERS = [
  '我要用', '给我来', '帮我用', '我打算', '我要', '我想', '我出', '我放', '我使',
  '给我', '帮我', '替我', '让我', '麻烦', '使用', '使出', '发动',
  '来一记', '来一个', '一个', '一记', '一下', '用', '来', '我', '要', '想', '请',
];

/** 中缀修饰：招式前面挂的形容词与副词，「强化普攻」「狠狠打」都算同一个招式 */
const MID_FILLERS = ['普通', '强化', '狠狠', '用力', '使劲', '直接', '马上', '立刻', '赶紧', '迅速', '果断', '连续', '一次', '这一下', '那一下', '这个', '那个', '这次', '刚才'];

/**
 * 句尾填充：语气词与指代对象。
 * 不剥「吗」「呢」：带疑问语气的整句留给 command.ts 判断，ASR 层不替玩家猜。
 */
const TAIL_FILLERS = ['一下', '一次', '这招', '那招', '招式', '呗', '吧', '了', '啊', '呀', '哦', '嘛', '你', '他', '她', '它', '这', '那'];

const HEAD_SORTED = [...HEAD_FILLERS].sort((a, b) => b.length - a.length);
const MID_SORTED = [...MID_FILLERS].sort((a, b) => b.length - a.length);
const TAIL_SORTED = [...TAIL_FILLERS].sort((a, b) => b.length - a.length);

/** 反复剥句首填充，直到剥不动（「我要用」拆成「我要」+「用」也能剥净） */
function stripHead(text: string): string {
  let rest = text;
  for (let changed = true; changed; ) {
    changed = false;
    for (const filler of HEAD_SORTED) {
      if (rest.length > filler.length && rest.startsWith(filler)) {
        rest = rest.slice(filler.length);
        changed = true;
        break;
      }
    }
  }
  return rest;
}

/** 反复剥句尾填充；保留最后一个字，避免把「打」这种单字别名连尾巴一起剥掉 */
function stripTail(text: string): string {
  let rest = text;
  for (let changed = true; changed; ) {
    changed = false;
    for (const filler of TAIL_SORTED) {
      if (rest.length > filler.length && rest.endsWith(filler)) {
        rest = rest.slice(0, rest.length - filler.length);
        changed = true;
        break;
      }
    }
  }
  return rest;
}

/**
 * 去掉口语填充与修饰，只留招式说法本身。
 *
 * 只动句首、句尾与少量固定中缀（普通、强化、狠狠），不改中间的字：
 * 「打开菜单」「大家」这类日常说法不会被剥成招式，「我要可党」会被剥成「可党」。
 */
export function stripFillers(raw: string): string {
  let text = normalizeAsr(raw);
  for (let round = 0; round < 3; round += 1) {
    const before = text;
    text = stripHead(text);
    text = stripTail(text);
    for (const filler of MID_SORTED) {
      if (text.includes(filler)) text = text.split(filler).join('');
    }
    if (text === before) break;
  }
  return text;
}

/** 逐字转音节；表外字（数字、英文、生僻字）给 undefined，调用方据此放弃近音比较 */
export function toSyllables(text: string): (string | undefined)[] {
  return Array.from(normalizeAsr(text), (char) => syllableOf(char));
}

/** 声母表：两字母的写在前面，拆分音节时优先匹配 zh/ch/sh */
const INITIALS = ['zh', 'ch', 'sh', 'b', 'p', 'm', 'f', 'd', 't', 'n', 'l', 'g', 'k', 'h', 'j', 'q', 'x', 'r', 'z', 'c', 's', 'y', 'w'];

/** 声母混淆：清浊、送气与方言口音里最常见的几组 */
const INITIAL_CONFUSIONS: Readonly<Record<string, readonly string[]>> = {
  g: ['k', 'h'],
  k: ['g', 'h'],
  h: ['g', 'k', 'f'],
  f: ['h'],
  b: ['p'],
  p: ['b'],
  d: ['t'],
  t: ['d'],
  n: ['l'],
  l: ['n'],
  z: ['zh'],
  zh: ['z'],
  c: ['ch'],
  ch: ['c'],
  s: ['sh'],
  sh: ['s'],
};

/** 韵母混淆：前后鼻音不分是中文 ASR 最常见的错法 */
const FINAL_CONFUSIONS: Readonly<Record<string, readonly string[]>> = {
  in: ['ing'],
  ing: ['in'],
  an: ['ang'],
  ang: ['an'],
  en: ['eng'],
  eng: ['en', 'ong'],
  ong: ['eng'],
  ian: ['iang'],
  iang: ['ian'],
  uan: ['uang'],
  uang: ['uan'],
};

/**
 * 鼻音韵尾脱落：平台偶尔吞掉 an/ang/en/eng/in/ing 的尾巴，
 * 「闪避」会被转写成「傻逼」、「格挡」会被转写成「哥打」。
 * 这是 ASR 的常见现象，按一处轻微混淆处理，不往招式表里逐个加错词。
 */
const DROPPED_CODA: Readonly<Record<string, string>> = {
  an: 'a',
  ang: 'a',
  en: 'e',
  eng: 'e',
  in: 'i',
  ing: 'i',
  ian: 'ia',
  iang: 'ia',
  uan: 'ua',
  uang: 'ua',
};

/** 两个韵母是否只差一个鼻音韵尾 */
function codaDropped(a: string, b: string): boolean {
  return DROPPED_CODA[a] === b || DROPPED_CODA[b] === a;
}

/** 把不带声调的音节拆成声母与韵母；没有声母的（an、er）声母为空串 */
function splitSyllable(syllable: string): [string, string] {
  for (const initial of INITIALS) {
    if (syllable.startsWith(initial) && syllable.length > initial.length) {
      return [initial, syllable.slice(initial.length)];
    }
  }
  return ['', syllable];
}

function confused(map: Readonly<Record<string, readonly string[]>>, a: string, b: string): boolean {
  return (map[a] ?? []).includes(b);
}

/**
 * 两个音节的差距：同音 0、声母或韵母混淆 0.5、其它 1。
 *
 * 表外字按 1 处理（无法比较就当最不像），这样整句里只要有一个生僻字，
 * 近音匹配就会因为超过阈值自动放弃，不会瞎猜。
 */
export function syllableDistance(a: string | undefined, b: string | undefined): number {
  if (a === undefined || b === undefined) return 1;
  if (a === b) return 0;

  const [initialA, finalA] = splitSyllable(a);
  const [initialB, finalB] = splitSyllable(b);
  const initialClose = initialA === initialB || (initialA !== '' && initialB !== '' && confused(INITIAL_CONFUSIONS, initialA, initialB));
  const finalClose =
    finalA === finalB || confused(FINAL_CONFUSIONS, finalA, finalB) || codaDropped(finalA, finalB);

  return initialClose && finalClose ? 0.5 : 1;
}

/** 只在这一阶段能用的招式：玩家在主动阶段说「格挡」不算出招 */
export type SpokenStage = 'active' | 'response';

/** 近音匹配结果；score 越大越可信，调用方可以据此决定要不要再问一次 */
export interface SpokenMatch {
  id: ActionId;
  /** 0~1：1 表示整句就是词表里的说法 */
  score: number;
  /** 命中路径：精确 / 整句前后缀 / 音节近音 */
  via: 'exact' | 'prefix' | 'syllable';
}

interface SpokenTerm {
  id: ActionId;
  /** 归一化后的说法 */
  term: string;
}

/**
 * 参与比较的说法表：招式标识、中文名、口语别名、线上确认的 ASR 误识别。
 *
 * 唤出咒语不进来：命中后要把原文回念给玩家听，那件事在 actions.ts 的 matchAction 里做。
 */
/**
 * 口语简称：不进 ACTIONS 词表 —— 那里的匹配是子串包含，「开大」会把「打开大家」判成大招。
 * 放进这一层，整句必须就是它（前后只允许填充词），「打开大家」自然不命中。
 */
const SHORTHAND_TERMS: readonly SpokenTerm[] = [
  { id: 'ult', term: '开大' },
  { id: 'ult', term: '开大招' },
  { id: 'ult', term: '放大招' },
  // 「来」是句首填充，会先被剥掉，所以「来个大的」剥完剩「个大的」
  { id: 'ult', term: '个大的' },
];

const SPOKEN_TERMS: readonly SpokenTerm[] = [
  ...Object.values(ACTIONS).flatMap((meta) =>
    [meta.id, meta.label, ...meta.aliases, ...(meta.asrErrors ?? [])]
      .map((term) => normalizeAsr(term))
      .filter((term) => term.length > 0)
      .map((term) => ({ id: meta.id, term })),
  ),
  ...SHORTHAND_TERMS.map((entry) => ({ id: entry.id, term: normalizeAsr(entry.term) })),
];

/** 按阶段筛掉这一阶段用不上的招式；不传阶段则全表参与 */
function termsFor(stage?: SpokenStage): readonly SpokenTerm[] {
  if (!stage) return SPOKEN_TERMS;
  const allow = stage === 'active' ? isActiveAction : isResponseAction;
  return SPOKEN_TERMS.filter((entry) => allow(entry.id));
}

/**
 * 整句前后缀匹配：玩家常把招式裹在话里说（「我要开大招」「躲开这一下」）。
 *
 * 只认开头和结尾，不做句中包含：句中包含「开大」的是「打开大家」这种日常说法，
 * 认了就会错配。同一长度命中两个不同招式时返回 null，让玩家重说。
 */
/**
 * 招式词前后是否只是填充词或同一招式的重复。
 *
 * 平台会把播报原样回灌进麦克风（「对手一记普攻」「轮到你出招」），这类句子也以招式词收尾，
 * 只按前后缀认会把别人的播报当成自己的出招 —— 宁可没听清，也不能替玩家扣能量。
 */
function isBareAround(residual: string, id: ActionId): boolean {
  const rest = stripFillers(residual);
  if (!rest) return true;
  // 连说两遍同一招（「大招大招」）仍算这一手
  return SPOKEN_TERMS.some((entry) => entry.term === rest && entry.id === id);
}

function matchByPrefix(text: string, terms: readonly SpokenTerm[]): SpokenMatch | null {
  const hits = terms
    .filter(
      (entry) =>
        entry.term.length >= 2
        && entry.term.length < text.length
        && (text.startsWith(entry.term) || text.endsWith(entry.term)),
    )
    // 招式词之外还夹着别的话，说明这不是单纯出招
    .filter((entry) => {
      const residual = text.startsWith(entry.term)
        ? text.slice(entry.term.length)
        : text.slice(0, text.length - entry.term.length);
      return isBareAround(residual, entry.id);
    });
  // 说漏了尾字：整句是某个说法的开头，且不短于两个字（「终极」→ 终极大招）
  const truncated = terms.filter(
    (entry) => entry.term.length > text.length && text.length >= 2 && entry.term.startsWith(text),
  );

  let longest = 0;
  let found: SpokenMatch | null = null;
  for (const entry of [...hits, ...truncated]) {
    const length = entry.term.length;
    if (length < longest) continue;
    if (length === longest && found && found.id !== entry.id) return null;
    longest = length;
    found = { id: entry.id, score: 0.9, via: 'prefix' };
  }
  return found;
}

/**
 * 等长逐音节比较：只接受整句所有音节的差距之和不超过一处混淆（0.5）。
 *
 * 例如「硬航」对「硬扛」只差 hang/kang 的声母（0.5）→ 承受；
 * 「公园」对「攻击」差一个整音节（1）→ 不认，宁可让玩家重说。
 * 两种招式一样像时返回 null，不替玩家挑。
 */
function matchBySyllable(text: string, terms: readonly SpokenTerm[]): SpokenMatch | null {
  if (text.length < 2 || text.length > MAX_FUZZY_LENGTH) return null;

  const spoken = toSyllables(text);
  if (spoken.some((syllable) => syllable === undefined)) return null;

  const costPerAction = new Map<ActionId, number>();
  for (const entry of terms) {
    if (entry.term.length !== text.length) continue;
    const target = toSyllables(entry.term);
    if (target.some((syllable) => syllable === undefined)) continue;

    const cost = target.reduce((sum, syllable, index) => sum + syllableDistance(spoken[index], syllable), 0);
    if (cost > MAX_SYLLABLE_COST) continue;

    const current = costPerAction.get(entry.id);
    if (current === undefined || cost < current) costPerAction.set(entry.id, cost);
  }

  const ranked = [...costPerAction.entries()].sort((a, b) => a[1] - b[1]);
  const best = ranked[0];
  if (!best) return null;
  const [id, cost] = best;
  const runnerUp = ranked[1];
  // 两个招式一样像：这是歧义，不是识别成功
  if (runnerUp && runnerUp[1] === cost) return null;

  return { id, score: Math.round((1 - cost / text.length) * 100) / 100, via: 'syllable' };
}

/** 问句不猜：带疑问语气词或商量口吻的整句留给 command.ts 回「查询」，ASR 层不替玩家决定出手 */
const QUESTION_MARKERS = ['能不能', '可不可以', '要不要', '该不该', '是不是', '会不会', '行不行'];

function looksLikeQuestion(text: string): boolean {
  // 「吗/呢/么」收尾，或句中带商量口吻的疑问词
  return /[吗呢么]$/.test(text) || QUESTION_MARKERS.some((marker) => text.includes(marker));
}

/**
 * 把一句可能被转写错的原话读成招式；认不出或不够确定时返回 null。
 *
 * 顺序：精确 → 整句前后缀 → 音节近音。越往后越松，但每一步都要求唯一且够像，
 * 认不出就交给调用方回「没听清」，不消耗能量、不推进回合。
 * 疑问与否定不在这里判：调用方应先跑 command.ts 的拦截，否则「我要格挡吗」也会命中。
 */
export function matchSpokenAction(raw: string, stage?: SpokenStage): SpokenMatch | null {
  const normalized = normalizeAsr(raw);
  if (!normalized) return null;

  const text = stripFillers(normalized) || normalized;
  if (!text) return null;
  // 商量要不要出招的话不是出招指令
  if (looksLikeQuestion(normalized) || looksLikeQuestion(text)) return null;

  const terms = termsFor(stage);

  // 1. 精确：整句就是一个说法，单字别名只在这一步生效
  const exact = terms.find((entry) => entry.term === text);
  if (exact) return { id: exact.id, score: 1, via: 'exact' };

  // 2. 前后缀：招式裹在短句里说
  const prefix = matchByPrefix(text, terms);
  if (prefix) return prefix;

  // 3. 近音：等长比较，最多容一处声母/韵母混淆
  return matchBySyllable(text, terms);
}
