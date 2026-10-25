import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { it } from 'node:test';
import { loadConfig } from '../src/config.js';
import type { GameReply } from '../src/game/protocol.js';
import { GameService } from '../src/game/service.js';
import { createApp } from '../src/http/app.js';
import { createLogger } from '../src/log.js';
import { BattleStore } from '../src/store/battles.js';
import { RoomStore } from '../src/store/rooms.js';

async function within<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('MCP cancellation did not reach service')), 1500);
    })]);
  } finally { clearTimeout(timer!); }
}

it('HTTP 断开取消 wait_event，之后进房事实仍由新的请求消费一次', async () => {
  const logger = createLogger('error');
  const store = new BattleStore({ ttlMs: 60_000 });
  const rooms = new RoomStore({ ttlMs: 60_000, random: () => 0 });
  const service = new GameService({ store, rooms, logger, random: () => 0 });
  let started!: () => void;
  let cancelled!: () => void;
  const waitStarted = new Promise<void>(resolve => { started = resolve; });
  const waitCancelled = new Promise<void>(resolve => { cancelled = resolve; });
  const originalWait = service.waitEvent.bind(service);
  service.waitEvent = (key, options = {}) => {
    options.signal?.addEventListener('abort', cancelled, { once: true });
    started();
    return originalWait(key, options);
  };
  const app = createApp({ config: loadConfig({}), logger, store, rooms, service });
  let server!: Server;
  await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
  let id = 0;
  const request = async (device: string, tool: string, args: Record<string, unknown> = {}, signal?: AbortSignal) => {
    const response = await fetch(url, {
      method: 'POST', headers: {
        'content-type': 'application/json', accept: 'application/json, text/event-stream',
        'X-Linx-Device-Id': device, 'X-Linx-Agent-Id': 'cancel-test',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name: tool, arguments: args } }),
      signal,
    });
    assert.equal(response.status, 200);
    const payload = await response.json() as {result:{content:Array<{text:string}>}};
    return JSON.parse(payload.result.content[0]!.text) as GameReply;
  };
  try {
    const opened = await request('host-cancel', 'game_say', { text: '开房间' });
    assert.equal(opened.need, 'wait_guest');
    const controller = new AbortController();
    const waiting = request('host-cancel', 'wait_event', {}, controller.signal);
    await within(waitStarted);
    controller.abort();
    await assert.rejects(waiting, { name: 'AbortError' });
    // Observe the exact SDK signal reaching GameService, not only a browser timeout.
    await within(waitCancelled);
    await request('guest-cancel', 'game_say', { text: `加入房间${opened.room}` });
    const facts = await request('host-cancel', 'game_say', { text: '战况如何' });
    assert.ok(facts.events?.some(event => event.t === 'start'));
    const again = await request('host-cancel', 'game_say', { text: '战况如何' });
    assert.deepEqual(again.events, []);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
