import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import type { GameReply } from '../src/game/protocol.js';
import { loadConfig } from '../src/config.js';
import { GameService } from '../src/game/service.js';
import { createApp } from '../src/http/app.js';
import { createLogger } from '../src/log.js';
import { BattleStore } from '../src/store/battles.js';
import { RoomStore } from '../src/store/rooms.js';

/**
 * Streamable HTTP 版 MCP 端到端测试。
 * 灵矽平台（新版客户端）直接 POST JSON-RPC 到 /mcp，不先建 SSE 连接，
 * 每次 POST 都带 X-Linx-Device-Id / X-Linx-Agent-Id 头，因此服务端必须按无状态方式处理。
 */

const DEVICE = 'device-streamable';
const AGENT_ID = 'agent-1';
const SESSION_ID = 'session-1';

let server: Server;
let baseUrl = '';

before(async () => {
  const logger = createLogger('error');
  const store = new BattleStore({ ttlMs: 60_000 });
  const rooms = new RoomStore({ ttlMs: 60_000 });
  const service = new GameService({ store, rooms, logger, random: () => 0 });
  const app = createApp({
    config: { ...loadConfig({}), enableDebugEndpoints: false },
    logger,
    store,
    rooms,
    service,
  });

  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
});

/** 按平台的调用方式发一次 JSON-RPC 请求（或通知） */
async function post(body: Record<string, unknown>) {
  const response = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'X-Linx-Device-Id': DEVICE,
      'X-Linx-Agent-Id': AGENT_ID,
      'X-Linx-Session-Id': SESSION_ID,
    },
    body: JSON.stringify(body),
  });

  const text = await response.text();
  return { status: response.status, contentType: response.headers.get('content-type') ?? '', text };
}

/** 请求：带 id，期望拿到 JSON 结果 */
async function rpc(method: string, params?: unknown, id = 1) {
  return post({ jsonrpc: '2.0', id, method, params });
}

/** 通知：不带 id */
async function notify(method: string, params?: unknown) {
  return post({ jsonrpc: '2.0', method, params });
}

async function callTool(name: string, args: Record<string, unknown> = {}): Promise<GameReply> {
  const result = await rpc('tools/call', { name, arguments: args });
  assert.equal(result.status, 200, `tools/call ${name} 应返回 200，实际 ${result.status}：${result.text}`);
  const payload = JSON.parse(result.text) as {
    result?: { content?: Array<{ type: string; text: string }>; isError?: boolean };
  };
  const text = payload.result?.content?.[0]?.text ?? '';
  assert.notEqual(payload.result?.isError, true, `工具 ${name} 不应报错：${text}`);
  return JSON.parse(text) as GameReply;
}

describe('Streamable HTTP 通道', () => {
  it('initialize 返回服务信息', async () => {
    const result = await rpc('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'linx-streamable', version: '1.0.0' },
    });

    assert.equal(result.status, 200);
    const payload = JSON.parse(result.text) as { result?: { serverInfo?: { name?: string } } };
    assert.equal(payload.result?.serverInfo?.name, 'linx-fighter');
  });

  it('tools/list 能列出两个 v2 工具', async () => {
    const result = await rpc('tools/list');
    const payload = JSON.parse(result.text) as { result?: { tools?: Array<{ name: string }> } };
    const names = (payload.result?.tools ?? []).map((tool) => tool.name).sort();
    assert.deepEqual(names, ['game_say', 'wait_event']);
  });

  it('工具调用在多次 POST 之间共享对局状态', async () => {
    const started = await callTool('game_say', { text: '开始' });
    assert.equal(started.v, 2);
    assert.equal(started.phase, 'battle');
    assert.ok(started.events?.some(event => event.t === 'start'));
    const acted = await callTool('game_say', { text: '普攻' });
    assert.ok(acted.events?.some(event => event.t === 'hit' && event.by === 'you'));
    assert.equal(acted.pending?.by, 'foe');
    assert.equal(acted.need, 'respond');
    const status = await callTool('game_say', { text: '战况如何' });
    assert.equal(status.round, 1);
    assert.deepEqual(status.you, acted.you);
  });

  it('会话结束的 DELETE 请求被礼貌接受', async () => {
    const response = await fetch(`${baseUrl}/mcp`, { method: 'DELETE' });
    assert.equal(response.status, 200);
  });

  it('通知类消息返回 202 而不是报错', async () => {
    const result = await notify('notifications/initialized');
    assert.ok([200, 202].includes(result.status), `通知应被接受，实际 ${result.status}：${result.text}`);
  });
});

it('wait_event 的本次声纹参数/header 冲突静默，且不会消费进房事实或继承前次参数', async () => {
  const logger = createLogger('error');
  const store = new BattleStore({ttlMs:60000});
  const rooms = new RoomStore({ttlMs:60000,random:()=>0});
  const service = new GameService({store,rooms,logger,random:()=>0,speakers:['阿澈','阿岚']});
  const app = createApp({config:loadConfig({}),logger,store,rooms,service});
  let isolated!: Server;
  await new Promise<void>(resolve=>{isolated=app.listen(0,'127.0.0.1',()=>resolve());});
  const url=`http://127.0.0.1:${(isolated.address() as AddressInfo).port}/mcp`;
  let nextId=0;
  const invoke = async (device:string,name:string,args:Record<string,unknown>,speaker?:string):Promise<GameReply> => {
    const response=await fetch(url,{
      method:'POST',
      headers:{'content-type':'application/json',accept:'application/json, text/event-stream',
        'X-Linx-Device-Id':device,'X-Linx-Agent-Id':'speaker-wait',
        ...(speaker?{'X-Linx-Speaker-Name':encodeURIComponent(speaker)}:{}),
      },
      body:JSON.stringify({jsonrpc:'2.0',id:++nextId,method:'tools/call',params:{name,arguments:args}}),
    });
    assert.equal(response.status,200);
    const payload=await response.json() as {result:{content:Array<{text:string}>;isError?:boolean}};
    assert.notEqual(payload.result.isError,true);
    return JSON.parse(payload.result.content[0]!.text) as GameReply;
  };
  try {
    const opening=await invoke('header-host','game_say',{text:'发起挑战',speaker:'阿澈'});
    assert.equal(opening.need,'wait_guest');
    assert.equal((await invoke('header-host','wait_event',{})).silent,true,'前一工具参数不能代替本次声纹');
    await invoke('header-guest','game_say',{text:`接受挑战，编号${opening.room}`,speaker:'阿岚'});
    const conflict=await invoke('header-host','wait_event',{speaker:'阿岚'},'阿澈');
    assert.deepEqual(conflict,{v:2,ok:true,silent:true});
    const permitted=await invoke('header-host','wait_event',{},'阿澈');
    assert.ok(permitted.events?.some(event=>event.t==='start'),'冲突请求不得消费事实');
    const repeated=await invoke('header-host','wait_event',{speaker:'阿澈'},'阿澈');
    assert.equal(repeated.silent,true,'已交付阶段不重复播报');
  } finally {
    await new Promise<void>((resolve,reject)=>isolated.close(error=>error?reject(error):resolve()));
  }
});
