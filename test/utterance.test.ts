import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { classifyUtterance } from '../src/game/utterance.js';

describe('一句话意图分类', () => {
  it('问战况归为 status', () => {
    for (const text of ['战况如何', '现在局面怎么样', '我还剩多少血', '第几轮了', '谁赢了', '我赢了吗']) {
      assert.equal(classifyUtterance(text), 'status', `「${text}」应问战况`);
    }
  });

  it('问玩法归为 help，且不会被「出招」抢成招式', () => {
    for (const text of ['怎么玩', '怎么出招', '规则是什么', '教我一下', '怎么才能赢']) {
      assert.equal(classifyUtterance(text), 'help', `「${text}」应问玩法`);
    }
  });

  it('明确要开局归为 start', () => {
    for (const text of ['开始', '开始吧', '来一局', '开战', '再来一局', '开房间', '联机']) {
      assert.equal(classifyUtterance(text), 'start', `「${text}」应判为开局`);
    }
  });

  it('招式与念咒交回 act，不在这一层判断', () => {
    for (const text of ['攻击', '普攻', '公鸡', '强攻', '共鸣斩破军', '格挡', '闪避']) {
      assert.equal(classifyUtterance(text), 'unknown', `「${text}」应交给 act 结算`);
    }
  });

  it('认不出来的句子不猜意图', () => {
    for (const text of ['', '   ', '今天天气不错', '你是谁', '开', '打开菜单']) {
      assert.equal(classifyUtterance(text), 'unknown', `「${text}」不应被归成任何明确意图`);
    }
  });

  it('标点与大小写不影响判断', () => {
    assert.equal(classifyUtterance('战况，如何？'), 'status');
    assert.equal(classifyUtterance(' 开始！ '), 'start');
  });
});
