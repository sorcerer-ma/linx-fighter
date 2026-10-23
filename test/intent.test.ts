import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { actionOfStage, createIntentResolver, parseIntentContent } from '../src/game/intent.js';

const logger = { warn: () => {} };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function chat(content: string): Response {
  return jsonResponse({ choices: [{ message: { content } }] });
}

describe('意图模型', () => {
  it('解析合法输出：阶段内的招式且置信度足够', () => {
    assert.equal(parseIntentContent('{"action":"light","confidence":0.9}', 'active'), 'light');
    assert.equal(parseIntentContent('{"action":"guard","confidence":0.8}', 'response'), 'guard');
    assert.equal(parseIntentContent('{"action":"take","confidence":0.7}', 'response'), 'take');
  });

  it('置信度不足、unknown、跨阶段、非法内容都按没认出来处理', () => {
    assert.equal(parseIntentContent('{"action":"heavy","confidence":0.69}', 'active'), null);
    assert.equal(parseIntentContent('{"action":"unknown","confidence":0.99}', 'active'), null);
    assert.equal(parseIntentContent('{"action":"guard","confidence":0.99}', 'active'), null);
    assert.equal(parseIntentContent('{"action":"dance","confidence":0.99}', 'active'), null);
    assert.equal(parseIntentContent('not json', 'active'), null);
    assert.equal(parseIntentContent('null', 'active'), null);
    assert.equal(parseIntentContent('{"action":"light","confidence":"0.9"}', 'active'), null);
    assert.equal(parseIntentContent('{"action":1,"confidence":0.9}', 'active'), null);
  });

  it('按阶段区分合法招式', () => {
    assert.equal(actionOfStage('active', 'ult'), true);
    assert.equal(actionOfStage('active', 'dodge'), false);
    assert.equal(actionOfStage('response', 'dodge'), true);
    assert.equal(actionOfStage('response', 'charge'), false);
  });

  it('调用 OpenRouter：模型、JSON Schema、Authorization 都正确', async () => {
    let captured: { url: string; init: RequestInit } | undefined;
    const resolver = createIntentResolver({
      apiKey: 'sk-test',
      fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
        captured = { url: String(url), init: init ?? {} };
        return chat('{"action":"heavy","confidence":0.93}');
      }) as typeof fetch,
      logger,
    });

    assert.equal(await resolver.resolve('给我狠狠地来一下', 'active'), 'heavy');
    const seen = captured as unknown as { url: string; init: RequestInit };
    assert.equal(seen.url, 'https://openrouter.ai/api/v1/chat/completions');
    const headers = seen.init.headers as Record<string, string>;
    assert.equal(headers.Authorization, 'Bearer sk-test');
    const body = JSON.parse(String(seen.init.body));
    assert.equal(body.model, 'google/gemma-4-26b-a4b-it');
    assert.equal(body.response_format.json_schema.strict, true);
    assert.deepEqual(body.response_format.json_schema.schema.properties.action.enum, [
      'light',
      'heavy',
      'ult',
      'charge',
      'unknown',
    ]);
  });

  it('非 200、网络异常、缺少 content、低置信度都回退为 null', async () => {
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
    assert.equal(await resolverWith((async () => jsonResponse({ choices: [{}] })) as typeof fetch).resolve('打', 'active'), null);
    assert.equal(
      await resolverWith((async () => chat('{"action":"dodge","confidence":0.2}')) as typeof fetch).resolve('躲', 'response'),
      null,
    );
    assert.equal(
      await resolverWith((async () => chat('{"action":"light","confidence":0.95}')) as typeof fetch).resolve('躲', 'response'),
      null,
    );
  });

  it('可以覆盖模型名与超时时间', async () => {
    let body: { model?: string } = {};
    const resolver = createIntentResolver({
      apiKey: 'sk-test',
      model: 'google/gemma-4-26b-a4b-it',
      timeoutMs: 900,
      fetchImpl: (async (_url: string, init: RequestInit) => {
        body = JSON.parse(String(init.body));
        return chat('{"action":"charge","confidence":0.8}');
      }) as typeof fetch,
    });
    assert.equal(await resolver.resolve('凝聚力量', 'active'), 'charge');
    assert.equal(body.model, 'google/gemma-4-26b-a4b-it');
  });
});
