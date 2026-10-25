import assert from 'node:assert/strict';
import { it } from 'node:test';
import { loadSandboxConfig } from '../sandbox/config.js';
import { SandboxAgent, createSandboxAgent } from '../sandbox/platform/agent.js';
import { OpenAiReplyModel } from '../sandbox/platform/reply-model.js';
import type { GameReply } from '../src/game/protocol.js';

const opening: GameReply = {v:2,ok:true,phase:'battle',need:'move',events:[{t:'start',foe:'教头',first:'you'}],say:'教头到了，我先手。该我出招。'};
const tool = (reply:GameReply) => ({ async callTool(){return {reply,isError:false};} });
it('未配置模型不自动选供应商；共享提示词启动读取',()=>{
 const config=loadSandboxConfig({});assert.equal(createSandboxAgent(config.agent),undefined);
 assert.throws(()=>createSandboxAgent({...config.agent,model:'mock'}),/配置未完成/);
 assert.throws(()=>createSandboxAgent({...config.agent,promptPath:'/no-such-prompt'}));
});
it('原话只调用一次game_say，空格不改；wait仅独立调用wait_event',async()=>{
 const calls:unknown[]=[]; const waits:Array<number|undefined>=[];
 const tools={async callTool(name:string,args:Record<string,unknown>,options?:{timeoutMs?:number}){calls.push({name,args});if(name==='wait_event')waits.push(options?.timeoutMs);return {reply:opening,isError:false};}};
 const agent=new SandboxAgent('伙伴');
 await agent.run('  强攻！  ',tools);await agent.wait(tools);
 for(const text of ['共鸣对决，发起挑战','接受挑战，编号1234','开房间','加入房间1234']){await agent.run(text,tools);assert.deepEqual(calls.pop(),{name:'game_say',args:{text}});}
 assert.deepEqual(calls,[{name:'game_say',args:{text:'  强攻！  '}},{name:'wait_event',args:{}}]);
 // 默认290秒挂起，工具传输300秒；并非平台配置自动生效
 assert.equal(waits[0], 300_000);
});
it('事实驱动自由表达不要求朗读整个资源快照或固定邀请短语',async()=>{
 const facts:GameReply={...opening,you:{hp:14,maxHp:14,ap:3,maxAp:5,ult:1},foe:{name:'教头',hp:18,maxHp:18,ap:3,ult:1}};
 const agent=new SandboxAgent('伙伴',{async express(_system,input){assert.equal(input,facts);return '教头来了，我先手，兴奋起来了！告诉我打哪招？';}});
 const result=await agent.run('开始',tool(facts));assert.equal(result.rewriteStatus,'rewritten');assert.ok(!result.text.includes('14'));
});
it('silent和unknown不调用表达，表达失败不重做游戏且异常脱敏',async()=>{
 let calls=0,models=0;const agent=new SandboxAgent('伙伴',{async express(){models++;throw new Error('Bearer fake-secret');}});
 const tools={async callTool(){calls++;return {reply:opening,isError:false};}};
 const failed=await agent.run('开始',tools);assert.equal(calls,1);assert.equal(failed.text,opening.say);assert.equal(failed.rewriteStatus,'fallback-error');
 assert.ok(!JSON.stringify(failed).includes('fake-secret'));
 const silent=await agent.run('回灌',tool({v:2,ok:true,silent:true}));assert.equal(silent.text,'');assert.equal(silent.silent,true);
 await agent.run('未知',tool({v:2,ok:false,reason:'unknown',events:[],say:'结果未确认，先核实。'}));assert.equal(models,1);
});
it('拒绝演绎记录固定类别，不将候选或秘密放入diagnostics',async()=>{
 const facts:GameReply={v:2,ok:false,phase:'idle',need:'none',reason:'unclear',events:[],say:'没听清，再说一次。'};
 for(const [candidate,status] of [['我有点懵，没听清，再告诉我一次？','rewritten'],['我命中了！','fallback-invalid']]){
  const agent=new SandboxAgent('伙伴',{async express(){return candidate!;}});const result=await agent.run('嗯',tool(facts));assert.equal(result.rewriteStatus,status);
  if(status==='fallback-invalid'){assert.equal('validationReason' in result && result.validationReason,'certainty');assert.ok(!JSON.stringify(result).includes(candidate!));}
 }
});
it('模型请求只发送事实，不以say为改写底稿；没有tools且尊重取消',async()=>{
 let body:any;let signal:AbortSignal|undefined;
 const model=new OpenAiReplyModel({baseUrl:'https://mock.invalid/v1',model:'mock',apiKey:'fake',timeoutMs:1000,fetchImpl:async(_url,init)=>{body=JSON.parse(String(init?.body));signal=init?.signal??undefined;return new Response(JSON.stringify({choices:[{message:{content:'教头来了，我先手！告诉我怎么出招。'}}]}));}});
 const controller=new AbortController();await model.express('人设',opening,{signal:controller.signal});
 assert.equal(body.stream,false);assert.ok(!('tools' in body));const input=JSON.parse(body.messages[1].content);assert.equal(input.v,2);assert.ok(!('say' in input));
 controller.abort();assert.equal(signal?.aborted,true);
});
it('表达HTTP失败或只有推理过程不能当作成功',async()=>{
 for(const response of [new Response('',{status:503}),new Response(JSON.stringify({choices:[{message:{reasoning_content:'推理'}}]}))]){
  const model=new OpenAiReplyModel({baseUrl:'http://mock.invalid',model:'mock',apiKey:'fake',timeoutMs:1000,fetchImpl:async()=>response});
  await assert.rejects(model.express('人设',opening));
 }
});
