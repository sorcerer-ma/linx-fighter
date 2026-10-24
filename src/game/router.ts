/**
 * 混合路由的模型侧：本地规则没定下来的句子，交给模型判断是哪一类命令。
 *
 * 关键词表只做「快路径」——招式别名、同音误识别、唤出词、开局、加入房间、
 * 战况这些必须精确的指令就地判定；剩下拿不准的（口语改写、规则外的提问、
 * 语气词）连同当前阶段一起发给 Command Code 的 System One 决策接口，
 * 在「这个阶段能做什么」的选项里选一个。
 *
 * 约束（见 docs/engineering/command-routing.md 与 AGENTS.md）：
 * - 只决定命令类别，不产出数值、不改对局状态；
 * - 问句阶段（question）绝不给出招式选项，避免问一句就真的出手；
 * - 置信度低于阈值、超时、HTTP 异常、返回选项越界，都当没认出来。
 */

import type { Logger } from '../log.js';
import type { Command } from './command.js';
import { askDecision, DEFAULT_DECISION_MODEL } from './commandcode.js';

/** 低于这个置信度就当没认出来，宁可让玩家重说一次 */
export const ROUTER_CONFIDENCE_THRESHOLD = 0.6;

/**
 * 路由阶段：
 * - none：还没有对局；
 * - active：轮到我出招；
 * - response：对手出了招，等我应对；
 * - waiting：轮不到我（已在等对手应对）；
 * - question：这句话是提问，只允许分到「问什么」，不允许出招。
 */
export type RouterStage = 'none' | 'active' | 'response' | 'waiting' | 'question';

export interface CommandRouter {
  /** 把一句话读到当前阶段的命令上；认不出或置信度不足返回 null */
  resolve(text: string, stage: RouterStage): Promise<Command | null>;
}

export interface CommandRouterOptions {
  apiKey: string;
  model?: string;
  timeoutMs?: number;
  /** 默认官方地址，测试或代理时覆盖 */
  baseUrl?: string;
  /** 单测注入，生产用全局 fetch */
  fetchImpl?: typeof fetch;
  logger?: Pick<Logger, 'warn' | 'debug'>;
}

/** 每个选项的说明；模型只在这个集合里选 */
const CRITERIA = {
  light: '普攻：试探性的轻攻击，花费 1 点能量，造成 3 点伤害。',
  heavy: '强攻：全力重击，花费 2 点能量，造成 5 点伤害。',
  ult: '大招：绝招或必杀，花费 4 点能量，造成 9 点伤害，整局只能用一次。',
  charge: '蓄力：这一轮不出手，积攒 1 点能量。',
  guard: '格挡：挡下对手这一击，伤害减 2 点，花费 1 点能量。',
  dodge: '闪避：尝试躲开对手这一击，一半概率完全躲掉，花费 1 点能量。',
  take: '承受：不格挡也不闪避，硬吃这一击，不花能量。',
  status: '查询战况：生命值、能量、大招剩余次数、轮次、当前局面。',
  help: '询问玩法规则：怎么出招、怎么应对、游戏怎么玩。',
  start: '要开始一局新对局（单人练习或再来一局）。',
  'open-room': '要开房间、联机、双人对战。',
  outside: '与游戏无关的提问或闲聊：天气、算数、翻译、讲故事、推荐、常识。',
  unknown: '听不清、不是完整指令，或只是语气词。',
} as const;

type Choice = keyof typeof CRITERIA;

/** 每个阶段允许的选项；question 阶段没有任何招式选项 */
const MENUS: Record<RouterStage, Choice[]> = {
  none: ['start', 'open-room', 'status', 'help', 'outside', 'unknown'],
  active: ['light', 'heavy', 'ult', 'charge', 'status', 'help', 'start', 'outside', 'unknown'],
  response: ['guard', 'dodge', 'take', 'status', 'help', 'outside', 'unknown'],
  waiting: ['status', 'help', 'outside', 'unknown'],
  question: ['status', 'help', 'outside', 'unknown'],
};

const STAGE_TEXT: Record<RouterStage, { stage: string; instructions: string }> = {
  none: {
    stage: '玩家还没有进入对局',
    instructions: '判断这句话想做什么；只能选给定选项。',
  },
  active: {
    stage: '轮到玩家出招',
    instructions: '判断这句话想做什么：出哪一招，或是在查战况、问玩法、闲聊；只能选给定选项。',
  },
  response: {
    stage: '对手已经出招，正等玩家应对',
    instructions: '判断这句话想做什么：用哪种方式应对，或是在查战况、问玩法、闲聊；只能选给定选项。',
  },
  waiting: {
    stage: '玩家已经出招，正在等对手应对',
    instructions: '这一轮玩家不能再出手；判断这句话是想查战况、问玩法还是闲聊。',
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
  const timeoutMs = options.timeoutMs ?? 1500;

  return {
    async resolve(text, stage) {
      const question = questionFor(stage);
      const startedAt = Date.now();
      // 失败、超时、非 200 都由客户端吞掉并回 null，这里按「没认出来」处理
      const payload = await askDecision(
        {
          apiKey: options.apiKey,
          baseUrl: options.baseUrl,
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
