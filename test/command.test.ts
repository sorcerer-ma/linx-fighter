import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readCommand, type Command } from '../src/game/command.js';

/** 断言读出来的命令种类，失败时把原话带上，方便定位是哪一句串了味 */
function expectKind(text: string, kind: Command['kind']): void {
  assert.equal(readCommand(text).kind, kind, `「${text}」应读成 ${kind}`);
}

describe('一句话读成命令', () => {
  it('问战况读成 status', () => {
    for (const text of ['战况如何', '现在局面怎么样', '生命值', '能量', '我的生命值还剩多少', '能量够不够', '真气', '行动点', '我还剩多少血', '第几轮了', '谁赢了', '我赢了吗']) {
      expectKind(text, 'status');
    }
  });

  it('蓄力的能量说法读成 turn，不落到战况', () => {
    for (const text of [
      '回能量', '回点能量', '回满能量', '补能量', '补点能量', '补满能量',
      '攒能量', '攒点能量', '攒满能量', '存能量', '蓄能量', '聚能量', '我回点能量',
      // 带「大招」二字的长词留在本地：删了会被「大招」的包含匹配抢走
      '憋大招', '攒大招', '留大招', '存大招', '我在憋大招', '先憋大招',
    ]) {
      const command = readCommand(text);
      assert.equal(command.kind, 'turn', `「${text}」应读成 turn`);
      assert.equal(command.kind === 'turn' ? command.action : null, 'charge', `「${text}」是在蓄力`);
    }
    // 查询句仍走战况：招式匹配前的问句拦截优先
    for (const text of ['能量', '能量够不够', '还剩多少能量', '我的能量还剩多少']) {
      expectKind(text, 'status');
    }
  });

  it('问蓄力要几回合仍读成 status，不能真去蓄力', () => {
    for (const text of ['回满能量要几回合', '补满能量要几回合', '回能量要几轮', '攒点能量要多久', '怎么回能量']) {
      expectKind(text, 'status');
    }
  });

  it('问玩法读成 help，且不会被「出招」抢成招式', () => {
    for (const text of ['怎么玩', '怎么出招', '规则是什么', '教我一下', '怎么才能赢']) {
      expectKind(text, 'help');
    }
  });

  it('明确要开局读成 start', () => {
    for (const text of ['开始', '开始吧', '来一局', '开战', '再来一局']) {
      expectKind(text, 'start');
    }
  });

  it('发起挑战与联机读成 open-room，和单人开局分开', () => {
    for (const text of ['共鸣对决，发起挑战', '发起挑战', '联机', '双人对战', '开个房', '一起打吧']) {
      expectKind(text, 'open-room');
    }
  });

  it('带编号的接受挑战读成 join-room，旧说法仍兼容', () => {
    assert.deepEqual(readCommand('接受挑战，编号1234'), { kind: 'join-room', code: '1234' });
    assert.deepEqual(readCommand('接受挑战编号一二三四'), { kind: 'join-room', code: '1234' });
    // 旧口令留作输入兼容，不再作为引导文案
    assert.deepEqual(readCommand('加入房间1234'), { kind: 'join-room', code: '1234' });
    assert.deepEqual(readCommand('进房一二三四'), { kind: 'join-room', code: '1234' });
    // 接受意图缺编号仍留在加入路径，不能转为创建。裸编号仍不执行。
    assert.deepEqual(readCommand('接受挑战'), {kind:'join-room',code:''});
    assert.notEqual(readCommand('编号1234').kind, 'join-room');
    assert.notEqual(readCommand('今天1234').kind, 'join-room');
  });

  it('招式读成 turn，拼音规则接不住的误识别与唤出指令都算', () => {
    for (const text of ['攻击', '普攻', '大着', '强攻', '格挡', '闪避']) {
      expectKind(text, 'turn');
    }
    assert.deepEqual(readCommand('共鸣斩破军'), { kind: 'turn', action: 'light', chant: '共鸣斩破军' });
    assert.deepEqual(readCommand('天倾共此声'), { kind: 'turn', action: 'ult', chant: '天倾共此声' });
  });

  it('本地只认高频说法，语义口语交给模型', () => {
    // 这些说法原本靠长别名表覆盖，现在收敛掉，改由命令路由按阶段判断
    for (const text of ['猛攻', '抡他', '生吃这一下', '防一下', '躲一下']) {
      expectKind(text, 'route');
    }
  });

  it('认不出来的句子交给模型路由', () => {
    for (const text of ['', '   ', '今天天气不错', '开', '打开菜单']) {
      expectKind(text, 'route');
    }
    // 规则外的提问同样交给模型：本地不再用关键词猜问的是游戏内还是游戏外
    expectKind('你是谁', 'route');
  });

  it('标点与大小写不影响判断', () => {
    expectKind('战况，如何？', 'status');
    expectKind(' 开始！ ', 'start');
    expectKind(' 攻击 ', 'turn');
  });
});

describe('不该出手的表达', () => {
  it('带招式词的问句不按招式处理', () => {
    // 问的是资源与剩余次数：本地直接播战况，不消耗资源
    for (const text of ['我的大招还剩几次', '还剩多少能量', '还剩多少真气', '我的能量还剩多少', '我还能放几次大招']) {
      expectKind(text, 'status');
    }
    // 问的是「能不能用」：交给模型分到查询或玩法，绝不出招
    for (const text of ['能放大招吗', '能不能放大招', '大招还能用吗']) {
      const command = readCommand(text);
      assert.equal(command.kind, 'route', `「${text}」只是提问，不能出招`);
      assert.equal(command.kind === 'route' ? command.question : false, true, `「${text}」应标记为提问`);
    }
  });

  it('反问式疑问优先于否定：「能不能」不算「不能」', () => {
    // 问资源够不够：本地直接播战况
    for (const text of ['够不够能量放大招', '够不够真气放大招']) {
      expectKind(text, 'status');
    }
    for (const text of ['能不能放大招', '可不可以出招', '要不要放大招', '该不该放大招', '是不是该出大招']) {
      const command = readCommand(text);
      assert.equal(command.kind, 'route', `「${text}」是问句，不能出招`);
      assert.equal(command.kind === 'route' ? command.question : false, true, `「${text}」应标记为提问`);
    }
  });

  it('否定与收手读成 refused，不执行招式', () => {
    for (const text of ['不要大招', '别打', '我不出招', '算了', '先不打', '住手', '别急']) {
      assert.deepEqual(readCommand(text), { kind: 'refused', why: 'negated' }, `「${text}」是在说不打`);
    }
  });

  it('一句话说两招算歧义', () => {
    for (const text of ['大招还是强攻', '攻击或者闪避', '先闪避再攻击']) {
      assert.deepEqual(readCommand(text), { kind: 'refused', why: 'ambiguous' }, `「${text}」没说清要出哪一招`);
    }
  });

  it('收窄掉的语义口语与 ASR 误写照样参与歧义判定', () => {
    // 这些说法本地不再直接执行，但一句话点到两招仍要让玩家重说，
    // 否则规则会替他挑剩下那一招打出去
    for (const text of ['猛攻还是普攻', '公鸡还是强攻', '重机还是大招', '成受还是格挡']) {
      assert.deepEqual(readCommand(text), { kind: 'refused', why: 'ambiguous' }, `「${text}」没说清要出哪一招`);
    }
    // 「回能量」不在招式表里，也是蓄力：和另一招并提同样要重说
    for (const text of ['回能量还是强攻', '攒能量还是强攻', '回满能量还是放大招']) {
      assert.deepEqual(readCommand(text), { kind: 'refused', why: 'ambiguous' }, `「${text}」没说清要出哪一招`);
    }
    // 只点到一种就照常交给模型，不因为「提及」词表变宽就拦下来
    for (const text of ['猛攻', '公鸡', '蓄势待发']) {
      assert.equal(readCommand(text).kind, 'route', `「${text}」应交给模型路由`);
    }
  });

  it('正常出招不拦截', () => {
    // 「特别」里的「别」不是否定，带形容词的出招照样生效
    for (const text of ['攻击', '共鸣斩破军', '我要强攻他', '特别强的攻击']) {
      expectKind(text, 'turn');
    }
    for (const text of ['区别', '告别']) {
      expectKind(text, 'route');
    }
  });

  it('点名的对手是打击目标，不是叙述对手的那半句', () => {
    // 目标介词后面的「对手」不是这句话的主语，剥掉就成了没人称的「我要对」
    for (const [text, action] of [
      ['我要对对手强攻。', 'heavy'],
      ['我要对对手普攻', 'light'],
      ['我要对对手格挡', 'guard'],
    ] as const) {
      const command = readCommand(text);
      assert.equal(command.kind, 'turn', `「${text}」应照常出招`);
      if (command.kind === 'turn') assert.equal(command.action, action, `「${text}」读成了 ${command.action}`);
    }
    // 两招并存仍旧拦下：剥掉目标只剩强攻，会让歧义句直接打出强攻
    assert.deepEqual(readCommand('我要对对手普攻，还是强攻'), { kind: 'refused', why: 'ambiguous' });
    // 以对手为主语的子句照旧剥掉，只看自己那半句
    for (const text of ['对手放大招，我格挡', '格挡对手的强攻']) {
      const command = readCommand(text);
      assert.equal(command.kind, 'turn', `「${text}」应照常出招`);
      if (command.kind === 'turn') assert.equal(command.action, 'guard', `「${text}」读成了 ${command.action}`);
    }
  });

  it('多字介词与 ASR 空白后面的对手同样只算打击目标', () => {
    // 「朝着 / 冲着 / 对着 / 向着」是多字介词，只看前一个字符会漏成叙述对手
    for (const [text, action] of [
      ['我要朝着对手强攻。', 'heavy'],
      ['我要冲着对手普攻。', 'light'],
      ['我要对着对手放大招。', 'ult'],
      ['我要向着对手格挡。', 'guard'],
    ] as const) {
      const command = readCommand(text);
      assert.equal(command.kind, 'turn', `「${text}」应照常出招`);
      if (command.kind === 'turn') assert.equal(command.action, action, `「${text}」读成了 ${command.action}`);
    }
    // ASR 在介词后插一个空白，这一手仍是打向对手：两招并存要照样拦下
    for (const text of [
      '我要对 对手普攻，还是强攻',
      '我要朝着对手用普攻，还是强攻',
      '我要冲着对手普攻，还是强攻',
      '我要向着对手普攻，还是强攻',
    ]) {
      assert.deepEqual(readCommand(text), { kind: 'refused', why: 'ambiguous' }, `「${text}」应拦住两招并存`);
    }
  });

  it('对手在蓄力不等于本机蓄力', () => {
    // 「对手回能量」是在描述对手，剥掉对手子句后本机没有出招，也就不能白涨能量
    for (const text of ['对手回能量，我先等等', '对手攒点能量，我先看看', '对手补能量，我先不动']) {
      assert.equal(readCommand(text).kind, 'status', `「${text}」只是描述对手，不能当成我蓄力`);
    }
    // 自己那半句照常执行：剥掉对手子句不影响本机的这一手
    for (const [text, action] of [
      ['对手回能量，我强攻', 'heavy'],
      ['对手回能量，我也回能量', 'charge'],
      ['对手攒能量，我先格挡', 'guard'],
      ['对手攒点能量，我回能量', 'charge'],
    ] as const) {
      const command = readCommand(text);
      assert.equal(command.kind, 'turn', `「${text}」应照常出招`);
      if (command.kind === 'turn') assert.equal(command.action, action, `「${text}」读成了 ${command.action}`);
    }
    // 对手子句里带招式、自己那半句也带招式：歧义判定只看留下的部分
    assert.deepEqual(readCommand('对手先蓄力，我回能量还是强攻'), { kind: 'refused', why: 'ambiguous' });
    // 没有标点的对手子句不剥：这句话到底谁出招没说清，宁可让玩家重说也别替他打出去
    assert.deepEqual(readCommand('对手回能量还是强攻'), { kind: 'refused', why: 'ambiguous' });
  });

  it('问号在去掉标点之前就要认出来', () => {
    for (const text of ['大招？', '大招?']) {
      const command = readCommand(text);
      assert.equal(command.kind, 'route', `「${text}」是问句，不能出招`);
      assert.equal(command.kind === 'route' ? command.question : false, true);
    }
  });
});

describe('问句与规则外的句子交给模型', () => {
  it('带问号或查询口吻的句子一律不执行，由模型分到查询、玩法或闲聊', () => {
    // 有明确疑问词：标记成提问，交给模型分
    for (const text of ['今天天气怎么样', '现在几点', '你是谁', '为什么我输了', '帮我算一下强攻伤害', '能不能讲个笑话']) {
      const command = readCommand(text);
      assert.equal(command.kind, 'route', `「${text}」不应被当作出招`);
      assert.equal(command.kind === 'route' ? command.question : false, true, `「${text}」应标记为提问`);
    }
    // 没有疑问词的祈使句（讲个笑话、1加1等于几、帮我翻译一下这句话）也交给模型：
    // 是不是提问由模型判断，本地不再用话题词表抢先分类
    for (const text of ['讲个笑话', '1加1等于几', '帮我翻译一下这句话']) {
      expectKind(text, 'route');
    }
  });

  it('纯查询不含招式词，本地直接播战况，省一次模型往返', () => {
    for (const text of ['我的能量还剩多少', '现在第几轮', '战况如何', '能量够不够']) {
      expectKind(text, 'status');
    }
  });

  it('问玩法在出招与发起挑战之前', () => {
    for (const text of ['怎么玩', '怎么放大招', '怎么出招']) {
      expectKind(text, 'help');
    }
  });

  it('否定仍优先于疑问', () => {
    expectKind('能不能别打', 'refused');
  });

  it('不是提问的闲聊也交给模型，由它决定是开局、查询还是闲聊', () => {
    for (const text of ['今天挺热', '我饿了', '随便聊聊']) {
      expectKind(text, 'route');
    }
  });
});

describe('命令之间的优先级', () => {
  it('问玩法优先于招式：问规则不能真的出一招', () => {
    for (const text of ['怎么出招', '怎么放大招', '怎么玩']) {
      expectKind(text, 'help');
    }
  });

  it('挑战语义优先于问句：「能不能联机」是发起双人挑战', () => {
    // 这句既是问句又带联机语义，按发起挑战处理，不能只播一句局面
    for (const text of ['能不能联机', '要不要发起挑战', '可不可以发起挑战']) {
      expectKind(text, 'open-room');
    }
  });

  it('问玩法优先于发起挑战：「双人怎么玩」问的是规则', () => {
    for (const text of ['双人怎么玩', '联机怎么操作']) {
      expectKind(text, 'help');
    }
  });

  it('明确否定先于挑战口令：说「不要接受挑战」不能真去换房或重开', () => {
    // 这两句以前落到 join-room / open-room，会真把玩家自己那一局连同对手撤掉
    for (const text of ['不要接受挑战，编号1234', '不要发起挑战']) {
      expectKind(text, 'refused');
    }
    // 否定换成别的说法同样收住，只要 blockReason 认得出是明确否定
    for (const text of ['不用联机', '不想开房', '算了不联机了']) {
      expectKind(text, 'refused');
    }
    // 否定词表认不出的组合也要单独收住：这些说法在基线不会直接执行挑战
    for (const text of ['不接受挑战，编号1234', '别发起挑战', '不挑战你', '别联机了']) {
      expectKind(text, 'refused');
    }
    // 但否定词只是句首客套时仍是发起挑战：别把裸「别/不」当成全局否定
    for (const text of ['别担心，发起挑战吧', '不用怕，联机吧', '别急，发起挑战']) {
      expectKind(text, 'open-room');
    }
    // 肯定口令与反问式入口照旧：问「要不要」不是否定
    assert.deepEqual(readCommand('接受挑战，编号1234'), { kind: 'join-room', code: '1234' });
    expectKind('发起挑战', 'open-room');
    expectKind('要不要发起挑战', 'open-room');
  });

  it('问玩法先于多招式歧义：点到两招是在问区别，不是要同时出两招', () => {
    for (const text of ['普攻和强攻怎么用', '格挡和闪避怎么用', '双人怎么玩']) {
      expectKind(text, 'help');
    }
    // 没有问法的两招仍然判歧义，让玩家重说
    expectKind('普攻和强攻', 'refused');
  });
});


it('强化攻击确定性匹配强攻，普通攻击和否定查询保持原语义',()=>{
 for(const text of ['强化攻击','我要强化攻击','强攻']){const c=readCommand(text);assert.equal(c.kind,'turn');assert.equal(c.kind==='turn'?c.action:null,'heavy');}
 for(const text of ['普通攻击','攻击']){const c=readCommand(text);assert.equal(c.kind,'turn');assert.equal(c.kind==='turn'?c.action:null,'light');}
 assert.equal(readCommand('不要强化攻击').kind,'refused');
 assert.notEqual(readCommand('强化攻击会怎样？').kind,'turn');
});

it('加入意图缺少或错误编号不创建，否定和查询仍不执行',()=>{
 for(const text of ['加入挑战','接受挑战','加入双人挑战','加入房间12345','接受挑战编号123','进房'])assert.deepEqual(readCommand(text),{kind:'join-room',code:''},text);
 for(const text of ['加入挑战1234','加入双人挑战一二三四'])assert.deepEqual(readCommand(text),{kind:'join-room',code:'1234'},text);
 for(const text of ['不要加入挑战','不加入双人挑战','别进房'])assert.equal(readCommand(text).kind,'refused',text);
 assert.deepEqual(readCommand('怎么加入挑战？'),{kind:'route',question:true});
 assert.equal(readCommand('双人怎么玩').kind,'help');
 assert.equal(readCommand('共鸣对决，发起挑战').kind,'open-room');
});
