import { readFileSync } from 'node:fs';
import { SandboxAgent } from '../sandbox/platform/agent.js';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { loadSandboxConfig } from '../sandbox/config.js';
import { SandboxClient } from '../sandbox/platform/client.js';
import { createSandboxServer } from '../sandbox/server.js';
import { loadConfig } from '../src/config.js';
import { GameService } from '../src/game/service.js';
import { createApp } from '../src/http/app.js';
import { createLogger } from '../src/log.js';
import { BattleStore } from '../src/store/battles.js';
import { RoomStore } from '../src/store/rooms.js';

/**
 * 沙箱端到端：真的起一个游戏服务 + 一个沙箱服务，走 HTTP 与 MCP 全链路。
 *
 * 覆盖的重点是「沙箱只是载体」——页面/CLI 说什么，沙箱原样转给 game_say，
 * 判断与结算都在游戏服务里，沙箱不复制任何规则。
 */

let gameServer: Server;
let sandboxServer: Server;
let sandboxUrl = '';

function listen(app: { listen(port: number, host: string, cb: () => void): Server }): Promise<Server> {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function urlOf(server: Server): string {
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

function sandboxFor(upstream: string): Promise<Server> {
  const config = { ...loadSandboxConfig({}), upstream, agentId: 'linx-test', timeoutMs: 3000, logLevel: 'error' as const };
  const client = new SandboxClient({
    upstream,
    agentId: config.agentId,
    timeoutMs: config.timeoutMs,
    logger: createLogger('error'),
  });
  return listen(createSandboxServer({ config, client }));
}

async function say(deviceId: string, text: string): Promise<Record<string, any>> {
  const response = await fetch(`${sandboxUrl}/api/say`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ deviceId, text }),
  });
  assert.equal(response.status, 200);
  return (await response.json()) as Record<string, any>;
}

before(async () => {
  const logger = createLogger('error');
  const store = new BattleStore({ ttlMs: 60_000 });
  const rooms = new RoomStore({ ttlMs: 60_000 });
  const service = new GameService({ store, rooms, logger, random: () => 0 });
  const gameApp = createApp({
    config: { ...loadConfig({}), enableDebugEndpoints: true },
    logger,
    store,
    rooms,
    service,
  });
  gameServer = await listen(gameApp);
  sandboxServer = await sandboxFor(urlOf(gameServer));
  sandboxUrl = urlOf(sandboxServer);
});

after(async () => {
  await new Promise<void>((resolve) => sandboxServer.close(() => resolve()));
  await new Promise<void>((resolve) => gameServer.close(() => resolve()));
});

describe('沙箱服务', () => {
  it('/api/config 给出上游地址、身份与状态流地址', async () => {
    const response = await fetch(`${sandboxUrl}/api/config`);
    const body = (await response.json()) as {
      ok: boolean;
      upstream: string;
      agentId: string;
      eventsUrl: string;
      defaultDeviceId: string;
      voice: { lang: string };
      agentMode: string;
      waitTimeoutMs: number;
    };

    assert.equal(body.ok, true);
    assert.equal(body.upstream, urlOf(gameServer));
    assert.equal(body.agentId, 'linx-test');
    // 纯 HTTP 页面直连游戏服务的状态流
    assert.equal(body.eventsUrl, `${urlOf(gameServer)}/events`);
    assert.match(body.defaultDeviceId, /^web-/);
    assert.equal(body.voice.lang, 'zh-CN');
    assert.equal(body.agentMode, 'compatibility');
    // 页面的等待预算要盖住服务端 5 分钟挂起，不能让页面先报连接中断
    assert.ok(body.waitTimeoutMs > 300_000);
    assert.ok(!('apiKey' in body) && !('promptPath' in body) && !('agent' in body));
  });

  it('/api/say 把原话透传给 game_say，并带回播报与局面', async () => {
    const opened = await say('web-test-1', '共鸣对决，发起挑战');
    assert.equal(opened.ok, true);
    assert.equal(opened.tool, 'game_say');
    assert.equal(opened.deviceId, 'web-test-1');
    assert.equal(opened.agentId, 'linx-test');
    assert.match(String(opened.reply), /编号\d{4}/);
    assert.equal(opened.state.room, opened.state.battle.room);
    assert.equal(opened.state.battle.mode, 'pvp');
    assert.ok(Array.isArray(opened.trace.requests));
    // trace 里能看到 initialize 与 tools/call 两次调用
    const methods = (opened.trace.requests as Array<{ method: string }>).map((request) => request.method);
    assert.ok(methods.includes('initialize'));
    assert.ok(methods.includes('tools/call'));
  });

  it('/api/state 与 /api/say 看到的是同一局', async () => {
    const played = await say('web-test-2', '开始');
    assert.match(String(played.reply), /对决开始/);

    const response = await fetch(`${sandboxUrl}/api/state?deviceId=web-test-2`);
    const body = (await response.json()) as { ok: boolean; state: { battle: { round: number } } };
    assert.equal(body.ok, true);
    assert.equal(body.state.battle.round, 1);
  });

  it('/api/tools 列出服务端工具，game_say 排在最前', async () => {
    const response = await fetch(`${sandboxUrl}/api/tools`);
    const body = (await response.json()) as { ok: boolean; tools: Array<{ name: string }> };
    assert.equal(body.ok, true);
    const names = body.tools.map((tool) => tool.name);
    assert.ok(names.includes('game_say'));
    assert.equal(names[0], 'game_say');
  });

  it('/api/say 拒绝空句子', async () => {
    const response = await fetch(`${sandboxUrl}/api/say`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceId: 'web-test-3', text: '   ' }),
    });
    assert.equal(response.status, 400);
    const body = (await response.json()) as { ok: boolean; error: string };
    assert.equal(body.ok, false);
    assert.equal(body.error, 'empty_text');
  });

  it('未知 /api 路径回 JSON 404', async () => {
    const response = await fetch(`${sandboxUrl}/api/nothing`);
    assert.equal(response.status, 404);
    const body = (await response.json()) as { error: string };
    assert.equal(body.error, 'not_found');
  });

  it('上游连不上时给玩家一句能听懂的话，不抛堆栈', async () => {
    const dead = await sandboxFor('http://127.0.0.1:1');
    try {
      const response = await fetch(`${urlOf(dead)}/api/say`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ deviceId: 'web-test-4', text: '开始' }),
      });
      const body = (await response.json()) as { ok: boolean; reply: string; error: string };
      assert.equal(response.status, 200);
      assert.equal(body.ok, false);
      assert.equal(body.error, 'upstream_unreachable');
      assert.match(body.reply, /结果未确认/);
    } finally {
      await new Promise<void>((resolve) => dead.close(() => resolve()));
    }
  });
});

it('原话Agent经真实MCP执行一次game_say；查询不出招、身份隔离', async () => {
  const prompt=readFileSync(loadSandboxConfig({}).agent.promptPath,'utf8');
  const agent=new SandboxAgent(prompt);
  const client=new SandboxClient({upstream:urlOf(gameServer),agentId:'agent-test',timeoutMs:3000,logger:createLogger('error'),agent});
  const start=await client.say('agent-one','开始游戏');
  assert.equal(start.tool,'game_say');assert.ok(start.state?.battle);
  const status=await client.say('agent-one','战况如何');
  assert.equal(status.tool,'game_say');assert.deepEqual(status.state?.battle?.you,start.state?.battle?.you);
  assert.equal(status.reply,status.sourceReply);assert.equal(status.rewriteStatus,'original');
  const calls=status.trace.requests.filter(r=>r.method==='tools/call');
  assert.equal(calls.length,1);assert.equal(calls[0]?.tool,'game_say');
  const other=await client.say('agent-two','战况如何');assert.equal(other.state?.battle,null);
});


it('真实MCP开局与拒绝进入表达，日志只记录状态；表达失败不重试工具',async()=>{
 const logs:Array<{message:string;fields?:Record<string,unknown>}>=[];
 const logger={...createLogger('error'),info(message:string,fields?:Record<string,unknown>){logs.push({message,fields})}};
 let modelCalls=0;
 const agent=new SandboxAgent('伙伴',{async express(_prompt,facts){modelCalls++;const start=facts.events?.find(e=>e.t==='start');if(start?.t==='start')return `${start.foe}来了，${start.first==='you'?'我先手，告诉我怎么出招':'对手先手，我等着接招'}！`;throw new Error('unavailable with fake-secret');}});
 const client=new SandboxClient({upstream:urlOf(gameServer),agentId:'feedback-agent',timeoutMs:3000,logger,agent});
 const opened=await client.say('feedback-private-device','开始');
 assert.equal(opened.rewriteStatus,'rewritten');assert.match(opened.reply,/来了/);
 const refused=await client.say('feedback-private-device','不要普攻');
 assert.equal(refused.rewriteStatus,'fallback-error');assert.equal(refused.reply,refused.sourceReply);
 assert.equal(modelCalls,2);
 for(const result of [opened,refused])assert.equal(result.trace.requests.filter(r=>r.method==='tools/call').length,1);
 const entries=logs.filter(x=>x.message==='沙箱转发');assert.equal(entries.length,2);
 assert.equal(entries[0]?.fields?.rewriteStatus,'rewritten');assert.equal(entries[1]?.fields?.rewriteStatus,'fallback-error');
 assert.equal(entries[1]?.fields?.expressionError,'表达模型不可用');
 for(const entry of entries){assert.ok(!('text' in entry.fields!));assert.ok(!('reply' in entry.fields!));assert.ok(typeof entry.fields?.requestId==='string');}
 assert.ok(!JSON.stringify(entries).includes('fake-secret'));
});

it('v2 超长输入不截断执行，原文空格保持',async()=>{
 const tooLong=await say('overlong-v2','开始'+ '啊'.repeat(200));
 assert.equal(tooLong.protocol.reason,'unclear');assert.equal(tooLong.protocol.ok,false);assert.equal(tooLong.state.battle,null);
 const calls=tooLong.trace.requests.filter((r:any)=>r.method==='tools/call');assert.equal(calls[0].request.params.arguments.text.length,202);
});
it('等待经独立wait_event返回事实，不重做game_say',async()=>{
 const client=new SandboxClient({upstream:urlOf(gameServer),agentId:'wait-agent',timeoutMs:3000,logger:createLogger('error')});
 const host=await client.say('wait-host','开房间');assert.equal(host.protocol?.need,'wait_guest');
 const waiting=client.wait('wait-host');await new Promise(resolve=>setTimeout(resolve,30));
 const guest=await client.say('wait-guest','加入房间'+host.protocol?.room);assert.equal(guest.protocol?.phase,'battle');
 const result=await waiting;assert.equal(result.protocol?.phase,'battle');assert.equal(result.tool,'wait_event');
 const calls=result.trace.requests.filter(r=>r.method==='tools/call');assert.equal(calls.length,1);assert.equal(calls[0]?.tool,'wait_event');
});
it('表达过程中换局，旧话术被丢弃，不与新快照一起播出',async()=>{
 let entered!:()=>void;const entry=new Promise<void>(resolve=>{entered=resolve;});
 let release!:(text:string)=>void;const candidate=new Promise<string>(resolve=>{release=resolve;});
 const agent=new SandboxAgent('伙伴',{async express(){entered();return candidate;}});
 const options={upstream:urlOf(gameServer),agentId:'stale-agent',timeoutMs:3000,logger:createLogger('error')};
 const client=new SandboxClient({...options,agent});const plain=new SandboxClient(options);
 const old=client.say('stale-one','开始');await entry;const fresh=await plain.say('stale-one','重新开始');assert.ok(fresh.state?.battle);
 release('教头来了，我先手，告诉我怎么出招！');
 const result=await old;assert.equal(result.silent,true);assert.equal(result.reply,'');assert.equal(result.rewriteStatus,'stale');assert.notEqual(result.sourceBattleId,result.state?.battle?.battleId);
});

it('review: 对局中问玩法保留同局身份并显示回复，不误判stale或消费补账',async()=>{
 const device='qa-help-v2';const opening=await say(device,'开始');
 const help=await say(device,'怎么玩');
 assert.equal(help.ok,true);assert.equal(help.silent,false);assert.notEqual(help.rewriteStatus,'stale');
 assert.ok(help.reply.length>0);assert.equal(help.protocol.v,2);assert.ok(help.protocol.text);
 assert.equal(help.sourceBattleId,opening.sourceBattleId);assert.equal(help.state.battle.battleId,opening.sourceBattleId);
 assert.deepEqual(help.protocol.events,[]);
});
