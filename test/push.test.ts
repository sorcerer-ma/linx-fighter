import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  PUSH_GUEST_WAIT_MS,
  PUSH_IDLE_MS,
  PUSH_IDLE_URGENT_MS,
  PUSH_WAIT_MS,
  createPushEngine,
} from '../src/game/push.js';
import type { BattleState, PendingAttackState } from '../src/game/state.js';

const PENDING_ENEMY: PendingAttackState = { actor: 'enemy', move: 'heavy', moveLabel: '强攻', damage: 5 };
const PENDING_PLAYER: PendingAttackState = { actor: 'player', move: 'light', moveLabel: '普攻', damage: 4 };

/** 直接构造一份页面看到的局面，避免每条用例都真的打一局 */
function view(overrides: Partial<BattleState> = {}): BattleState {
  return {
    room: '1234',
    mode: 'pvp',
    side: 'player',
    phase: 'battle',
    round: 1,
    active: 'player',
    firstMover: 'player',
    pending: null,
    waiting: false,
    you: { name: '我', hp: 10, maxHp: 14, ap: 2, maxAp: 4, ultLeft: 1 },
    opponent: { name: '对手', hp: 10, maxHp: 14, ap: 2, maxAp: 4, ultLeft: 1 },
    winner: null,
    history: [],
    updatedAt: 0,
    ...overrides,
  };
}

describe('主动推送引擎', () => {
  it('第一条快照只建基线，不会把旧局面当成新事件', () => {
    const engine = createPushEngine({ now: () => 0 });
    assert.deepEqual(engine.observe(view()), []);
  });

  it('对手进房时推一次，随后同一局面不再重复', () => {
    let now = 0;
    const engine = createPushEngine({ now: () => now });

    engine.observe(view({ waiting: true, updatedAt: 0 }));
    now = 1_000;
    // 真实加入只改 waiting，对局本身的时间戳不变
    const joined = engine.observe(view({ waiting: false, updatedAt: 0 }));
    assert.equal(joined.length, 1);
    assert.equal(joined[0]?.kind, 'opponent-joined');
    assert.equal(joined[0]?.tone, 'info');
    assert.match(joined[0]?.text ?? '', /对手来了/);
    assert.match(joined[0]?.text ?? '', /对决开始/);

    now = 2_000;
    assert.deepEqual(engine.observe(view({ waiting: false, updatedAt: 0 })), []);
  });

  it('从等人切到单人局、别的房间或新一局，不算对手进房', () => {
    const waiting = view({ waiting: true, room: '1234', updatedAt: 0 });

    let now = 0;
    const solo = createPushEngine({ now: () => now });
    solo.observe(waiting);
    now = 1_000;
    assert.deepEqual(solo.observe(view({ waiting: false, mode: 'solo', room: null, updatedAt: 0 })), []);

    const otherRoom = createPushEngine({ now: () => now });
    otherRoom.observe(waiting);
    assert.deepEqual(otherRoom.observe(view({ waiting: false, room: '5678', updatedAt: 0 })), []);

    const newBattle = createPushEngine({ now: () => now });
    newBattle.observe(waiting);
    assert.deepEqual(newBattle.observe(view({ waiting: false, room: '1234', updatedAt: 1_000 })), []);
  });

  it('上一帧还在等对手应对，下一帧对手已经反击，也要立刻提醒', () => {
    let now = 0;
    const engine = createPushEngine({ now: () => now });
    engine.observe(view({ pending: PENDING_PLAYER, updatedAt: 0 }));

    now = 1_000;
    const counter = engine.observe(view({ pending: PENDING_ENEMY, updatedAt: 1_000 }));
    assert.equal(counter.length, 1);
    assert.equal(counter[0]?.kind, 'opponent-move');
    assert.match(counter[0]?.text ?? '', /对手强攻还没结算/);
  });

  it('对手出招时立刻提醒，之后只补一次应对催促', () => {
    let now = 0;
    const engine = createPushEngine({ now: () => now });
    engine.observe(view());

    now = 1_000;
    const move = engine.observe(view({ pending: PENDING_ENEMY, active: 'player', updatedAt: 1_000 }));
    assert.equal(move.length, 1);
    assert.equal(move[0]?.kind, 'opponent-move');
    assert.equal(move[0]?.tone, 'alert');
    assert.match(move[0]?.text ?? '', /对手强攻还没结算/);
    assert.match(move[0]?.text ?? '', /格挡、闪避，还是承受/);

    now = 1_000 + PUSH_IDLE_URGENT_MS - 1;
    assert.deepEqual(engine.observe(view({ pending: PENDING_ENEMY, updatedAt: 1_000 })), []);

    now = 1_000 + PUSH_IDLE_URGENT_MS;
    const nudge = engine.observe(view({ pending: PENDING_ENEMY, updatedAt: 1_000 }));
    assert.equal(nudge.length, 1);
    assert.equal(nudge[0]?.kind, 'idle-respond');
    assert.equal(nudge[0]?.tone, 'wait');
    assert.match(nudge[0]?.text ?? '', /你定，我照做/);

    now += PUSH_IDLE_URGENT_MS;
    assert.deepEqual(engine.observe(view({ pending: PENDING_ENEMY, updatedAt: 1_000 })), []);
  });

  it('自己回合空闲先轻催、再重催，之后不再开口', () => {
    let now = 0;
    const engine = createPushEngine({ now: () => now });
    engine.observe(view());

    now = PUSH_IDLE_MS - 1;
    assert.deepEqual(engine.observe(view()), []);

    now = PUSH_IDLE_MS;
    const first = engine.observe(view());
    assert.equal(first.length, 1);
    assert.equal(first[0]?.kind, 'idle-turn');
    assert.match(first[0]?.text ?? '', /轮到你出招了/);

    now = PUSH_IDLE_URGENT_MS;
    const second = engine.observe(view());
    assert.equal(second.length, 1);
    assert.equal(second[0]?.kind, 'idle-turn');
    assert.match(second[0]?.text ?? '', /还没听到你的指令/);

    now = PUSH_IDLE_URGENT_MS + 60_000;
    assert.deepEqual(engine.observe(view()), []);
  });

  it('轮询被卡住很久时只发重的那一句，不连发两条', () => {
    let now = 0;
    const engine = createPushEngine({ now: () => now });
    engine.observe(view());

    now = 50_000;
    const messages = engine.observe(view());
    assert.equal(messages.length, 1);
    assert.equal(messages[0]?.kind, 'idle-turn');
    assert.match(messages[0]?.text ?? '', /还没听到你的指令/);
  });

  it('玩家出手后空闲计时重新开始，等对手时只提醒一次', () => {
    let now = 0;
    const engine = createPushEngine({ now: () => now });
    engine.observe(view());

    now = 20_000;
    assert.equal(engine.observe(view()).length, 1); // 第一次轻催

    // 玩家出招：局面变了，接下来该对手应对
    now = 21_000;
    const acted = view({ pending: PENDING_PLAYER, updatedAt: 21_000 });
    assert.deepEqual(engine.observe(acted), []);

    now = 21_000 + PUSH_WAIT_MS;
    const wait = engine.observe(view({ pending: PENDING_PLAYER, updatedAt: 21_000 }));
    assert.equal(wait.length, 1);
    assert.equal(wait[0]?.kind, 'wait-opponent');
    assert.match(wait[0]?.text ?? '', /我陪你等着/);

    now += PUSH_WAIT_MS;
    assert.deepEqual(engine.observe(view({ pending: PENDING_PLAYER, updatedAt: 21_000 })), []);
  });

  it('房间一直没人加入时提醒一次，没有房间号就不推', () => {
    let now = 0;
    const engine = createPushEngine({ now: () => now });
    engine.observe(view({ waiting: true }));

    now = PUSH_GUEST_WAIT_MS - 1;
    assert.deepEqual(engine.observe(view({ waiting: true })), []);

    now = PUSH_GUEST_WAIT_MS;
    const messages = engine.observe(view({ waiting: true }));
    assert.equal(messages.length, 1);
    assert.equal(messages[0]?.kind, 'wait-guest');
    assert.match(messages[0]?.text ?? '', /编号1234还等着对方接受/);

    now += PUSH_GUEST_WAIT_MS;
    assert.deepEqual(engine.observe(view({ waiting: true })), []);

    const noRoom = createPushEngine({ now: () => now });
    noRoom.observe(view({ waiting: true, room: null }));
    now += PUSH_GUEST_WAIT_MS;
    assert.deepEqual(noRoom.observe(view({ waiting: true, room: null })), []);
  });

  it('重连后不会立刻催上一局留下的空闲', () => {
    let now = 10_000;
    const engine = createPushEngine({ now: () => now });
    const stale = view({ updatedAt: 0 });

    assert.deepEqual(engine.observe(stale), []);

    now = 10_000 + PUSH_IDLE_MS - 1;
    assert.deepEqual(engine.observe(stale), []);

    now = 10_000 + PUSH_IDLE_MS;
    assert.equal(engine.observe(stale).length, 1);
  });

  it('终局不推，避免和玩家那次行动的回复重复', () => {
    let now = 0;
    const engine = createPushEngine({ now: () => now });
    engine.observe(view());

    now = 1_000;
    const ended = view({ phase: 'victory', winner: 'player', updatedAt: 1_000 });
    assert.deepEqual(engine.observe(ended), []);

    now = 100_000;
    assert.deepEqual(engine.observe(ended), []);
  });

  it('局面消失后清空基线，新一局重新起算', () => {
    let now = 0;
    const engine = createPushEngine({ now: () => now });
    engine.observe(view());

    now = 1_000;
    assert.deepEqual(engine.observe(null), []);

    now = 2_000;
    assert.deepEqual(engine.observe(view({ updatedAt: 2_000 })), []);
  });

  it('触发表按视角判断：对方出招才提醒，自己出招不提醒', () => {
    let now = 0;
    const engine = createPushEngine({ now: () => now });
    engine.observe(view());

    now = 1_000;
    const own = engine.observe(view({ pending: PENDING_PLAYER, updatedAt: 1_000 }));
    assert.deepEqual(own, []);
  });

  it('能量刚够大招时推一次，同一就绪状态不重复', () => {
    let now = 0;
    const base = view({ you: { ...view().you, ap: 3 } });
    const engine = createPushEngine({ now: () => now });
    engine.observe(base);

    now = 1_000;
    const ready = engine.observe(view({ you: { ...base.you, ap: 4 }, updatedAt: 1_000 }));
    assert.equal(ready.length, 1);
    assert.equal(ready[0]?.kind, 'ult-ready');
    assert.equal(ready[0]?.tone, 'info');
    assert.match(ready[0]?.text ?? '', /大招已经就绪/);

    now = 2_000;
    assert.deepEqual(engine.observe(view({ you: { ...base.you, ap: 4 }, updatedAt: 1_000 })), []);
  });

  it('只靠能量变化也能识别就绪，不依赖局面时间戳', () => {
    let now = 0;
    const base = view({ you: { ...view().you, ap: 3 }, updatedAt: 0 });
    const engine = createPushEngine({ now: () => now });
    engine.observe(base);

    now = 1_000;
    const ready = engine.observe(view({ you: { ...base.you, ap: 4 }, updatedAt: 0 }));
    assert.equal(ready.length, 1);
    assert.equal(ready[0]?.kind, 'ult-ready');
  });

  it('大招已用完或本来就够时，不提示就绪', () => {
    let now = 0;
    const used = view({ you: { ...view().you, ap: 3, ultLeft: 0 } });
    const engine = createPushEngine({ now: () => now });
    engine.observe(used);
    now = 1_000;
    assert.deepEqual(engine.observe(view({ you: { ...used.you, ap: 4 }, updatedAt: 1_000 })), []);

    const already = createPushEngine({ now: () => now });
    const full = view({ you: { ...view().you, ap: 4 } });
    already.observe(full);
    now = 2_000;
    assert.deepEqual(already.observe(view({ you: { ...full.you, ap: 5 }, updatedAt: 2_000 })), []);
  });

  it('同一帧对手出招与大招就绪同时发生，先报更急的对手动作', () => {
    let now = 0;
    const base = view({ you: { ...view().you, ap: 3 } });
    const engine = createPushEngine({ now: () => now });
    engine.observe(base);

    now = 1_000;
    const both = engine.observe(
      view({ you: { ...base.you, ap: 4 }, pending: PENDING_ENEMY, updatedAt: 1_000 }),
    );
    assert.equal(both.length, 1);
    assert.equal(both[0]?.kind, 'opponent-move');
  });
});
