import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  askChat,
  askDecision,
  DEFAULT_BASE_URL,
  DEFAULT_CHAT_MODEL,
  DEFAULT_DECISION_MODEL,
  type ChatInput,
  type DecisionInput,
} from '../src/game/llm.js';

/** 记录一次 fetch 调用的 URL 与 init，供断言请求体、请求头 */
interface FetchCall {
  url: string;
  init: RequestInit;
}

/** 一个会记账的假 fetch：按调用顺序返回预置响应 */
function captureFetch(responses: Array<Response | (() => Promise<Response>)>): {
  calls: FetchCall[];
  fetchImpl: typeof fetch;
} {
  const calls: FetchCall[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = responses.shift();
    assert.ok(next !== undefined, '假 fetch 的响应已用完');
    return typeof next === 'function' ? next() : next;
  }) as typeof fetch;
  return { calls, fetchImpl };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** OpenAI 兼容的 chat 响应 */
function completion(content: unknown): Response {
  return jsonResponse({ choices: [{ message: { role: 'assistant', content } }] });
}

/** 收集 logger 调用，避免测试打出真实日志 */
function loggerSpy(): {
  logger: { warn: (message: string, fields?: Record<string, unknown>) => void; debug: (message: string, fields?: Record<string, unknown>) => void };
  warns: Array<{ message: string; fields?: Record<string, unknown> }>;
  debugs: Array<{ message: string; fields?: Record<string, unknown> }>;
} {
  const warns: Array<{ message: string; fields?: Record<string, unknown> }> = [];
  const debugs: Array<{ message: string; fields?: Record<string, unknown> }> = [];
  return {
    logger: {
      warn: (message, fields) => warns.push({ message, fields }),
      debug: (message, fields) => debugs.push({ message, fields }),
    },
    warns,
    debugs,
  };
}

function bodyOf(init: RequestInit): Record<string, unknown> {
  assert.equal(typeof init.body, 'string');
  return JSON.parse(init.body as string) as Record<string, unknown>;
}

const DECISION: DecisionInput = {
  state: { round: 1, ap: 3 },
  questions: {
    move: {
      type: 'choice',
      instructions: '选一个招式',
      criteria: { light: '普攻', heavy: '强攻' },
    },
  },
};

const CHAT: ChatInput = {
  messages: [{ role: 'user', content: '今天天气怎么样？' }],
};

describe('决策模型：askDecision', () => {
  it('默认走网关 /systemone，带鉴权头、默认模型与原样透传的局面', async () => {
    const payload = { answers: { move: { choice: 'heavy' } } };
    const { calls, fetchImpl } = captureFetch([jsonResponse(payload)]);
    const options = { apiKey: 'test-key', timeoutMs: 800, fetchImpl };

    assert.deepEqual(await askDecision(options, DECISION), payload);

    const call = calls[0];
    assert.ok(call, '应发出一次请求');
    const { url, init } = call;
    assert.equal(url, `${DEFAULT_BASE_URL}/systemone`);
    assert.equal(init.method, 'POST');
    const headers = init.headers as Record<string, string>;
    assert.equal(headers.Authorization, 'Bearer test-key');
    assert.equal(headers['Content-Type'], 'application/json');
    assert.ok(init.signal instanceof AbortSignal, '超时通过 AbortSignal 控制');
    assert.equal(init.signal.aborted, false);
    assert.deepEqual(bodyOf(init), {
      model: DEFAULT_DECISION_MODEL,
      state: DECISION.state,
      questions: DECISION.questions,
    });
  });

  it('覆盖模型、网关地址与决策路径', async () => {
    const { calls, fetchImpl } = captureFetch([jsonResponse({ answers: {} })]);
    const options = {
      apiKey: 'k',
      baseUrl: 'http://gateway.test/v9',
      decisionPath: '/custom/systemone',
      timeoutMs: 100,
      fetchImpl,
    };

    await askDecision(options, { ...DECISION, model: 'custom/decider' });

    const call = calls[0];
    assert.ok(call, '应发出一次请求');
    const { url, init } = call;
    assert.equal(url, 'http://gateway.test/v9/custom/systemone');
    assert.equal(bodyOf(init).model, 'custom/decider');
  });

  it('非 2xx 返回 null 并记录状态码', async () => {
    const spy = loggerSpy();
    const { fetchImpl } = captureFetch([jsonResponse({ error: 'boom' }, 503)]);
    const options = { apiKey: 'k', timeoutMs: 100, fetchImpl, logger: spy.logger };

    assert.equal(await askDecision(options, DECISION), null);

    assert.equal(spy.warns.length, 1);
    assert.equal(spy.warns[0]?.message, '模型返回异常状态');
    assert.deepEqual(spy.warns[0]?.fields, { path: '/systemone', status: 503 });
    assert.equal(spy.debugs.length, 0, '失败路径不记完成日志');
  });

  it('响应不是合法 JSON 时返回 null', async () => {
    const spy = loggerSpy();
    const { fetchImpl } = captureFetch([new Response('not json', { status: 200 })]);
    const options = { apiKey: 'k', timeoutMs: 100, fetchImpl, logger: spy.logger };

    assert.equal(await askDecision(options, DECISION), null);
    assert.equal(spy.warns[0]?.message, '模型调用失败');
    assert.equal(typeof spy.warns[0]?.fields?.error, 'string');
  });

  it('未注入 logger 时成功与失败都不抛错', async () => {
    const ok = captureFetch([jsonResponse({ answers: {} })]);
    assert.deepEqual(
      await askDecision({ apiKey: 'k', timeoutMs: 100, fetchImpl: ok.fetchImpl }, DECISION),
      { answers: {} },
    );

    const bad = captureFetch([jsonResponse({}, 500)]);
    assert.equal(
      await askDecision({ apiKey: 'k', timeoutMs: 100, fetchImpl: bad.fetchImpl }, DECISION),
      null,
    );
  });

  it('响应体为 null 或非对象时返回 null，usage 非对象时不记 token', async () => {
    const spy = loggerSpy();
    const nullBody = captureFetch([jsonResponse(null)]);
    assert.equal(
      await askDecision(
        { apiKey: 'k', timeoutMs: 100, fetchImpl: nullBody.fetchImpl, logger: spy.logger },
        DECISION,
      ),
      null,
    );

    const textBody = captureFetch([jsonResponse('plain text')]);
    assert.equal(
      await askDecision(
        { apiKey: 'k', timeoutMs: 100, fetchImpl: textBody.fetchImpl, logger: spy.logger },
        DECISION,
      ),
      'plain text',
    );

    const numberUsage = captureFetch([jsonResponse({ usage: 7 })]);
    await askDecision(
      { apiKey: 'k', timeoutMs: 100, fetchImpl: numberUsage.fetchImpl, logger: spy.logger },
      DECISION,
    );

    const noUsage = captureFetch([jsonResponse({ answers: {} })]);
    await askDecision(
      { apiKey: 'k', timeoutMs: 100, fetchImpl: noUsage.fetchImpl, logger: spy.logger },
      DECISION,
    );

    const nullUsage = captureFetch([jsonResponse({ usage: null })]);
    await askDecision(
      { apiKey: 'k', timeoutMs: 100, fetchImpl: nullUsage.fetchImpl, logger: spy.logger },
      DECISION,
    );

    const partialUsage = captureFetch([jsonResponse({ usage: { input_tokens: 'many', output_tokens: 4 } })]);
    await askDecision(
      { apiKey: 'k', timeoutMs: 100, fetchImpl: partialUsage.fetchImpl, logger: spy.logger },
      DECISION,
    );

    const debugFields = spy.debugs.map((entry) => entry.fields);
    assert.equal(debugFields.length, 6);
    // 前五次调用的 payload 或 usage 结构非法，只能记延迟，不记 token
    for (const fields of debugFields.slice(0, 5)) {
      assert.deepEqual(Object.keys(fields ?? {}).sort(), ['latencyMs', 'path']);
      assert.equal(fields?.path, '/systemone');
      assert.equal(typeof fields?.latencyMs, 'number');
    }
    // 最后一次只有 output_tokens 是数字
    assert.equal(typeof debugFields[5]?.latencyMs, 'number');
    assert.equal(debugFields[5]?.inputTokens, undefined);
    assert.equal(debugFields[5]?.outputTokens, 4);
  });

  it('记录合法 usage 的 token 数', async () => {
    const spy = loggerSpy();
    const { fetchImpl } = captureFetch([
      jsonResponse({ answers: {}, usage: { input_tokens: 12, output_tokens: 3 } }),
    ]);

    await askDecision(
      { apiKey: 'k', timeoutMs: 100, fetchImpl, logger: spy.logger },
      DECISION,
    );

    assert.equal(spy.warns.length, 0);
    assert.equal(spy.debugs.length, 1);
    assert.deepEqual(spy.debugs[0]?.fields, {
      path: '/systemone',
      latencyMs: spy.debugs[0]?.fields?.latencyMs,
      inputTokens: 12,
      outputTokens: 3,
    });
  });
});

describe('语言模型：askChat', () => {
  it('默认走网关 /chat/completions，默认模型且不带推理参数', async () => {
    const { calls, fetchImpl } = captureFetch([completion('今天多云。')]);
    const options = { apiKey: 'test-key', timeoutMs: 800, fetchImpl };

    assert.equal(await askChat(options, CHAT), '今天多云。');

    const call = calls[0];
    assert.ok(call, '应发出一次请求');
    const { url, init } = call;
    assert.equal(url, `${DEFAULT_BASE_URL}/chat/completions`);
    const body = bodyOf(init);
    assert.equal(body.model, DEFAULT_CHAT_MODEL);
    assert.deepEqual(body.messages, CHAT.messages);
    assert.equal('thinking' in body, false, '默认不写推理开关');
    assert.equal('reasoning_effort' in body, false);
  });

  it('reasoning=off 时关闭思考，reasoning=low 时降低推理强度', async () => {
    const off = captureFetch([completion('好。')]);
    await askChat(
      { apiKey: 'k', timeoutMs: 100, fetchImpl: off.fetchImpl },
      { ...CHAT, reasoning: 'off' },
    );
    const offBody = bodyOf(off.calls[0]?.init ?? {});
    assert.deepEqual(offBody.thinking, { type: 'disabled' });
    assert.equal('reasoning_effort' in offBody, false);

    const low = captureFetch([completion('好。')]);
    await askChat(
      { apiKey: 'k', timeoutMs: 100, fetchImpl: low.fetchImpl },
      { ...CHAT, reasoning: 'low' },
    );
    const lowBody = bodyOf(low.calls[0]?.init ?? {});
    assert.equal(lowBody.reasoning_effort, 'low');
    assert.equal('thinking' in lowBody, false);
  });

  it('带上温度、最大 token 数与覆盖后的模型、网关地址、路径', async () => {
    const { calls, fetchImpl } = captureFetch([completion('在。')]);
    const options = {
      apiKey: 'k',
      baseUrl: 'http://gateway.test/v9',
      chatPath: '/custom/chat',
      timeoutMs: 100,
      fetchImpl,
    };

    await askChat(options, {
      messages: [{ role: 'user', content: '你在吗' }],
      model: 'custom/chat-model',
      temperature: 0.2,
      maxTokens: 80,
    });

    const first = calls[0];
    assert.ok(first, '应发出一次请求');
    assert.equal(first.url, 'http://gateway.test/v9/custom/chat');
    assert.deepEqual(bodyOf(first.init), {
      model: 'custom/chat-model',
      messages: [{ role: 'user', content: '你在吗' }],
      temperature: 0.2,
      max_tokens: 80,
    });
  });

  it('非 2xx 与 fetch 抛错都返回 null 并写日志', async () => {
    const spy = loggerSpy();
    const failed = captureFetch([jsonResponse({}, 502)]);
    assert.equal(
      await askChat(
        { apiKey: 'k', timeoutMs: 100, fetchImpl: failed.fetchImpl, logger: spy.logger },
        CHAT,
      ),
      null,
    );
    assert.deepEqual(spy.warns[0]?.fields, { path: '/chat/completions', status: 502 });

    const thrown = captureFetch([
      () => Promise.reject(new Error('socket hang up')),
    ]);
    assert.equal(
      await askChat(
        { apiKey: 'k', timeoutMs: 100, fetchImpl: thrown.fetchImpl, logger: spy.logger },
        CHAT,
      ),
      null,
    );
    assert.equal(spy.warns[1]?.message, '模型调用失败');
    assert.deepEqual(spy.warns[1]?.fields, { path: '/chat/completions', error: 'socket hang up' });

    const nonError = captureFetch([() => Promise.reject('plain failure')]);
    assert.equal(
      await askChat(
        { apiKey: 'k', timeoutMs: 100, fetchImpl: nonError.fetchImpl, logger: spy.logger },
        CHAT,
      ),
      null,
    );
    assert.deepEqual(spy.warns[2]?.fields, { path: '/chat/completions', error: 'plain failure' });
  });

  it('超时中断（AbortSignal）返回 null', async () => {
    const spy = loggerSpy();
    // 自己持有 ref 定时器：AbortSignal.timeout 的定时器是 unref 的，
    // 事件循环空转时测试进程会先退出。abort 未按时触发时也会失败而不是挂住。
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const fallback = setTimeout(
          () => reject(new DOMException('timeout fallback', 'AbortError')),
          200,
        );
        init?.signal?.addEventListener('abort', () => {
          clearTimeout(fallback);
          reject(new DOMException('The operation was aborted.', 'AbortError'));
        });
      })) as typeof fetch;

    assert.equal(
      await askChat({ apiKey: 'k', timeoutMs: 10, fetchImpl, logger: spy.logger }, CHAT),
      null,
    );
    assert.equal(spy.warns[0]?.message, '模型调用失败');
    assert.equal(spy.warns[0]?.fields?.error, 'The operation was aborted.');
  });

  it('fetch 直接抛 AbortError 时返回 null', async () => {
    const { fetchImpl } = captureFetch([
      () => Promise.reject(new DOMException('This operation was aborted', 'AbortError')),
    ]);
    assert.equal(await askChat({ apiKey: 'k', timeoutMs: 100, fetchImpl }, CHAT), null);
  });

  it('未注入 fetchImpl 时使用全局 fetch', async () => {
    const original = globalThis.fetch;
    const calls: string[] = [];
    globalThis.fetch = (async (url: string | URL | Request) => {
      calls.push(String(url));
      return completion('用全局 fetch。');
    }) as typeof fetch;
    try {
      assert.equal(
        await askChat({ apiKey: 'k', timeoutMs: 500 }, CHAT),
        '用全局 fetch。',
      );
      assert.deepEqual(calls, [`${DEFAULT_BASE_URL}/chat/completions`]);
    } finally {
      globalThis.fetch = original;
    }
  });

  it('响应结构非法时返回 null', async () => {
    const cases: unknown[] = [
      null,
      'plain text',
      {},
      { choices: 'nope' },
      { choices: [] },
      { choices: [null] },
      { choices: [{}] },
      { choices: [{ message: {} }] },
      { choices: [{ message: { content: 42 } }] },
      { choices: [{ message: { content: '   ' } }] },
    ];

    for (const payload of cases) {
      const { calls, fetchImpl } = captureFetch([jsonResponse(payload)]);
      assert.equal(
        await askChat({ apiKey: 'k', timeoutMs: 100, fetchImpl }, CHAT),
        null,
        `payload ${JSON.stringify(payload)} 应返回 null`,
      );
      assert.equal(calls.length, 1);
    }
  });

  it('内容前后空白时原样返回（清洗交给 chat.ts）', async () => {
    const { fetchImpl } = captureFetch([completion('  今天多云。  ')]);
    assert.equal(await askChat({ apiKey: 'k', timeoutMs: 100, fetchImpl }, CHAT), '  今天多云。  ');
  });
});
