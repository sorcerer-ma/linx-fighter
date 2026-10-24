import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { RoomStore } from '../src/store/rooms.js';

function store(options: { now?: () => number; random?: () => number } = {}): RoomStore {
  return new RoomStore({
    ttlMs: 60_000,
    now: options.now ?? (() => 1_000_000),
    random: options.random ?? (() => 0.5),
  });
}

describe('房间存储', () => {
  it('开房生成四位房间号，并建立房主索引', () => {
    const rooms = store();
    const room = rooms.create('host#1');

    assert.match(room.code, /^\d{4}$/);
    assert.equal(room.guestKey, null);
    assert.equal(rooms.size, 1);
    assert.equal(rooms.byPlayer('host#1')?.code, room.code);
  });

  it('同一位房主重新开房会撤掉旧房间', () => {
    const rooms = store();
    const first = rooms.create('host#1');
    const second = rooms.create('host#1');

    // 号可以复用，但旧房间必须已经撤掉，只剩新的这一间
    assert.equal(rooms.size, 1);
    assert.equal(rooms.get(second.code), second);
    assert.equal(rooms.byPlayer('host#1')?.code, second.code);
  });

  it('房间号撞车时重试，连撞 100 次后退化成按序补位', () => {
    const rooms = store({ random: () => 0 });
    assert.equal(rooms.create('host#1').code, '1000');
    // 随机数恒为 0 会一直撞 1000，重试耗尽后从 1000 起找空位
    assert.equal(rooms.create('host#2').code, '1001');
  });

  it('加入房间区分不存在、已满与重复加入', () => {
    const rooms = store();
    const room = rooms.create('host#1');

    assert.deepEqual(rooms.join('9999', 'guest#1'), { ok: false, reason: 'missing' });
    assert.equal(rooms.join(room.code, 'guest#1').ok, true);
    assert.equal(rooms.byPlayer('guest#1')?.code, room.code);
    // 同一位加入者重复加入视为成功，换人则已满
    assert.equal(rooms.join(room.code, 'guest#1').ok, true);
    assert.deepEqual(rooms.join(room.code, 'guest#2'), { ok: false, reason: 'full' });
  });

  it('超时后房间失效，反向索引一并清掉', () => {
    let now = 1_000_000;
    const rooms = store({ now: () => now });
    const room = rooms.create('host#1');
    rooms.join(room.code, 'guest#1');

    now += 60_001;
    assert.equal(rooms.get(room.code), undefined);
    assert.equal(rooms.byPlayer('host#1'), undefined);
    assert.equal(rooms.byPlayer('guest#1'), undefined);
    assert.equal(rooms.size, 0);
  });

  it('续期、清理与手动移除', () => {
    let now = 1_000_000;
    const rooms = store({ now: () => now });
    const room = rooms.create('host#1');
    rooms.join(room.code, 'guest#1');

    // 续期后不会被清理
    now += 50_000;
    rooms.touch(room.code);
    now += 50_000;
    assert.equal(rooms.get(room.code)?.code, room.code);
    assert.equal(rooms.sweep(), 0);

    // 再超时则 sweep 清掉，手动 remove 不存在也不报错
    now += 60_001;
    assert.equal(rooms.sweep(), 1);
    assert.equal(rooms.size, 0);
    rooms.remove(room.code);
    rooms.touch(room.code);
  });
});
