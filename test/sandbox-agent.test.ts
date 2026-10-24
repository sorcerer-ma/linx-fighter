import assert from 'node:assert/strict';
import { it } from 'node:test';
import { loadSandboxConfig } from '../sandbox/config.js';
import { SandboxAgent, createSandboxAgent } from '../sandbox/platform/agent.js';
import { OpenAiReplyModel } from '../sandbox/platform/reply-model.js';
it('不默认选择模型；单源提示词读取，未配置保留明确直连',()=>{
 const config=loadSandboxConfig({});assert.equal(config.agent.model,undefined);assert.equal(createSandboxAgent(config.agent),undefined);
 assert.throws(()=>createSandboxAgent({...config.agent,model:'test'}),/配置未完成/);
 assert.ok(createSandboxAgent({...config.agent,model:'test',baseUrl:'http://example.invalid',apiKey:'fake'}) instanceof SandboxAgent);
 assert.throws(()=>createSandboxAgent({...config.agent,promptPath:'/no-such-agent-prompt'}));
});
it('每条原话包括查询、开房都只执行一次game_say且不改原文',async()=>{
 for(const text of ['  强攻！  ','战况如何','开房间','加入房间1234','不要大招']){
  const calls:unknown[]=[];
  const agent=new SandboxAgent('test');
  const result=await agent.run(text,{async callTool(name,args){calls.push({name,args});return {text:'对手受伤，我剩3点能量。',isError:false}}});
  assert.deepEqual(calls,[{name:'game_say',args:{text}}]);
  assert.equal(result.text,result.sourceText);assert.equal(result.rewriteStatus,'awaiting-facts');
 }
});
it('工具异常绝不再执行或换工具；明确错误原样保留',async()=>{
 const agent=new SandboxAgent('test');let calls=0;
 await assert.rejects(agent.run('强攻',{async callTool(){calls++;throw new Error('connection lost')}}),/connection lost/);
 assert.equal(calls,1);
 const result=await agent.run('状态',{async callTool(){return {text:'结果待核实。',isError:true}}});
 assert.equal(result.isError,true);assert.equal(result.text,'结果待核实。');
});
it('表达适配器只发非流式chat请求，无游戏工具；仅使用本地假fetch',async()=>{
 const requests:Array<{url:string;body:any;authorization:string|null}>=[];
 const model=new OpenAiReplyModel({baseUrl:'https://opencode.ai/inference/openai/v1',model:'deepseek-v4.1-flash-free',apiKey:'fake-test-only',timeoutMs:1000,
  fetchImpl:async(url,init)=>{requests.push({url:String(url),body:JSON.parse(String(init?.body)),authorization:new Headers(init?.headers).get('Authorization')});return new Response(JSON.stringify({choices:[{message:{content:' 我挡住了一部分，掉1点生命值。 '}}]}),{status:200})}});
 assert.equal(await model.rewrite('伙伴人设','我格挡，掉1点生命值。'),'我挡住了一部分，掉1点生命值。');
 assert.equal(requests[0]?.url,'https://opencode.ai/inference/openai/v1/chat/completions');
 assert.equal(requests[0]?.body.model,'deepseek-v4.1-flash-free');assert.equal(requests[0]?.body.stream,false);assert.ok(!('tools' in requests[0]!.body));
 assert.equal(requests[0]?.body.messages[0].role,'system');
});
it('表达HTTP失败或无有效内容明确失败，不将推理过程当回复',async()=>{
 for(const response of [new Response('unavailable',{status:503}),new Response(JSON.stringify({choices:[{message:{reasoning_content:'不能当作最终回复'}}]}),{status:200})]){
  const model=new OpenAiReplyModel({baseUrl:'http://mock.invalid',model:'mock',apiKey:'fake',timeoutMs:1000,fetchImpl:async()=>response});
  await assert.rejects(model.rewrite('人设','真实结果'));
 }
});
