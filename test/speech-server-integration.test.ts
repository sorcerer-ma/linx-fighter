import assert from 'node:assert/strict';
import { once, EventEmitter } from 'node:events';
import { it } from 'node:test';
import { createSandboxServer } from '../sandbox/server.js';
import { loadSandboxConfig } from '../sandbox/config.js';
import { SandboxClient } from '../sandbox/platform/client.js';
import { createLogger } from '../src/log.js';
import { loadSpeechConfig, type SpeechConfig } from '../sandbox/speech.js';
import { int32, sized } from '../sandbox/speech/binary.js';
import { parseTts } from '../sandbox/speech/tts-protocol.js';
import type { ConnectSpeech } from '../sandbox/speech/doubao.js';

const logger=createLogger('error');
function appFor(speech:SpeechConfig, connectSpeech?:ConnectSpeech, bridge=false){
 const config={...loadSandboxConfig({}),ttsBridge:bridge};
 const client=new SandboxClient({upstream:config.upstream,agentId:config.agentId,timeoutMs:1000,logger});
 return createSandboxServer({config,client,speech,connectSpeech});
}
function ttsRoutes(app:ReturnType<typeof createSandboxServer>):number{
 return app.router.stack.filter((layer:any)=>layer.route?.path==='/api/speech/tts'&&layer.route.methods.post).length;
}
it('browser default stays browser; direct and local bridge register exactly one TTS route',()=>{
 const browser=loadSpeechConfig({});assert.equal(browser.asr,'browser');assert.equal(browser.tts,'browser');
 assert.equal(ttsRoutes(appFor(browser)),1);assert.equal(ttsRoutes(appFor(browser,undefined,true)),1);
 assert.throws(()=>loadSpeechConfig({SANDBOX_ASR_MODE:'doubao'}),/Missing SANDBOX_SPEECH_API_KEY/);
 assert.throws(()=>loadSpeechConfig({SANDBOX_TTS_MODE:'doubao'}),/Missing SANDBOX_SPEECH_API_KEY/);
});
it('injected direct cloud config reports backend TTS without exposing credentials or causing provider requests on config',async()=>{
 const speech:SpeechConfig={asr:'doubao',tts:'doubao',doubao:{apiKey:'fixture-secret',asrResource:'fixture',ttsResource:'seed-tts-2.0',speaker:'zh_female_cancan_uranus_bigtts'}};
 let connections=0;const app=appFor(speech,async()=>{connections++;throw Error('unexpected');});
 const server=app.listen(0,'127.0.0.1');await once(server,'listening');
 try{
  const response=await fetch(`http://127.0.0.1:${(server.address() as {port:number}).port}/api/config`);const text=await response.text();const body=JSON.parse(text);
  assert.equal(body.voice.asr,'doubao');assert.equal(body.voice.tts,'backend');assert.equal(body.voice.ttsMode,'doubao');assert.equal(connections,0);
  assert.ok(!text.includes('fixture-secret'));assert.ok(!text.includes('apiKey'));assert.equal(ttsRoutes(app),1);
 }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
it('server direct TTS uses injected connector and canonical selected profile, never the fixed local bridge',async()=>{
 let connections=0;const speakers:string[]=[];
 class Socket extends EventEmitter{
  session='';
  frame(event:number,id:string,payload=Buffer.from('{}'),audio=false){return Buffer.concat([Buffer.from([0x11,audio?0xb4:0x94,audio?0:0x10,0]),int32(event),sized(Buffer.from(id)),sized(payload)]);}
  send(data:Buffer){const event=data.readInt32BE(4);if(event===1)queueMicrotask(()=>this.emit('message',this.frame(50,'fixture')));
   if(event===100||event===200){const encoded=Buffer.from(data);encoded[1]=0x94;const frame=parseTts(encoded);this.session=frame.id;
    if(event===100){speakers.push(JSON.parse(frame.payload.toString()).req_params.speaker);queueMicrotask(()=>this.emit('message',this.frame(150,frame.id)));}}
   if(event===102)queueMicrotask(()=>{this.emit('message',this.frame(352,this.session,Buffer.alloc(16),true));this.emit('message',this.frame(152,this.session,Buffer.from('{"usage":{"text_words":4}}')));});
  }
  close(){this.emit('close');}
 }
 const speech=loadSpeechConfig({SANDBOX_TTS_MODE:'doubao',SANDBOX_SPEECH_API_KEY:'fixture',SANDBOX_TTS_RESOURCE:'seed-tts-2.0',SANDBOX_TTS_SPEAKER:'zh_female_cancan_uranus_bigtts'});
 const app=appFor(speech,async()=>{connections++;return new Socket();});const server=app.listen(0,'127.0.0.1');await once(server,'listening');
 try{
  const url=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  const response=await fetch(url+'/api/speech/tts',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:'我准备好了。',emotion:'determined',profileId:'qingcang'})});
  assert.equal(response.status,200);assert.equal(response.headers.get('X-Speech-Profile'),'qingcang');assert.equal(response.headers.get('X-Speech-Emotion-Applied'),'determined');assert.equal(response.headers.get('Content-Type')?.split(';')[0],'audio/wav');
  assert.equal((await response.arrayBuffer()).byteLength,60);assert.equal(connections,1);assert.deepEqual(speakers,['zh_male_qingcang_uranus_bigtts']);
 }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
