import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readCommand } from '../src/game/command.js';
import { ECHO_RULES, echoAck, looksLikeAssistantEcho, matchEchoRule } from '../src/game/crosstalk.js';
import { createBattle } from '../src/game/engine.js';
import {
  narrateActionBlocked,
  narrateAutoStart,
  narrateBattleStart,
  narrateCatchUp,
  narrateChant,
  narrateEcho,
  narrateHelp,
  narrateNoBattle,
  narrateOpening,
  narrateOtherDeviceTurn,
  narrateOtherDeviceWaiting,
  narrateRejection,
  narrateRoomCreated,
  narrateRoomFull,
  narrateRoomInvalid,
  narrateRoomJoined,
  narrateRoomMissing,
  narrateSeatListening,
  narrateStaleAction,
  narrateStatus,
  narrateTurn,
  narrateUnknownAction,
  narrateWaitingRoom,
} from '../src/game/narrator.js';
import { GameService, type GameServiceDeps } from '../src/game/service.js';
import type { Battle, BattleEvent } from '../src/game/types.js';
import { createLogger } from '../src/log.js';
import { BattleStore } from '../src/store/battles.js';
import { RoomStore } from '../src/store/rooms.js';

const HOST = 'device-a#agent-1';
const GUEST = 'device-b#agent-2';
const SOLO = 'device-s#agent-9';

function battle(firstMover: 'player' | 'enemy' = 'player', mode: 'solo' | 'pvp' = 'solo'): Battle {
  return createBattle({ now: 0, seed: 1, firstMover, mode });
}

/** 一次攻击结算的事件：字段与引擎实际产出保持一致 */
function attack(over: Partial<Extract<BattleEvent, { type: 'attack' }>> = {}): BattleEvent[] {
  return [
    {
      type: 'attack',
      round: 1,
      side: 'player',
      move: 'heavy',
      response: 'guard',
      dodged: false,
      crit: false,
      guarded: true,
      forced: false,
      damage: 3,
      targetHp: 15,
      ...over,
    },
  ];
}

/** 一句播报最多两句，句内不超过 60 字，与 narrator.test.ts 同口径 */
function assertSpeakable(text: string): void {
  const sentences = text.split(/[。！？]/).filter((part) => part.trim().length > 0);
  assert.ok(sentences.length <= 2, `最多两句，实际 ${sentences.length} 句：${text}`);
  for (const sentence of sentences) {
    assert.ok(sentence.length <= 60, `单句过长（${sentence.length} 字）：${sentence}`);
  }
}

/**
 * 服务真正会念出口的句子：全部由 narrator 自己生成。
 * 改播报文案却忘了同步 crosstalk.ts 的规则时，这里会立刻失败。
 */
function realBroadcasts(): string[] {
  const idle = battle();
  const theirs = battle('enemy');
  const pendingEnemy = battle();
  pendingEnemy.pending = { actor: 'enemy', move: 'heavy', damage: 5 };
  const pendingMine = battle('player', 'pvp');
  pendingMine.pending = { actor: 'player', move: 'light', damage: 3 };
  const waitingRoom = battle('player', 'pvp');
  const won = battle();
  won.phase = 'victory';
  const lost = battle();
  lost.phase = 'defeat';
  const poor = battle();
  poor.player.ap = 1;

  return [
    narrateBattleStart(idle),
    narrateOpening(idle),
    narrateOpening(pendingEnemy),
    narrateAutoStart(idle),
    narrateStatus(idle),
    narrateStatus(theirs),
    narrateStatus(pendingEnemy),
    narrateStatus(pendingMine),
    narrateStatus(waitingRoom, { waiting: true }),
    narrateStatus(won),
    narrateStatus(lost),
    narrateTurn(idle, [{ type: 'charge', round: 1, side: 'player', ap: 4 }]),
    narrateTurn(idle, attack()),
    narrateTurn(idle, attack({ dodged: true, damage: 0 })),
    narrateTurn(idle, attack({ side: 'enemy', round: 2, response: 'dodge', dodged: false, damage: 7, targetHp: 11 })),
    narrateTurn(idle, attack({ side: 'enemy', round: 2, response: 'take', forced: true, damage: 5, targetHp: 9 })),
    narrateTurn(idle, [{ type: 'pending', round: 1, side: 'enemy', move: 'ult' }]),
    narrateTurn(idle, [{ type: 'round-start', round: 3, bonus: 2 }]),
    narrateChant('共鸣斩破军'),
    narrateRoomCreated('1234'),
    narrateRoomJoined('1234'),
    narrateWaitingRoom('1234'),
    narrateRoomMissing('1234'),
    narrateRoomFull('1234'),
    narrateRoomInvalid(),
    narrateActionBlocked('negated'),
    narrateActionBlocked('ambiguous'),
    narrateStaleAction(),
    narrateUnknownAction(null),
    narrateUnknownAction(idle),
    narrateUnknownAction(pendingEnemy),
    narrateUnknownAction(pendingMine),
    narrateUnknownAction(theirs),
    narrateRejection(pendingEnemy, { reason: 'wrong-stage', action: 'guard' }),
    narrateRejection(poor, { reason: 'insufficient-ap', action: 'ult' }),
    narrateRejection(idle, { reason: 'no-ult', action: 'ult' }),
    narrateRejection(idle, { reason: 'full-ap', action: 'charge' }),
    narrateRejection(won, { reason: 'ended', action: 'light' }),
    narrateNoBattle(),
    narrateHelp(),
    narrateCatchUp(['对手强攻，我格挡，掉3点生命值，剩11']),
    narrateEcho(),
    narrateOtherDeviceTurn(),
    narrateOtherDeviceWaiting(),
    narrateSeatListening('红方'),
    narrateSeatListening('蓝方'),
    narrateTurn(pendingMine, [{ type: 'pending', round: 1, side: 'player', move: 'ult' }]),
    narrateTurn(pendingEnemy, [{ type: 'pending', round: 1, side: 'enemy', move: 'ult' }]),
    narrateStatus(pendingMine),
    narrateStatus(pendingEnemy),
    narrateRejection(pendingMine, { reason: 'insufficient-ap', action: 'ult' }),
  ];
}

/** 真机日志里的原句与旧版播报：现场固件还可能念这些 */
const legacyPhrases = [
  '对手一记普攻',
  '你已经出手了，等对手应对',
  '轮到你出招',
  '主动阶段可以说普攻、强攻、大招或蓄力',
  '轮到我们了，大招',
  '你已经出招，这一手等对手应对',
  '能量耗尽',
];

/** 玩家正常指挥时说得出的话：一句都不能被当成回灌，否则玩家喊了没反应 */
const playerPhrases = [
  '普攻',
  '强攻',
  '大招',
  '蓄力',
  '格挡',
  '闪避',
  '承受',
  '我出普攻',
  '我要大招',
  '我出一记强化普攻',
  '我要对对手放大招',
  '我先蓄力',
  '我的大招还剩几次',
  '对手的大招还剩几次',
  '不要大招',
  '大招还是强攻',
  '特别强的攻击',
  '能不能放大招',
  '格挡对手的强攻',
  '如果对手强攻，我就格挡',
  '我要对对手强攻',
  '轮到我了，普攻',
  '我还有14点生命值，普攻',
  '我还有14点生命值普攻',
  '我还有14点生命值，攻击',
  '第3轮了，普攻',
  '第3轮了，攻击',
  '我能量已经满了，普攻',
  '我能量已经满了，防御',
  '战况如何',
  '怎么玩',
  '双人怎么玩',
  '开始游戏',
  '加入房间1234',
  '开房间',
  '联机',
  '带我打一局',
  '你是谁',
  '今天天气不错',
  '',
];

/** 播报按句切开：装置分段收音时，任何一句单独回灌都要认得出 */
function sentences(text: string): string[] {
  return text
    .split(/[。！？]/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/** 读成某一招：kind 与招式一起断言 */
function expectTurn(text: string, action: string): void {
  const command = readCommand(text);
  assert.equal(command.kind, 'turn', `「${text}」应读成出招，实际 ${command.kind}`);
  if (command.kind === 'turn') assert.equal(command.action, action, `「${text}」读成了 ${command.action}`);
}

describe('回灌识别', () => {
  it('伙伴真正会念出口的每一句都被判成回灌', () => {
    for (const text of realBroadcasts()) {
      assert.ok(text.length > 0, '播报不应为空');
      assert.equal(looksLikeAssistantEcho(text), true, `没认出这句播报：${text}`);
      // 逐句再判一次：装置会分段收音，整段能认不等于单句能认
      const parts = sentences(text);
      assert.ok(parts.length > 0, `播报应能切出句子：${text}`);
      for (const part of parts) {
        assert.equal(looksLikeAssistantEcho(part), true, `没认出这句播报：${part}（整段：${text}）`);
      }
    }
  });

  it('自己出手的首句单独回灌也不会真放一招', () => {
    // 真机踩过的坑：整句能命中「等对手应对」，但首句单独出现时没有规则管，
    // 于是「我出大招，接招！」被读成出招，扣掉能量还耗掉这一局的大招
    for (const move of ['普攻', '强攻', '大招', '蓄力']) {
      const first = `我出${move}，接招！`;
      assert.equal(matchEchoRule(first), 'attack-declared', first);
      assert.equal(readCommand(first).kind, 'echo', first);
    }
    assert.equal(matchEchoRule('我出大招，接招！等对手应对'), 'attack-declared');
    assert.equal(matchEchoRule('等对手应对'), 'await-opponent');
    assert.equal(matchEchoRule('我出大招，接招'), 'attack-declared');
    assert.equal(readCommand('我出大招，接招！等对手应对').kind, 'echo');
  });

  it('播报的第二句是下一步说明，单独回灌也不能被当成指令', () => {
    // 这几句都是现役播报的第二句：漏判就会被当成开局、出招或直接应招
    assert.equal(readCommand('说「开始游戏」可以再来一局').kind, 'echo');
    assert.equal(readCommand('可以说普攻、强攻、大招、蓄力').kind, 'echo');
    assert.equal(readCommand('可以先蓄力，或者换一招').kind, 'echo');
    assert.equal(readCommand('现在只能承受，硬吃这一下').kind, 'echo');
    assert.equal(readCommand('想出手就直接说招式').kind, 'echo');
    assert.equal(readCommand('重新说一次要出的招').kind, 'echo');
    assert.equal(readCommand(narrateSeatListening('红方')).kind, 'echo');
  });

  it('每条规则都被真实播报或现场旧句命中，规则表不是写死的摆设', () => {
    // 与 crosstalk.ts 里的 squash 同口径：逐条确认规则本身有效，不看谁先命中
    const squash = (text: string): string =>
      text
        .trim()
        .toLowerCase()
        .replace(/[\s，,。．.!！?？、"“”'‘’：:；;～~…·]/g, '');
    const pool = [...realBroadcasts(), ...legacyPhrases].map(squash);
    for (const rule of ECHO_RULES) {
      assert.ok(
        pool.some((text) => rule.pattern.test(text)),
        `规则 ${rule.name} 没有被任何真实播报或现场旧句命中`,
      );
    }
  });

  it('真人正常指挥一律不误判', () => {
    for (const text of playerPhrases) {
      assert.equal(looksLikeAssistantEcho(text), false, `真指令被误判成回灌：${text}`);
    }
  });

  it('真机日志里的回灌原句逐句命中', () => {
    for (const text of legacyPhrases) {
      assert.equal(looksLikeAssistantEcho(text), true, `真机回灌原句没认出：${text}`);
    }
  });

  it('真机回访：问状态不会被当成播报回灌，也不再闷不吭声', () => {
    // 两句都是现场实测：以前命中 ap-short / turn-hint 规则，答完「嗯」就没声了
    assert.equal(looksLikeAssistantEcho('我只有3点能量'), false);
    assert.equal(looksLikeAssistantEcho('轮到你了吗'), false);
    assert.equal(readCommand('我只有3点能量').kind, 'status');
    assert.equal(readCommand('轮到你了吗').kind, 'status');
    // 播报原句带消耗半句，照旧认回灌
    assert.equal(matchEchoRule('我只有3点能量，大招要4点。'), 'ap-short');
    assert.equal(matchEchoRule('轮到你出招'), 'turn-hint');
  });

  it('玩家带问号问状态不再被吞成「嗯」，播报自己的问句照旧算回灌', () => {
    // squash 抹掉问号后 `[?？]` 是死分支：玩家问资源会被当成播报闷声回「嗯」
    assert.equal(readCommand('我还有5点生命值？').kind, 'status');
    assert.equal(readCommand('第几轮了？').kind, 'status');
    assert.equal(readCommand('我还剩几次大招？').kind, 'status');
    assert.equal(readCommand('我只有3点能量？').kind, 'status');
    // 播报自己会问玩家「还是承受？」，这类问号不能被当成玩家提问
    assert.equal(matchEchoRule('我该格挡、闪避，还是承受？'), 'pending-choice');
    assert.equal(readCommand('对手强攻还没结算，我该格挡、闪避，还是承受？').kind, 'echo');
  });

  it('报了数值再补一句招式，这一声是在下指令', () => {
    // 真机踩过：这两句被判成回灌，刚开局轮到玩家时只回「嗯。」，普攻根本没出去
    for (const text of ['轮到我了，普攻', '我还有14点生命值，普攻']) {
      assert.equal(looksLikeAssistantEcho(text), false, `真指令被误判成回灌：${text}`);
      expectTurn(text, 'light');
    }
    // 只报数值的播报照旧算回灌：没有第二句招式，就不是在指挥
    assert.equal(readCommand('第1轮，我14点生命值、3点能量，对手18点生命值、3点能量').kind, 'echo');
    // 回合提示里的招式词是播报的一部分，不能被当成独立指令
    assert.equal(readCommand('轮到我们了，大招').kind, 'echo');
    assert.equal(matchEchoRule('轮到你出招'), 'turn-hint');
  });

  it('数值后面的招式不带标点或换了别名，也照样进命令解析', () => {
    // 评论复现：ASR 不给逗号、或者玩家说的是「攻击」这类别名时，数值片段会把它一起吞掉
    for (const [text, action] of [
      ['我还有14点生命值普攻', 'light'],
      ['我还有14点生命值，攻击', 'light'],
      ['第3轮了，攻击', 'light'],
      ['我能量已经满了，防御', 'guard'],
    ] as const) {
      assert.equal(looksLikeAssistantEcho(text), false, `真指令被误判成回灌：${text}`);
      expectTurn(text, action);
    }
    // 数值后面还跟着别的描述、或播报在解释不能出手时，照旧算回灌
    assert.equal(matchEchoRule('我只有3点能量，大招要4点。'), 'ap-short');
    assert.equal(matchEchoRule('第1轮，我14点生命值、3点能量，对手18点生命值、3点能量'), 'hp-report');
    assert.equal(matchEchoRule('我能量已经满了，不用再蓄力，直接出招。'), 'ap-full');
  });

  it('真人把对手当主语叙述时判回灌：那不是替我出招', () => {
    assert.equal(matchEchoRule('对手普攻'), 'opponent-narration');
    assert.equal(matchEchoRule('对手一记普攻'), 'legacy-attack');
    assert.equal(matchEchoRule('对手强攻，我格挡，掉3点生命值'), 'hp-result');
    // 说了「我要 / 我就」就是在下指令，条件句也得交给规则引擎去读
    assert.equal(looksLikeAssistantEcho('如果对手强攻，我就格挡'), false);
    assert.equal(readCommand('对手普攻').kind, 'echo');
    // 同一句里报了自己的应对，就是在指挥我：让位给规则引擎
    assert.equal(matchEchoRule('对手普攻，我格挡'), null);
    // 叙述对手的子句不算本机的招式：剥掉后只剩格挡，不该被当成「两种招式」
    expectTurn('对手普攻，我格挡', 'guard');
    expectTurn('对手放大招，我格挡', 'guard');
    // 口语更喜欢说「对面」
    assert.equal(matchEchoRule('对面放大招'), 'opponent-narration');
    expectTurn('对面放大招，我格挡', 'guard');
    expectTurn('格挡对手的强攻', 'guard');
    // 自己真点了两招仍旧拦下，让它提示重说
    assert.equal(readCommand('大招还是强攻').kind, 'refused');
    // 「对对手放大招」里的对手是目标，不能被剥掉
    expectTurn('我要对对手放大招', 'ult');
    expectTurn('我要强攻对手', 'heavy');
  });
});

describe('读命令时的归属判定', () => {
  it('真机日志里的回灌原句不会被当成指令', () => {
    for (const text of legacyPhrases) {
      assert.equal(readCommand(text).kind, 'echo', text);
    }
  });

  it('房间播报与唤出回念不会自己踩自己', () => {
    // 房间播报里带着「加入房间1234」，判晚了就成了自己加入自己的房间
    assert.equal(readCommand(narrateRoomCreated('1234')).kind, 'echo');
    assert.equal(readCommand(narrateWaitingRoom('1234')).kind, 'echo');
    assert.equal(readCommand(narrateRoomMissing('1234')).kind, 'echo');
    // 唤出回念里带着招式词，判晚了就成了二次出招
    assert.equal(readCommand(narrateChant('共鸣斩破军')).kind, 'echo');
    assert.equal(readCommand(narrateBattleStart(battle())).kind, 'echo');
  });

  it('玩家正常说法照旧走原来的分支', () => {
    assert.equal(readCommand('普攻').kind, 'turn');
    assert.equal(readCommand('我出普攻').kind, 'turn');
    assert.equal(readCommand('加入房间1234').kind, 'join-room');
    assert.equal(readCommand('战况如何').kind, 'status');
    assert.equal(readCommand('开始游戏').kind, 'start');
    // 闲聊问句：规则不接，交给模型路由去答
    assert.equal(readCommand('你是谁').kind, 'route');
  });

  it('目标介词后面的对手是打击对象，不是这句话的主语', () => {
    // 「我要对对手普攻，还是强攻」原先整段剥到只剩「我要对」，两种招式被漏成强攻
    const both = readCommand('我要对对手普攻，还是强攻');
    assert.equal(both.kind, 'refused');
    if (both.kind === 'refused') assert.equal(both.why, 'ambiguous');
    // 点名打谁的那一手照旧解析出来，不能因为提到对手就变成没听清
    expectTurn('我要对对手强攻。', 'heavy');
    expectTurn('我要对对手普攻', 'light');
    expectTurn('我要对对手格挡', 'guard');
    expectTurn('我要强攻对手', 'heavy');
    // 「对手的大招」这类名词短语仍是叙述，剥掉后只看自己那半句
    expectTurn('格挡对手的强攻', 'guard');
    expectTurn('我要对对手放大招', 'ult');
  });
});

describe('回灌后的极短应答', () => {
  it('第一次回灌只答一个字，静默期内不再开口', () => {
    assert.equal(echoAck('ack-once#agent', narrateHelp(), 1_000), '嗯。');
    assert.equal(echoAck('ack-once#agent', narrateRoomCreated('1234'), 1_500), '');
    assert.equal(echoAck('ack-once#agent', narrateBattleStart(battle()), 2_999), '');
    assert.equal(echoAck('ack-once#agent', narrateHelp(), 3_000), '嗯。');
  });

  it('不同设备各记各的静默期', () => {
    assert.equal(echoAck('ack-a#agent', narrateHelp(), 10_000), '嗯。');
    assert.equal(echoAck('ack-b#agent', narrateHelp(), 10_000), '嗯。');
  });

  it('自己那句「嗯」再被收一遍也不开口，两台设备不会互相点头', () => {
    assert.equal(echoAck('ack-loop#agent', narrateEcho(), 20_000), '');
    assert.equal(echoAck('ack-loop#agent', '嗯嗯', 20_000), '');
    assert.equal(echoAck('ack-loop#agent', '恩。', 20_000), '');
  });

  it('静默记录有上限，堆满后先清掉过期的', () => {
    // 先攒满记录：同一时刻进来的设备都还在静默期里，不会被清掉
    for (let i = 0; i < 600; i += 1) echoAck(`ack-bulk-${i}#agent`, narrateHelp(), 30_000);
    // 半分钟后新设备开口：过期记录被清掉，它照样能听到应答
    assert.equal(echoAck('ack-bulk-new#agent', narrateHelp(), 60_000), '嗯。');
    assert.equal(echoAck('ack-bulk-new#agent', narrateHelp(), 60_001), '');
  });

  it('应答本身够短、不带问句，也不会复读播报', () => {
    assert.equal(narrateEcho(), '嗯。');
    assert.doesNotMatch(narrateEcho(), /[？?]/);
    assert.ok(narrateEcho().length <= 6);
  });
});

describe('他机指令降噪', () => {
  it('双人局里轮到对手时只回最短事实，单人局保持原提示', () => {
    assert.equal(narrateUnknownAction(battle('enemy', 'pvp')), '还没轮到我出招。');
    assert.equal(narrateRejection(battle('enemy', 'pvp'), { reason: 'wrong-stage', action: 'guard' }), '还没轮到我出招。');
    // 单人局没有跨设备问题，保留原来的引导句
    assert.equal(narrateUnknownAction(battle('enemy')), '还没轮到我出招，等对手先动。');
    assert.equal(narrateRejection(battle('enemy'), { reason: 'wrong-stage', action: 'guard' }), '还没轮到我出招，等对手先动。');
  });

  it('本机已出招等对手应对时也只回最短事实', () => {
    const mine = battle('player', 'pvp');
    mine.pending = { actor: 'player', move: 'light', damage: 3 };
    assert.equal(narrateUnknownAction(mine), '这一手等对手应对。');
    assert.equal(narrateRejection(mine, { reason: 'waiting-opponent', action: 'light' }), '这一手等对手应对。');
    assertSpeakable(narrateOtherDeviceWaiting());
    assertSpeakable(narrateOtherDeviceTurn());
  });
});

describe('串音落地到对局', () => {
  it('回灌原话不推进对局、不消耗资源，只答一个字', async () => {
    const { service } = setup();
    const started = await service.start(SOLO);
    assert.ok(started.battle);

    const echoed = await service.say(SOLO, '对手一记普攻');
    assert.equal(echoed.text, '嗯。');
    assert.deepEqual(echoed.battle, started.battle);
    assert.equal(echoed.battle?.history.length, 0);

    // 同一台设备接着被回灌一遍：静默期内不再开口，环路断在这里
    const again = await service.say(SOLO, narrateBattleStart(started.battle!));
    assert.equal(again.text, '');
    assert.deepEqual(again.battle, started.battle);
  });

  it('首句回灌不会真的放掉一招', async () => {
    const { service } = setup();
    const started = await service.start(SOLO);
    const before = started.battle;
    assert.ok(before);

    // 这就是漏判时最贵的一句：读成出招会扣能量、耗掉本局大招、推进轮次
    const echoed = await service.say(SOLO, '我出大招，接招！');
    assert.equal(echoed.text, '嗯。');
    assert.deepEqual(echoed.battle, before);
    assert.equal(echoed.battle?.player.ap, before.player.ap);
    assert.equal(echoed.battle?.player.ultLeft, before.player.ultLeft);
    assert.equal(echoed.battle?.history.length, 0);
  });

  it('房间播报回灌不会替玩家开房，也不会自己加入自己的房间', async () => {
    const { service, rooms } = setup();
    const echoed = await service.say(HOST, narrateRoomCreated('1234'));
    assert.equal(echoed.text, '嗯。');
    assert.equal(echoed.battle, null);
    assert.equal(rooms.size, 0);
  });

  it('双人局里对方的播报不会替本机应招', async () => {
    const { service } = setup();
    await service.start(HOST, { mode: 'pvp' });
    const code = findRoom(service, HOST);
    await service.start(GUEST, { room: code });

    const hostBefore = service.status(HOST).battle;
    assert.ok(hostBefore);
    const echoed = await service.say(HOST, '对手这一手还没结算，我只能格挡、闪避或承受');
    assert.equal(echoed.text, '嗯。');
    assert.deepEqual(echoed.battle, hostBefore);
  });

  it('双人局里出手后重复喊招式，只回最短事实', async () => {
    const { service } = setup();
    await service.start(HOST, { mode: 'pvp' });
    const code = findRoom(service, HOST);
    await service.start(GUEST, { room: code });

    assert.match((await service.say(HOST, '普攻')).text, /我出普攻/);
    const repeated = await service.say(HOST, '强攻');
    assert.equal(repeated.text, '这一手等对手应对。');
    // 双人局要等对手应招才结算，这一手仍然挂在待应对上，没有被重复执行
    assert.equal(repeated.battle?.pending?.actor, 'player');
    assert.equal(repeated.battle?.history.length, 0);
  });

  it('双人局里替对手设备喊招，只回最短事实且不结算', async () => {
    const { service } = setup();
    await service.start(HOST, { mode: 'pvp' });
    const code = findRoom(service, HOST);
    await service.start(GUEST, { room: code });

    const guestTried = await service.say(GUEST, '普攻');
    assert.equal(guestTried.text, '还没轮到我出招。');
    assert.equal(guestTried.battle?.history.length, 0);
  });

  it('轮到我了、报完生命值再补的招式，在刚开局的单人局里真的出得去', async () => {
    // 评论复现：这几句被判成回灌，刚开局轮到玩家时只回「嗯。」或空串，能量和回合都不动。
    // 没有逗号、或者玩家说的是「攻击」这类别名，也必须真的出手。
    for (const text of [
      '轮到我了，普攻',
      '我还有14点生命值，普攻',
      '我还有14点生命值普攻',
      '我还有14点生命值，攻击',
    ]) {
      const { service } = setup();
      const started = await service.start(SOLO);
      const before = started.battle;
      assert.ok(before);

      const said = await service.say(SOLO, text);
      assert.match(said.text, /^我普攻/, text);
      assert.equal(said.battle?.history.length, 1, text);
      assert.equal(said.battle?.player.ap, before.player.ap - 1, text);
    }
  });

  it('点名对手的明确招式照旧执行，一句话里两种招式仍然拦下', async () => {
    // 评论复现：这些话原先都读不对——明确的一手被剥掉，两招并存时又漏判成强攻
    for (const text of ['我要对对手强攻。', '我要朝着对手强攻。', '我要冲着对手强攻。']) {
      const { service } = setup();
      const started = await service.start(SOLO);
      const before = started.battle;
      assert.ok(before);
      const heavyHit = await service.say(SOLO, text);
      assert.match(heavyHit.text, /^我强攻/, text);
      assert.equal(heavyHit.battle?.history.length, 1, text);
      assert.equal(heavyHit.battle?.player.ap, before.player.ap - 2, text);
    }

    for (const text of ['我要对对手普攻，还是强攻', '我要朝着对手用普攻，还是强攻', '我要对 对手普攻，还是强攻']) {
      const { service } = setup();
      const fresh = await service.start(SOLO);
      assert.ok(fresh.battle);
      const blocked = await service.say(SOLO, text);
      assert.match(blocked.text, /两种招式/, text);
      // 歧义句既不耗资源也不推进对局，只让玩家重说
      assert.deepEqual(blocked.battle, fresh.battle, text);
    }
  });
});

/** 每个用例换一个时间基准：静默记录是模块级的，别让用例互相影响 */
let clockBase = 1_000_000;

function setup(overrides: Partial<GameServiceDeps> = {}) {
  clockBase += 10_000;
  let now = clockBase;
  const store = new BattleStore({ ttlMs: 60_000, now: () => now });
  const rooms = new RoomStore({ ttlMs: 60_000, now: () => now, random: () => 0 });
  const service = new GameService({
    store,
    rooms,
    logger: createLogger('error'),
    now: () => now,
    random: () => 0,
    ...overrides,
  });
  return {
    store,
    rooms,
    service,
    advance(ms: number): void {
      now += ms;
    },
  };
}

function findRoom(service: GameService, host: string): string {
  const match = service.status(host).text.match(/房间(\d{4})/);
  assert.ok(match, `战况里应带房间号：${service.status(host).text}`);
  return match[1]!;
}
