import type { ActionId, ActiveActionId, ResponseMove } from './types.js';

export interface ActionMeta {
  id: ActionId;
  /** 中文招式名，播报与提示用 */
  label: string;
  /** 玩家可能说的同义说法；单字项只在精确匹配时生效，避免误判 */
  aliases: string[];
  /** ASR 同音/近音的常见误识别（平台侧转写成什么样不由我们决定），只参与匹配，不进提示文案 */
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
    aliases: ['普攻', '普通攻击', '轻击', '轻攻', '攻击', '打击', '进攻', '出手', '出招', '打', '砍', '斩', '揍', 'attack', 'atk'],
    asrErrors: ['公鸡', '工击', '攻鸡', '公机', '恭击'],
    chants: ['共鸣斩破军', '轻锋裂长空'],
  },
  heavy: {
    id: 'heavy',
    label: '强攻',
    aliases: ['强攻', '重击', '重攻', '强击', '猛攻', '全力攻击', '大力攻击', '狠打'],
    asrErrors: ['强公', '墙攻', '强弓', '羌攻', '强功'],
    chants: ['重锋碎山河', '千钧落星河'],
  },
  ult: {
    id: 'ult',
    label: '大招',
    aliases: ['大招', '绝招', '必杀', '必杀技', '绝技', '终极技', '终极大招', '奥义'],
    asrErrors: ['大召', '大找', '大昭', '打招', '大着'],
    chants: ['天倾共此声', '万籁俱寂灭'],
  },
  charge: {
    id: 'charge',
    label: '蓄力',
    // 游戏已统一叫「能量」，因此玩家会把蓄力说成「回能量」「攒点能量」；
    // 旧资源口语与对应 ASR 误识别仅兼容输入，推荐名称仍为蓄力。
    aliases: [
      '蓄力', '蓄气', '回气', '聚气', '憋大招', '攒气', '蓄势', '调息', '回力', '运气', 'recover',
      '回能量', '回点能量', '回满能量', '补能量', '补点能量', '补满能量',
      '攒能量', '攒点能量', '攒满能量', '存能量', '蓄能量', '聚能量',
    ],
    asrErrors: ['续力', '蓄利', '蓄立', '续气', '回七', '回器', '回汽', '汇气', '调西', '蓄汽'],
    chants: ['一息归元海', '静听吾心跳'],
  },
  guard: {
    id: 'guard',
    label: '格挡',
    aliases: ['格挡', '格档', '抵挡', '防御', '防守', '护盾', '架住', '挡', '防'],
    asrErrors: ['哥挡', '隔挡', '防预', '房御', '革挡'],
    chants: ['声海化金汤', '共鸣壁立千仞'],
  },
  dodge: {
    id: 'dodge',
    label: '闪避',
    aliases: ['闪避', '躲避', '躲开', '躲闪', '闪开', '闪身', '避开', '回避', '规避', '躲', '闪'],
    asrErrors: ['闪币', '散避', '朵开', '多开', '防疫', '躲壁'],
    chants: ['踏歌借流光', '身随声影动'],
  },
  take: {
    id: 'take',
    label: '承受',
    aliases: ['承受', '硬抗', '硬扛', '扛住', '吃伤害', '硬吃', '生吃', '扛'],
    asrErrors: ['成受', '狠抗', '硬坑'],
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

/** 参与匹配的全部说法：推标识 + 口语别名 + ASR 常见误识别 */
function matchTerms(meta: ActionMeta): string[] {
  return [meta.id, ...meta.aliases, ...(meta.asrErrors ?? [])];
}

/** 包含匹配用的长词候选；单字项（打、躲、防）不参与，避免「打开菜单」被误判 */
interface TermCandidate {
  id: ActionId;
  term: string;
  /** 该说法是唤出指令时带回原文，命中后播报要回念 */
  chant?: string;
}

/** 全部可做包含匹配的说法，唤出指令也算对应招式的说法 */
function containmentCandidates(): TermCandidate[] {
  return Object.values(ACTIONS)
    .flatMap((meta) => [
      ...matchTerms(meta).map((term) => ({ id: meta.id, term, chant: undefined as string | undefined })),
      ...meta.chants.map((chant) => ({ id: meta.id, term: chant, chant })),
    ])
    .filter(({ term }) => term.length >= 2);
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
 * 1. 精确匹配——单字别名（打、躲、防）只在这里生效，避免「打开菜单」被误判；
 * 2. 包含匹配——长词优先，让「免疫这次公鸡」先命中「公鸡」而不是更短的词；
 *    唤出指令与普通说法一起按长度排序，命中咒语时回念整句。
 *
 * 认不出来返回 null，由调用方提示可选招式（不消耗回合、不改数值）。
 */
export function matchAction(raw: string): ActionMatch | null {
  const text = normalize(raw);
  if (!text) return null;

  // 1. 精确匹配：整句就是某个说法（含单字别名与平台直接下发的英文标识）
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
 * 与 matchAction 同一套词表与口径，但返回全部命中而不是第一个：
 * 「大招还是强攻」是商量，不是出招，调用方据此让玩家重说而不是替他选一个。
 *
 * 包含匹配按长度从长到短占用文本区间：「全力攻击」整体算强攻，
 * 不能让里面的「攻击」再算一次，否则一句话会被判成两种招式。
 * 返回顺序按招式表声明顺序，调用方不必关心匹配先后。
 */
export function matchActionIds(raw: string): ActionId[] {
  const text = normalize(raw);
  if (!text) return [];

  // 整句就是一个说法：单字别名（打、躲）只在这一步生效，与 matchAction 保持一致
  const exact = Object.values(ACTIONS).find((meta) => matchTerms(meta).includes(text));
  if (exact) return [exact.id];

  // 先找出所有说法在句中的出现位置，再按长度从长到短贪心占用
  const hits = containmentCandidates()
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
