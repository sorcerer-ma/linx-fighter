import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createCommandRouter, parseRouteDecision, ROUTER_CONFIDENCE_THRESHOLD } from '../src/game/router.js';

/** 构造一个 System One 决策响应 */
function decision(choice: string, confidence = 0.9): unknown {
  return { answers: { command: { choice, confidence } } };
}

describe('路由结果解析', () => {
  it('招式与查询按选项映射成命令', () => {
    assert.deepEqual(parseRouteDecision(decision('heavy'), 'active', '上去揍他'), {
      kind: 'turn',
      action: 'heavy',
    });
    assert.deepEqual(parseRouteDecision(decision('status'), 'active', '现在怎么样'), { kind: 'status' });
    assert.deepEqual(parseRouteDecision(decision('help'), 'response', '怎么应对'), { kind: 'help' });
    assert.deepEqual(parseRouteDecision(decision('start'), 'none', '来一局'), { kind: 'start' });
    assert.deepEqual(parseRouteDecision(decision('open-room'), 'none', '联机'), { kind: 'open-room' });
    // 规则外的问题把原话带回去，交给语言模型
    assert.deepEqual(parseRouteDecision(decision('outside'), 'none', ' 今天天气怎么样 '), {
      kind: 'ask',
      text: '今天天气怎么样',
    });
  });

  it('置信度低于阈值或选了 unknown 就当没认出来', () => {
    assert.equal(parseRouteDecision(decision('heavy', ROUTER_CONFIDENCE_THRESHOLD - 0.01), 'active', '揍他'), null);
    assert.equal(parseRouteDecision(decision('unknown', 0.99), 'active', '嗯'), null);
    // 用概率代替顶层置信度时同样生效
    assert.deepEqual(
      parseRouteDecision({ answers: { command: { choice: 'guard', probabilities: { guard: 0.7 } } } }, 'response', '挡住'),
      { kind: 'turn', action: 'guard' },
    );
    assert.equal(
      parseRouteDecision({ answers: { command: { choice: 'guard', probabilities: { guard: 0.2 } } } }, 'response', '挡住'),
      null,
    );
  });

  it('菜单外的选项一律不认，防止问句被路由成出招', () => {
    // 提问阶段没有任何招式选项
    assert.equal(parseRouteDecision(decision('ult'), 'question', '我能放大招吗'), null);
    // 等对手时不能替玩家出招
    assert.equal(parseRouteDecision(decision('charge'), 'waiting', '蓄力'), null);
    // 没有对局时不能直接出招
    assert.equal(parseRouteDecision(decision('light'), 'none', '打他'), null);
    // 上一局打完了也不能再出招，但可以再来一局或闲聊
    for (const move of ['light', 'heavy', 'ult', 'charge', 'guard', 'dodge', 'take']) {
      assert.equal(parseRouteDecision(decision(move), 'ended', '再来一下'), null, `结束状态不该认「${move}」`);
    }
    assert.deepEqual(parseRouteDecision(decision('start'), 'ended', '我还想接着玩'), { kind: 'start' });
    assert.deepEqual(parseRouteDecision(decision('status'), 'ended', '刚才打得怎么样'), { kind: 'status' });
    assert.deepEqual(parseRouteDecision(decision('outside', 0.8), 'ended', '讲个笑话'), {
      kind: 'ask',
      text: '讲个笑话',
    });
    // 结构不对或字段缺失
    assert.equal(parseRouteDecision(null, 'active', '打他'), null);
    assert.equal(parseRouteDecision({}, 'active', '打他'), null);
    assert.equal(parseRouteDecision({ answers: { command: { choice: 42 } } }, 'active', '打他'), null);
  });
});

describe('命令路由客户端', () => {
  it('请求带上当前阶段与原话，阶段菜单随阶段收窄', async () => {
    const bodies: string[] = [];
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(String(init?.body ?? ''));
      return new Response(JSON.stringify(decision('heavy')), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    const router = createCommandRouter({ apiKey: 'test-key', fetchImpl, baseUrl: 'http://router.test/v1' });
    const command = await router.resolve('上去揍他', 'active');
    assert.deepEqual(command, { kind: 'turn', action: 'heavy' });

    const body = JSON.parse(bodies[0] ?? '{}') as {
      state?: { stage?: string; utterance?: string };
      questions?: { command?: { type?: string; criteria?: Record<string, string> } };
    };
    // 模型必须看得到原话，否则只能瞎猜
    assert.equal(body.state?.utterance, '上去揍他');
    assert.equal(body.state?.stage, '轮到玩家出招');
    assert.equal(body.questions?.command?.type, 'choice');
    const criteria = Object.keys(body.questions?.command?.criteria ?? {});
    assert.ok(criteria.includes('heavy'));
    assert.ok(criteria.includes('outside'));
    // 主动阶段可以出招，但也要允许查询与闲聊
    assert.ok(criteria.includes('status'));
  });

  it('提问阶段的菜单里没有招式选项', async () => {
    let body = '';
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      body = String(init?.body ?? '');
      return new Response(JSON.stringify(decision('status')), { status: 200 });
    }) as typeof fetch;

    const router = createCommandRouter({ apiKey: 'k', fetchImpl, baseUrl: 'http://router.test/v1' });
    const command = await router.resolve('我的大招还剩几次', 'question');
    assert.deepEqual(command, { kind: 'status' });
    const criteria = Object.keys(
      (JSON.parse(body) as { questions: { command: { criteria: Record<string, string> } } }).questions.command
        .criteria,
    );
    for (const move of ['light', 'heavy', 'ult', 'charge', 'guard', 'dodge', 'take']) {
      assert.ok(!criteria.includes(move), `提问阶段不该出现「${move}」`);
    }
  });

  it('结束阶段的菜单里只剩开局、查询、玩法与闲聊', async () => {
    let body = '';
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      body = String(init?.body ?? '');
      return new Response(JSON.stringify(decision('start')), { status: 200 });
    }) as typeof fetch;

    const router = createCommandRouter({ apiKey: 'k', fetchImpl, baseUrl: 'http://router.test/v1' });
    assert.deepEqual(await router.resolve('我还想接着玩', 'ended'), { kind: 'start' });

    const parsed = JSON.parse(body) as {
      state: { stage: string };
      questions: { command: { criteria: Record<string, string> } };
    };
    assert.equal(parsed.state.stage, '上一局已经结束');
    const criteria = Object.keys(parsed.questions.command.criteria);
    for (const move of ['light', 'heavy', 'ult', 'charge', 'guard', 'dodge', 'take']) {
      assert.ok(!criteria.includes(move), `结束状态不该出现「${move}」`);
    }
    for (const choice of ['start', 'open-room', 'status', 'help', 'outside']) {
      assert.ok(criteria.includes(choice), `结束状态应该还能选「${choice}」`);
    }
  });

  it('模型调用失败按没认出来处理', async () => {
    const failing = (async () => new Response('boom', { status: 500 })) as typeof fetch;
    const router = createCommandRouter({ apiKey: 'k', fetchImpl: failing, baseUrl: 'http://router.test/v1' });
    assert.equal(await router.resolve('上去揍他', 'active'), null);

    const broken = (async () => {
      throw new Error('network down');
    }) as typeof fetch;
    const down = createCommandRouter({ apiKey: 'k', fetchImpl: broken, baseUrl: 'http://router.test/v1' });
    assert.equal(await down.resolve('上去揍他', 'active'), null);
  });
});
