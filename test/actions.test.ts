import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ACTIONS, matchAction, parseAction } from '../src/game/actions.js';

describe('招式识别', () => {
  it('精确匹配中文与英文', () => {
    assert.equal(parseAction('攻击'), 'attack');
    assert.equal(parseAction('闪避'), 'dodge');
    assert.equal(parseAction('回气'), 'recover');
    assert.equal(parseAction('attack'), 'attack');
    assert.equal(parseAction('  ATTACK  '), 'attack');
    assert.equal(parseAction('攻击。'), 'attack');
  });

  it('识别口语里的招式', () => {
    assert.equal(parseAction('我要攻击他'), 'attack');
    assert.equal(parseAction('赶紧躲避'), 'dodge');
    assert.equal(parseAction('先调息片刻'), 'recover');
    assert.equal(parseAction('向右闪避！'), 'dodge');
  });

  it('容忍 ASR 同音/近音误识别', () => {
    // 平台侧 ASR 会把「攻击」转成「公鸡」这类同音字，只能在我们这层兜住
    assert.equal(parseAction('公鸡'), 'attack');
    assert.equal(parseAction('我要公鸡你'), 'attack');
    assert.equal(parseAction('工击'), 'attack');
    assert.equal(parseAction('多开'), 'dodge');
    assert.equal(parseAction('防疫'), 'dodge');
    assert.equal(parseAction('躲闪'), 'dodge');
    assert.equal(parseAction('回七'), 'recover');
    assert.equal(parseAction('调西片刻'), 'recover');
  });

  it('念出唤出指令也能出招，并带回原文', () => {
    assert.deepEqual(matchAction('共鸣斩破军'), { id: 'attack', chant: '共鸣斩破军' });
    assert.equal(parseAction('我要用共鸣壁卸力'), 'dodge');
    assert.equal(parseAction('一息气自回'), 'recover');
    // 普通说法出招时不带唤出指令，播报里也就不会回念
    assert.deepEqual(matchAction('攻击'), { id: 'attack' });
  });

  it('唤出指令唯一，且不会互相包含', () => {
    const chants = Object.values(ACTIONS).flatMap((meta) => meta.chants ?? []);
    assert.equal(new Set(chants).size, chants.length);
    for (const a of chants) {
      for (const b of chants) {
        if (a !== b) assert.ok(!a.includes(b), `${a} 不应包含 ${b}`);
      }
    }
  });

  it('无关的话不会被误判', () => {
    assert.equal(parseAction(''), null);
    assert.equal(parseAction('   '), null);
    // 单字别名「打」只在精确匹配生效，避免「打开菜单」被当成攻击
    assert.equal(parseAction('打开菜单'), null);
    assert.equal(parseAction('讲个笑话'), null);
  });

  it('招式表覆盖三种招式且有中文名', () => {
    assert.deepEqual(Object.keys(ACTIONS).sort(), ['attack', 'dodge', 'recover']);
    for (const meta of Object.values(ACTIONS)) {
      assert.ok(meta.label.length > 0);
      assert.ok(meta.aliases.includes(meta.label), `${meta.id} 的别名应包含中文名`);
    }
  });
});
