import type { ActionId } from './types.js';

export interface ActionMeta {
  id: ActionId;
  /** 中文招式名，播报与提示用 */
  label: string;
  /** 玩家可能说的同义说法；单字项只在精确匹配时生效，避免误判 */
  aliases: string[];
  /** ASR 同音/近音的常见误识别（平台侧转写成什么样不由我们决定），只参与匹配，不进提示文案 */
  asrErrors?: string[];
  /** 中二唤出指令：玩家念整句咒语也能出招，命中后原样回念给玩家听 */
  chants?: string[];
}

export const ACTIONS: Record<ActionId, ActionMeta> = {
  attack: {
    id: 'attack',
    label: '攻击',
    aliases: ['攻击', '打', '砍', '揍', '进攻', '出手', '出招', 'attack', 'hit', 'strike'],
    asrErrors: ['公鸡', '工击', '攻鸡', '公机'],
    chants: ['共鸣斩破军', '声浪裂长空'],
  },
  dodge: {
    id: 'dodge',
    label: '闪避',
    aliases: ['闪避', '闪', '躲', '躲开', '躲闪', '躲避', '闪开', '闪身', '避开', '防御', '防守', '防', 'dodge', 'evade', 'block'],
    asrErrors: ['闪币', '朵开', '多开', '防疫', '防预'],
    chants: ['共鸣壁卸力', '听风身不沾'],
  },
  recover: {
    id: 'recover',
    label: '回气',
    aliases: ['回气', '调息', '蓄气', '聚气', '回力', '运气', 'recover', 'charge', 'rest'],
    asrErrors: ['回七', '回器', '回汽', '汇气', '调西', '蓄汽'],
    chants: ['共鸣桩归元', '一息气自回'],
  },
};

/** 生成给工具描述用的招式提示 */
export function actionHints(): string {
  return Object.values(ACTIONS)
    .map((meta) => `${meta.id}（${meta.label}）`)
    .join('、');
}

/** 招式中文名，找不到时回退到原始标识 */
export function actionLabel(id: ActionId): string {
  return ACTIONS[id]?.label ?? id;
}

/** 全部招式的中文名，用于「可选招式」提示 */
export function actionLabels(): string[] {
  return Object.values(ACTIONS).map((meta) => meta.label);
}

/** 参与匹配的全部说法：口语别名 + ASR 常见误识别 */
function matchTerms(meta: ActionMeta): string[] {
  return [...meta.aliases, ...(meta.asrErrors ?? [])];
}

export interface ActionMatch {
  id: ActionId;
  /** 命中的唤出指令原文；按普通说法命中时为 undefined */
  chant?: string;
}

/**
 * 把玩家口语归一化成招式，并带回命中的唤出指令。
 * 平台侧 ASR 会把「攻击」转成「公鸡」、「回气」转成「回七」，所以匹配表里同时带误识别样例。
 * 认不出来返回 null，由调用方提示可选招式（不消耗回合）。
 */
export function matchAction(raw: string): ActionMatch | null {
  const text = raw
    .trim()
    .toLowerCase()
    .replace(/[\s，,。．.!！?？、"“”'‘’：:；;]/g, '');
  if (!text) return null;

  // 1. 精确匹配：单字别名（打、躲）只在这里生效，避免「打开菜单」被误判成攻击
  for (const meta of Object.values(ACTIONS)) {
    if (meta.aliases.includes(text)) return { id: meta.id };
  }

  // 2. 包含匹配：别名、误识别、唤出指令一起，按长度从长到短，长句咒语优先
  const candidates = Object.values(ACTIONS)
    .flatMap((meta) => [
      ...matchTerms(meta).map((term) => ({ id: meta.id, term, chant: undefined as string | undefined })),
      ...(meta.chants ?? []).map((chant) => ({ id: meta.id, term: chant, chant })),
    ])
    .filter(({ term }) => term.length >= 2)
    .sort((a, b) => b.term.length - a.term.length);

  for (const candidate of candidates) {
    if (text.includes(candidate.term)) {
      return candidate.chant ? { id: candidate.id, chant: candidate.chant } : { id: candidate.id };
    }
  }
  return null;
}

/** 只要招式（不需要回念唤出指令时用） */
export function parseAction(raw: string): ActionId | null {
  return matchAction(raw)?.id ?? null;
}
