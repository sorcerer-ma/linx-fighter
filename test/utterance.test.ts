import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { blockAction, classifyUtterance } from '../src/game/utterance.js';

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

describe('招式拦截原因', () => {
  it('问句不按招式处理', () => {
    for (const text of ['我的大招还剩几次', '能放大招吗', '能不能放大招', '还剩多少真气', '大招还能用吗', '我还能放几次大招']) {
      assert.equal(blockAction(text), 'query', `「${text}」是问句`);
    }
  });

  it('反问式疑问优先于否定：「能不能」不算「不能」', () => {
    for (const text of ['能不能放大招', '可不可以出招', '要不要放大招', '该不该放大招', '是不是该出大招', '够不够真气放大招']) {
      assert.equal(blockAction(text), 'query', `「${text}」是反问式疑问，不是否定`);
    }
  });

  it('否定与收手不按招式处理', () => {
    for (const text of ['不要大招', '别打', '我不出招', '算了', '先不打', '住手', '别急']) {
      assert.equal(blockAction(text), 'negated', `「${text}」是在说不打`);
    }
  });

  it('一句话说两招算歧义', () => {
    for (const text of ['大招还是强攻', '攻击或者闪避', '先闪避再攻击']) {
      assert.equal(blockAction(text), 'ambiguous', `「${text}」没说清要出哪一招`);
    }
  });

  it('正常出招不拦截', () => {
    for (const text of ['攻击', '共鸣斩破军', '我要强攻他', '']) {
      assert.equal(blockAction(text), null, `「${text}」应继续按招式处理`);
    }
    // 「特别」里的「别」不是否定，带形容词的出招照样生效
    assert.equal(blockAction('特别强的攻击'), null);
    assert.equal(blockAction('区别'), null);
    assert.equal(blockAction('告别'), null);
  });

  it('问号在去掉标点之前就要认出来', () => {
    assert.equal(blockAction('大招？'), 'query');
    assert.equal(blockAction('大招?'), 'query');
  });
});

describe('带招式词的问句不真的出手', () => {
  it('问招式余量归为 status', () => {
    for (const text of ['我的大招还剩几次', '我还能放几次大招', '剩多少真气', '大招还能用吗']) {
      assert.equal(classifyUtterance(text), 'status', `「${text}」应问战况`);
    }
  });

  it('原有招式判定不变', () => {
    for (const text of ['攻击', '公鸡']) {
      assert.equal(classifyUtterance(text), 'unknown', `「${text}」仍交给 act 结算`);
    }
    // 否定与歧义不在这一层改判，交给 act 按 blockAction 提示重说
    assert.equal(classifyUtterance('不要大招'), 'unknown');
    assert.equal(classifyUtterance('大招还是强攻'), 'unknown');
    // 问玩法仍然优先于招式
    assert.equal(classifyUtterance('怎么出招'), 'help');
    assert.equal(classifyUtterance('怎么放大招'), 'help');
  });

  it('问房间里没点招式仍按开局处理', () => {
    // 「能不能联机」是问句，但玩家要的是开一局，不能只播局面
    for (const text of ['能不能联机', '要不要开房间', '可不可以开房间']) {
      assert.equal(classifyUtterance(text), 'start', `「${text}」应开房`);
    }
  });
});
