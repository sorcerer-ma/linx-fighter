import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { SandboxAgent, loadAgentPrompt } from '../sandbox/platform/agent.js';
import { SandboxClient } from '../sandbox/platform/client.js';
import { OpenAiReplyModel } from '../sandbox/platform/reply-model.js';
import { SPEECH_PROFILES, speechProfile, profilePrompt, resolveProfileId, companionPrompt, type SpeechProfileId } from '../sandbox/platform/profiles.js';
import { createLogger } from '../src/log.js';
import type { GameReply } from '../src/game/protocol.js';

const facts:GameReply={v:2,ok:true,phase:'idle',need:'none',events:[],say:'我准备好了。'};
const output=JSON.stringify({segments:[{text:'我准备好了，好期待呀！',emotion:'expectant'}]});
it('three profile IDs and speakers exactly match the approved voice pairs, with no forced name',()=>{
 assert.deepEqual(Object.keys(SPEECH_PROFILES),['cancan','qingcang','tiancai']);
 assert.equal(speechProfile('cancan')?.speaker,'zh_female_cancan_uranus_bigtts');
 assert.equal(speechProfile('qingcang')?.speaker,'zh_male_qingcang_uranus_bigtts');
 assert.equal(speechProfile('tiancai')?.speaker,'zh_male_tiancaitongsheng_uranus_bigtts');
 assert.equal(resolveProfileId(undefined),'cancan');assert.equal(speechProfile('__proto__'),undefined);
 assert.equal(speechProfile('other'),undefined);assert.throws(()=>resolveProfileId('other'),/未知伙伴气质/);
 const shared=readFileSync(new URL('../config/companion-profiles/shared.md',import.meta.url),'utf8');
 assert.ok(!shared.includes('小喵'));assert.match(shared,/名字/);assert.match(shared,/不因切换而改名|不指定或改变名字/);assert.match(shared,/不能由音色|音色名不是伙伴名字/);
 for(const id of Object.keys(SPEECH_PROFILES) as SpeechProfileId[]){assert.ok(!profilePrompt(id).includes('你的名字是'));assert.match(profilePrompt(id),/不能替换或覆盖/);}
});
it('actual expression adapter receives three different style supplements and keeps the full main safety prompt',async()=>{
 const main=loadAgentPrompt(new URL('../config/linx-agent-prompt.md',import.meta.url).pathname);
 const systems:string[]=[];const calls:Array<{name:string;args:Record<string,unknown>}>=[];
 const model=new OpenAiReplyModel({baseUrl:'https://mock.invalid/v1',model:'mock',apiKey:'fake',timeoutMs:1000,fetchImpl:async(_url,init)=>{
  const body=JSON.parse(String(init?.body));assert.ok(!('tools' in body));systems.push(body.messages[0].content);
  return new Response(JSON.stringify({choices:[{message:{content:output}}]}));
 }});
 const agent=new SandboxAgent(main,model);
 for(const profileId of Object.keys(SPEECH_PROFILES) as SpeechProfileId[]){
  const result=await agent.run('原话一字不改',{async callTool(name,args){calls.push({name,args});return {reply:facts,isError:false};}},{profileId});
  assert.equal(result.profileId,profileId);assert.equal(result.speech.source,'model');assert.equal(result.text,'我准备好了，好期待呀！');
 }
 assert.equal(calls.length,3);for(const call of calls)assert.deepEqual(call,{name:'game_say',args:{text:'原话一字不改'}});
 assert.equal(new Set(systems).size,3);
 for(const system of systems){assert.ok(system.startsWith(main.split('【第三层：可变人格】')[0]!.trimEnd()));assert.match(system,/只调用一次game_say/);assert.match(system,/【主规则优先】/);assert.match(system,/unknown/);assert.ok(!system.includes('你的名字是“小喵”'));}
 assert.match(systems[0]!,/【知性灿灿声线：温暖机灵的共鸣精灵】/);assert.match(systems[1]!,/【擎苍声线：沉稳有斗志的共鸣精灵】/);assert.match(systems[2]!,/【天才童声声线：活泼勇敢的共鸣精灵】/);
});
it('invalid profile rejects run and wait before any MCP or expression, and missing profile defaults cancan',async()=>{
 let game=0,models=0;const agent=new SandboxAgent('主规则',{async express(){models++;return output;}});
 const tools={async callTool(){game++;return {reply:facts,isError:false};}};
 for(const profileId of ['unknown','__proto__','../../evil','']){
  await assert.rejects(agent.run('开始',tools,{profileId}),/未知伙伴气质/);
  await assert.rejects(agent.wait(tools,{profileId}),/未知伙伴气质/);
 }
 assert.equal(game,0);assert.equal(models,0);
 const result=await agent.run('嗯',tools);assert.equal(result.profileId,'cancan');assert.equal(game,1);assert.equal(models,1);
});
it('profile is locked before an asynchronous game call, including wait_event',async()=>{
 let enter!:()=>void;const entered=new Promise<void>(resolve=>{enter=resolve;});
 let release!:()=>void;const released=new Promise<void>(resolve=>{release=resolve;});
 let system='';const calls:string[]=[];
 const options={profileId:'qingcang'};
 const agent=new SandboxAgent('主规则',{async express(prompt){system=prompt;return output;}});
 const waiting=agent.wait({async callTool(name,args){calls.push(name);assert.deepEqual(args,{});enter();await released;return {reply:facts,isError:false};}},options);
 await entered;options.profileId='tiancai';release();const result=await waiting;
 assert.deepEqual(calls,['wait_event']);assert.equal(result.profileId,'qingcang');assert.match(system,/【擎苍声线：/);assert.ok(!system.includes('【天才童声声线：'));
});
it('client validates unknown profile before initialize and returns request-locked profile on all results',async()=>{
 const original=globalThis.fetch;let fetches=0;let toolCalls=0;const prompts:string[]=[];
 const options={profileId:'cancan'};
 globalThis.fetch=async(url,init)=>{
  fetches++;
  if(String(url).includes('/state'))return new Response(JSON.stringify({device:'test',agent:'test',room:null,battle:null}));
  const body=JSON.parse(String(init?.body));
  if(!('id' in body))return new Response(null,{status:202});
  if(body.method==='initialize'){options.profileId='tiancai';return new Response(JSON.stringify({jsonrpc:'2.0',id:body.id,result:{serverInfo:{name:'mock',version:'2'}}}),{headers:{'content-type':'application/json'}});}
  toolCalls++;return new Response(JSON.stringify({jsonrpc:'2.0',id:body.id,result:{_meta:{'linx/battleId':null},content:[{type:'text',text:JSON.stringify(facts)}]}}),{headers:{'content-type':'application/json'}});
 };
 try{
  const client=new SandboxClient({upstream:'http://mock.invalid',agentId:'test',timeoutMs:1000,logger:createLogger('error'),agent:new SandboxAgent('主规则',{async express(prompt){prompts.push(prompt);return output;}})});
  await assert.rejects(client.say('test','开始',{profileId:'unknown'}),/未知伙伴气质/);await assert.rejects(client.wait('test',{profileId:'unknown'}),/未知伙伴气质/);assert.equal(fetches,0);
  const result=await client.say('test','嗯',options);assert.equal(result.profileId,'cancan');assert.equal(toolCalls,1);assert.match(prompts[0]!,/【知性灿灿声线：/);
  const controller=new AbortController();controller.abort();const cancelled=await client.wait('test',{profileId:'qingcang',signal:controller.signal});
  assert.equal(cancelled.profileId,'qingcang');assert.equal(cancelled.silent,true);assert.deepEqual(cancelled.speech.segments,[]);assert.equal(toolCalls,1);
 }finally{globalThis.fetch=original;}
});

it('本机个体名独立于三种音色并实际进入表达prompt；未命名不自动叫小喵',async()=>{
 const systems:string[]=[];const model={async express(system:string){systems.push(system);return JSON.stringify({segments:[{text:'我准备好了。',emotion:'expectant'}]});}};
 const facts:GameReply={v:2,ok:true,phase:'idle',need:'none',events:[],say:'我准备好了。'};
 const tools={async callTool(){return{reply:facts,isError:false};}};
 const named=new SandboxAgent('共享主规则',model,'小喵');
 for(const profileId of ['cancan','qingcang','tiancai'])await named.run('嗯',tools,{profileId});
 assert.equal(systems.length,3);for(const system of systems)assert.ok(system.includes('companionName="小喵"'));
 systems.length=0;await new SandboxAgent('共享主规则',model).run('嗯',tools,{profileId:'tiancai'});
 assert.ok(!systems[0]!.includes('小喵'));assert.ok(systems[0]!.includes('尚未设置个体名字'));
});

it('three styles only replace persona: fixed execution and world stay identical and are not duplicated',()=>{
 const main=loadAgentPrompt(new URL('../config/linx-agent-prompt.md',import.meta.url).pathname);
 const execution=main.indexOf('【第一层：执行契约（不可覆盖）】'),world=main.indexOf('【第二层：固定世界观（不可覆盖）】'),persona=main.indexOf('【第三层：可变人格】');
 assert.ok(execution===0 && execution<world && world<persona);
 const fixed=main.slice(0,persona).trimEnd();
 for(const id of Object.keys(SPEECH_PROFILES) as SpeechProfileId[]){
  const generated=companionPrompt(main,id,'小喵');assert.equal(generated.slice(0,fixed.length),fixed);
  assert.equal(generated.split('在《共鸣：闻声对决》的世界里').length-1,1);
  assert.match(generated,/纯正常timeout|正常空超时/);assert.match(generated,/silent:true/);
  assert.ok(!/最多等待一次|最多调用一次 wait_event|不自动续挂/.test(generated));
 }
});
