import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { applyRequestContext, battleKey, createDeviceContext, identityHeaders } from '../src/mcp/context.js';

describe('设备上下文', () => {
  it('默认上下文没有身份，按匿名连接归属', () => {
    const ctx = createDeviceContext('conn-1');
    assert.deepEqual(ctx, {
      deviceId: '',
      agentId: '',
      sessionId: '',
      display: 'voice',
      speakerName: '',
      speakerId: '',
      anonymousId: 'conn-1',
    });
    assert.equal(battleKey(ctx), 'anon:conn-1');
  });

  it('说话人头只进上下文，不影响对局归属', () => {
    const ctx = createDeviceContext('conn-9');
    applyRequestContext(
      ctx,
      {
        'x-linx-device-id': 'dev-9',
        'x-linx-speaker-name': ' 小林 ',
        'x-linx-speaker-id': 'spk_123',
      },
      {},
    );
    assert.equal(ctx.speakerName, '小林');
    assert.equal(ctx.speakerId, 'spk_123');
    assert.equal(battleKey(ctx), 'dev-9#default');
  });

  it('这一轮没带说话人就清空，避免把上一位说话人算到别人头上', () => {
    const ctx = createDeviceContext('conn-10');
    applyRequestContext(ctx, { 'x-linx-speaker-name': '小林' }, {});
    applyRequestContext(ctx, { 'x-linx-device-id': 'dev-10' }, {});
    assert.equal(ctx.speakerName, '');
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

  it('X-Linx-Display 决定载体形态，认不出的值不动上一次的结果', () => {
    const ctx = createDeviceContext('conn-6');
    applyRequestContext(ctx, { 'x-linx-display': 'screen' });
    assert.equal(ctx.display, 'screen');

    applyRequestContext(ctx, { 'x-linx-display': 'tv' });
    assert.equal(ctx.display, 'screen');

    applyRequestContext(ctx, {}, { display: 'voice' });
    assert.equal(ctx.display, 'voice');
  });

  it('说话人称呼按中文还原：百分号编码与 latin1 乱码都认', () => {
    const percent = createDeviceContext('conn-11');
    applyRequestContext(percent, { 'x-linx-speaker-name': '%E5%B0%8F%E6%9E%97' }, {});
    assert.equal(percent.speakerName, '小林');

    const latin1 = createDeviceContext('conn-12');
    applyRequestContext(
      latin1,
      { 'x-linx-speaker-name': Buffer.from('小林', 'utf8').toString('latin1') },
      {},
    );
    assert.equal(latin1.speakerName, '小林');

    const broken = createDeviceContext('conn-13');
    applyRequestContext(broken, { 'x-linx-speaker-name': '%E5%B0' }, {});
    assert.equal(broken.speakerName, '%E5%B0');
  });

  it('身份头快照只留自定义头，敏感头打码', () => {
    const picked = identityHeaders({
      host: '127.0.0.1:8000',
      'user-agent': 'curl/8.7.1',
      accept: 'application/json',
      'x-linx-device-id': 'dev-1',
      'x-linx-speaker-name': '小林',
      authorization: 'Bearer secret-token',
      'x-api-key': 'sk-123',
      'x-array': ['a', 'b'],
    });
    assert.deepEqual(picked, {
      'x-linx-device-id': 'dev-1',
      'x-linx-speaker-name': '小林',
      authorization: '<已隐藏>',
      'x-api-key': '<已隐藏>',
      'x-array': 'a, b',
    });
  });

  it('没有自定义头时快照是空的', () => {
    assert.deepEqual(identityHeaders({ host: 'x', accept: '*/*' }), {});
  });
});
