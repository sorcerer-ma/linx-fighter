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
    assert.equal(parseAction('attack'), 'light');
    assert.equal(parseAction('  HEAVY  '), 'heavy');
    assert.equal(parseAction('攻击。'), 'light');
  });

  it('识别口语里的招式', () => {
    assert.equal(parseAction('我要强攻他'), 'heavy');
    assert.equal(parseAction('先调息片刻'), 'charge');
    assert.equal(parseAction('向右闪避！'), 'dodge');
    assert.equal(parseAction('我选择格挡'), 'guard');
    assert.equal(parseAction('生吃这一下'), 'take');
  });

  it('容忍 ASR 同音/近音误识别', () => {
    // 平台侧 ASR 会把「攻击」转成「公鸡」这类同音字，只能在我们这层兜住
    assert.equal(parseAction('公鸡'), 'light');
    assert.equal(parseAction('我要公鸡你'), 'light');
    assert.equal(parseAction('工击'), 'light');
    assert.equal(parseAction('墙攻'), 'heavy');
    assert.equal(parseAction('大召'), 'ult');
    assert.equal(parseAction('回七'), 'charge');
    assert.equal(parseAction('多开'), 'dodge');
    assert.equal(parseAction('防疫'), 'dodge');
    assert.equal(parseAction('哥挡'), 'guard');
    assert.equal(parseAction('成受'), 'take');
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

  it('单字别名只在精确匹配生效，不误判日常对话', () => {
    assert.equal(parseAction('躲'), 'dodge');
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
    assert.deepEqual(matchActionIds('我要公鸡你'), ['light']);
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

  it('单字别名只在整句精确匹配时生效', () => {
    assert.deepEqual(matchActionIds('打'), ['light']);
    assert.deepEqual(matchActionIds('躲'), ['dodge']);
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
    for (const text of ['大招还是强攻', '攻击或者闪避', '全力攻击', '我要公鸡你']) {
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
