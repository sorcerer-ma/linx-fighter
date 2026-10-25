import assert from 'node:assert/strict';
import { it } from 'node:test';
// @ts-expect-error Browser adapter is plain JS.
import { backendPlayback } from '../sandbox/public/playback.js';

it('真实音频适配器发送情绪，等Audio ended并回报实际应用元数据；取消释放音频',async()=>{
 const originalFetch=globalThis.fetch, originalAudio=(globalThis as any).Audio;
 const originalCreate=URL.createObjectURL, originalRevoke=URL.revokeObjectURL;
 const audios:any[]=[],sent:any[]=[],revoked:string[]=[];
 class AudioFixture{
  onended?:()=>void;onerror?:()=>void;paused=false;removed=false;
  constructor(public url:string){audios.push(this);}
  play(){return Promise.resolve();}pause(){this.paused=true;}removeAttribute(){this.removed=true;}
 }
 (globalThis as any).Audio=AudioFixture;
 URL.createObjectURL=()=> 'blob:fixture';URL.revokeObjectURL=url=>{revoked.push(url);};
 globalThis.fetch=async(input,init)=>{
  assert.equal(input,'/api/speech/tts');sent.push(JSON.parse(init!.body as string));
  return new Response(new Uint8Array([82,73,70,70]),{headers:{'content-type':'audio/wav','X-Speech-Emotion-Requested':'proud','X-Speech-Emotion-Applied':'happy','X-Speech-Control':'emotion'}});
 };
 try{
  let done=false;let applied:any;
  const first=backendPlayback({text:'挡住啦！',emotion:'proud'},new AbortController().signal,(value:any)=>{applied=value;}).then(()=>{done=true;});
  while(!audios.length)await new Promise(r=>setImmediate(r));
  assert.equal(done,false);assert.deepEqual(sent[0],{text:'挡住啦！',emotion:'proud'});
  assert.deepEqual(applied,{requested:'proud',applied:'happy',control:'emotion'});
  audios[0].onended();await first;assert.equal(done,true);assert.equal(audios[0].paused,true);
  const controller=new AbortController();const second=backendPlayback({text:'有点痛！',emotion:'hurt'},controller.signal);
  const rejected=assert.rejects(second,/cancelled/);
  while(audios.length<2)await new Promise(r=>setImmediate(r));controller.abort();await rejected;
  assert.equal(audios[1].paused,true);assert.equal(audios[1].removed,true);assert.equal(revoked.length,2);
 }finally{globalThis.fetch=originalFetch;(globalThis as any).Audio=originalAudio;URL.createObjectURL=originalCreate;URL.revokeObjectURL=originalRevoke;}
});
