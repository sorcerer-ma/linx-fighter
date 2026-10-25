import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { GameService } from '../src/game/service.js';
import { createLogger } from '../src/log.js';
import { applyRequestContext, createDeviceContext } from '../src/mcp/context.js';
import { registerGameTools } from '../src/mcp/tools.js';

type ToolHandler = (args: Record<string, unknown>, extra?: {signal:AbortSignal}) => Promise<{
  content:Array<{type:string;text:string}>;isError?:boolean;structuredContent?:unknown;_meta?:Record<string,unknown>;
}>;
function registerWith(service:GameService, logger=createLogger('error')) {
  const handlers=new Map<string,ToolHandler>();
  const definitions=new Map<string,Record<string,unknown>>();
  const server={registerTool:(name:string,definition:Record<string,unknown>,handler:ToolHandler)=>{
    handlers.set(name,handler);definitions.set(name,definition);
  }} as unknown as McpServer;
  const ctx=createDeviceContext('conn-tools');
  applyRequestContext(ctx,{'x-linx-device-id':'dev-tools','x-linx-agent-id':'agent-tools'});
  registerGameTools(server,{service,logger,ctx,waitTimeoutMs:300_000});
  return {handlers,definitions,ctx};
}
const success={text:'兼容内部文案',battle:null,reply:{v:2,ok:true,phase:'idle',need:'none',events:[],say:'我在。'}};

describe('v2 工具层',()=>{
  it('只注册原话与等待两个工具，等待只接收本次可选声纹元数据，不接收对局身份',()=>{
    const {handlers,definitions}=registerWith({} as GameService);
    assert.deepEqual([...handlers.keys()].sort(),['game_say','wait_event']);
    const say=z.toJSONSchema(definitions.get('game_say')!.inputSchema as z.ZodType,{io:'input'});
    assert.equal((say.properties!.text as {maxLength:number}).maxLength,200);
    assert.equal((say.properties!.text as {minLength:number}).minLength,1);
    assert.ok(say.properties!.speaker);
    assert.equal(say.additionalProperties,false);
    const wait=z.toJSONSchema(definitions.get('wait_event')!.inputSchema as z.ZodType,{io:'input'});
    assert.deepEqual(Object.keys(wait.properties!),['speaker']);assert.equal(wait.additionalProperties,false);
  });
  it('原话不裁剪，声纹不污染下一次上下文；只编码事实 JSON',async()=>{
    let received='';let key='';
    const {handlers,ctx}=registerWith({say:async(k:string,text:string)=>{key=k;received=text;return success;}} as unknown as GameService);
    const input='  强化攻击  ';
    const result=await handlers.get('game_say')!({text:input,speaker:'小林'});
    assert.equal(received,input);assert.equal(key,'dev-tools#agent-tools');assert.equal(ctx.speakerName,'');
    assert.deepEqual(JSON.parse(result.content[0]!.text),success.reply);
    assert.equal(result.structuredContent,undefined);assert.equal(result.isError,undefined);
    assert.deepEqual(result._meta,{'linx/battleId':null});
  });
  it('执行对局标识只进私有传输元数据，不混入公开事实',async()=>{
    const {handlers}=registerWith({say:()=>({...success,battle:{id:'battle-executed'}})} as unknown as GameService);
    const result=await handlers.get('game_say')!({text:'攻击'});
    assert.deepEqual(result._meta,{'linx/battleId':'battle-executed'});
    assert.deepEqual(JSON.parse(result.content[0]!.text),success.reply);
  });
  it('超长和空白返回业务 unclear，绝不执行或截断招式',async()=>{
    let calls=0;let invalid=0;
    const {handlers}=registerWith({say:()=>{calls++;return success;},invalidInput:()=>{invalid++;return {...success,reply:{...success.reply,ok:false,reason:'unclear'}};}} as unknown as GameService);
    for(const text of ['攻击'+'啊'.repeat(199),'','  ']) {
      const result=await handlers.get('game_say')!({text});
      const reply=JSON.parse(result.content[0]!.text);
      assert.equal(reply.reason,'unclear');assert.equal(result.isError,undefined);
    }
    assert.equal(calls,0);assert.equal(invalid,3);
  });
  it('按 Unicode 字符计数，200 个字符原样送入服务',async()=>{
    let received='';
    const {handlers}=registerWith({say:(_key:string,text:string)=>{received=text;return success;}} as unknown as GameService);
    const input='😀'.repeat(200);
    await handlers.get('game_say')!({text:input});assert.equal(received,input);
  });
  it('wait_event 传递取消信号且不再执行 game_say',async()=>{
    const controller=new AbortController();let observed:AbortSignal|undefined;
    const {handlers}=registerWith({waitEvent:(_key:string,options:{signal?:AbortSignal})=>{observed=options.signal;return success;}} as unknown as GameService);
    await handlers.get('wait_event')!({}, {signal:controller.signal});assert.equal(observed,controller.signal);
  });
  it('声纹只取本次参数或请求头，冲突与缺失不继承旧值',async()=>{
    const heard:Array<string|undefined>=[];
    const service={say:(_key:string,_text:string,options:{speaker?:string})=>{heard.push(options.speaker);return success;},waitEvent:(_key:string,options:{speaker?:string;timeoutMs?:number})=>{heard.push(options.speaker);assert.equal(options.timeoutMs,300_000);return success;}} as unknown as GameService;
    const {handlers,ctx}=registerWith(service);
    await handlers.get('game_say')!({text:'普攻',speaker:'阿澈'});
    await handlers.get('game_say')!({text:'普攻'});
    assert.deepEqual(heard,['阿澈',undefined]);
    ctx.speakerName='阿岚';
    const refused=await handlers.get('wait_event')!({speaker:'阿澈'});
    assert.equal(JSON.parse(refused.content[0]!.text).silent,true);
    assert.deepEqual(heard,['阿澈',undefined]);
    await handlers.get('wait_event')!({});
    assert.equal(heard[2],'阿岚');
  });

  it('silent 是合法 JSON，没有占位话术或 structuredContent',async()=>{
    const {handlers}=registerWith({say:()=>({...success,text:'',reply:{v:2,ok:true,silent:true}})} as unknown as GameService);
    const result=await handlers.get('game_say')!({text:'普攻'});
    assert.deepEqual(JSON.parse(result.content[0]!.text),{v:2,ok:true,silent:true});assert.equal(result.structuredContent,undefined);
  });
  it('服务异常返回 unknown 且不伪造局面，不泄漏异常原文',async()=>{
    const boom=()=>{throw new Error('sensitive-provider-response');};
    const {handlers}=registerWith({say:boom,waitEvent:boom} as unknown as GameService);
    for(const name of ['game_say','wait_event']) {
      const result=await handlers.get(name)!({text:'攻击'});assert.equal(result.isError,true);
      const reply=JSON.parse(result.content[0]!.text);
      assert.equal(reply.v,2);assert.equal(reply.ok,false);assert.equal(reply.reason,'unknown');
      assert.equal(reply.phase,undefined);assert.equal(reply.you,undefined);
      assert.deepEqual(result._meta,{'linx/battleId':null});
      assert.doesNotMatch(result.content[0]!.text,/sensitive/);assert.match(reply.say,/不要重复出招/);
    }
  });
});
