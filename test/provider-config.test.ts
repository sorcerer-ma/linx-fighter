import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import { askDecision, askChat } from '../src/game/llm.js';

test('独立 provider 的地址、密钥与路径分别路由', async () => {
  const config = loadConfig({ DECISION_API_KEY: 'decision-test', CHAT_API_KEY: 'chat-test',
    DECISION_BASE_URL: 'https://decision.invalid/v1', CHAT_BASE_URL: 'https://chat.invalid/v2',
    DECISION_PATH: '/choose', CHAT_PATH: '/answer', API_KEY: 'legacy-test', BASE_URL: 'https://legacy.invalid' });
  const calls: unknown[] = [];
  const fetchImpl: typeof fetch = async (url, init) => {
    calls.push([url, (init?.headers as Record<string, string>).Authorization]);
    return new Response(JSON.stringify({ choices: [{ message: { content: '测试' } }] }));
  };
  await askDecision({ apiKey: config.decisionApiKey!, baseUrl: config.decisionBaseUrl,
    decisionPath: config.decisionPath, timeoutMs: 1000, fetchImpl }, { state: {}, questions: {} });
  await askChat({ apiKey: config.chatApiKey!, baseUrl: config.chatBaseUrl,
    chatPath: config.chatPath, timeoutMs: 1000, fetchImpl }, { messages: [] });
  assert.deepEqual(calls, [['https://decision.invalid/v1/choose', 'Bearer decision-test'],
    ['https://chat.invalid/v2/answer', 'Bearer chat-test']]);
});

test('各 provider 可单独启用，不借用另一方配置', () => {
  const decision = loadConfig({ DECISION_API_KEY: 'd', DECISION_BASE_URL: 'https://d.invalid' });
  assert.equal(decision.decisionApiKey, 'd');
  assert.equal(decision.chatApiKey, undefined);
  assert.equal(decision.chatBaseUrl, undefined);
  const chat = loadConfig({ CHAT_API_KEY: 'c', CHAT_BASE_URL: 'https://c.invalid' });
  assert.equal(chat.chatApiKey, 'c');
  assert.equal(chat.decisionApiKey, undefined);
  assert.equal(chat.decisionBaseUrl, undefined);
});

test('旧配置逐字段回退；空白专用值视为未配置', () => {
  const config = loadConfig({ API_KEY: ' old ', BASE_URL: ' https://old.invalid ',
    DECISION_API_KEY: ' ', CHAT_BASE_URL: ' ' });
  assert.equal(config.decisionApiKey, 'old');
  assert.equal(config.chatApiKey, 'old');
  assert.equal(config.decisionBaseUrl, 'https://old.invalid');
  assert.equal(config.chatBaseUrl, 'https://old.invalid');
});

test('显式 provider 地址不能回退共享密钥跨域使用', () => {
  const config = loadConfig({ API_KEY: 'legacy-test',
    DECISION_BASE_URL: 'https://decision.invalid', CHAT_BASE_URL: 'https://chat.invalid' });
  assert.equal(config.decisionApiKey, undefined);
  assert.equal(config.chatApiKey, undefined);
});

test('显式专用地址只阻止对应 provider 的共享密钥回退', () => {
  const chat = loadConfig({ API_KEY: 'legacy-test', CHAT_BASE_URL: 'https://chat.invalid' });
  assert.equal(chat.chatApiKey, undefined);
  assert.equal(chat.decisionApiKey, 'legacy-test');
  const decision = loadConfig({ API_KEY: 'legacy-test', DECISION_BASE_URL: 'https://decision.invalid' });
  assert.equal(decision.decisionApiKey, undefined);
  assert.equal(decision.chatApiKey, 'legacy-test');
});
