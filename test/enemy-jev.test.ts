import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ENEMY_AI } from '../src/game/enemy.js';
import {
  activeQuestion,
  createJevEnemyAI,
  legalActiveActions,
  legalResponses,
  parseEnemyDecision,
  responseQuestion,
} from '../src/game/enemy-jev.js';
import type { ActionView, BattleAI, ResponseView } from '../src/game/types.js';

const logger = { warn: () => {}, debug: () => {} };

/** 主动阶段视角：默认对手（enemy 侧）满血、3 真气、1 次大招；玩家 14 血 */
function actionViewFixture(
  overrides: Partial<{ round: number; bonus: number; hp: number; ap: number; ultLeft: number; enemyHp: number }> = {},
): ActionView {
  return {
    round: overrides.round ?? 1,
    bonus: overrides.bonus ?? 0,
    self: { hp: overrides.hp ?? 18, ap: overrides.ap ?? 3, ultLeft: overrides.ultLeft ?? 1 },
    enemy: { hp: overrides.enemyHp ?? 14, ap: 3, ultLeft: 1 },
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
  it('主动阶段先按行动点过滤合法招式', () => {
    assert.deepEqual(legalActiveActions(actionViewFixture({ ap: 0 })), ['charge']);
    assert.deepEqual(legalActiveActions(actionViewFixture({ ap: 1 })), ['light', 'charge']);
    assert.deepEqual(legalActiveActions(actionViewFixture({ ap: 3 })), ['light', 'heavy', 'charge']);
    assert.deepEqual(legalActiveActions(actionViewFixture({ ap: 4 })), ['light', 'heavy', 'ult', 'charge']);
    assert.deepEqual(legalActiveActions(actionViewFixture({ ap: 4, ultLeft: 0 })), ['light', 'heavy', 'charge']);
    assert.deepEqual(legalActiveActions(actionViewFixture({ ap: 5 })), ['light', 'heavy', 'ult']);
  });

  it('应对阶段没有真气时只能承受', () => {
    assert.deepEqual(legalResponses(responseViewFixture({ ap: 0 })), ['take']);
    assert.deepEqual(legalResponses(responseViewFixture({ ap: 1 })), ['guard', 'dodge', 'take']);
  });

  it('主动题干带上轮次、加成、双方数值与选项说明', () => {
    const view = actionViewFixture({ round: 3, bonus: 2, hp: 12, ap: 4, ultLeft: 1 });
    const { state, question } = activeQuestion(view);
    assert.match(state, /第 3 轮/);
    assert.match(state, /伤害加成 \+2/);
    assert.match(state, /气血 12/);
    assert.match(state, /大招剩 1 次/);
    assert.match(question.criteria.ult!, /造成 11 点伤害/);
    assert.match(question.criteria.charge!, /真气 \+1/);
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

  it('解析返回：只在合法选项内、置信度足够才生效', () => {
    assert.equal(parseEnemyDecision(decisionPayload('heavy', 0.8), ['light', 'heavy']), 'heavy');
    assert.equal(parseEnemyDecision(decisionPayload('ult', 0.99), ['light', 'heavy']), null);
    assert.equal(parseEnemyDecision(decisionPayload('light', 0.59), ['light', 'heavy']), null);
    assert.equal(parseEnemyDecision(decisionPayload('light'), ['light']), null);
    assert.equal(parseEnemyDecision({ answers: { move: { choice: 'light', probabilities: { light: 0.7 } } } }, ['light']), 'light');
    assert.equal(parseEnemyDecision({ answers: { move: { choice: 'light', probabilities: 1 } } }, ['light']), null);
    assert.equal(parseEnemyDecision(null, ['light']), null);
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
      model: 'typesafe/jev-1.13',
      logger,
      fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
        captured = { url: String(url), init: init ?? {} };
        return decision('light', 0.84);
      }) as typeof fetch,
    });

    // 只有 1 点真气：大招与强攻都不该出现在选项里
    const view = actionViewFixture({ ap: 1 });
    assert.equal(await ai.chooseAction(view), 'light');
    const seen = captured as unknown as { url: string; init: RequestInit };
    assert.equal(seen.url, 'https://openrouter.ai/api/alpha/decisions');
    const headers = seen.init.headers as Record<string, string>;
    assert.equal(headers.Authorization, 'Bearer sk-test');
    const body = JSON.parse(String(seen.init.body));
    assert.equal(body.model, 'typesafe/jev-1.13');
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

  it('低置信度、非法选项、非 2xx、网络异常都回退本地决策', async () => {
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
      // 1 点真气下允许的只有 light/charge；ult 非法
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
