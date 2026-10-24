import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { loadConfig } from '../src/config.js';

describe('配置解析', () => {
  it('全部使用默认值', () => {
    assert.deepEqual(loadConfig({}), {
      port: 8000,
      host: '0.0.0.0',
      logLevel: 'info',
      battleTtlMs: 1_800_000,
      enableDebugEndpoints: true,
      apiKey: undefined,
      baseUrl: undefined,
      decisionPath: undefined,
      chatPath: undefined,
      chatReasoning: 'off',
      decisionModel: 'typesafe/jev-1.14',
      chatModel: 'deepseek/deepseek-v4-flash',
      routerTimeoutMs: 2000,
      chatTimeoutMs: 6000,
      enemyAi: 'jev',
      enemyTimeoutMs: 2000,
      attribution: 'off',
      adminToken: undefined,
    });
  });

  it('座位归属只认 strict，其余一律 off', () => {
    assert.equal(loadConfig({ ATTRIBUTION_MODE: 'strict' }).attribution, 'strict');
    assert.equal(loadConfig({ ATTRIBUTION_MODE: ' STRICT ' }).attribution, 'strict');
    assert.equal(loadConfig({ ATTRIBUTION_MODE: 'on' }).attribution, 'off');
    assert.equal(loadConfig({ ATTRIBUTION_MODE: '' }).attribution, 'off');
  });

  it('监控页口令去空白，空串等于公开', () => {
    assert.equal(loadConfig({ ADMIN_TOKEN: '  s3cret ' }).adminToken, 's3cret');
    assert.equal(loadConfig({ ADMIN_TOKEN: '   ' }).adminToken, undefined);
  });

  it('端口钳制在合法范围，非法值回退默认端口', () => {
    assert.equal(loadConfig({ PORT: '70000' }).port, 65535);
    assert.equal(loadConfig({ PORT: '0' }).port, 1);
    assert.equal(loadConfig({ PORT: 'abc' }).port, 8000);
    assert.equal(loadConfig({ PORT: '   ' }).port, 8000);
    assert.equal(loadConfig({ PORT: '3000' }).port, 3000);
  });

  it('日志级别只接受已知值', () => {
    assert.equal(loadConfig({ LOG_LEVEL: ' DEBUG ' }).logLevel, 'debug');
    assert.equal(loadConfig({ LOG_LEVEL: 'warn' }).logLevel, 'warn');
    assert.equal(loadConfig({ LOG_LEVEL: 'verbose' }).logLevel, 'info');
  });

  it('对局空闲时间最少 60 秒', () => {
    assert.equal(loadConfig({ BATTLE_TTL_SECONDS: '10' }).battleTtlMs, 60_000);
    assert.equal(loadConfig({ BATTLE_TTL_SECONDS: '900' }).battleTtlMs, 900_000);
    assert.equal(loadConfig({ BATTLE_TTL_SECONDS: 'oops' }).battleTtlMs, 1_800_000);
  });

  it('调试端点跟随环境，显式开关优先', () => {
    assert.equal(loadConfig({}).enableDebugEndpoints, true);
    assert.equal(loadConfig({ NODE_ENV: 'production' }).enableDebugEndpoints, false);
    assert.equal(loadConfig({ NODE_ENV: 'production', ENABLE_DEBUG_ENDPOINTS: 'YES' }).enableDebugEndpoints, true);
    assert.equal(loadConfig({ ENABLE_DEBUG_ENDPOINTS: 'off' }).enableDebugEndpoints, false);
    assert.equal(loadConfig({ ENABLE_DEBUG_ENDPOINTS: ' ' }).enableDebugEndpoints, true);
  });

  it('模型配置：Key 去空白、模型与地址可覆盖、超时钳制', () => {
    assert.equal(loadConfig({ API_KEY: '  test-key  ' }).apiKey, 'test-key');
    assert.equal(loadConfig({ API_KEY: '   ' }).apiKey, undefined);
    assert.equal(loadConfig({}).apiKey, undefined);
    assert.equal(loadConfig({ BASE_URL: ' http://127.0.0.1:9999/v1 ' }).baseUrl, 'http://127.0.0.1:9999/v1');
    assert.equal(loadConfig({}).baseUrl, undefined);
    assert.equal(
      loadConfig({ DECISION_PATH: ' /custom/decisions ' }).decisionPath,
      '/custom/decisions',
    );
    assert.equal(loadConfig({}).decisionPath, undefined);
    assert.equal(loadConfig({ CHAT_PATH: '/custom/chat' }).chatPath, '/custom/chat');
    assert.equal(loadConfig({}).chatPath, undefined);
    assert.equal(loadConfig({ CHAT_REASONING: ' OFF ' }).chatReasoning, 'off');
    assert.equal(loadConfig({ CHAT_REASONING: 'low' }).chatReasoning, 'low');
    assert.equal(loadConfig({ CHAT_REASONING: 'high' }).chatReasoning, 'off');
    assert.equal(loadConfig({}).chatReasoning, 'off');
    assert.equal(loadConfig({ DECISION_MODEL: ' typesafe/jev-1.15 ' }).decisionModel, 'typesafe/jev-1.15');
    assert.equal(loadConfig({}).decisionModel, 'typesafe/jev-1.14');
    assert.equal(loadConfig({ CHAT_MODEL: ' deepseek/deepseek-v4.1-flash ' }).chatModel, 'deepseek/deepseek-v4.1-flash');
    assert.equal(loadConfig({}).chatModel, 'deepseek/deepseek-v4-flash');
    assert.equal(loadConfig({ ROUTER_TIMEOUT_MS: '50' }).routerTimeoutMs, 200);
    assert.equal(loadConfig({ ROUTER_TIMEOUT_MS: '9000' }).routerTimeoutMs, 5000);
    assert.equal(loadConfig({ ROUTER_TIMEOUT_MS: 'oops' }).routerTimeoutMs, 2000);
    assert.equal(loadConfig({ CHAT_TIMEOUT_MS: '100' }).chatTimeoutMs, 500);
    assert.equal(loadConfig({ CHAT_TIMEOUT_MS: '99999' }).chatTimeoutMs, 8000);
    assert.equal(loadConfig({ CHAT_TIMEOUT_MS: 'oops' }).chatTimeoutMs, 6000);
  });

  it('对手决策配置：开关归一化、超时钳制', () => {
    assert.equal(loadConfig({ ENEMY_AI: 'local' }).enemyAi, 'local');
    assert.equal(loadConfig({ ENEMY_AI: ' LOCAL ' }).enemyAi, 'local');
    assert.equal(loadConfig({ ENEMY_AI: 'jev' }).enemyAi, 'jev');
    assert.equal(loadConfig({ ENEMY_AI: 'gpt' }).enemyAi, 'jev');
    assert.equal(loadConfig({ ENEMY_TIMEOUT_MS: '50' }).enemyTimeoutMs, 200);
    assert.equal(loadConfig({ ENEMY_TIMEOUT_MS: '99999' }).enemyTimeoutMs, 5000);
    assert.equal(loadConfig({ ENEMY_TIMEOUT_MS: 'oops' }).enemyTimeoutMs, 2000);
  });

  it('监听地址可覆盖且去空白', () => {
    assert.equal(loadConfig({ HOST: ' 127.0.0.1 ' }).host, '127.0.0.1');
    assert.equal(loadConfig({ HOST: '   ' }).host, '0.0.0.0');
  });
});
