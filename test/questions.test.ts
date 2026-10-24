import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { askScope, compactText, outsideQuestion } from '../src/game/questions.js';

describe('规则内 / 规则外分流', () => {
  it('问对局内的事都留在本地', () => {
    const game = [
      '我的能量还剩多少',
      '我的大招还剩几次',
      '回满能量要几回合',
      '怎么回能量',
      '谁赢了',
      '还剩多少',
      '为什么我输了',
      '帮我算一下强攻伤害',
      '现在第几轮',
      '我血量还剩多少',
      '对手还剩几次大招',
      '怎么玩',
    ];
    for (const text of game) {
      assert.equal(askScope(text), 'game', `应判成规则内：${text}`);
    }
  });

  it('问天气、算数、常识与代劳请求交给语言模型', () => {
    const outside = [
      '今天天气怎么样',
      '讲个笑话',
      '1加1等于几',
      '现在几点',
      '你是谁',
      '帮我翻译一下这句话',
      '背首诗',
      '北京有什么好玩的',
      '为什么天是蓝的',
    ];
    for (const text of outside) {
      assert.equal(askScope(text), 'outside', `应判成规则外：${text}`);
    }
  });

  it('不是在提问就不分流，交给后续规则判断', () => {
    for (const text of ['开始游戏', '格挡', '我强攻', '放大招', '嗯', '', '不要大招']) {
      assert.equal(askScope(text), null, `不该判成提问：${text}`);
    }
  });

  it('抹平空白与标点后再判断，只喊一个问号不算有效问题', () => {
    assert.equal(askScope('  我的  能量还剩多少？ '), 'game');
    assert.equal(askScope('？'), null);
    assert.equal(askScope(' '), null);
  });

  it('问句统一抹平空白与标点、英文转小写', () => {
    assert.equal(compactText('  我 的 能量，还剩多少？ '), '我的能量还剩多少');
    assert.equal(compactText('OK！'), 'ok');
  });

  it('交给模型的问题去首尾空白并截断到 200 字', () => {
    assert.equal(outsideQuestion('  今天天气怎么样？  '), '今天天气怎么样？');
    const long = '啊'.repeat(300);
    assert.equal(outsideQuestion(long).length, 200);
  });
});
