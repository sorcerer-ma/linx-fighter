import type { ActionId } from './types.js';

export interface ActionMeta {
  id: ActionId;
  /** 中文招式名，播报与提示用 */
  label: string;
  /** 语音识别的说法千奇百怪，这里列出常见同义说法 */
  aliases: string[];
}

export const ACTIONS: Record<ActionId, ActionMeta> = {
  attack: {
    id: 'attack',
    label: '攻击',
    aliases: ['攻击', '打', '砍', '揍', '进攻', '出手', '出招', 'attack', 'hit', 'strike'],
  },
  dodge: {
    id: 'dodge',
    label: '闪避',
    aliases: ['闪避', '躲', '躲开', '躲避', '闪开', '闪身', '避开', '防御', 'dodge', 'evade', 'block'],
  },
  recover: {
    id: 'recover',
    label: '回气',
    aliases: ['回气', '调息', '蓄气', '聚气', '回力', '运气', 'recover', 'charge', 'rest'],
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

/**
 * 把玩家口语归一化成三个招式之一。
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
    if (meta.aliases.some((alias) => alias === text)) return meta.id;
  }

  // 2. 包含匹配：按别名长度从长到短，先匹配更长更具体的说法
  const candidates = Object.values(ACTIONS)
    .flatMap((meta) => meta.aliases.map((alias) => ({ id: meta.id, alias })))
    .filter(({ alias }) => alias.length >= 2)
    .sort((a, b) => b.alias.length - a.alias.length);

  for (const { id, alias } of candidates) {
    if (text.includes(alias)) return id;
  }
  return null;
}
