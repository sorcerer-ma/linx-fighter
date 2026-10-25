import assert from 'node:assert/strict';
import { it } from 'node:test';
const { createListeningSession } = await import(new URL('../sandbox/public/listening.js', import.meta.url).href);
function harness() {
  const instances: any[] = [], states: any[] = [], texts: string[] = [], errors: string[] = [];
  class Recognition {
    onstart?: () => void;
    onend?: () => void;
    aborted = false;
    constructor() { instances.push(this); }
    start() { this.onstart?.(); }
    abort() { this.aborted = true; this.onend?.(); }
  }
  const session = createListeningSession({Recognition,onState:(s:any)=>states.push(s),onText:()=>{},onFinal:(s:string)=>texts.push(s),onError:(s:string)=>errors.push(s)});
  return {session,instances,states,texts,errors};
}
it('单段结束及短静音保持用户启用，并接续真实收音', t => {
  t.mock.timers.enable({apis:['setTimeout']});
  const h=harness();h.session.start();
  h.instances[0].onerror({error:'no-speech'});h.instances[0].onend();
  assert.equal(h.session.enabled,true);assert.equal(h.states.at(-1).active,false);
  t.mock.timers.tick(300);assert.equal(h.instances.length,2);assert.equal(h.states.at(-1).active,true);
});
it('手动停止取消延迟重启，旧回调及播报恢复不重新开启',t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const h=harness();h.session.start();h.instances[0].onend();h.session.stop();
  t.mock.timers.tick(1000);h.session.resume();h.instances[0].onend();
  assert.equal(h.instances.length,1);assert.equal(h.session.enabled,false);
});
it('最终识别仅发送一次，等待回复或TTS期间暂停，结束再恢复',()=>{
  const h=harness();h.session.start();const first=h.instances[0];
  const event={resultIndex:0,results:[Object.assign([{transcript:'强攻'}],{isFinal:true})]};
  first.onresult(event);first.onresult(event);
  assert.deepEqual(h.texts,['强攻']);assert.equal(h.session.enabled,true);assert.equal(h.states.at(-1).active,false);
  h.session.pause();assert.equal(h.instances.length,1);
  h.session.resume();h.session.resume();assert.equal(h.instances.length,2);
});
it('权限拒绝或不可恢复错误停止，不无限重试',t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  for(const code of ['not-allowed','service-not-allowed','audio-capture','network']){
    const h=harness();h.session.start();h.instances[0].onerror({error:code});
    h.instances[0].onend();t.mock.timers.tick(1000);h.session.resume();
    assert.equal(h.session.enabled,false);assert.equal(h.instances.length,1);assert.deepEqual(h.errors,[code]);
  }
});
it('暂停与终止丢弃旧recognizer的迟到final，临时识别不提交',()=>{
  const h=harness();h.session.start();const first=h.instances[0];
  first.onresult({resultIndex:0,results:[Object.assign([{transcript:'强攻'}],{isFinal:false})]});assert.deepEqual(h.texts,[]);
  h.session.pause();first.onresult({resultIndex:0,results:[Object.assign([{transcript:'强攻'}],{isFinal:true})]});
  assert.deepEqual(h.texts,[]);h.session.stop();h.session.resume();assert.equal(h.instances.length,1);
});
