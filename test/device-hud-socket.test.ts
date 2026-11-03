/**
 * 设备推送通道的行为断言：连上先给当前帧，局面变化后再推新帧，缺设备号直接拒绝。
 */

import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, it } from 'node:test';
import { WebSocket, type WebSocketServer } from 'ws';
import { loadConfig } from '../src/config.js';
import { GameService } from '../src/game/service.js';
import { createApp } from '../src/http/app.js';
import { attachDeviceHudSocket } from '../src/http/device-hud-socket.js';
import { createHudKeyResolver } from '../src/http/hud-key.js';
import { createLogger } from '../src/log.js';
import { BattleStore } from '../src/store/battles.js';
import { RoomStore } from '../src/store/rooms.js';

interface Harness {
  port: number;
  service: GameService;
  socket: WebSocketServer;
  close: () => Promise<void>;
}

async function boot(): Promise<Harness> {
  const logger = createLogger('error');
  const store = new BattleStore({ ttlMs: 60_000 });
  const rooms = new RoomStore({ ttlMs: 60_000, random: () => 0 });
  const service = new GameService({ store, rooms, logger, random: () => 0 });
  const config = loadConfig({});
  const app = createApp({ config, logger, store, rooms, service });
  let server!: Server;
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  const socket = attachDeviceHudSocket({
    server, service, logger, resolveKey: createHudKeyResolver({ service, store }),
  });
  const port = (server.address() as AddressInfo).port;
  return {
    port, service, socket,
    close: () => new Promise<void>((resolve) => {
      socket.close();
      server.close(() => resolve());
    }),
  };
}

/** 把推送排进队列：连接刚建立时可能先于测试挂监听到达，队列能兜住 */
class Client {
  private readonly queue: Array<Record<string, unknown>> = [];
  private readonly waiters: Array<(frame: Record<string, unknown>) => void> = [];

  constructor(readonly ws: WebSocket) {
    ws.on('message', (raw) => {
      const frame = JSON.parse(String(raw)) as Record<string, unknown>;
      const waiter = this.waiters.shift();
      if (waiter) waiter(frame);
      else this.queue.push(frame);
    });
  }

  async next(timeoutMs = 3000): Promise<Record<string, unknown>> {
    const ready = this.queue.shift();
    if (ready) return ready;
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('等待推送超时')), timeoutMs);
      this.waiters.push((frame) => { clearTimeout(timer); resolve(frame); });
    });
  }

  close(): void { this.ws.close(); }
}

function connect(port: number, query: string): Promise<Client> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/device/ws?${query}`);
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve(new Client(ws)));
    ws.once('error', reject);
  });
}

describe('设备推送通道', () => {
  it('连上先给待命帧，开局后推战斗帧', async () => {
    const harness = await boot();
    try {
      const client = await connect(harness.port, 'device=dev-ws');
      const first = await client.next();
      assert.equal(first.battle, false);
      assert.equal(first.expression, 'neutral');
      assert.equal(first.seq, 1);

      await harness.service.start('dev-ws#default', { mode: 'solo' });
      const second = await client.next();
      assert.equal(second.battle, true);
      assert.equal(second.mode, 'solo');
      assert.ok((second.seq as number) > (first.seq as number));
      assert.equal(typeof second.hp, 'number');
      client.close();
    } finally {
      await harness.close();
    }
  });

  it('没有设备号时拒绝订阅', async () => {
    const harness = await boot();
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${harness.port}/device/ws`);
      const code = await new Promise<number>((resolve) => {
        ws.once('close', (value) => resolve(value));
      });
      assert.equal(code, 1008);
    } finally {
      await harness.close();
    }
  });

  it('配置口令后，没带 token 的设备被拒绝', async () => {
    const logger = createLogger('error');
    const store = new BattleStore({ ttlMs: 60_000 });
    const rooms = new RoomStore({ ttlMs: 60_000, random: () => 0 });
    const service = new GameService({ store, rooms, logger, random: () => 0 });
    const config = loadConfig({});
    const app = createApp({ config, logger, store, rooms, service });
    let server!: Server;
    await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', () => resolve()); });
    const socket = attachDeviceHudSocket({
      server, service, logger, resolveKey: createHudKeyResolver({ service, store }), token: 'secret',
    });
    const port = (server.address() as AddressInfo).port;
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/device/ws?device=dev-ws`);
      const code = await new Promise<number>((resolve) => { ws.once('close', (value) => resolve(value)); });
      assert.equal(code, 1008);
    } finally {
      socket.close();
      await new Promise<void>((resolve) => { server.close(() => resolve()); });
    }
  });
});
