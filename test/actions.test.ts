import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ACTIONS,
  actionHints,
  actionLabel,
  actionLabels,
  activeActionLabels,
  matchAction,
  matchActionIds,
  parseAction,
  responseActionLabels,
} from '../src/game/actions.js';

describe('招式识别', () => {
  it('精确匹配中文与英文标识', () => {
    assert.equal(parseAction('攻击'), 'light');
    assert.equal(parseAction('普攻'), 'light');
    assert.equal(parseAction('强攻'), 'heavy');
    assert.equal(parseAction('大招'), 'ult');
    assert.equal(parseAction('蓄力'), 'charge');
    assert.equal(parseAction('格挡'), 'guard');
    assert.equal(parseAction('闪避'), 'dodge');
    assert.equal(parseAction('硬抗'), 'take');
    assert.equal(parseAction('light'), 'light');
    assert.equal(parseAction('  HEAVY  '), 'heavy');
    assert.equal(parseAction('攻击。'), 'light');
  });

  it('识别口语里的招式', () => {
    assert.equal(parseAction('我要强攻他'), 'heavy');
    assert.equal(parseAction('先调息片刻'), 'charge');
    assert.equal(parseAction('向右闪避！'), 'dodge');
    assert.equal(parseAction('我选择格挡'), 'guard');
    assert.equal(parseAction('硬抗这一下'), 'take');
  });

  it('精确层只兜拼音规则接不住的误识别', () => {
    // 同音、近音、吞韵尾的错字交给 asr.ts，对应断言在 test/asr.test.ts；
    // 这里只留语义级误听和音节表尚未收录的字。
    assert.equal(parseAction('大着'), 'ult');
    assert.equal(parseAction('可党'), 'guard');
    assert.equal(parseAction('狠抗'), 'take');
    assert.equal(parseAction('硬坑'), 'take');
    assert.equal(parseAction('硬航'), 'take');
    assert.equal(parseAction('长寿'), 'take');
  });

  it('收窄后的口语只判提及，不直接执行', () => {
    // 执行层只留高频说法，这些口语交给模型路由；但它们仍算「点到了这一招」
    for (const text of ['猛攻', '重机', '大召', '哥挡', '成受', '公鸡', '蓄势待发']) {
      assert.equal(parseAction(text), null, `「${text}」不该被本地直接执行`);
    }
    for (const [text, ids] of [
      ['猛攻还是普攻', ['heavy', 'light']],
      ['公鸡还是强攻', ['heavy', 'light']],
      ['回能量还是强攻', ['charge', 'heavy']],
      ['蓄势待发还是硬扛', ['charge', 'take']],
    ] as const) {
      assert.deepEqual([...matchActionIds(text)].sort(), [...ids].sort(), `「${text}」点到了两种招式`);
    }
  });

  it('带「大招」的蓄力说法仍读成蓄力，不落进大招', () => {
    // 这两个字一删，「憋大招」会被包含匹配的「大招」抢走，打掉一局一次的大招
    for (const text of ['憋大招', '攒大招', '留大招', '存大招']) {
      assert.equal(parseAction(text), 'charge', `「${text}」是攒能量，不是放大招`);
    }
  });

  it('念出唤出指令也能出招，并带回原文', () => {
    assert.deepEqual(matchAction('共鸣斩破军'), { id: 'light', chant: '共鸣斩破军' });
    assert.equal(parseAction('我要用共鸣壁立千仞'), 'guard');
    assert.deepEqual(matchAction('天倾共此声'), { id: 'ult', chant: '天倾共此声' });
    // 普通说法出招时不带唤出指令，播报里也就不会回念
    assert.deepEqual(matchAction('普攻'), { id: 'light' });
  });

  it('唤出指令唯一，且不会互相包含', () => {
    const chants = Object.values(ACTIONS).flatMap((meta) => meta.chants);
    assert.equal(new Set(chants).size, chants.length);
    for (const a of chants) {
      for (const b of chants) {
        if (a !== b) assert.ok(!a.includes(b), `${a} 不应包含 ${b}`);
      }
    }
  });

  it('单字只保留最高频的「打」，其余短句交给命令路由', () => {
    assert.equal(parseAction('躲'), null);
    assert.equal(parseAction('打'), 'light');
    assert.equal(parseAction('打开菜单'), null);
    assert.equal(parseAction('讲个笑话'), null);
    assert.equal(parseAction(''), null);
    assert.equal(parseAction('   '), null);
  });

  it('提示文案覆盖七种招式，未知标识回退原文', () => {
    assert.deepEqual(actionLabels(), ['普攻', '强攻', '大招', '蓄力', '格挡', '闪避', '承受']);
    assert.deepEqual(activeActionLabels(), ['普攻', '强攻', '大招', '蓄力']);
    assert.deepEqual(responseActionLabels(), ['格挡', '闪避', '承受']);
    assert.match(actionHints(), /light（普攻）/);
    assert.match(actionHints(), /take（承受）/);
    assert.equal(actionLabel('ult'), '大招');
    assert.equal(actionLabel('unknown' as Parameters<typeof actionLabel>[0]), 'unknown');
  });

  it('招式表覆盖七种操作且有中文名', () => {
    assert.deepEqual(Object.keys(ACTIONS).sort(), ['charge', 'dodge', 'guard', 'heavy', 'light', 'take', 'ult']);
    for (const meta of Object.values(ACTIONS)) {
      assert.ok(meta.label.length > 0);
      assert.ok(meta.aliases.includes(meta.label), `${meta.id} 的别名应包含中文名`);
      assert.ok(meta.chants.length >= 2, `${meta.id} 应至少两条唤出指令`);
    }
  });
});

describe('一句话里的招式集合', () => {
  it('单招式只返回一个 id', () => {
    assert.deepEqual(matchActionIds('攻击'), ['light']);
    assert.deepEqual(matchActionIds('大招'), ['ult']);
    assert.deepEqual(matchActionIds('我要攻击你'), ['light']);
    assert.deepEqual(matchActionIds('  HEAVY  '), ['heavy']);
    assert.deepEqual(matchActionIds('攻击。'), ['light']);
  });

  it('一句话点到两种招式时全部返回', () => {
    // 「还是」「或者」是商量口吻，调用方据此让玩家重说，不能替他选一招
    assert.deepEqual([...matchActionIds('大招还是强攻')].sort(), ['heavy', 'ult']);
    assert.deepEqual([...matchActionIds('攻击或者闪避')].sort(), ['dodge', 'light']);
    assert.deepEqual([...matchActionIds('先闪避再攻击')].sort(), ['dodge', 'light']);
  });

  it('同一招重复出现只算一次', () => {
    assert.deepEqual(matchActionIds('大招大招'), ['ult']);
    assert.deepEqual(matchActionIds('攻击，攻击'), ['light']);
  });

  it('没有招式时返回空数组', () => {
    assert.deepEqual(matchActionIds(''), []);
    assert.deepEqual(matchActionIds('   '), []);
    assert.deepEqual(matchActionIds('今天天气不错'), []);
    assert.deepEqual(matchActionIds('打开菜单'), []);
  });

  it('单字只保留「打」，其余短句不再靠别名兜底', () => {
    assert.deepEqual(matchActionIds('打'), ['light']);
    assert.deepEqual(matchActionIds('躲'), []);
    // 「打开菜单」里的「打」不是出招，也不能被当成第二种招式
    assert.deepEqual(matchActionIds('打开菜单'), []);
    assert.deepEqual(matchActionIds('打开大招'), ['ult']);
  });

  it('唤出指令算对应招式', () => {
    assert.deepEqual(matchActionIds('共鸣斩破军'), ['light']);
    assert.deepEqual(matchActionIds('我要用共鸣壁立千仞'), ['guard']);
    assert.deepEqual(matchActionIds('天倾共此声'), ['ult']);
  });

  it('长词优先，不在同一个词里再抠出短招式', () => {
    // 「全力攻击」是强攻，不能又被里面的「攻击」算成普攻
    assert.deepEqual(matchActionIds('全力攻击'), ['heavy']);
    assert.deepEqual(matchActionIds('普通攻击'), ['light']);
  });

  it('matchAction 仍是单招式结果，且落在 matchActionIds 里', () => {
    for (const text of ['大招还是强攻', '攻击或者闪避', '全力攻击', '我要攻击你']) {
      const single = matchAction(text);
      assert.ok(single, `「${text}」应有 matchAction 结果`);
      assert.ok(matchActionIds(text).includes(single.id), `「${text}」的 matchAction 应是命中招式之一`);
    }
  });
});


it('强化攻击长别名占用整个词，不被其中攻击误算成第二招',()=>{
 assert.deepEqual(matchAction('强化攻击'),{id:'heavy'});
 assert.deepEqual(matchActionIds('我要强化攻击'),['heavy']);
});
