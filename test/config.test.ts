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
      openrouterApiKey: undefined,
      openrouterModel: 'google/gemma-4-26b-a4b-it',
      intentTimeoutMs: 1500,
    });
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

  it('意图模型配置：Key 去空白、模型可覆盖、超时钳制', () => {
    assert.equal(loadConfig({ OPENROUTER_API_KEY: '  sk-test  ' }).openrouterApiKey, 'sk-test');
    assert.equal(loadConfig({ OPENROUTER_API_KEY: '   ' }).openrouterApiKey, undefined);
    assert.equal(loadConfig({}).openrouterApiKey, undefined);
    assert.equal(loadConfig({ OPENROUTER_MODEL: ' google/gemma-4-26b-a4b-it ' }).openrouterModel, 'google/gemma-4-26b-a4b-it');
    assert.equal(loadConfig({ INTENT_TIMEOUT_MS: '50' }).intentTimeoutMs, 200);
    assert.equal(loadConfig({ INTENT_TIMEOUT_MS: '9000' }).intentTimeoutMs, 5000);
    assert.equal(loadConfig({ INTENT_TIMEOUT_MS: 'oops' }).intentTimeoutMs, 1500);
  });

  it('监听地址可覆盖且去空白', () => {
    assert.equal(loadConfig({ HOST: ' 127.0.0.1 ' }).host, '127.0.0.1');
    assert.equal(loadConfig({ HOST: '   ' }).host, '0.0.0.0');
  });
});
