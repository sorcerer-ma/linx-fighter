/**
 * PR #1 Python 参考仿真（tests/simulation/v02_validation.py）的 TypeScript 移植。
 *
 * 目的不是重新设计玩法，而是「对拍」：用本仓库移植后的 engine 重跑参考仿真的
 * 全部对局，逐项比对 outputs 里的基准结果，证明移植零漂移。因此这里的策略、
 * 防守风格、循环顺序、统计口径都必须和 Python 逐行对应，不能顺手优化：
 *
 * - 8 种策略的顺序决定随机数消耗顺序（影响全部结果），不能改；
 * - 双方共用同一套防守风格（save=False 激进 / save=True 省点），与参考一致；
 * - 参考实现的随机源是全局 `random.seed(20261023)`，整轮仿真只播种一次，
 *   随机流跨对局连续消耗，所以这里也必须全程共用同一个 Mt19937 实例。
 *
 * 参考口径（见 /tmp/v02ref 与 docs/archive/v0.2/test-validation.md）：
 * 先手 14 血、后手 18 血；行动点初始 3、上限 5，各自首次主动阶段不回复，
 * 之后每个主动阶段 +2；蓄力 +1；大招每局一次；第 3 轮起每轮伤害 +2。
 * 防守方在攻击锁定后选择应对，伤害不因应对改变（引擎已保证）。
 *
 * 每一局用 createBattle(firstMover='player') 开局，玩家侧扮演参考仿真的
 * 先手策略 A，对手侧通过注入的 BattleAI 扮演后手策略 B。玩家先手，所以
 * 对手的 chooseAction 一定在玩家行动之后被引擎调用；玩家被攻击而还有行动点
 * 时引擎会留下 pending，由本模块按参考 defense 决策应对。
 */

import { createBattle, resolveTurn } from '../../src/game/engine.js';
import { ATTACKS, CRIT_BONUS, RESPONSES, roundDamageBonus } from '../../src/game/rules.js';
import type {
  ActionId,
  ActiveActionId,
  BattleAI,
  BattleEvent,
  ResponseMove,
  TurnDeps,
} from '../../src/game/types.js';
import { Mt19937 } from './mt19937.js';

/** 参考实现的策略顺序，必须原样保留 */
export const POLICY_ORDER = [
  'light',
  'heavy',
  'reserve',
  'rush',
  'wait_empty',
  'finish',
  'prepared',
  'adaptive_finish',
] as const;

export type Policy = (typeof POLICY_ORDER)[number];

/** 默认随机种子，与 v02_validation.py 一致 */
export const DEFAULT_SEED = 20261023;

/** 每个组合的对局数，与 v02_validation.py 一致 */
export const DEFAULT_GAMES_PER_MATCHUP = 2000;

/**
 * 对局保护上限。参考实现 `for turn in range(100)` 最多 100 个半回合，
 * 也就是 50 轮；超过说明状态机没按预期收尾，直接报错而不是悄悄记成平局。
 */
const MAX_ROUNDS = 50;

/** 每次循环至少推进一个「半回合」；400 次调用足够覆盖 50 轮，仅作兜底 */
const LOOP_LIMIT = 400;

/** 单局结果：先手方是否获胜 + 结束轮数（参考实现的 rd） */
export interface GameOutcome {
  firstWins: boolean;
  rounds: number;
}

/** 按轮次累计的应对次数，键为轮次，值为三种应对的计数 */
export type ResponseTally = Map<number, ResponseRoundCounts>;

export interface ResponseRoundCounts {
  guard: number;
  dodge: number;
  take: number;
}

/** 参考 choose 的入参：行动方与对手的公开信息 + 当轮伤害加成 */
export interface ChooseContext {
  hp: number;
  enemyHp: number;
  ap: number;
  enemyAp: number;
  ultLeft: number;
  /** 当轮伤害加成；参考实现把 ATT 改写成「基础伤害 + 加成」后再决策 */
  bonus: number;
}

/**
 * 参考实现的 8 种策略。
 *
 * 前 6 种来自 limited_ults.py，后 2 种来自 v02_validation.py 的扩展，
 * 其中 `finish` 的阈值 11 与 `adaptive_finish` 的「当轮大招伤害 + 2」是
 * 两套不同口径，不要合并：前者是固定血线，后者随轮次加成变化。
 */
export function choose(policy: Policy, ctx: ChooseContext): ActiveActionId {
  const { hp, enemyHp, ap, enemyAp, ultLeft, bonus } = ctx;

  switch (policy) {
    case 'light':
      return 'light';
    case 'heavy':
      return 'heavy';
    case 'reserve':
      // 固定阈值策略：攒到 3 点就打强攻，否则普攻
      return ap >= 3 ? 'heavy' : 'light';
    case 'rush':
    case 'wait_empty':
    case 'finish': {
      // 次数耗尽后转普通进攻
      if (ultLeft === 0) return ap >= 3 ? 'heavy' : 'light';
      const ready = ap >= 4;
      const wanted =
        policy === 'rush' ||
        (policy === 'wait_empty' && enemyAp === 0) ||
        (policy === 'finish' && enemyHp <= 11);
      if (ready && wanted) return 'ult';
      if (!ready && wanted) return 'charge';
      return ap >= 3 ? 'heavy' : 'light';
    }
    case 'prepared':
    case 'adaptive_finish': {
      if (ultLeft === 0) return ap >= 3 ? 'heavy' : 'light';
      // 参考实现里 d 取的是当轮改写后的 ATT['ult'][1]，即 9 + 当轮加成
      const ultDamage = ATTACKS.ult.damage + bonus;
      const heavyDamage = ATTACKS.heavy.damage + bonus;
      const wanted =
        policy === 'prepared'
          ? enemyAp === 0
          : enemyHp <= ultDamage + 2;
      if (ap >= 4 && wanted) return 'ult';
      if (ap < 4 && hp > heavyDamage + 2) return 'charge';
      return ap >= 3 ? 'heavy' : 'light';
    }
  }
}

/**
 * 参考模拟的防守决策 defense(hp, ap, move, save)。
 *
 * 与引擎内置 ENEMY_AI 的思路一致，但这里必须独立实现，因为对拍的是参考
 * 算法而不是产品 AI：
 * - 没有行动点只能承受；
 * - save 风格在行动点不高于 2、且吃下这一下不会倒下时主动承受；
 * - 其余情况下只在格挡与闪避之间选择（参考实现不把承受列为候选），
 *   先比「被打死的概率」，再比「期望承伤」，平手时取格挡。
 *
 * 这里的浮点运算顺序要与 Python 一致：概率乘积、求和顺序都会影响
 * 平手判定，进而影响整条随机序列，不能随意重排。
 */
export function referenceDefense(
  hp: number,
  ap: number,
  damage: number,
  critChance: number,
  dodgeChance: number,
  save: boolean,
): ResponseMove {
  if (ap === 0) return 'take';
  if (save && ap <= 2 && hp > damage + 2) return 'take';

  // 格挡：固定减 2，仍可能暴击
  const guard = risk(hp, [
    [damage - RESPONSES.guard.reduction, 1 - critChance],
    [damage, critChance],
  ]);
  // 闪避：先判闪避（成功则 0 伤），失败后仍可能暴击
  const dodge = risk(hp, [
    [0, dodgeChance],
    [damage, (1 - dodgeChance) * (1 - critChance)],
    [damage + CRIT_BONUS, (1 - dodgeChance) * critChance],
  ]);

  if (dodge.death !== guard.death) return dodge.death < guard.death ? 'dodge' : 'guard';
  return dodge.expected < guard.expected ? 'dodge' : 'guard';
}

/** 对应 Python 的 min(outcomes, key=(阵亡概率, 期望承伤)) */
function risk(hp: number, outcomes: Array<[damage: number, probability: number]>): {
  death: number;
  expected: number;
} {
  let death = 0;
  let expected = 0;
  for (const [damage, probability] of outcomes) {
    if (damage >= hp) death += probability;
    expected += damage * probability;
  }
  return { death, expected };
}

export interface GameOptions {
  /** 全程共用的随机源，不能每局重新播种 */
  mt: Mt19937;
  /** 防守风格：False 激进，True 省点 */
  save: boolean;
  /** 可选的全局应对统计；传入后本局的每次攻击都会记一笔 */
  tally?: ResponseTally;
}

/**
 * 重跑参考实现的一局：first 为先手（player），second 为后手（enemy）。
 * 返回先手是否获胜与结束轮数；不合法操作、超时都直接抛错。
 */
export async function runGame(first: Policy, second: Policy, options: GameOptions): Promise<GameOutcome> {
  const { mt, save, tally } = options;
  let battle = createBattle({ now: 0, seed: 0, firstMover: 'player' });

  const ai: BattleAI = {
    // 后手策略：引擎在玩家主动阶段结束后自动推进对手的主动阶段
    chooseAction: (view) =>
      choose(second, {
        hp: view.self.hp,
        enemyHp: view.enemy.hp,
        ap: view.self.ap,
        enemyAp: view.enemy.ap,
        ultLeft: view.self.ultLeft,
        bonus: view.bonus,
      }),
    // 玩家出招后由引擎询问对手如何应对，这里用参考 defense
    chooseResponse: (view) =>
      referenceDefense(view.self.hp, view.self.ap, view.damage, view.critChance, view.dodgeChance, save),
  };
  const deps: TurnDeps = { random: () => mt.random(), ai };

  for (let calls = 0; battle.phase === 'battle'; calls++) {
    if (calls >= LOOP_LIMIT || battle.round > MAX_ROUNDS) {
      throw new Error(`对局未在保护上限内结束：${first} vs ${second}，轮次 ${battle.round}`);
    }

    const pending = battle.pending;
    const action: ActionId = pending
      ? // 只有对手出手后才会留下 pending，此时轮到玩家应对
        referenceDefense(
          battle.player.hp,
          battle.player.ap,
          pending.damage,
          ATTACKS[pending.move].critChance,
          ATTACKS[pending.move].dodgeChance,
          save,
        )
      : choose(first, {
          hp: battle.player.hp,
          enemyHp: battle.enemy.hp,
          ap: battle.player.ap,
          enemyAp: battle.enemy.ap,
          ultLeft: battle.player.ultLeft,
          bonus: roundDamageBonus(battle.round),
        });

    const result = await resolveTurn(battle, action, 0, deps);
    if (result.rejection) {
      throw new Error(
        `仿真出现非法操作：${action}（${result.rejection.reason}），${first} vs ${second}`,
      );
    }
    if (tally) countResponses(tally, result.events);
    battle = result.battle;
  }

  return { firstWins: battle.phase === 'victory', rounds: battle.round };
}

/** 把本次结算里的攻击事件计入应对统计（攻击事件与参考 defense 调用一一对应） */
function countResponses(tally: ResponseTally, events: BattleEvent[]): void {
  for (const event of events) {
    if (event.type !== 'attack') continue;
    let row = tally.get(event.round);
    if (!row) {
      row = { guard: 0, dodge: 0, take: 0 };
      tally.set(event.round, row);
    }
    row[event.response] += 1;
  }
}

/** 镜像对局（同策略互打）的统计 */
export interface MirrorStats {
  /** 先手胜率 */
  firstWin: number;
  /** 平均结束轮数 */
  meanRounds: number;
  /** 3～5 轮结束的占比 */
  target: number;
  /** 原始计数，便于和夹具做整数精确比对 */
  wins: number;
  totalRounds: number;
  targetCount: number;
  games: number;
}

/** 一组防守风格（save=False / True）的统计 */
export interface SaveGroupStats {
  save: boolean;
  /** 组合键 `先手,后手` 的原始胜局数 */
  wins: Record<string, number>;
  /** 组合键 `先手,后手` 的先手胜率 */
  matrix: Record<string, number>;
  mirror: Record<Policy, MirrorStats>;
  /** 组内全部对局的先手胜率均值（64 个组合的算术平均） */
  firstWin: number;
  /** 组内全部对局的平均轮数 */
  meanRounds: number;
  target: number;
  /** 各策略的均衡得分 */
  scores: Record<Policy, number>;
  /** 原始计数 */
  games: number;
  /** 每个策略组合的对局数（2000） */
  gamesPerMatchup: number;
  totalRounds: number;
  targetCount: number;
}

/** 全部对局的汇总 */
export interface OverallStats {
  games: number;
  target: number;
  early: number;
  late: number;
  mean: number;
  p90: number;
  p95: number;
  targetCount: number;
  earlyCount: number;
  lateCount: number;
  totalRounds: number;
}

/** 一次完整仿真的结果，对应参考 JSON 的结构 */
export interface ValidationStats {
  groups: SaveGroupStats[];
  overall: OverallStats;
  /** 键为轮次字符串（1～8），与参考 JSON 的 responses 对齐 */
  responses: Record<string, ResponseRoundCounts>;
}

export interface ValidationOptions {
  /** 每个组合的对局数，默认 2000（全量 64×2000×2 = 256,000 局） */
  gamesPerMatchup?: number;
  seed?: number;
}

/**
 * 完整重跑参考仿真的统计流程。
 *
 * 迭代顺序必须与 Python 完全一致：
 * for save in [False, True]: for x in POL: for y in POL: N 局。
 * 随机流只播种一次，跨组连续消耗，所以统计顺序也固定。
 */
export async function runValidationSuite(options: ValidationOptions = {}): Promise<ValidationStats> {
  const gamesPerMatchup = options.gamesPerMatchup ?? DEFAULT_GAMES_PER_MATCHUP;
  const mt = new Mt19937(options.seed ?? DEFAULT_SEED);
  const tally: ResponseTally = new Map();
  const groups: SaveGroupStats[] = [];
  const allRounds: number[] = [];

  for (const save of [false, true]) {
    const wins: Record<string, number> = {};
    const matrix: Record<string, number> = {};
    const mirror = {} as Record<Policy, MirrorStats>;
    const groupRounds: number[] = [];
    let targetCount = 0;

    for (const x of POLICY_ORDER) {
      for (const y of POLICY_ORDER) {
        let comboWins = 0;
        const mirrorRounds: number[] = [];

        for (let i = 0; i < gamesPerMatchup; i++) {
          const outcome = await runGame(x, y, { mt, save, tally });
          if (outcome.firstWins) comboWins += 1;
          groupRounds.push(outcome.rounds);
          if (outcome.rounds >= 3 && outcome.rounds <= 5) targetCount += 1;
          if (x === y) mirrorRounds.push(outcome.rounds);
        }

        const key = `${x},${y}`;
        wins[key] = comboWins;
        matrix[key] = comboWins / gamesPerMatchup;

        if (x === y) {
          let totalRounds = 0;
          let comboTarget = 0;
          for (const rounds of mirrorRounds) {
            totalRounds += rounds;
            if (rounds >= 3 && rounds <= 5) comboTarget += 1;
          }
          mirror[x] = {
            firstWin: comboWins / gamesPerMatchup,
            meanRounds: totalRounds / gamesPerMatchup,
            target: comboTarget / gamesPerMatchup,
            wins: comboWins,
            totalRounds,
            targetCount: comboTarget,
            games: gamesPerMatchup,
          };
        }
      }
    }

    let totalRounds = 0;
    for (const rounds of groupRounds) totalRounds += rounds;

    groups.push({
      save,
      wins,
      matrix,
      mirror,
      firstWin: meanOfMatrix(matrix),
      meanRounds: totalRounds / groupRounds.length,
      target: targetCount / groupRounds.length,
      scores: balancedScores(matrix),
      games: groupRounds.length,
      gamesPerMatchup,
      totalRounds,
      targetCount,
    });
    // 逐项追加：单组 12.8 万个元素，展开运算符会爆调用栈
    for (const rounds of groupRounds) allRounds.push(rounds);
  }

  // 与参考实现一致：按结束轮数升序取 90/95 分位
  const sorted = [...allRounds].sort((a, b) => a - b);
  const overall: OverallStats = {
    games: sorted.length,
    target: countRange(sorted, 3, 5) / sorted.length,
    early: countRange(sorted, 0, 2) / sorted.length,
    late: countRange(sorted, 6, Number.POSITIVE_INFINITY) / sorted.length,
    mean: sumOf(allRounds) / allRounds.length,
    p90: sorted[Math.floor(0.9 * sorted.length)]!,
    p95: sorted[Math.floor(0.95 * sorted.length)]!,
    targetCount: countRange(sorted, 3, 5),
    earlyCount: countRange(sorted, 0, 2),
    lateCount: countRange(sorted, 6, Number.POSITIVE_INFINITY),
    totalRounds: sumOf(allRounds),
  };

  // 参考输出只统计第 1～8 轮；更晚轮次的应对在参考结果里被丢弃，
  // 这里保留同样的口径（第 9 轮以后不参与比对）。
  const responses: Record<string, ResponseRoundCounts> = {};
  for (let round = 1; round <= 8; round++) {
    const row = tally.get(round);
    responses[String(round)] = row ? { ...row } : { guard: 0, dodge: 0, take: 0 };
  }

  return { groups, overall, responses };
}

/** 先手胜率均值：Python `statistics.mean(matrix.values())`，按插入顺序求和 */
function meanOfMatrix(matrix: Record<string, number>): number {
  let sum = 0;
  let count = 0;
  for (const x of POLICY_ORDER) {
    for (const y of POLICY_ORDER) {
      sum += matrix[`${x},${y}`]!;
      count += 1;
    }
  }
  return sum / count;
}

/**
 * 均衡得分：参考实现里 scores[p] = sum((matrix[p,y] + 1 - matrix[y,p]) / 2 for y != p) / 7。
 * 求和必须复刻 CPython 3.12 内建 sum() 的语义，否则会差 1 ulp。
 */
function balancedScores(matrix: Record<string, number>): Record<Policy, number> {
  const scores = {} as Record<Policy, number>;
  for (const x of POLICY_ORDER) {
    const deltas: number[] = [];
    for (const y of POLICY_ORDER) {
      if (y === x) continue;
      deltas.push((matrix[`${x},${y}`]! + 1 - matrix[`${y},${x}`]!) / 2);
    }
    scores[x] = cpythonSum(deltas) / (POLICY_ORDER.length - 1);
  }
  return scores;
}

/**
 * 复刻 CPython 3.12 内建 sum() 的浮点求和语义：Neumaier 补偿求和。
 * Python 3.12 起 sum() 对浮点输入走这条路径，直接左到右累加会差 1 ulp。
 */
function cpythonSum(values: readonly number[]): number {
  let sum = 0;
  let compensation = 0;
  for (const value of values) {
    const next = sum + value;
    if (Math.abs(sum) >= Math.abs(value)) {
      compensation += (sum - next) + value;
    } else {
      compensation += (value - next) + sum;
    }
    sum = next;
  }
  return sum + compensation;
}

function sumOf(values: number[]): number {
  let sum = 0;
  for (const value of values) sum += value;
  return sum;
}

/** 闭区间计数；用于统计 3～5 轮与早于 3 轮、晚于 5 轮 */
function countRange(values: number[], min: number, max: number): number {
  let count = 0;
  for (const value of values) {
    if (value >= min && value <= max) count += 1;
  }
  return count;
}
