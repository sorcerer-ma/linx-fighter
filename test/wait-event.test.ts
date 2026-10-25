import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { GameService } from '../src/game/service.js';
import { BattleStore } from '../src/store/battles.js';
import { RoomStore } from '../src/store/rooms.js';
import { createLogger } from '../src/log.js';

function setup() {
  return new GameService({
    store: new BattleStore({ ttlMs: 60000 }),
    rooms: new RoomStore({ ttlMs: 60000, random: () => 0 }),
    logger: createLogger('error'), random: () => 0,
  });
}

describe('v2 bounded event waiting', () => {
  it('wakes for join and consumes opening only once', async () => {
    const service = setup();
    const opened = await service.say('host', '开房');
    const waiting = service.waitEvent('host', { timeoutMs: 1000 });
    await service.say('guest', `加入房间${opened.reply!.room}`);
    const result = await waiting;
    assert.equal(result.reply?.phase, 'battle');
    assert.equal(result.reply?.need, 'move');
    assert.equal(result.reply?.events?.filter(event => event.t === 'start').length, 1);
    assert.deepEqual(service.status('host').reply?.events, []);
  });

  it('times out without changing room or resources', async () => {
    const service = setup();
    await service.say('host', '开房');
    const before = service.snapshot('host');
    const result = await service.waitEvent('host', { timeoutMs: 1 });
    assert.deepEqual(result.reply?.events, [{ t: 'timeout', what: 'guest' }]);
    assert.equal(result.reply?.need, 'wait_guest');
    assert.deepEqual(service.snapshot('host'), before);
  });

  it('does not consume later join after cancellation', async () => {
    const service = setup();
    const opened = await service.say('host', '开房');
    const controller = new AbortController();
    const waiting = service.waitEvent('host', { signal: controller.signal, timeoutMs: 1000 });
    controller.abort();
    await waiting;
    await service.say('guest', `加入房间${opened.reply!.room}`);
    assert.ok(service.status('host').reply?.events?.some(event => event.t === 'start'));
  });

  it('cannot deliver the same queued event to two waits', async () => {
    const service = setup();
    const opened = await service.say('host', '开房');
    const first = service.waitEvent('host', { timeoutMs: 100 });
    const second = service.waitEvent('host', { timeoutMs: 5 });
    await service.say('guest', `加入房间${opened.reply!.room}`);
    const results = await Promise.all([first, second]);
    assert.equal(results.flatMap(result => result.reply?.events ?? []).filter(event => event.t === 'start').length, 1);
  });

  it('new input cancels the old wait before changing battle, without stealing new facts', async () => {
    const service = setup();
    await service.say('host', '开房');
    const waiting = service.waitEvent('host', { timeoutMs: 100 });
    const next = await service.say('host', '开始');
    const old = await waiting;
    assert.deepEqual(old.reply, {v:2,ok:true,silent:true});
    assert.notEqual(old.battle?.id, next.battle?.id);
    assert.equal(service.snapshot('host')?.state?.battleId, next.battle?.id);
  });

  it('does not consume pending facts for invalid input', async () => {
    const service = setup();
    const opened = await service.say('host', '开房');
    await service.say('guest', `加入房间${opened.reply!.room}`);
    assert.equal(service.invalidInput('host').reply?.reason, 'unclear');
    assert.ok(service.status('host').reply?.events?.some(event => event.t === 'start'));
  });
});
