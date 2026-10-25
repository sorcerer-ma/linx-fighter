import type { ActionId, ActiveActionId, ResponseMove } from './types.js';

export interface ActionMeta {
  id: ActionId;
  /** 中文招式名，播报与提示用 */
  label: string;
  /** 本地会直接执行的说法；短词只在精确匹配时生效，避免误判 */
  aliases: string[];
  /**
   * 只参与「这句话点到哪几招」的判定，永远不直接执行。
   *
   * 收窄执行词表后，口语执行交给模型；但玩家一句话里比了两招（「猛攻还是普攻」）时，
   * 仍要认出两招并让他重说，否则会替他挑一招打出去。ASR 误写也放这里：
   * 同音层只在规则认不出时才跑，规则已经认出另一招时它没有机会再判歧义。
   *
   * 只收两个字以上的说法：单字不参与包含匹配，列进来只是噪音。
   */
  mentions?: string[];
  /**
   * 只放拼音规则接不住的误识别：语义级，或音节表还没收录的字。
   * 同音、近音、吞掉鼻音韵尾的错字不要往这里加，交给 asr.ts 的音节比较。
   */
  asrErrors?: string[];
  /** 中二唤出指令：玩家念整句咒语也能出招，命中后原样回念给玩家听 */
  chants: string[];
}

/**
 * 招式表：主动阶段的普攻、强攻、大招、蓄力，应对阶段的格挡、闪避、承受。
 *
 * v0.2 起「攻击/闪避」不再是一组对等按钮：先手方在主动阶段选招，
 * 后手方在对手出招后选择应对。匹配层只负责把口语归一化成这七种操作。
 */
export const ACTIONS: Record<ActionId, ActionMeta> = {
  light: {
    id: 'light',
    label: '普攻',
    // 只留最常用的说法；「打」是最高频单字指令，模型单独判它容易犹豫，留在本地
    aliases: ['普攻', '攻击', '打'],
    // 收窄掉的别名与误写仍算「点到普攻」，只用于判歧义
    mentions: ['普通攻击', '轻击', '轻攻', '打击', '进攻', '出手', '出招', 'attack', 'atk', '公鸡', '工击', '攻鸡', '公机', '恭击'],
    chants: ['共鸣斩破军', '轻锋裂长空'],
  },
  heavy: {
    id: 'heavy',
    label: '强攻',
    // 「全力攻击」要在本地压过「攻击」，否则会被普攻抢走；其余狠话交给模型
    aliases: ['强攻', '重击', '全力攻击', '大力攻击'],
    // 收窄掉的别名与误写仍算「点到强攻」，只用于判歧义
    mentions: ['重攻', '强击', '猛攻', '狠打', '强公', '墙攻', '强弓', '羌攻', '强功', '重机'],
    chants: ['重锋碎山河', '千钧落星河'],
  },
  ult: {
    id: 'ult',
    label: '大招',
    // 「开大/开大招/放大招」是子串匹配的大坑（打开大家、把大门打开），不进词表；
    // 这几种口语简称由 asr.ts 的整句匹配认。
    aliases: ['大招', '绝招'],
    // 「大着」是「大招」的语义级误听，音节规则接不住
    asrErrors: ['大着'],
    // 收窄掉的别名与误写仍算「点到大招」，只用于判歧义
    mentions: ['必杀', '必杀技', '绝技', '终极技', '奥义', '大召', '大找', '大昭', '打招'],
    chants: ['天倾共此声', '万籁俱寂灭'],
  },
  charge: {
    id: 'charge',
    label: '蓄力',
    // 游戏已统一叫「能量」，因此玩家会把蓄力说成「回能量」「攒点能量」；
    // 旧资源口语与对应 ASR 误识别仅兼容输入，推荐名称仍为蓄力。
    // 「回能量」「攒一下」这类说法不在本地展开，由模型按当前阶段判断。
    // 但「憋大招 / 攒大招」必须留在这里：它们带着大招的「大招」两个字，
    // 从词表删掉就会落进大招的包含匹配，玩家想攒能量却把一局一次的大招打出去。
    aliases: ['蓄力', '调息', '回气', '憋大招', '攒大招', '留大招', '存大招'],
    // 收窄掉的别名与误写仍算「点到蓄力」，只用于判歧义
    mentions: [
      '蓄气', '聚气', '攒气', '蓄势', '回力', '运气', 'recover', '蓄能量', '聚能量',
      '回能量', '回点能量', '回满能量', '补能量', '补点能量', '补满能量',
      '攒能量', '攒点能量', '攒满能量', '存能量',
      '续力', '蓄利', '蓄立', '续气', '回七', '回器', '回汽', '汇气', '调西', '蓄汽',
    ],
    chants: ['一息归元海', '静听吾心跳'],
  },
  guard: {
    id: 'guard',
    label: '格挡',
    aliases: ['格挡', '防御'],
    // 「可党」的「可」还没进音节表，先留一条；其余同音写法交给 asr.ts
    asrErrors: ['可党'],
    // 收窄掉的别名与误写仍算「点到格挡」，只用于判歧义
    mentions: ['格档', '抵挡', '防守', '护盾', '架住', '哥挡', '隔挡', '防预', '房御', '革挡'],
    chants: ['声海化金汤', '共鸣壁立千仞'],
  },
  dodge: {
    id: 'dodge',
    label: '闪避',
    aliases: ['闪避', '躲避', '躲开'],
    // 「闪币」「朵开」「傻逼」这类同音、近音、吞韵尾的误写由 asr.ts 统一处理，
    // 这里不再逐词列；列得越多，越容易把真正的新错法漏掉。
    // 收窄掉的别名与误写仍算「点到闪避」，只用于判歧义
    mentions: ['躲闪', '闪开', '闪身', '避开', '回避', '规避', '闪币', '散避', '朵开', '多开', '防疫', '躲壁'],
    chants: ['踏歌借流光', '身随声影动'],
  },
  take: {
    id: 'take',
    label: '承受',
    aliases: ['承受', '硬抗'],
    // 这几个是语义/非近音误听，或音节表还没收录的字，拼音规则接不住
    asrErrors: ['狠抗', '硬坑', '硬航', '长寿'],
    // 收窄掉的别名与误写仍算「点到承受」，只用于判歧义
    mentions: ['硬扛', '扛住', '吃伤害', '硬吃', '生吃', '成受'],
    chants: ['以身为剑鞘', '此身擎天地'],
  },
};

/** 主动阶段可选的招式（给工具描述与提示用） */
export const ACTIVE_ACTIONS: ActiveActionId[] = ['light', 'heavy', 'ult', 'charge'];

/** 应对阶段可选的招式 */
export const RESPONSE_ACTIONS: ResponseMove[] = ['guard', 'dodge', 'take'];

/** 生成给工具描述用的招式提示 */
export function actionHints(): string {
  return '主动：light（普攻）、heavy（强攻）、ult（大招）、charge（蓄力）；应对：guard（格挡）、dodge（闪避）、take（承受）';
}

/** 招式中文名，找不到时回退到原始标识 */
export function actionLabel(id: ActionId): string {
  return ACTIONS[id]?.label ?? id;
}

/** 全部招式的中文名，用于「可选招式」提示 */
export function actionLabels(): string[] {
  return Object.values(ACTIONS).map((meta) => meta.label);
}

/** 主动阶段全部招式的中文名 */
export function activeActionLabels(): string[] {
  return ACTIVE_ACTIONS.map((id) => actionLabel(id));
}

/** 应对阶段全部招式的中文名 */
export function responseActionLabels(): string[] {
  return RESPONSE_ACTIONS.map((id) => actionLabel(id));
}

/** 参与执行匹配的全部说法：推标识 + 口语别名 + ASR 常见误识别 */
function matchTerms(meta: ActionMeta): string[] {
  return [meta.id, ...meta.aliases, ...(meta.asrErrors ?? [])];
}

/** 参与「这句话点到哪几招」判定的说法：执行词表之外再加只判提及的口语 */
function mentionTerms(meta: ActionMeta): string[] {
  return [...matchTerms(meta), ...(meta.mentions ?? [])];
}

/** 包含匹配用的长词候选；单字项不参与，避免「打开菜单」被误判 */
interface TermCandidate {
  id: ActionId;
  term: string;
  /** 该说法是唤出指令时带回原文，命中后播报要回念 */
  chant?: string;
}

/** 按给定词表拼出可做包含匹配的说法，唤出指令也算对应招式的说法 */
function candidatesOf(termsOf: (meta: ActionMeta) => string[]): TermCandidate[] {
  return Object.values(ACTIONS)
    .flatMap((meta) => [
      ...termsOf(meta).map((term) => ({ id: meta.id, term, chant: undefined as string | undefined })),
      ...meta.chants.map((chant) => ({ id: meta.id, term: chant, chant })),
    ])
    .filter(({ term }) => term.length >= 2);
}

/** 执行用的包含匹配候选：只认本地会直接执行的说法 */
function containmentCandidates(): TermCandidate[] {
  return candidatesOf(matchTerms);
}

/** 判歧义用的包含匹配候选：多认一层只用于判提及的口语 */
function mentionCandidates(): TermCandidate[] {
  return candidatesOf(mentionTerms);
}

export interface ActionMatch {
  id: ActionId;
  /** 命中的唤出指令原文；按普通说法命中时为 undefined */
  chant?: string;
}

/** 归一化：去空白与标点、英文转小写，避免 ASR 标点把招式拆开 */
function normalize(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[\s，,。．.!！?？、"“”'‘’：:；;～~…·]/g, '');
}

/**
 * 把玩家口语归一化成招式，并带回命中的唤出指令。
 *
 * 匹配顺序：
 * 1. 精确匹配——短词只在这里生效，避免「打开菜单」被误判；
 * 2. 包含匹配——长词优先，让「免疫这次公鸡」先命中「公鸡」而不是更短的词；
 *    唤出指令与普通说法一起按长度排序，命中咒语时回念整句。
 *
 * 认不出来返回 null，由调用方提示可选招式（不消耗回合、不改数值）。
 */
export function matchAction(raw: string): ActionMatch | null {
  const text = normalize(raw);
  if (!text) return null;

  // 1. 精确匹配：整句就是某个说法（含平台直接下发的英文标识）
  for (const meta of Object.values(ACTIONS)) {
    if (matchTerms(meta).includes(text)) return { id: meta.id };
  }

  // 2. 包含匹配：咒语与多字说法按长度从长到短，长句优先
  const candidates = containmentCandidates().sort((a, b) => b.term.length - a.term.length);

  for (const candidate of candidates) {
    if (text.includes(candidate.term)) {
      return candidate.chant ? { id: candidate.id, chant: candidate.chant } : { id: candidate.id };
    }
  }
  return null;
}

/**
 * 一句话里点到的全部不同招式（用于判断「到底要出哪一招」）。
 *
 * 与 matchAction 不同：这里问的是「提到了哪几招」，所以用比执行词表更宽的
 * 提及词表（含只判歧义的口语与误写）。「大招还是强攻」是商量，不是出招，
 * 调用方据此让玩家重说而不是替他选一个——收窄执行词表后尤其不能漏判，
 * 否则「猛攻还是普攻」会只剩普攻可认，直接被当成出招打出去。
 *
 * 包含匹配按长度从长到短占用文本区间：「全力攻击」整体算强攻，
 * 不能让里面的「攻击」再算一次，否则一句话会被判成两种招式。
 * 返回顺序按招式表声明顺序，调用方不必关心匹配先后。
 */
export function matchActionIds(raw: string): ActionId[] {
  const text = normalize(raw);
  if (!text) return [];

  // 整句就是一个说法：短词只在这一步生效，与 matchAction 保持一致
  const exact = Object.values(ACTIONS).find((meta) => mentionTerms(meta).includes(text));
  if (exact) return [exact.id];

  // 先找出所有说法在句中的出现位置，再按长度从长到短贪心占用
  const hits = mentionCandidates()
    .flatMap(({ id, term }) => {
      const found: { id: ActionId; start: number; end: number }[] = [];
      for (let at = text.indexOf(term); at !== -1; at = text.indexOf(term, at + 1)) {
        found.push({ id, start: at, end: at + term.length });
      }
      return found;
    })
    .sort((a, b) => b.end - b.start - (a.end - a.start) || a.start - b.start);

  const taken: { start: number; end: number }[] = [];
  const ids = new Set<ActionId>();
  for (const hit of hits) {
    if (taken.some((span) => hit.start < span.end && span.start < hit.end)) continue;
    taken.push({ start: hit.start, end: hit.end });
    ids.add(hit.id);
  }

  return Object.keys(ACTIONS).filter((id) => ids.has(id as ActionId)) as ActionId[];
}

/** 只要招式（不需要回念唤出指令时用） */
export function parseAction(raw: string): ActionId | null {
  return matchAction(raw)?.id ?? null;
}
