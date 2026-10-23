import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { applyRequestContext, battleKey, createDeviceContext } from '../src/mcp/context.js';

describe('设备上下文', () => {
  it('默认上下文没有身份，按匿名连接归属', () => {
    const ctx = createDeviceContext('conn-1');
    assert.deepEqual(ctx, { deviceId: '', agentId: '', sessionId: '', anonymousId: 'conn-1' });
    assert.equal(battleKey(ctx), 'anon:conn-1');
  });

  it('设备头优先，头为空时回退到查询参数', () => {
    const ctx = createDeviceContext('conn-2');
    applyRequestContext(ctx, { 'x-linx-device-id': 'dev-1', 'x-linx-agent-id': '   ' }, { agent: 'agent-q' });
    assert.equal(ctx.deviceId, 'dev-1');
    assert.equal(ctx.agentId, 'agent-q');
    assert.equal(battleKey(ctx), 'dev-1#agent-q');
  });

  it('重复的头取第一个，数字型查询参数转成字符串', () => {
    const ctx = createDeviceContext('conn-3');
    applyRequestContext(ctx, { 'x-linx-device-id': ['dev-2', 'dev-3'] }, {});
    assert.equal(ctx.deviceId, 'dev-2');

    applyRequestContext(ctx, {}, { device: 42, agent: 'a-1' });
    assert.equal(ctx.deviceId, '42');
    assert.equal(battleKey(ctx), '42#a-1');
  });

  it('没有设备头时按会话归属', () => {
    const ctx = createDeviceContext('conn-4');
    applyRequestContext(ctx, { 'x-linx-session-id': 's-1' });
    assert.equal(battleKey(ctx), 'session:s-1');

    applyRequestContext(ctx, {}, { session: 's-2' });
    assert.equal(battleKey(ctx), 'session:s-2');
  });

  it('设备存在但智能体缺失时用 default 兜底', () => {
    const ctx = createDeviceContext('conn-5');
    applyRequestContext(ctx, { 'x-linx-device-id': 'dev-4' });
    assert.equal(battleKey(ctx), 'dev-4#default');
  });
});
