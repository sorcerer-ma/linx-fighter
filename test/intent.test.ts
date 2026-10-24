import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { actionOfStage, createIntentResolver, parseIntentDecision } from '../src/game/intent.js';

const logger = { warn: () => {}, debug: () => {} };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** 构造一条 JEV decisions 返回 */
function decision(choice: string, confidence?: number, probabilities?: Record<string, number>): Response {
  return jsonResponse({
    answers: { move: { type: 'choice', choice, confidence, probabilities } },
    usage: { input_tokens: 420, output_tokens: 45, cost: 0.0000234 },
  });
}

describe('JEV 意图模型', () => {
  it('解析合法返回：阶段内的招式且置信度足够', () => {
    assert.equal(parseIntentDecision({ answers: { move: { choice: 'light', confidence: 0.9 } } }, 'active'), 'light');
    assert.equal(parseIntentDecision({ answers: { move: { choice: 'guard', confidence: 0.8 } } }, 'response'), 'guard');
    assert.equal(parseIntentDecision({ answers: { move: { choice: 'take', confidence: 0.6 } } }, 'response'), 'take');
  });

  it('顶层缺少 confidence 时退回该选项的概率', () => {
    assert.equal(
      parseIntentDecision({ answers: { move: { choice: 'ult', probabilities: { ult: 0.87, heavy: 0.13 } } } }, 'active'),
      'ult',
    );
    // 概率也不足时按没认出来处理
    assert.equal(
      parseIntentDecision({ answers: { move: { choice: 'charge', probabilities: { charge: 0.4 } } } }, 'active'),
      null,
    );
    // 概率字段不是对象时无法评估置信度
    assert.equal(parseIntentDecision({ answers: { move: { choice: 'light', probabilities: 1 } } }, 'active'), null);
  });

  it('置信度不足、none、跨阶段、非法结构都按没认出来处理', () => {
    assert.equal(parseIntentDecision({ answers: { move: { choice: 'heavy', confidence: 0.59 } } }, 'active'), null);
    assert.equal(parseIntentDecision({ answers: { move: { choice: 'none', confidence: 0.99 } } }, 'active'), null);
    assert.equal(parseIntentDecision({ answers: { move: { choice: 'guard', confidence: 0.99 } } }, 'active'), null);
    assert.equal(parseIntentDecision({ answers: { move: { choice: 'dance', confidence: 0.99 } } }, 'active'), null);
    assert.equal(parseIntentDecision({ answers: { move: { choice: 'dodge', confidence: 0.99 } } }, 'active'), null);
    assert.equal(parseIntentDecision({}, 'active'), null);
    assert.equal(parseIntentDecision(null, 'active'), null);
    assert.equal(parseIntentDecision('not json', 'active'), null);
    assert.equal(parseIntentDecision({ answers: { move: { choice: 'light' } } }, 'active'), null);
  });

  it('按阶段区分合法招式', () => {
    assert.equal(actionOfStage('active', 'ult'), true);
    assert.equal(actionOfStage('active', 'dodge'), false);
    assert.equal(actionOfStage('response', 'dodge'), true);
    assert.equal(actionOfStage('response', 'charge'), false);
  });

  it('调用 JEV decisions 接口：端点、模型、选项与状态都正确', async () => {
    let captured: { url: string; init: RequestInit } | undefined;
    const resolver = createIntentResolver({
      apiKey: 'sk-test',
      fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
        captured = { url: String(url), init: init ?? {} };
        return decision('heavy', 0.93, { heavy: 0.93, light: 0.07 });
      }) as typeof fetch,
      logger,
    });

    assert.equal(await resolver.resolve('给我狠狠地来一下', 'active'), 'heavy');
    const seen = captured as unknown as { url: string; init: RequestInit };
    assert.equal(seen.url, 'https://openrouter.ai/api/alpha/decisions');
    const headers = seen.init.headers as Record<string, string>;
    assert.equal(headers.Authorization, 'Bearer sk-test');
    const body = JSON.parse(String(seen.init.body));
    assert.equal(body.model, 'typesafe/jev-1.13');
    assert.equal(body.state.utterance, '给我狠狠地来一下');
    assert.equal(body.questions.move.type, 'choice');
    assert.deepEqual(Object.keys(body.questions.move.criteria).sort(), ['charge', 'heavy', 'light', 'none', 'ult']);
    assert.equal(typeof body.questions.move.criteria.none, 'string');
  });

  it('应对阶段的选项只含格挡/闪避/承受', async () => {
    let body: { questions?: { move?: { criteria?: Record<string, string> } } } = {};
    const resolver = createIntentResolver({
      apiKey: 'sk-test',
      fetchImpl: (async (_url: string, init: RequestInit) => {
        body = JSON.parse(String(init.body));
        return decision('dodge', 0.88);
      }) as typeof fetch,
    });
    assert.equal(await resolver.resolve('躲开', 'response'), 'dodge');
    assert.deepEqual(Object.keys(body.questions?.move?.criteria ?? {}).sort(), ['dodge', 'guard', 'none', 'take']);
  });

  it('非 200、网络异常、缺少 answers、低置信度、跨阶段都回退为 null', async () => {
    const resolverWith = (impl: typeof fetch) => createIntentResolver({ apiKey: 'sk-test', fetchImpl: impl, logger });

    assert.equal(await resolverWith((async () => jsonResponse({}, 500)) as typeof fetch).resolve('打', 'active'), null);
    assert.equal(
      await resolverWith(
        (async () => {
          throw new Error('timeout');
        }) as typeof fetch,
      ).resolve('打', 'active'),
      null,
    );
    assert.equal(await resolverWith((async () => jsonResponse({ answers: {} })) as typeof fetch).resolve('打', 'active'), null);
    assert.equal(await resolverWith((async () => decision('none', 0.99)) as typeof fetch).resolve('打', 'active'), null);
    assert.equal(await resolverWith((async () => decision('light', 0.2)) as typeof fetch).resolve('打', 'active'), null);
    assert.equal(await resolverWith((async () => decision('guard', 0.9)) as typeof fetch).resolve('打', 'active'), null);
  });

  it('可以覆盖模型名', async () => {
    let body: { model?: string } = {};
    const resolver = createIntentResolver({
      apiKey: 'sk-test',
      model: 'typesafe/jev-1.13-20260917',
      timeoutMs: 900,
      fetchImpl: (async (_url: string, init: RequestInit) => {
        body = JSON.parse(String(init.body));
        return decision('charge', 0.8);
      }) as typeof fetch,
    });
    assert.equal(await resolver.resolve('凝聚力量', 'active'), 'charge');
    assert.equal(body.model, 'typesafe/jev-1.13-20260917');
  });
});
