import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ACTIONS, parseAction } from '../src/game/actions.js';

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
