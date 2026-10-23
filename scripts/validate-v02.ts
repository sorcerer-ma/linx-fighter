/**
 * v0.2 玩法对拍脚本：用移植后的 TypeScript engine 重跑 PR #1 的 Python 参考仿真，
 * 与 test/fixtures/v02-validation.json（原 v02_validation_results.json）逐项比对。
 *
 *   node --import tsx scripts/validate-v02.ts
 *
 * 比对口径：
 * - 整数局数（胜局、各轮应对次数、局数、分位轮次）必须完全相等；
 * - 夹具里的浮点率用 Math.round(rate * N) 恢复成整数后再比，避免浮点噪声；
 * - 派生均值（mean_rounds / overall.mean / first_win 均值）允许 1e-12 误差；
 * - scores 按参考实现的浮点运算顺序计算，要求逐位相同。
 *
 * 任何一处不一致就打印「键、期望、实际」并以退出码 1 结束；全部通过则打印
 * 各风格的镜像指标、overall 与实际耗时，退出码 0。
 */

import { readFileSync } from 'node:fs';
import { POLICY_ORDER, runValidationSuite, type SaveGroupStats } from '../test/helpers/v02-simulation.js';

/** 派生均值的允许误差 */
const MEAN_TOLERANCE = 1e-12;

interface FixtureMirror {
  first_win: number;
  mean_rounds: number;
  target: number;
}

interface FixtureGroup {
  matrix: Record<string, number>;
  mirror: Record<string, FixtureMirror>;
  mean_rounds: number;
  target: number;
  first_win: number;
  scores: Record<string, number>;
}

interface Fixture {
  False: FixtureGroup;
  True: FixtureGroup;
  overall: {
    games: number;
    target: number;
    early: number;
    late: number;
    mean: number;
    p90: number;
    p95: number;
  };
  responses: Record<string, { guard: number; dodge: number; take: number }>;
}

/** 第一处差异：打印后直接失败退出 */
function fail(key: string, expected: unknown, actual: unknown): never {
  console.error('✗ 对拍失败，第一处差异：');
  console.error(`  键：${key}`);
  console.error(`  期望：${format(expected)}`);
  console.error(`  实际：${format(actual)}`);
  process.exit(1);
}

function format(value: unknown): string {
  return typeof value === 'number' ? String(value) : JSON.stringify(value);
}

/** 整数必须完全相等 */
function expectInt(key: string, expected: number, actual: number): void {
  if (expected !== actual) fail(key, expected, actual);
}

/** 浮点（派生均值）允许小误差 */
function expectClose(key: string, expected: number, actual: number): void {
  if (!(Math.abs(expected - actual) <= MEAN_TOLERANCE)) fail(key, expected, actual);
}

/** 误差要求为零：按参考运算顺序算出的浮点必须逐位相同 */
function expectExact(key: string, expected: number, actual: number): void {
  if (expected !== actual) fail(key, expected, actual);
}

/**
 * 浮点率比对：先把夹具率恢复成整数局数做严格比对，
 * 再顺带确认本实现算出的率与夹具率一致（防止夹具本身被截断过）。
 */
function expectRate(key: string, fixtureRate: number, wins: number, games: number): void {
  const expectedWins = Math.round(fixtureRate * games);
  expectInt(`${key}（局数）`, expectedWins, wins);
  expectClose(`${key}（比率）`, fixtureRate, wins / games);
}

function compareGroup(save: boolean, group: SaveGroupStats, fixture: FixtureGroup): void {
  const label = save ? 'True' : 'False';
  const games = group.games;
  const perMatchup = group.gamesPerMatchup;

  // 8×8 对局矩阵：先手胜局数
  for (const x of POLICY_ORDER) {
    for (const y of POLICY_ORDER) {
      const key = `${label}.matrix.${x},${y}`;
      expectRate(key, fixture.matrix[`${x},${y}`]!, group.wins[`${x},${y}`]!, perMatchup);
    }
  }

  // 镜像对局：先手胜局、平均轮数、3～5 轮占比
  for (const policy of POLICY_ORDER) {
    const expected = fixture.mirror[policy]!;
    const actual = group.mirror[policy];
    expectRate(
      `${label}.mirror.${policy}.first_win`,
      expected.first_win,
      actual.wins,
      perMatchup,
    );
    expectClose(
      `${label}.mirror.${policy}.mean_rounds`,
      expected.mean_rounds,
      actual.meanRounds,
    );
    expectRate(
      `${label}.mirror.${policy}.target`,
      expected.target,
      actual.targetCount,
      perMatchup,
    );
  }

  // 组内合计：先手胜率均值、平均轮数、目标区间占比
  expectRate(`${label}.first_win`, fixture.first_win, meanMatrixWins(group), games);
  expectClose(`${label}.mean_rounds`, fixture.mean_rounds, group.meanRounds);
  expectRate(`${label}.target`, fixture.target, group.targetCount, games);

  // 均衡得分：按参考实现的浮点运算顺序计算，要求逐位相同
  for (const policy of POLICY_ORDER) {
    expectExact(`${label}.scores.${policy}`, fixture.scores[policy]!, group.scores[policy]);
  }
}

/** 组内 64 个组合的胜局总和，与夹具的 first_win 率对应 */
function meanMatrixWins(group: SaveGroupStats): number {
  let wins = 0;
  for (const x of POLICY_ORDER) {
    for (const y of POLICY_ORDER) wins += group.wins[`${x},${y}`]!;
  }
  return wins;
}

function printGroup(group: SaveGroupStats): void {
  const label = group.save ? 'True（省点防守）' : 'False（激进防守）';
  console.log(`\n防守风格 save=${label}`);
  console.log('  策略              first_win  mean_rounds  target');
  for (const policy of POLICY_ORDER) {
    const mirror = group.mirror[policy];
    console.log(
      `  ${policy.padEnd(16)}  ${mirror.firstWin.toFixed(4)}     ` +
        `${mirror.meanRounds.toFixed(4)}      ${mirror.target.toFixed(4)}`,
    );
  }
  console.log(
    `  ${'组均值'.padEnd(14)}  ${group.firstWin.toFixed(4)}     ` +
      `${group.meanRounds.toFixed(4)}      ${group.target.toFixed(4)}`,
  );
}

function main(): void {
  const fixture = JSON.parse(
    readFileSync(new URL('../test/fixtures/v02-validation.json', import.meta.url), 'utf8'),
  ) as Fixture;

  console.log('=== v0.2 对拍：TypeScript engine vs PR #1 Python 参考仿真 ===');
  console.log('协议：8 策略 × 8 策略 × 2 防守风格 × 2000 局，种子 20261023');

  const startedAt = performance.now();
  const stats = runValidationSuite();
  const elapsedMs = performance.now() - startedAt;

  // 每组（save=False / True）逐项比对
  for (const group of stats.groups) {
    compareGroup(group.save, group, group.save ? fixture.True : fixture.False);
  }

  // overall
  const { overall } = stats;
  expectInt('overall.games', fixture.overall.games, overall.games);
  expectRate('overall.target', fixture.overall.target, overall.targetCount, overall.games);
  expectRate('overall.early', fixture.overall.early, overall.earlyCount, overall.games);
  expectRate('overall.late', fixture.overall.late, overall.lateCount, overall.games);
  expectClose('overall.mean', fixture.overall.mean, overall.mean);
  expectInt('overall.p90', fixture.overall.p90, overall.p90);
  expectInt('overall.p95', fixture.overall.p95, overall.p95);

  // 按轮次的应对次数：参考输出只含第 1～8 轮
  for (let round = 1; round <= 8; round++) {
    const expected = fixture.responses[String(round)]!;
    const actual = stats.responses[String(round)]!;
    for (const response of ['guard', 'dodge', 'take'] as const) {
      expectInt(
        `responses.${round}.${response}`,
        expected[response],
        actual[response],
      );
    }
  }

  // 全部通过：打印镜像指标、overall 与实际耗时
  for (const group of stats.groups) printGroup(group);

  console.log('\noverall');
  console.log(
    `  games=${overall.games} target=${overall.target.toFixed(4)} ` +
      `early=${overall.early.toFixed(4)} late=${overall.late.toFixed(4)} ` +
      `mean=${overall.mean.toFixed(4)} p90=${overall.p90} p95=${overall.p95}`,
  );
  console.log(
    '  应对次数（第 1～8 轮）：' +
      Object.entries(stats.responses)
        .map(([round, row]) => `${round}:g${row.guard}/d${row.dodge}/t${row.take}`)
        .join(' '),
  );

  console.log(`\n✓ 全部 ${overall.games} 局与夹具逐项一致，零漂移`);
  console.log(`实际耗时：${(elapsedMs / 1000).toFixed(2)}s`);
  process.exit(0);
}

main();
