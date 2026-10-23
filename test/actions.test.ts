import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ACTIONS,
  actionHints,
  actionLabel,
  actionLabels,
  activeActionLabels,
  matchAction,
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
