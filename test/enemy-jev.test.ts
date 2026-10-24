import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ENEMY_AI } from '../src/game/enemy.js';
import {
  activeQuestion,
  createJevEnemyAI,
  describeHistory,
  historySummary,
  legalActiveActions,
  legalResponses,
  parseEnemyDecision,
  responseQuestion,
} from '../src/game/enemy-jev.js';
import type { ActionView, BattleAI, ResponseView, TurnRecord } from '../src/game/types.js';

const logger = { info: () => {}, warn: () => {}, debug: () => {} };

/** 主动阶段视角：默认对手（enemy 侧）满生命值、3 能量、1 次大招；玩家 14点生命值 */
function actionViewFixture(
  overrides: Partial<{
    round: number;
    bonus: number;
    hp: number;
    ap: number;
    ultLeft: number;
    enemyHp: number;
    history: TurnRecord[];
  }> = {},
): ActionView {
  return {
    round: overrides.round ?? 1,
    bonus: overrides.bonus ?? 0,
    self: { hp: overrides.hp ?? 18, ap: overrides.ap ?? 3, ultLeft: overrides.ultLeft ?? 1 },
    enemy: { hp: overrides.enemyHp ?? 14, ap: 3, ultLeft: 1 },
    history: overrides.history ?? [],
  };
}

/** 应对阶段视角：默认玩家一记普攻、伤害 3 */
function responseViewFixture(
  overrides: Partial<{
    round: number;
    bonus: number;
    hp: number;
    ap: number;
    move: 'light' | 'heavy' | 'ult';
    damage: number;
    critChance: number;
    dodgeChance: number;
    history: TurnRecord[];
  }> = {},
): ResponseView {
  return {
    round: overrides.round ?? 1,
    bonus: overrides.bonus ?? 0,
    self: { hp: overrides.hp ?? 18, ap: overrides.ap ?? 3, ultLeft: 1 },
    attacker: { hp: 14, ap: 3, ultLeft: 1 },
    move: overrides.move ?? 'light',
    damage: overrides.damage ?? 3,
    critChance: overrides.critChance ?? 0.2,
    dodgeChance: overrides.dodgeChance ?? 0.5,
    history: overrides.history ?? [],
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** 构造一条 JEV decisions 返回 */
function decision(choice: string, confidence?: number, probabilities?: Record<string, number>): Response {
  return jsonResponse({
    answers: { move: { type: 'choice', choice, confidence, probabilities } },
    usage: { input_tokens: 460, output_tokens: 38, cost: 0.0000241 },
  });
}

const fallback: BattleAI = { chooseAction: () => 'charge', chooseResponse: () => 'take' };

describe('JEV 对手 AI：合法选项与题干', () => {
  it('主动阶段先按能量过滤合法招式', () => {
    assert.deepEqual(legalActiveActions(actionViewFixture({ ap: 0 })), ['charge']);
    assert.deepEqual(legalActiveActions(actionViewFixture({ ap: 1 })), ['light', 'charge']);
    assert.deepEqual(legalActiveActions(actionViewFixture({ ap: 3 })), ['light', 'heavy', 'charge']);
    assert.deepEqual(legalActiveActions(actionViewFixture({ ap: 4 })), ['light', 'heavy', 'ult', 'charge']);
    assert.deepEqual(legalActiveActions(actionViewFixture({ ap: 4, ultLeft: 0 })), ['light', 'heavy', 'charge']);
    assert.deepEqual(legalActiveActions(actionViewFixture({ ap: 5 })), ['light', 'heavy', 'ult']);
  });

  it('应对阶段没有能量时只能承受', () => {
    assert.deepEqual(legalResponses(responseViewFixture({ ap: 0 })), ['take']);
    assert.deepEqual(legalResponses(responseViewFixture({ ap: 1 })), ['guard', 'dodge', 'take']);
  });

  it('主动题干带上轮次、加成、双方数值与选项说明', () => {
    const view = actionViewFixture({ round: 3, bonus: 2, hp: 12, ap: 4, ultLeft: 1 });
    const { state, question } = activeQuestion(view);
    assert.match(state, /第 3 轮/);
    assert.match(state, /伤害加成 \+2/);
    assert.match(state, /生命值 12/);
    assert.match(state, /大招剩 1 次/);
    assert.match(question.criteria.ult!, /造成 11 点伤害/);
    assert.match(question.criteria.charge!, /能量 \+1/);
  });

  it('应对题干带上攻击伤害与概率', () => {
    const { state, question } = responseQuestion(
      responseViewFixture({ move: 'heavy', damage: 7, critChance: 0.2, dodgeChance: 0.5 }),
    );
    assert.match(state, /强攻/);
    assert.match(state, /基础伤害 7/);
    assert.match(state, /闪避成功率|闪避率|50%/);
    assert.match(question.criteria.guard!, /减 2/);
  });

  it('解析返回：只认本地过滤后的合法选项，置信度不作为拒绝条件', () => {
    assert.equal(parseEnemyDecision(decisionPayload('heavy', 0.8), ['light', 'heavy']), 'heavy');
    assert.equal(parseEnemyDecision(decisionPayload('light', 0.3), ['light', 'heavy']), 'light');
    assert.equal(parseEnemyDecision(decisionPayload('ult', 0.99), ['light', 'heavy']), null);
    assert.equal(parseEnemyDecision(decisionPayload('light'), ['light']), 'light');
    assert.equal(parseEnemyDecision({ answers: { move: { choice: 'light', probabilities: { light: 0.7 } } } }, ['light']), 'light');
    assert.equal(parseEnemyDecision({ answers: { move: { choice: 42 } } }, ['light']), null);
    assert.equal(parseEnemyDecision(null, ['light']), null);
  });

  it('低置信度但合法的选择仍然采纳', async () => {
    const ai = createJevEnemyAI({
      apiKey: 'sk-test',
      logger,
      fetchImpl: (async () => decision('heavy', 0.3)) as typeof fetch,
    });
    assert.equal(await ai.chooseAction(actionViewFixture({ ap: 3 })), 'heavy');
  });
});

describe('JEV 对手 AI：战报与习惯输入', () => {
  const history: TurnRecord[] = [
    { round: 1, actor: 'player', action: 'light', response: 'guard', damage: 1, guarded: true, createdAt: 100 },
    { round: 1, actor: 'enemy', action: 'heavy', response: 'take', damage: 5, createdAt: 200 },
    { round: 2, actor: 'player', action: 'charge', createdAt: 300 },
  ];

  it('战报转成带结果的短句', () => {
    assert.equal(describeHistory(history[0]!), '第1轮 玩家普攻，你格挡，掉1');
    assert.equal(
      describeHistory({ round: 2, actor: 'player', action: 'heavy', response: 'dodge', dodged: true, createdAt: 0 }),
      '第2轮 玩家强攻，你闪开',
    );
    assert.equal(
      describeHistory({ round: 3, actor: 'enemy', action: 'ult', response: 'take', damage: 11, crit: true, createdAt: 0 }),
      '第3轮 你大招，玩家硬扛，暴击掉11',
    );
    assert.equal(describeHistory({ round: 4, actor: 'enemy', action: 'charge', createdAt: 0 }), '第4轮 你蓄力');
  });

  it('习惯统计只看玩家出招与玩家应对', () => {
    assert.equal(historySummary(history), '玩家习惯：主动 普攻1、蓄力1；应对 硬扛1。');
    assert.equal(historySummary([]), '');
  });

  it('题干带上最近战报与习惯，空历史不提', () => {
    const { state } = activeQuestion(actionViewFixture({ history }));
    assert.match(state, /最近战报：第1轮 玩家普攻，你格挡，掉1；/);
    assert.match(state, /玩家习惯：主动 普攻1、蓄力1；应对 硬扛1。/);

    const empty = activeQuestion(actionViewFixture()).state;
    assert.doesNotMatch(empty, /最近战报/);
    assert.doesNotMatch(empty, /玩家习惯/);

    const responseState = responseQuestion(responseViewFixture({ history })).state;
    assert.match(responseState, /最近战报/);
  });

  it('请求体里带上战报与习惯', async () => {
    let capturedBody = '';
    const ai = createJevEnemyAI({
      apiKey: 'sk-test',
      logger,
      fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => {
        capturedBody = String(init?.body);
        return decision('heavy', 0.8);
      }) as typeof fetch,
    });
    await ai.chooseAction(actionViewFixture({ ap: 3, history }));
    const body = JSON.parse(capturedBody);
    assert.match(body.state.situation, /最近战报/);
    assert.match(body.state.situation, /玩家习惯：主动 普攻1、蓄力1/);
  });

  it('最近战报最多带 6 条，旧战报仍计入习惯', () => {
    const many: TurnRecord[] = Array.from({ length: 10 }, (_, i) => ({
      round: Math.floor(i / 2) + 1,
      actor: 'player' as const,
      action: 'light' as const,
      response: 'guard' as const,
      damage: 1,
      createdAt: i,
    }));
    const { state } = activeQuestion(actionViewFixture({ history: many }));
    const recent = state.match(/最近战报：([^。]*)。/)?.[1]?.split('；') ?? [];
    assert.equal(recent.length, 6);
    assert.match(historySummary(many), /普攻10/);
  });
});

function decisionPayload(choice: string, confidence?: number): unknown {
  return { answers: { move: { choice, confidence } } };
}

describe('JEV 对手 AI：调用与回退', () => {
  it('主动阶段按 JEV 返回出招，请求里只带合法选项', async () => {
    let captured: { url: string; init: RequestInit } | undefined;
    const ai = createJevEnemyAI({
      apiKey: 'sk-test',
      logger,
      fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
        captured = { url: String(url), init: init ?? {} };
        return decision('light', 0.84);
      }) as typeof fetch,
    });

    // 只有 1 点能量：大招与强攻都不该出现在选项里
    const view = actionViewFixture({ ap: 1 });
    assert.equal(await ai.chooseAction(view), 'light');
    const seen = captured as unknown as { url: string; init: RequestInit };
    assert.equal(seen.url, 'https://api.modelink.ai/v1/systemone');
    const headers = seen.init.headers as Record<string, string>;
    assert.equal(headers.Authorization, 'Bearer sk-test');
    const body = JSON.parse(String(seen.init.body));
    assert.equal(body.model, 'typesafe/jev-1.14');
    assert.equal(body.state.kind, 'action');
    assert.match(body.state.situation, /第 1 轮/);
    assert.equal(body.questions.move.type, 'choice');
    assert.deepEqual(Object.keys(body.questions.move.criteria).sort(), ['charge', 'light']);
  });

  it('应对阶段按 JEV 返回格挡', async () => {
    const ai = createJevEnemyAI({
      apiKey: 'sk-test',
      logger,
      fetchImpl: (async () => decision('guard', 0.9)) as typeof fetch,
    });
    assert.equal(await ai.chooseResponse(responseViewFixture({ ap: 3 })), 'guard');
  });

  it('非法选项、非 2xx、网络异常都回退本地决策', async () => {
    const cases: Array<() => typeof fetch> = [
      () => (async () => decision('dodge', 0.3)) as typeof fetch,
      () => (async () => decision('ult', 0.99)) as typeof fetch,
      () => (async () => jsonResponse({ error: 'bad' }, 500)) as typeof fetch,
      () =>
        (async () => {
          throw new Error('network down');
        }) as typeof fetch,
    ];
    for (const makeFetch of cases) {
      const ai = createJevEnemyAI({ apiKey: 'sk-test', logger, fetchImpl: makeFetch(), fallback });
      // 1 点能量下允许的只有 light/charge；ult 非法
      assert.equal(await ai.chooseAction(actionViewFixture({ ap: 1 })), 'charge');
    }
  });

  it('超时异常与普通网络异常一样回退本地决策', async () => {
    const ai = createJevEnemyAI({
      apiKey: 'sk-test',
      logger,
      timeoutMs: 10,
      fallback,
      fetchImpl: (async () => {
        throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
      }) as typeof fetch,
    });
    assert.equal(await ai.chooseAction(actionViewFixture({ ap: 3 })), 'charge');
    assert.equal(await ai.chooseResponse(responseViewFixture({ ap: 3 })), 'take');
  });

  it('本地决策模型本身也能处理合法局面（兜底不会卡住回合）', () => {
    assert.ok(['light', 'heavy', 'ult', 'charge'].includes(ENEMY_AI.chooseAction(actionViewFixture())));
    assert.ok(['guard', 'dodge', 'take'].includes(ENEMY_AI.chooseResponse(responseViewFixture())));
  });
});
