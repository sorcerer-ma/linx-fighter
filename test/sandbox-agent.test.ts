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
it('每条原话包括查询、发起挑战都只执行一次game_say且不改原文',async()=>{
 for(const text of ['  强攻！  ','战况如何','共鸣对决，发起挑战','接受挑战，编号1234','不要大招']){
  const calls:unknown[]=[];
  const agent=new SandboxAgent('test');
  const result=await agent.run(text,{async callTool(name,args){calls.push({name,args});return {text:'对手受伤，我剩3点能量。',isError:false}}});
  assert.deepEqual(calls,[{name:'game_say',args:{text}}]);
  assert.equal(result.text,result.sourceText);assert.equal(result.rewriteStatus,'original');
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
 assert.ok(!requests[0]?.body.messages[0].content.includes('只从服务端renderings'));
});
it('表达HTTP失败或无有效内容明确失败，不将推理过程当回复',async()=>{
 for(const response of [new Response('unavailable',{status:503}),new Response(JSON.stringify({choices:[{message:{reasoning_content:'不能当作最终回复'}}]}),{status:200})]){
  const model=new OpenAiReplyModel({baseUrl:'http://mock.invalid',model:'mock',apiKey:'fake',timeoutMs:1000,fetchImpl:async()=>response});
  await assert.rejects(model.rewrite('人设','真实结果'));
 }
});
it('允许候选外的整句改写，颠倒归属/胜负/终局下一步则回原文',async()=>{
 const {presentation}=await import('../src/game/presentation.js');
 const facts=presentation('turn',null,{renderings:['我受伤5点，对手获胜。','我掉5点生命值，对手赢了。']});
 facts.facts.phase='defeat';facts.facts.next='ended';
 for(const candidate of ['我挨了5点伤害，对手获胜了。','对手受伤5点，我获胜。','我受伤5点，对手获胜。该我出招。']){
  let calls=0;
  const agent=new SandboxAgent('test',{async rewrite(){return candidate}});
  const result=await agent.run('强攻',{async callTool(){calls++;return {text:facts.renderings[0]!,isError:false,presentation:facts}}});
  assert.equal(calls,1);
  assert.equal(result.text,candidate==='我挨了5点伤害，对手获胜了。'?candidate:facts.renderings[0]);
 }
});
it('表达失败回已有工具原文；未知结果及无事实不调用模型',async()=>{
 const {presentation}=await import('../src/game/presentation.js');let modelCalls=0,toolCalls=0;
 const agent=new SandboxAgent('test',{async rewrite(){modelCalls++;throw new Error('timeout')}});
 const facts=presentation('turn',null,{renderings:['真实结果。','真正的结果。']});
 const result=await agent.run('出招',{async callTool(){toolCalls++;return {text:'真实结果。',isError:false,presentation:facts}}});
 assert.equal(result.text,'真实结果。');assert.equal(result.rewriteStatus,'fallback-error');assert.equal(toolCalls,1);
 await agent.run('状态',{async callTool(){return {text:'结果未确认。',isError:true,presentation:presentation('error',null)}}});
 await agent.run('状态',{async callTool(){return {text:'没有演绎事实。',isError:false}}});assert.equal(modelCalls,1);
});

it('表达失败只返回受控错误码，不回显异常中的配置或认证内容',async()=>{
 const {presentation}=await import('../src/game/presentation.js');
 const facts=presentation('status',null,{renderings:['原文。','另一种表达。']});
 for(const message of ['表达模型请求失败：HTTP 403','request failed with Bearer fake-secret']){
  const agent=new SandboxAgent('test',{async rewrite(){throw new Error(message)}});
  const result=await agent.run('战况',{async callTool(){return {text:'原文。',isError:false,presentation:facts}}});
  assert.equal(result.text,'原文。');assert.ok(!JSON.stringify(result).includes('fake-secret'));
  assert.equal('expressionError' in result ? result.expressionError : '',message.startsWith('表达模型请求失败')?message:'表达模型不可用');
 }
});


it('开局、重说和明确拒绝可自由表达，仍只调用一次原话工具',async()=>{
 const {presentation}=await import('../src/game/presentation.js');
 const cases=[
  {kind:'opening' as const,source:'对决开始。',reply:'开打啦，我准备好了！'},
  {kind:'retry' as const,source:'没听清这一手，再说一次。',reply:'没听懂，再告诉我一次？'},
  {kind:'rejected' as const,source:'我只有3点能量，大招要4点。',reply:'我现在3点能量，大招要4点，换个办法吧？'},
 ];
 for(const c of cases){
  let tools=0,models=0;const facts=presentation(c.kind,null);
  const agent=new SandboxAgent('伙伴',{async rewrite(){models++;return c.reply}});
  const result=await agent.run('原话',{async callTool(name,args){tools++;assert.equal(name,'game_say');assert.deepEqual(args,{text:'原话'});return {text:c.source,isError:false,presentation:facts}}});
  assert.equal(result.text,c.reply);assert.equal(result.rewriteStatus,'rewritten');assert.equal(models,1);assert.equal(tools,1);
 }
 const facts=presentation('retry',null);facts.facts.next='act';
 const agent=new SandboxAgent('伙伴',{async rewrite(){return '我命中了！'}});
 const result=await agent.run('未知',{async callTool(){return {text:'没听清，再说一次。',isError:false,presentation:facts}}});
 assert.equal(result.rewriteStatus,'fallback-invalid');assert.equal(result.text,'没听清，再说一次。');
});
