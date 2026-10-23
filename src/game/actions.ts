import type { ActionId } from './types.js';

export interface ActionMeta {
  id: ActionId;
  /** 中文招式名，播报与提示用 */
  label: string;
  /** 玩家可能说的同义说法；单字项只在精确匹配时生效，避免误判 */
  aliases: string[];
  /** ASR 同音/近音的常见误识别（平台侧转写成什么样不由我们决定），只参与匹配，不进提示文案 */
  asrErrors?: string[];
}

export const ACTIONS: Record<ActionId, ActionMeta> = {
  attack: {
    id: 'attack',
    label: '攻击',
    aliases: ['攻击', '打', '砍', '揍', '进攻', '出手', '出招', 'attack', 'hit', 'strike'],
    asrErrors: ['公鸡', '工击', '攻鸡', '公机'],
  },
  dodge: {
    id: 'dodge',
    label: '闪避',
    aliases: ['闪避', '闪', '躲', '躲开', '躲闪', '躲避', '闪开', '闪身', '避开', '防御', '防守', '防', 'dodge', 'evade', 'block'],
    asrErrors: ['闪币', '朵开', '多开', '防疫', '防预'],
  },
  recover: {
    id: 'recover',
    label: '回气',
    aliases: ['回气', '调息', '蓄气', '聚气', '回力', '运气', 'recover', 'charge', 'rest'],
    asrErrors: ['回七', '回器', '回汽', '汇气', '调西', '蓄汽'],
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
  return meta.asrErrors ? [...meta.aliases, ...meta.asrErrors] : meta.aliases;
}

/**
 * 把玩家口语归一化成三个招式之一。
 * 平台侧 ASR 会把「攻击」转成「公鸡」、「回气」转成「回七」，所以匹配表里同时带误识别样例。
 * 认不出来返回 null，由调用方提示可选招式（不消耗回合）。
 */
export function parseAction(raw: string): ActionId | null {
  const text = raw
    .trim()
    .toLowerCase()
    .replace(/[\s，,。．.!！?？、"“”'‘’：:；;]/g, '');
  if (!text) return null;

  // 1. 精确匹配：单字别名（打、躲）只在这里生效，避免「打开菜单」被误判成攻击
  for (const meta of Object.values(ACTIONS)) {
    if (meta.aliases.includes(text)) return meta.id;
  }

  // 2. 包含匹配：别名与误识别一起，按长度从长到短，先匹配更长更具体的说法
  const candidates = Object.values(ACTIONS)
    .flatMap((meta) =>
      matchTerms(meta)
        .filter((term) => term.length >= 2)
        .map((term) => ({ id: meta.id, term })),
    )
    .sort((a, b) => b.term.length - a.term.length);

  for (const { id, term } of candidates) {
    if (text.includes(term)) return id;
  }
  return null;
}
