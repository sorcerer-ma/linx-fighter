import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createChatAnswerer, sanitizeChatAnswer } from '../src/game/chat.js';

const logger = { warn: () => {}, debug: () => {} };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function completion(content: string): Response {
  return jsonResponse({ choices: [{ message: { role: 'assistant', content } }], usage: { input_tokens: 120, output_tokens: 18 } });
}

describe('规则外问答：输出清洗', () => {
  it('保留一到两句，补齐句末标点', () => {
    assert.equal(sanitizeChatAnswer('今天多云，傍晚有雨'), '今天多云，傍晚有雨。');
    assert.equal(sanitizeChatAnswer('今天多云。傍晚有雨。'), '今天多云。傍晚有雨。');
  });

  it('最多留两句，多说的截掉', () => {
    assert.equal(sanitizeChatAnswer('第一句。第二句。第三句。'), '第一句。第二句。');
  });

  it('去掉 Markdown、引号与「回答：」前缀', () => {
    assert.equal(sanitizeChatAnswer('**回答：**「今天很热」'), '今天很热。');
    assert.equal(sanitizeChatAnswer('```\n冷知识\n```\n今天很热。'), '今天很热。');
  });

  it('超长截到 60 字以内，不留下半截标点', () => {
    const text = sanitizeChatAnswer(`${'很长的回答'.repeat(20)}。`);
    assert.ok(text !== null);
    assert.ok(text.length <= 60, `实际 ${text.length} 字`);
    assert.match(text, /。$/);
  });

  it('空内容与非法类型都返回 null', () => {
    assert.equal(sanitizeChatAnswer('   '), null);
    assert.equal(sanitizeChatAnswer(null), null);
    assert.equal(sanitizeChatAnswer(42), null);
    assert.equal(sanitizeChatAnswer('```\n```'), null);
  });
});

describe('规则外问答：调用语言模型', () => {
  it('按系统提示与用户原话请求 chat/completions', async () => {
    let captured: { url: string; init: RequestInit } | undefined;
    const answerer = createChatAnswerer({
      apiKey: 'test-key',
      fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
        captured = { url: String(url), init: init ?? {} };
        return completion('今天多云。');
      }) as typeof fetch,
      logger,
    });

    assert.equal(await answerer.answer('  今天天气怎么样？  '), '今天多云。');
    const seen = captured as unknown as { url: string; init: RequestInit };
    assert.equal(seen.url, 'https://api.modelink.ai/v1/chat/completions');
    const headers = seen.init.headers as Record<string, string>;
    assert.equal(headers.Authorization, 'Bearer test-key');
    const body = JSON.parse(String(seen.init.body));
    assert.equal(body.model, 'deepseek/deepseek-v4-flash');
    assert.deepEqual(body.thinking, { type: 'disabled' });
    assert.equal(body.messages[0].role, 'system');
    assert.match(body.messages[0].content, /第一人称/);
    assert.match(body.messages[0].content, /不能编造|绝不能编造|不许/);
    assert.equal(body.messages[1].role, 'user');
    assert.equal(body.messages[1].content, '今天天气怎么样？');
    assert.equal(typeof body.temperature, 'number');
    assert.equal(typeof body.max_tokens, 'number');
  });

  it('可以覆盖模型与根地址', async () => {
    let url = '';
    let model = '';
    const answerer = createChatAnswerer({
      apiKey: 'test-key',
      baseUrl: 'http://127.0.0.1:9999/provider/v1',
      model: 'deepseek/deepseek-v4.1-flash',
      fetchImpl: (async (seen: string, init: RequestInit) => {
        url = String(seen);
        model = JSON.parse(String(init.body)).model;
        return completion('好。');
      }) as typeof fetch,
    });

    assert.equal(await answerer.answer('在吗'), '好。');
    assert.equal(url, 'http://127.0.0.1:9999/provider/v1/chat/completions');
    assert.equal(model, 'deepseek/deepseek-v4.1-flash');
  });

  it('可以单独覆盖语言模型路径', async () => {
    let url = '';
    const answerer = createChatAnswerer({
      apiKey: 'test-key',
      baseUrl: 'https://gateway.test/api',
      chatPath: '/v1/chat/completions',
      fetchImpl: (async (seen: string) => {
        url = String(seen);
        return completion('不错。');
      }) as typeof fetch,
    });

    assert.equal(await answerer.answer('在吗'), '不错。');
    assert.equal(url, 'https://gateway.test/api/v1/chat/completions');
  });

  it('推理模型可以关掉思考，避免只回思考不回正文', async () => {
    let body = '';
    const answerer = createChatAnswerer({
      apiKey: 'test-key',
      baseUrl: 'https://gateway.test/api',
      chatPath: '/v1/chat/completions',
      reasoning: 'off',
      fetchImpl: (async (_seen: string, init: RequestInit) => {
        body = String(init.body);
        return completion('好。');
      }) as typeof fetch,
    });

    assert.equal(await answerer.answer('在吗'), '好。');
    assert.deepEqual(JSON.parse(body).thinking, { type: 'disabled' });
  });

  it('低推理档发送 reasoning_effort', async () => {
    let body = '';
    const answerer = createChatAnswerer({
      apiKey: 'test-key',
      reasoning: 'low',
      fetchImpl: (async (_seen: string, init: RequestInit) => {
        body = String(init.body);
        return completion('好。');
      }) as typeof fetch,
    });

    assert.equal(await answerer.answer('在吗'), '好。');
    assert.equal(JSON.parse(body).reasoning_effort, 'low');
    assert.equal(JSON.parse(body).thinking, undefined);
  });

  it('非 2xx、网络异常、空 choices 都返回 null', async () => {
    const answerWith = (impl: typeof fetch) => createChatAnswerer({ apiKey: 'test-key', fetchImpl: impl, logger });

    assert.equal(await answerWith((async () => jsonResponse({}, 500)) as typeof fetch).answer('在吗'), null);
    assert.equal(await answerWith((async () => jsonResponse({ choices: [] })) as typeof fetch).answer('在吗'), null);
    assert.equal(await answerWith((async () => completion('   ')) as typeof fetch).answer('在吗'), null);
    assert.equal(
      await answerWith(
        (async () => {
          throw new Error('timeout');
        }) as typeof fetch,
      ).answer('在吗'),
      null,
    );
  });
});
