import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { PROTOCOL_REPLY_MAX_BYTES, type GameReply } from '../src/game/protocol.js';
import type { GameService } from '../src/game/service.js';
import { createDeviceContext } from '../src/mcp/context.js';
import { encodeReply, unknownReply } from '../src/mcp/reply.js';
import { registerGameTools } from '../src/mcp/tools.js';
import { createLogger } from '../src/log.js';

describe('v2 完整 JSON 字节预算',()=>{
  const base:GameReply={v:2,ok:true,phase:'idle',need:'none',events:[],text:''};
  const available=PROTOCOL_REPLY_MAX_BYTES-Buffer.byteLength(JSON.stringify(base),'utf8');
  it('正好 16384 字节的 ASCII JSON 完整往返，多一字节拒绝',()=>{
    const reply={...base,text:'x'.repeat(available)};
    const text=encodeReply(reply);
    assert.equal(Buffer.byteLength(text,'utf8'),16384);assert.deepEqual(JSON.parse(text),reply);
    assert.throws(()=>encodeReply({...reply,text:reply.text+'x'}),RangeError);
  });
  it('UTF-8 中文按字节计量，而不是 JavaScript 字符串长度',()=>{
    const value='好'.repeat(Math.floor(available/3))+'x'.repeat(available%3);
    const reply={...base,text:value};
    assert.equal(Buffer.byteLength(encodeReply(reply),'utf8'),PROTOCOL_REPLY_MAX_BYTES);
    assert.throws(()=>encodeReply({...reply,text:value+'x'}),RangeError);
  });
  it('多事件不裁剪：预算内全部保留，超预算完整拒绝',()=>{
    const reply:GameReply={...base,text:undefined,say:'结算已确认。',events:Array.from({length:80},()=>({t:'hit' as const,by:'you' as const,mv:'heavy' as const,r:'guard' as const,dmg:3}))};
    assert.deepEqual(JSON.parse(encodeReply(reply)).events,reply.events);
    assert.throws(()=>encodeReply({...reply,events:Array.from({length:1000},()=>reply.events![0]!)}),RangeError);
  });
  it('编码超预算不重试已执行行动，返回 unknown 而非截断事实',async()=>{
    let calls=0;
    let invoke!: (args:{text:string})=>Promise<{content:Array<{text:string}>;isError?:boolean;_meta?:Record<string,unknown>}>;
    const server={registerTool:(name:string,_definition:unknown,handler:typeof invoke)=>{if(name==='game_say')invoke=handler;}} as unknown as McpServer;
    const service={say:()=>{calls++;return {text:'',battle:{id:'already-executed'},reply:{...base,text:'x'.repeat(PROTOCOL_REPLY_MAX_BYTES)}};}} as unknown as GameService;
    registerGameTools(server,{service,logger:createLogger('error'),ctx:createDeviceContext('size-test')});
    const result=await invoke({text:'攻击'});
    assert.equal(calls,1);assert.equal(result.isError,true);
    assert.deepEqual(JSON.parse(result.content[0]!.text),unknownReply());
    assert.equal(result._meta?.['linx/battleId'],null);
    assert.ok(Buffer.byteLength(result.content[0]!.text,'utf8')<PROTOCOL_REPLY_MAX_BYTES);
  });
});
