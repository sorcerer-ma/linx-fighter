import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createBattle } from '../src/game/engine.js';
import { pvpBattleKey } from '../src/game/pvp.js';
import { dropRoom, seatOf, tableFor, type TableDeps } from '../src/game/table.js';
import { createLogger } from '../src/log.js';
import { BattleStore } from '../src/store/battles.js';
import { EchoStore } from '../src/store/echoes.js';
import { RoomStore } from '../src/store/rooms.js';

/**
 * 桌子抽象的单测：单人桌与双人桌只看键、座位、镜像与补账归属，
 * 不经过 HTTP/引擎，补的是 service 测试里没走到的分支。
 */

/** 记录 clear 调用的补账存储包装：验证 dropRoom 只清该清的人 */
function recordingEcho(): { echo: EchoStore; cleared: string[] } {
  const inner = new EchoStore({ ttlMs: 60_000 });
  const cleared: string[] = [];
  const echo = {
    push: (key: string, line: string) => inner.push(key, line),
    take: (key: string) => inner.take(key),
    clear: (key: string) => {
      cleared.push(key);
      inner.clear(key);
    },
    sweep: () => inner.sweep(),
  } as unknown as EchoStore;
  return { echo, cleared };
}

function makeDeps(echo: EchoStore = new EchoStore({ ttlMs: 60_000 })): TableDeps & {
  rooms: RoomStore;
  store: BattleStore;
} {
  return {
    store: new BattleStore({ ttlMs: 60_000 }),
    rooms: new RoomStore({ ttlMs: 60_000, random: () => 0 }),
    echo,
    logger: createLogger('error'),
  };
}

describe('座位解析', () => {
  it('房主是 player、加入者是 enemy，其他人没有座位', () => {
    const room = {
      code: '1234',
      hostKey: 'host#1',
      guestKey: 'guest#1',
      createdAt: 0,
      updatedAt: 0,
    };
    assert.equal(seatOf(room, 'host#1'), 'player');
    assert.equal(seatOf(room, 'guest#1'), 'enemy');
    assert.equal(seatOf(room, 'stranger#1'), null);
    assert.equal(seatOf({ ...room, guestKey: null }, 'guest#1'), null);
  });
});

describe('单人桌', () => {
  it('键就是玩家键，没有房间也没有对手', () => {
    const deps = makeDeps();
    const me = 'dev-a#agent';
    const table = tableFor(deps, me);

    assert.equal(table.key, me);
    assert.equal(table.room, null);
    assert.equal(table.waiting(), false);
    assert.equal(table.echoTo('player'), null);
    assert.equal(table.seat(me), 'player');
    assert.equal(table.seat('other#1'), null);

    assert.equal(table.battle(), null);
    const battle = createBattle({ now: Date.now(), seed: 0 });
    deps.store.set(me, battle);
    assert.equal(table.battle()?.player.hp, battle.player.hp);
    assert.equal(table.view(me)?.player.hp, battle.player.hp);
    assert.equal(table.view('other#1'), null);
    // 单人局没有镜像：结算结果原样返回
    assert.equal(table.canonical(battle, 'player', battle), battle);
  });

  it('stillHere 要求本人、player 座位且当前不在任何房间', () => {
    const deps = makeDeps();
    const me = 'dev-a#agent';
    const table = tableFor(deps, me);

    assert.equal(table.stillHere(me, 'player'), true);
    assert.equal(table.stillHere('other#1', 'player'), false);
    assert.equal(table.stillHere(me, 'enemy'), false);

    // 一旦加了房间，单人桌就不该再认这一手
    deps.rooms.create(me);
    assert.equal(table.stillHere(me, 'player'), false);
  });
});

describe('双人桌', () => {
  it('按房间键存对局，房主看基准、加入者看左右互换', () => {
    const deps = makeDeps();
    const host = 'dev-a#agent';
    const guest = 'dev-b#agent';
    const room = deps.rooms.create(host);
    assert.equal(deps.rooms.claim(room.code, guest).ok, true);

    const base = createBattle({ now: Date.now(), seed: 0, mode: 'pvp' });
    deps.store.set(pvpBattleKey(room.code), base);

    const table = tableFor(deps, host);
    assert.equal(table.key, pvpBattleKey(room.code));
    assert.equal(table.room, room.code);
    assert.equal(table.seat(host), 'player');
    assert.equal(table.seat(guest), 'enemy');
    assert.equal(table.seat('stranger#1'), null);
    assert.equal(table.waiting(), false);
    assert.equal(table.echoTo('player'), guest);
    assert.equal(table.echoTo('enemy'), host);
    assert.equal(table.battle()?.player.name, base.player.name);

    const hostView = table.view(host);
    const guestView = table.view(guest);
    assert.equal(hostView?.player.hp, base.player.hp);
    assert.equal(guestView?.player.name, '你');
    assert.equal(guestView?.player.hp, base.enemy.hp);
    assert.equal(guestView?.enemy.hp, base.player.hp);
    assert.equal(table.view('stranger#1'), null);

    // 加入者的视角换回基准：名字恢复成基准对局里的名字
    const restored = table.canonical(guestView!, 'enemy', base);
    assert.equal(restored.player.name, base.player.name);
    assert.equal(restored.enemy.name, base.enemy.name);
    assert.equal(restored.player.hp, base.player.hp);
  });

  it('房主独自在房里时继续等对手，补账没有收件人', () => {
    const deps = makeDeps();
    const host = 'dev-a#agent';
    const room = deps.rooms.create(host);
    const table = tableFor(deps, host);

    assert.equal(table.waiting(), true);
    assert.equal(table.echoTo('player'), null);
    // 还没开对局：座位有效但没有可看的局面
    assert.equal(table.view(host), null);
    assert.equal(table.battle(), null);
  });

  it('stillHere 在撤房或换座后为 false', () => {
    const deps = makeDeps();
    const host = 'dev-a#agent';
    const guest = 'dev-b#agent';
    const room = deps.rooms.create(host);
    deps.rooms.claim(room.code, guest);
    const table = tableFor(deps, guest);

    assert.equal(table.stillHere(guest, 'enemy'), true);
    assert.equal(table.stillHere(guest, 'player'), false);
    assert.equal(table.stillHere(host, 'player'), true);

    deps.rooms.remove(room.code);
    assert.equal(table.stillHere(guest, 'enemy'), false);
  });
});

describe('撤房', () => {
  it('对局、房间与双方补账一起清掉', () => {
    const { echo, cleared } = recordingEcho();
    const deps = makeDeps(echo);
    const host = 'dev-a#agent';
    const guest = 'dev-b#agent';
    const room = deps.rooms.create(host);
    deps.rooms.claim(room.code, guest);
    deps.store.set(pvpBattleKey(room.code), createBattle({ now: Date.now(), seed: 0, mode: 'pvp' }));
    echo.push(host, '你上一手的结果');
    echo.push(guest, '你上一手的结果');

    dropRoom(deps, room, '换房');

    assert.equal(deps.store.get(pvpBattleKey(room.code)), undefined);
    assert.equal(deps.rooms.get(room.code), undefined);
    assert.deepEqual(cleared.sort(), [guest, host].sort());
    assert.deepEqual(echo.take(host), []);
    assert.deepEqual(echo.take(guest), []);
  });

  it('房里只有房主时只清房主自己的补账', () => {
    const { echo, cleared } = recordingEcho();
    const deps = makeDeps(echo);
    const host = 'dev-a#agent';
    const room = deps.rooms.create(host);
    echo.push(host, '你上一手的结果');

    dropRoom(deps, room, '重开');

    assert.deepEqual(cleared, [host]);
    assert.equal(deps.rooms.get(room.code), undefined);
    assert.deepEqual(echo.take(host), []);
  });
});
