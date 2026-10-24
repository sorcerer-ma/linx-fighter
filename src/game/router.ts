/**
 * 混合路由的模型侧：本地规则没定下来的句子，交给模型判断是哪一类命令。
 *
 * 关键词表只做「快路径」——招式别名、同音误识别、唤出词、开局、加入房间、
 * 战况这些必须精确的指令就地判定；剩下拿不准的（口语改写、规则外的提问、
 * 语气词）连同当前阶段一起发给模型网关的 `/systemone` 决策接口，
 * 在「这个阶段能做什么」的选项里选一个。
 *
 * 约束（见 docs/engineering/command-routing.md 与 AGENTS.md）：
 * - 只决定命令类别，不产出数值、不改对局状态；
 * - 问句阶段（question）绝不给出招式选项，避免问一句就真的出手；
 * - 置信度低于阈值、超时、HTTP 异常、返回选项越界，都当没认出来。
 */

import type { Logger } from '../log.js';
import type { Command } from './command.js';
import { askDecision, DEFAULT_DECISION_MODEL } from './llm.js';

/** 低于这个置信度就当没认出来，宁可让玩家重说一次 */
export const ROUTER_CONFIDENCE_THRESHOLD = 0.6;

/**
 * 路由阶段：
 * - none：还没有对局；
 * - active：轮到我出招；
 * - response：对手出了招，等我应对；
 * - waiting：轮不到我（已在等对手应对）；
 * - ended：上一局已经结束，只能重开、开房、查询、玩法或闲聊；
 * - question：这句话是提问，只允许分到「问什么」，不允许出招。
 */
export type RouterStage = 'none' | 'active' | 'response' | 'waiting' | 'ended' | 'question';

export interface CommandRouter {
  /** 把一句话读到当前阶段的命令上；认不出或置信度不足返回 null */
  resolve(text: string, stage: RouterStage): Promise<Command | null>;
}

export interface CommandRouterOptions {
  apiKey: string;
  model?: string;
  timeoutMs?: number;
  /** 默认网关地址，测试或代理时覆盖 */
  baseUrl?: string;
  /** 决策模型路径；换网关时覆盖 */
  decisionPath?: string;
  /** 单测注入，生产用全局 fetch */
  fetchImpl?: typeof fetch;
  logger?: Pick<Logger, 'warn' | 'debug'>;
}

/** 每个选项的说明；模型只在这个集合里选 */
const CRITERIA = {
  light: '普攻：试探性的轻攻击，花费 1 点能量，造成 3 点伤害；「轻轻来一下」「试探一下」也算。',
  heavy: '强攻：全力重击，花费 2 点能量，造成 5 点伤害；口语里的狠话（「给他点颜色看看」「搞他」「弄他」「揍他」「往死里打」）算强攻。',
  ult: '大招：绝招或必杀，花费 4 点能量，造成 9 点伤害，整局只能用一次；「开大」「放个大招」「来个大的」也算。',
  charge: '蓄力：这一轮不出手，积攒 1 点能量；「攒一下」「回口气」「憋一下」也算。',
  guard: '格挡：挡下对手这一击，伤害减 2 点，花费 1 点能量；「挡住」「顶一下」也算。',
  dodge: '闪避：尝试躲开对手这一击，一半概率完全躲掉，花费 1 点能量；「躲一下」「闪开」也算。',
  take: '承受：不格挡也不闪避，硬吃这一击，不花能量；「硬扛」「挺住」「挨一下」也算。',
  status: '查询战况：生命值、能量、大招剩余次数、轮次、当前局面。',
  help: '询问玩法规则：怎么出招、怎么应对、游戏怎么玩。',
  start: '要开始一局新对局（单人练习或再来一局）。',
  'open-room': '要开房间、联机、双人对战。',
  outside: '与游戏无关的提问或闲聊：天气、算数、翻译、讲故事、推荐、常识。',
  unknown: '听不清、不是完整指令、只是语气词，或这一轮做不了的动作。',
} as const;

type Choice = keyof typeof CRITERIA;

/** 每个阶段允许的选项；ended 与 question 阶段都没有任何招式选项 */
const MENUS: Record<RouterStage, Choice[]> = {
  none: ['start', 'open-room', 'status', 'help', 'outside', 'unknown'],
  active: ['light', 'heavy', 'ult', 'charge', 'status', 'help', 'start', 'outside', 'unknown'],
  response: ['guard', 'dodge', 'take', 'status', 'help', 'outside', 'unknown'],
  waiting: ['status', 'help', 'outside', 'unknown'],
  ended: ['start', 'open-room', 'status', 'help', 'outside', 'unknown'],
  question: ['status', 'help', 'outside', 'unknown'],
};

const STAGE_TEXT: Record<RouterStage, { stage: string; instructions: string }> = {
  none: {
    stage: '玩家还没有进入对局',
    instructions: '判断这句话想做什么；只能选给定选项。',
  },
  active: {
    stage: '轮到玩家出招',
    instructions:
      '判断这句话想做什么：出哪一招，或是在查战况、问玩法、闲聊；只能选给定选项。' +
      '玩家用口语、狠话表达进攻时就按语气强弱选一个招式，不要因为说法不标准而选 unknown。' +
      '玩家说的是格挡、闪避、承受这类应对动作时选 unknown（现在还没到应对的时候），不要改判成别的招式。',
  },
  response: {
    stage: '对手已经出招，正等玩家应对',
    instructions:
      '判断这句话想做什么：用哪种方式应对，或是在查战况、问玩法、闲聊；只能选给定选项。' +
      '玩家说的是出招（普攻、强攻、大招、蓄力）时选 unknown（现在轮到他应对，不该出招），不要改判成别的应对。',
  },
  waiting: {
    stage: '玩家已经出招，正在等对手应对',
    instructions: '这一轮玩家不能再出手；判断这句话是想查战况、问玩法还是闲聊。',
  },
  ended: {
    stage: '上一局已经结束',
    instructions: '这一局已经结束，玩家不能再出手；判断这句话是想再来一局、开房间、查战况、问玩法，还是闲聊。',
  },
  question: {
    stage: '玩家在提问，不是在出手',
    instructions: '这是提问：判断问的是对局内的信息、玩法规则，还是游戏之外的事。',
  },
};

/** 决策返回结构；只取需要的字段 */
interface RouteDecisionPayload {
  answers?: {
    command?: {
      choice?: unknown;
      confidence?: unknown;
      probabilities?: unknown;
    };
  };
  usage?: { input_tokens?: unknown; output_tokens?: unknown };
}

function commandOfChoice(choice: Choice, text: string): Command | null {
  switch (choice) {
    case 'light':
    case 'heavy':
    case 'ult':
    case 'charge':
    case 'guard':
    case 'dodge':
    case 'take':
      return { kind: 'turn', action: choice };
    case 'status':
    case 'help':
    case 'start':
    case 'open-room':
      return { kind: choice };
    case 'outside':
      return { kind: 'ask', text: text.trim() };
    case 'unknown':
      return null;
  }
}

/**
 * 解析路由结果：只接受菜单内的选项，且置信度达标。
 * export 出来给单测直接打桩。
 */
export function parseRouteDecision(
  payload: unknown,
  stage: RouterStage,
  text: string,
  threshold: number = ROUTER_CONFIDENCE_THRESHOLD,
): Command | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const answer = (payload as RouteDecisionPayload).answers?.command;
  if (typeof answer !== 'object' || answer === null) return null;

  const choice = answer.choice;
  if (typeof choice !== 'string') return null;
  const menu = MENUS[stage] as string[];
  if (!menu.includes(choice) || choice === 'unknown') return null;

  // 优先用顶层 confidence；缺失时退回该选项的概率
  const probabilities = answer.probabilities;
  const probability =
    typeof probabilities === 'object' && probabilities !== null
      ? (probabilities as Record<string, unknown>)[choice]
      : undefined;
  const confidence =
    typeof answer.confidence === 'number'
      ? answer.confidence
      : typeof probability === 'number'
        ? probability
        : 0;
  if (confidence < threshold) return null;

  return commandOfChoice(choice as Choice, text);
}

/** 当前阶段的问题描述：题干、选项说明都随阶段收窄 */
function questionFor(stage: RouterStage): { stage: string; instructions: string; criteria: Record<string, string> } {
  const menu = MENUS[stage];
  const criteria: Record<string, string> = {};
  for (const choice of menu) criteria[choice] = CRITERIA[choice];
  return { ...STAGE_TEXT[stage], criteria };
}

export function createCommandRouter(options: CommandRouterOptions): CommandRouter {
  const model = options.model ?? DEFAULT_DECISION_MODEL;
  const timeoutMs = options.timeoutMs ?? 2000;

  return {
    async resolve(text, stage) {
      const question = questionFor(stage);
      const startedAt = Date.now();
      // 失败、超时、非 200 都由客户端吞掉并回 null，这里按「没认出来」处理
      const payload = await askDecision(
        {
          apiKey: options.apiKey,
          baseUrl: options.baseUrl,
          decisionPath: options.decisionPath,
          timeoutMs,
          fetchImpl: options.fetchImpl,
          logger: options.logger,
        },
        {
          model,
          state: { stage: question.stage, utterance: text },
          questions: {
            command: {
              type: 'choice',
              instructions: question.instructions,
              criteria: question.criteria,
            },
          },
        },
      );
      const command = parseRouteDecision(payload, stage, text);
      options.logger?.debug('命令路由完成', {
        stage,
        kind: command?.kind ?? null,
        latencyMs: Date.now() - startedAt,
      });
      return command;
    },
  };
}
