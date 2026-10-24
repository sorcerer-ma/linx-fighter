import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  matchSpokenAction,
  normalizeAsr,
  stripFillers,
  syllableDistance,
  toSyllables,
} from '../src/game/asr.js';
import { parseAction } from '../src/game/actions.js';
import { readCommand } from '../src/game/command.js';

/** 断言识别到指定招式，并把命中路径一起钉住，避免以后放宽到错配 */
function expectAction(text: string, id: string, via: 'exact' | 'prefix' | 'syllable') {
  const match = matchSpokenAction(text);
  assert.ok(match, `「${text}」应当识别成 ${id}`);
  assert.equal(match.id, id, `「${text}」应识别成 ${id}，实际 ${match.id}`);
  assert.equal(match.via, via, `「${text}」的命中路径应为 ${via}`);
  assert.ok(match.score > 0 && match.score <= 1, `「${text}」的置信度应在 (0,1] 内`);
}

describe('ASR 文本归一化', () => {
  it('全角转半角、去空白与标点、英文小写', () => {
    assert.equal(normalizeAsr('  ＨＥＡＶＹ '), 'heavy');
    assert.equal(normalizeAsr('我要开大。'), '我要开大');
    assert.equal(normalizeAsr('公 鸡！'), '公鸡');
    assert.equal(normalizeAsr('攻击\n'), '攻击');
    assert.equal(normalizeAsr(''), '');
  });

  it('去口语填充与修饰，但不剥掉招式本身', () => {
    assert.equal(stripFillers('我要用强化普攻'), '普攻');
    assert.equal(stripFillers('给我来一个大招'), '大招');
    assert.equal(stripFillers('狠狠打'), '打');
    assert.equal(stripFillers('我要打'), '打');
    assert.equal(stripFillers('格挡吧'), '格挡');
    assert.equal(stripFillers('公鸡你'), '公鸡');
    // 「出招」「出手」本身就是普攻说法，句首的「出」不能当填充剥掉
    assert.equal(stripFillers('出招'), '出招');
    assert.equal(stripFillers('出手'), '出手');
  });

  it('日常说法不会被剥成招式', () => {
    assert.equal(stripFillers('打开菜单'), '打开菜单');
    assert.equal(stripFillers('大家'), '大家');
    // 「吗」「呢」不剥：带疑问语气的话整句不猜
    assert.equal(stripFillers('我要格挡吗'), '格挡吗');
  });
});

describe('音节与音节距离', () => {
  it('逐字转音节，表外字给 undefined', () => {
    assert.deepEqual(toSyllables('公鸡'), ['gong', 'ji']);
    assert.deepEqual(toSyllables('硬扛'), ['ying', 'kang']);
    // 「杭」不在同音表里（表只覆盖招式用到的音节），表外字一律 undefined
    assert.deepEqual(toSyllables('映杭'), ['ying', undefined]);
    assert.deepEqual(toSyllables('你猜7点'), [undefined, undefined, undefined, undefined]);
    assert.deepEqual(toSyllables(''), []);
  });

  it('同音为 0，声母/韵母混淆为 0.5，其余为 1', () => {
    assert.equal(syllableDistance('gong', 'gong'), 0);
    assert.equal(syllableDistance('kang', 'hang'), 0.5);
    assert.equal(syllableDistance('an', 'ang'), 0.5);
    assert.equal(syllableDistance('en', 'eng'), 0.5);
    assert.equal(syllableDistance('zong', 'zhong'), 0.5);
    assert.equal(syllableDistance('yin', 'ying'), 0.5);
    assert.equal(syllableDistance('gong', 'ji'), 1);
    // 韵腹不同（ang/eng）不算近音：两类字听起来差别明显，认错比认不出更糟
    assert.equal(syllableDistance('chang', 'cheng'), 1);
    assert.equal(syllableDistance(undefined, 'gong'), 1);
  });
});

describe('线上真实语料：同音只差一处也认', () => {
  it('语料里的错识别句子都能命中正确招式', () => {
    expectAction('公鸡', 'light', 'exact');
    expectAction('重机', 'heavy', 'exact');
    expectAction('硬航', 'take', 'exact');
    expectAction('长寿', 'take', 'exact');
    expectAction('我要可党。', 'guard', 'exact');
    expectAction('我要开大。', 'ult', 'exact');
    expectAction('我开大招。', 'ult', 'exact');
    expectAction('强化攻击', 'light', 'exact');
    expectAction('我出一记强化普攻', 'light', 'exact');
    expectAction('普通攻击', 'light', 'exact');
    expectAction('大招大招', 'ult', 'prefix');
    // 「这一下」属填充词，剥完就是「躲开」本身
    expectAction('躲开这一下', 'dodge', 'exact');
  });

  it('长说法优先，不在同一个词里抠出短招式', () => {
    // 「全力攻击」是强攻：等长比较时整体更像「全力攻击」，不能被「攻击」抢走
    assert.equal(matchSpokenAction('全力攻击')?.id, 'heavy');
  });
});

describe('词表里没有的写法靠音节比较兜住', () => {
  it('完全同音的错字', () => {
    expectAction('抢工', 'heavy', 'syllable');
    expectAction('扑工', 'light', 'syllable');
    expectAction('成寿', 'take', 'syllable');
    expectAction('隔党', 'guard', 'syllable');
    expectAction('陕币', 'dodge', 'syllable');
    expectAction('续立', 'charge', 'syllable');
    expectAction('达找', 'ult', 'syllable');
  });

  it('前后鼻音、声母混淆的近似说法', () => {
    // 多散：duo/san 与「躲闪」只差 s/sh 这一处，整句只容一处混淆
    const match = matchSpokenAction('多散');
    assert.ok(match);
    assert.equal(match.id, 'dodge');
    assert.equal(match.via, 'syllable');
    assert.equal(match.score, 0.75);
  });
});

describe('宁可认不出，也不认错', () => {
  it('噪声与闲聊不命中任何招式', () => {
    const noises = [
      '训练',
      '你猜中7点',
      '这一首梅生笑',
      '打开菜单',
      '我怕他吗',
      '公园',
      '各种',
      '大家',
      '开会',
      '今天天气不错',
    ];
    for (const text of noises) {
      assert.equal(matchSpokenAction(text), null, `「${text}」不应被识别成招式`);
    }
  });

  it('平台回灌的播报不算出招', () => {
    // 这些句子以招式词收尾，说的是别人在做什么；认了自己会白掉能量
    const echoes = [
      '对手一记普攻',
      '轮到你出招',
      '胜九，轮到你出招。蓄力。',
      '轮到我们了，大招。',
      '主动阶段可以说普攻、强攻、大招或蓄力。犀利',
    ];
    for (const text of echoes) {
      assert.equal(matchSpokenAction(text), null, `「${text}」不应被识别成招式`);
    }
  });

  it('单字别名只做精确匹配，不做近音扩展', () => {
    assert.equal(matchSpokenAction('打')?.id, 'light');
    assert.equal(matchSpokenAction('躲')?.id, 'dodge');
    assert.equal(matchSpokenAction('大家'), null);
    assert.equal(matchSpokenAction('躲开')?.id, 'dodge');
  });

  it('句中包含不算命中，只有前后缀才算', () => {
    // 「打开大家」句中带「开大」，但整句不是出招，包含匹配会把这里错配成大招
    assert.equal(matchSpokenAction('打开大家'), null);
    assert.equal(matchSpokenAction('打开大门'), null);
  });

  it('带疑问语气的整句不猜，交给 command.ts', () => {
    assert.equal(matchSpokenAction('我要格挡吗'), null);
    assert.equal(matchSpokenAction('能不能放大招'), null);
  });

  it('空串、纯标点、纯填充词返回 null', () => {
    assert.equal(matchSpokenAction(''), null);
    assert.equal(matchSpokenAction('   '), null);
    assert.equal(matchSpokenAction('。。。'), null);
    assert.equal(matchSpokenAction('我要'), null);
  });
});

describe('口语简称只在整句里认', () => {
  it('开大系简称识别为大招', () => {
    expectAction('开大', 'ult', 'exact');
    expectAction('我要开大。', 'ult', 'exact');
    expectAction('开大招', 'ult', 'exact');
    expectAction('放大招', 'ult', 'exact');
    expectAction('我要放大招', 'ult', 'exact');
    expectAction('来个大的', 'ult', 'exact');
  });

  it('含「开大」的日常话不命中', () => {
    // 这几个词留在词表里会被子串包含命中，这就是必须挪到这一层的原因
    for (const text of ['打开大家', '把大门打开', '打开大号']) {
      assert.equal(matchSpokenAction(text), null, `「${text}」不应被识别成招式`);
    }
  });

  it('词表不认口语简称，也不把闲聊读成出招', () => {
    assert.equal(parseAction('开大'), null);
    assert.equal(parseAction('我要开大。'), null);
    assert.equal(parseAction('打开大家'), null);
    assert.notEqual(readCommand('打开大家').kind, 'turn');
  });
});

describe('按阶段筛选招式', () => {
  it('主动阶段不认防守招式，应对阶段不认攻击', () => {
    assert.equal(matchSpokenAction('格挡', 'active'), null);
    assert.equal(matchSpokenAction('大招', 'response'), null);
    assert.equal(matchSpokenAction('格挡', 'response')?.id, 'guard');
    assert.equal(matchSpokenAction('大招', 'active')?.id, 'ult');
    // 不传阶段时全表参与：词表本身仍由流水线校验阶段
    assert.equal(matchSpokenAction('格挡')?.id, 'guard');
  });
});
