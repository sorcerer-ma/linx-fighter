/**
 * v0.2 仿真对拍的快速子集：验证 MT19937 移植精度与一场镜像对局的关键指标，
 * 全量 256,000 局的对拍在 scripts/validate-v02.ts。
 *
 *   node --import tsx --test test/simulation.test.ts
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Mt19937 } from './helpers/mt19937.js';
import { runGame } from './helpers/v02-simulation.js';

/** CPython 3.12 在 random.seed(20261023) 后 random() 的前 5 个值 */
const PYTHON_FIRST_FIVE = [
  0.2529479731947105,
  0.7788603842413495,
  0.5336638342796356,
  0.2407135559114315,
  0.36699767427812235,
];

describe('v0.2 仿真对拍（快速子集）', () => {
  it('MT19937 与 CPython 前 5 个随机数逐位一致', () => {
    const mt = new Mt19937(20261023);
    const actual = PYTHON_FIRST_FIVE.map(() => mt.random());
    assert.deepEqual(actual, PYTHON_FIRST_FIVE);
  });

  it('save=False 的 light 镜像 2000 局与夹具一致', () => {
    // 基准取自 test/fixtures/v02-validation.json 的 False.mirror.light
    const mt = new Mt19937(20261023);
    let wins = 0;
    let totalRounds = 0;
    let targetCount = 0;

    for (let i = 0; i < 2000; i++) {
      const outcome = runGame('light', 'light', { mt, save: false });
      if (outcome.firstWins) wins += 1;
      totalRounds += outcome.rounds;
      if (outcome.rounds >= 3 && outcome.rounds <= 5) targetCount += 1;
    }

    assert.equal(wins, 946);
    assert.equal(totalRounds / 2000, 5.3825);
    assert.equal(targetCount / 2000, 0.619);
  });
});
