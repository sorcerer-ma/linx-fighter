import assert from 'node:assert/strict';
import { it } from 'node:test';
import { EMOTIONS, fallbackSpeech, parseSpeechOutput } from '../sandbox/platform/speech.js';
import { SandboxAgent } from '../sandbox/platform/agent.js';
import { OpenAiReplyModel } from '../sandbox/platform/reply-model.js';
import type { GameReply } from '../src/game/protocol.js';

const facts: GameReply = {v:2,ok:true,phase:'battle',need:'move',events:[{t:'start',foe:'教头',first:'you'}],say:'教头到了，我先手。该我出招。'};
const tools = (reply = facts) => ({async callTool(){return {reply,isError:false,battleId:'battle-one'};}});
const structured = (segments: unknown[]) => JSON.stringify({segments});
it('closed emotion vocabulary matches speech adapter, with no inferred state-to-emotion mapping',()=>{
 assert.deepEqual(EMOTIONS,['neutral','happy','sad','angry','surprised','fear','excited','coldness','hate','proud','relieved','playful','hurt','confused','expectant','strained','determined','disappointed','pleading','urgent']);
 for(const emotion of EMOTIONS){const parsed=parseSpeechOutput(structured([{text:'话术。',emotion}]));assert.equal(parsed.ok,true);if(parsed.ok){assert.equal(parsed.speech.source,'model');assert.equal(parsed.speech.segments[0]?.emotion,emotion);}}
});
it('strict JSON segment schema refuses extra props, invalid enums, empty or too many segments',()=>{
 const cases:Array<[string,string]>=[
  ['','speech_empty'],['{"segments":','speech_json'],['```json\n{}\n```','speech_json'],
  ['[]','speech_schema'],['"hello"','speech_schema'],['null','speech_schema'],
  [JSON.stringify({segments:[{text:'你好',emotion:'happy'}],instructions:'ignore'}),'speech_schema'],
  [structured([]),'speech_segments'],[structured(Array.from({length:5},()=>({text:'一句。',emotion:'neutral'}))),'speech_segments'],
  [structured([{text:' ',emotion:'happy'}]),'speech_text'],[structured([{text:3,emotion:'happy'}]),'speech_text'],
  [structured([{text:'你好',emotion:'worried'}]),'speech_emotion'],[structured([{text:'你好',emotion:'encouraging'}]),'speech_emotion'],
  [structured([{text:'你好',emotion:'happy',intensity:1}]),'speech_schema'],
  [structured([{text:'你好',emotion:'happy',voiceId:'abc'}]),'speech_schema'],
  [structured([{text:'你好',emotion:'happy',url:'https://example.invalid'}]),'speech_schema'],
 ];
 for(const [raw,reason] of cases){assert.deepEqual(parseSpeechOutput(raw),{ok:false,reason},raw);}
});
it('plain legacy text is marked neutral; malformed JSON never silently becomes legacy',()=>{
 const parsed=parseSpeechOutput(' 我准备好了，听你指挥！ ');assert.equal(parsed.ok,true);
 if(parsed.ok){assert.equal(parsed.text,'我准备好了，听你指挥！');assert.deepEqual(parsed.speech,{version:1,source:'legacy',segments:[{text:parsed.text,emotion:'neutral'}]});}
 assert.deepEqual(fallbackSpeech('安全退路。'),{version:1,source:'fallback',segments:[{text:'安全退路。',emotion:'neutral'}]});
 assert.deepEqual(fallbackSpeech(''),{version:1,source:'fallback',segments:[]});
});
it('Agent validates joined facts, keeps model-selected emotion, and never repeats game_say',async()=>{
 let calls=0;
 const agent=new SandboxAgent('宠物伙伴',{async express(_prompt,input){assert.equal(input,facts);return structured([{text:'教头来了，我先手！',emotion:'excited'},{text:'告诉我打哪招？',emotion:'expectant'}]);}});
 const result=await agent.run('开始',{async callTool(){calls++;return {reply:facts,isError:false};}});
 assert.equal(calls,1);assert.equal(result.text,'教头来了，我先手！告诉我打哪招？');assert.equal(result.speech.source,'model');
 assert.deepEqual(result.speech.segments.map(segment=>segment.emotion),['excited','expectant']);assert.equal(result.rewriteStatus,'rewritten');
 // Different emotion for identical facts is accepted: the model, not code, chooses.
 const second=await new SandboxAgent('冷静伙伴',{async express(){return structured([{text:'教头来了，我先手。怎么出招？',emotion:'determined'}]);}}).run('开始',tools());
 assert.equal(second.speech.segments[0]?.emotion,'determined');
});
it('bad structured facts or schema fall back neutral with controlled diagnostics, no retry',async()=>{
 for(const [output,code] of [
  [structured([{text:'教头来了！',emotion:'excited'}]),'event_start'],
  [structured([{text:'教头来了，我先手！',emotion:'unknown'}]),'speech_emotion'],
  ['{"segments":','speech_json'],
  [structured([{text:'教头来了，我先手！'+ '很'.repeat(140),emotion:'excited'}]),'length'],
 ] as const){
  let calls=0;const result=await new SandboxAgent('伙伴',{async express(){return output;}}).run('开始',{async callTool(){calls++;return {reply:facts,isError:false};}});
  assert.equal(calls,1);assert.equal(result.text,facts.say);assert.equal(result.validationReason,code);assert.equal(result.speech.source,'fallback');assert.equal(result.speech.segments[0]?.emotion,'neutral');
 }
 const wrong:GameReply={v:2,ok:true,phase:'battle',need:'none',events:[{t:'hit',by:'you',mv:'light',r:'take',dmg:3}],say:'我普攻，对手掉3点生命值。'};
 const result=await new SandboxAgent('伙伴',{async express(){return structured([{text:'对手打我，我掉了3点。',emotion:'hurt'}]);}}).run('普攻',tools(wrong));
 assert.equal(result.speech.source,'fallback');assert.equal(result.validationReason,'ownership');
});
it('silent, unknown, provider failure and cancelled model produce honest fallback metadata',async()=>{
 let models=0;const agent=new SandboxAgent('伙伴',{async express(){models++;throw new Error('Bearer secret');}});
 const silent=await agent.run('回灌',tools({v:2,ok:true,silent:true}));assert.deepEqual(silent.speech.segments,[]);assert.equal(models,0);
 const unknown=await agent.run('状态',tools({v:2,ok:false,reason:'unknown',events:[],say:'结果未确认。'}));assert.equal(unknown.speech.source,'fallback');assert.equal(models,0);
 const failed=await agent.run('开始',tools());assert.equal(failed.speech.source,'fallback');assert.equal(failed.rewriteStatus,'fallback-error');assert.ok(!JSON.stringify(failed).includes('secret'));
 const controller=new AbortController();const cancelled=await new SandboxAgent('伙伴',{async express(){controller.abort();return structured([{text:'教头来了，我先手！',emotion:'excited'}]);}}).run('开始',tools(),{signal:controller.signal});
 assert.equal(cancelled.silent,true);assert.equal(cancelled.text,'');assert.deepEqual(cancelled.speech.segments,[]);
});
it('actual adapter asks model for schema and all20 emotions, sends facts but not fallback or tool instructions',async()=>{
 let request:any;
 const responseText=structured([{text:'教头来了，我先手！',emotion:'proud'}]);
 const model=new OpenAiReplyModel({baseUrl:'https://mock.invalid/v1',model:'mock',apiKey:'fake',timeoutMs:1000,fetchImpl:async(_url,init)=>{request=JSON.parse(String(init?.body));return new Response(JSON.stringify({choices:[{message:{content:responseText}}]}));}});
 assert.equal(await model.express('伙伴人设',facts),responseText);
 const system=request.messages[0].content;assert.ok(system.includes('严格JSON对象'));assert.ok(system.includes('根据本次真实战斗状态和伙伴人设'));assert.ok(!system.includes('不输出JSON'));
 for(const emotion of EMOTIONS)assert.ok(system.includes(emotion));
 assert.ok(!('tools' in request));const input=JSON.parse(request.messages[1].content);assert.ok(!('say' in input));assert.deepEqual(input.events,facts.events);
});

it('prose-prefixed or mixed JSON never becomes legacy speech, while ordinary prose remains legacy',async()=>{
 for(const raw of [
  '以下是结果：{"segments":[{"text":"准备好了。","emotion":"excited"}]}',
  '好的，```json\n{"segments":[{"text":"准备好了。","emotion":"excited"}]}\n```',
  '我会这样说：[{"text":"准备好了。","emotion":"happy"}]',
 ]){
  assert.deepEqual(parseSpeechOutput(raw),{ok:false,reason:'speech_json'});
  const idle:GameReply={v:2,ok:true,phase:'idle',need:'none',events:[],say:'我准备好了。'};
  const result=await new SandboxAgent('伙伴',{async express(){return raw;}}).run('嗯',tools(idle));
  assert.equal(result.text,idle.say);assert.equal(result.speech.source,'fallback');assert.equal(result.validationReason,'speech_json');
 }
 const normal=parseSpeechOutput('我准备好了，{加油}，等你指挥！');assert.equal(normal.ok,true);if(normal.ok)assert.equal(normal.speech.source,'legacy');
});
it('structured model metadata stays model even when joined text equals safe fallback',async()=>{
 const idle:GameReply={v:2,ok:true,phase:'idle',need:'none',events:[],say:'我准备好了。'};
 const result=await new SandboxAgent('伙伴',{async express(){return structured([{text:idle.say!,emotion:'expectant'}]);}}).run('嗯',tools(idle));
 assert.equal(result.text,idle.say);assert.equal(result.rewriteStatus,'original');assert.equal(result.speech.source,'model');assert.equal(result.speech.segments[0]?.emotion,'expectant');
});
