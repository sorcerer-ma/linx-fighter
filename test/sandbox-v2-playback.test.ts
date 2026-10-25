import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import vm from 'node:vm';

const script = readFileSync(new URL('../sandbox/public/app.js', import.meta.url), 'utf8').replace(/^import .*;\n/gm, '');
const flush = async () => { for (let i = 0; i < 6; i++) await new Promise<void>(resolve => setImmediate(resolve)); };
const outcome = (reply: string, need = 'move') => ({ ok: true, isError: false, reply, silent: false, protocol: { v: 2, ok: true, need, phase: 'battle', events: [] } });
function harness(audio = true, cloud = false) {
  const cloudItems: any[] = [];
  const nodes = new Map<string, any>(), messages: any[] = [], utterances: any[] = [], calls: any[] = [], docEvents: Record<string, () => void> = {};
  const timers = new Map<number, () => void>(); let timerId = 0, listeningOptions: any, stream: any;
  function node(id: string): any {
    if (!nodes.has(id)) nodes.set(id, {
      hidden: id === 'composer', textContent: '', value: '', dataset: {}, attrs: {}, events: {},
      setAttribute(key: string, value: string) { this.attrs[key] = value; },
      addEventListener(key: string, value: unknown) { this.events[key] = value; },
      getBoundingClientRect() { return { bottom: 0, top: 0 }; }, focus() {},
    });
    return nodes.get(id);
  }
  const listener = { enabled: true, active: true, paused: false, resumes: 0,
    start() { this.enabled = true; }, stop() { this.enabled = false; this.active = false; },
    pause() { this.paused = true; }, resume() { this.resumes++; if (this.enabled) this.paused = false; },
  };
  const document = { hidden: false, getElementById: node, querySelector() { return null; },
    addEventListener(name: string, fn: () => void) { docEvents[name] = fn; }, documentElement: { style: { setProperty() {} } },
  };
  const window: any = { location: { search: '?player=test' }, sessionStorage: { getItem() { return null; }, setItem() {} },
    isSecureContext: true, SpeechRecognition: class {}, addEventListener() {}, scrollBy() {},
  };
  if (audio) {
    window.SpeechSynthesisUtterance = class { constructor(public text: string) {} };
    window.speechSynthesis = { speak(utter: any) { utterances.push(utter); }, cancel() {} };
  }
  class EventSource {
    readyState = 1; onopen?: () => void; onerror?: () => void; onstate?: (data: any) => void;
    constructor() { stream = this; }
    addEventListener(name: string, fn: any) { if (name === 'state') this.onstate = fn; }
    close() {}
  }
  const fetch = (url: string, init: any = {}) => {
    if (url === '/api/config') return Promise.resolve({ ok: true, json: async () => ({ agentMode: 'relay', eventsUrl: '/events', voice:{tts:cloud ? 'backend' : 'browser'} }) });
    let resolve: (data: any) => void = () => {};
    const promise = new Promise<any>(done => { resolve = done; });
    calls.push({ url, init, respond(data: any) { resolve({ ok: true, json: async () => data }); } });
    return promise;
  };
  vm.runInContext(script, vm.createContext({ window, document, fetch, EventSource, AbortController, URLSearchParams, Uint8Array,
    backendPlayback(item: any, signal: AbortSignal, onEmotion: any) {
      return new Promise((resolve, reject) => {
        cloudItems.push({ item, signal, finish() { onEmotion({requested:item.emotion,applied:item.emotion,control:'instruction'}); resolve(undefined); }, fail() { reject(new Error('synthesis_failed')); } });
        signal.addEventListener('abort', () => reject(new Error('cancelled')), { once:true });
      });
    },
    diagnosticText() { return ''; },
    createConversation: () => ({ append(role: string, text: string) { messages.push({ role, text }); } }),
    createListeningSession(options: any) { listeningOptions = options; return listener; },
    companionView() { return {}; }, renderCompanion() {}, opponentDetails() { return ''; }, newSettlement() { return null; },
    setTimeout(fn: () => void) { const id = ++timerId; timers.set(id, fn); return id; }, clearTimeout(id: number) { timers.delete(id); },
  }));
  return { nodes, messages, utterances, calls, listener, cloudItems,
    async ready() { await flush(); stream.onopen(); },
    input(text: string) { listeningOptions.onFinal(text); },
    partial(text: string) { listeningOptions.onText(text, false); },
    stop() { node('mic').events.click(); },
    hide() { document.hidden = true; docEvents.visibilitychange!(); },
    state(battle: any, revision: number) { stream.onstate({ data: JSON.stringify({ battle, revision }) }); },
    fireTimers() { const list = [...timers.values()]; timers.clear(); list.forEach(fn => fn()); },
  };
}

it('播完即时话术后只等待一次；等待期间恢复持续聆听，等待结果不递归', async () => {
  const h = harness(); await h.ready(); h.input(' 开房间 ');
  assert.equal(JSON.parse(h.calls[0].init.body).text, ' 开房间 ');
  h.calls[0].respond(outcome('房间4821，我准备好了！', 'wait_guest')); await flush();
  assert.equal(h.calls.length, 1); assert.equal(h.utterances.length, 1);
  h.utterances[0].onend(); await flush();
  assert.equal(h.calls[1].url, '/api/wait'); assert.equal(h.listener.paused, false);
  h.calls[1].respond(outcome('还在等对手。', 'wait_guest')); await flush();
  h.utterances[1].onend(); await flush(); assert.equal(h.calls.length, 2);
});
it('静默不显示伙伴气泡、不合成、不挂起；SSE仅更新视觉', async () => {
  const h = harness(); await h.ready(); h.input('原话');
  h.calls[0].respond({ ...outcome('', 'wait_foe'), silent: true }); await flush();
  h.state(null, 1); await flush();
  assert.deepEqual(h.messages, [{ role: 'player', text: '原话' }]);
  assert.equal(h.utterances.length, 0); assert.equal(h.calls.length, 1);
});
it('新输入取消等待，忽略晚到的旧局回复，游戏行动不重试', async () => {
  const h = harness(); await h.ready(); h.input('攻击'); h.calls[0].respond(outcome('我这一手压上去了。', 'wait_foe')); await flush();
  h.utterances[0].onend(); await flush(); const waiting = h.calls[1];
  h.input('战况'); assert.equal(waiting.init.signal.aborted, true);
  waiting.respond(outcome('旧局晚到的话术')); h.calls[2].respond(outcome('现在轮到我。')); await flush();
  assert.equal(h.messages.some(x => x.text === '旧局晚到的话术'), false);
  assert.deepEqual(h.calls.map(c => c.url), ['/api/say', '/api/wait', '/api/say']);
  assert.equal(h.utterances.at(-1).text, '现在轮到我。');
});
it('播放错误或超时不当作完成，不提前等对手；隐藏页面丢弃迟到结果', async () => {
  for (const end of ['error', 'timeout']) {
    const h = harness(); await h.ready(); h.input('开房'); h.calls[0].respond(outcome('房间4821', 'wait_guest')); await flush();
    if (end === 'error') h.utterances[0].onerror(); else h.fireTimers();
    await flush(); assert.equal(h.calls.length, 1);
  }
  const h = harness(); await h.ready(); h.input('开始'); h.hide(); h.calls[0].respond(outcome('不该播出的旧结果')); await flush();
  assert.equal(h.utterances.length, 0); assert.equal(h.messages.length, 1);
});
it('手动停止与新局快照取消等待；用户未停止时新局不关麦', async () => {
  for (const manual of [true, false]) {
    const h = harness(); await h.ready(); h.state({ battleId: 'old', round: 1 }, 1);
    h.input('攻击'); h.calls[0].respond(outcome('等他应对。', 'wait_foe')); await flush(); h.utterances[0].onend(); await flush();
    if (manual) h.stop(); else h.state({ battleId: 'new', round: 1 }, 2);
    assert.equal(h.calls[1].init.signal.aborted, true);
    h.calls[1].respond(outcome('旧回复')); await flush(); assert.equal(h.messages.some(x => x.text === '旧回复'), false);
    assert.equal(h.listener.enabled, !manual);
  }
});
it('没有浏览器音频能力时展示文字后才等待，非 final 识别不会执行行动', async () => {
  const h = harness(false); await h.ready(); h.partial('开'); assert.equal(h.calls.length, 0); h.input('开房');
  h.calls[0].respond(outcome('房间4821', 'wait_guest')); await flush();
  assert.equal(h.calls[1].url, '/api/wait'); assert.equal(h.utterances.length, 0);
});
it('SSE 换局后旧 say 回复不播不记；自身开新局仍能播；播报中换局立即取消', async () => {
  const h = harness(); await h.ready(); h.state({ battleId: 'old', round: 1 }, 1);
  h.input('战况'); h.state({ battleId: 'new', round: 1 }, 2);
  h.calls[0].respond({ ...outcome('旧局的延迟回复'), sourceBattleId: 'old' }); await flush();
  assert.equal(h.messages.some(x => x.text === '旧局的延迟回复'), false);
  assert.equal(h.utterances.length, 0);
  h.input('开始'); h.state({ battleId: 'mine', round: 1 }, 3);
  h.calls[1].respond({ ...outcome('我准备好啦！', 'wait_foe'), sourceBattleId: 'mine' }); await flush();
  assert.equal(h.utterances[0].text, '我准备好啦！');
  h.state({ battleId: 'another', round: 1 }, 4); h.utterances[0].onend(); await flush();
  assert.equal(h.calls.length, 2);
});

const segmented = (segments: Array<{ text: string; emotion: string }>, need = 'wait_foe') => ({
  ...outcome(segments.map(item => item.text).join(''), need),
  speech: { version: 1, source: 'model', segments },
});
it('情绪分段依次播放，日志只显示合并句；麦克风整队列暂停，最后结束才等待', async () => {
  const h = harness(); await h.ready(); h.input('强攻');
  const segments = [{ text: '嘿，打中了！', emotion: 'proud' }, { text: '我还能再来！🔥', emotion: 'determined' }];
  h.calls[0].respond(segmented(segments)); await flush();
  const resumes = h.listener.resumes;
  assert.equal(h.utterances.length, 1);
  assert.equal(h.utterances[0].text, segments[0]!.text);
  assert.equal(h.nodes.get('replies').dataset.emotionIntent, 'proud');
  assert.equal(h.nodes.get('replies').dataset.emotionApplied, 'false');
  assert.equal(h.utterances[0].pitch, undefined);
  assert.equal(h.listener.paused, true);
  h.utterances[0].onend(); await flush();
  assert.equal(h.utterances.length, 2);
  assert.equal(h.utterances[1].text, segments[1]!.text);
  assert.equal(h.nodes.get('replies').dataset.emotionIntent, 'determined');
  assert.equal(h.utterances[1].rate, h.utterances[0].rate);
  assert.equal(h.listener.resumes, resumes);
  assert.equal(h.listener.paused, true);
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.messages.filter(x => x.role === 'partner'), [{ role: 'partner', text: segments.map(s => s.text).join('') }]);
  h.utterances[1].onend(); await flush();
  assert.equal(h.calls[1].url, '/api/wait');
  assert.equal(h.listener.paused, false);
});
it('分段队列失败、超时、手动停止和新输入均丢弃剩余段，不挂起也不重做行动', async () => {
  for (const mode of ['error', 'timeout', 'stop', 'input']) {
    const h = harness(); await h.ready(); h.input('攻击');
    h.calls[0].respond(segmented([{ text: '第一段。', emotion: 'excited' }, { text: '第二段。', emotion: 'happy' }, { text: '第三段。', emotion: 'neutral' }]));
    await flush();
    const oldUtter = h.utterances[0];
    if (mode === 'error') oldUtter.onerror();
    else if (mode === 'timeout') h.fireTimers();
    else if (mode === 'stop') h.stop();
    else h.input('战况');
    await flush(); oldUtter.onend(); await flush();
    assert.equal(h.utterances.length, 1, mode);
    assert.equal(h.calls.filter(c => c.url === '/api/wait').length, 0, mode);
    assert.equal(h.calls.filter(c => c.url === '/api/say').length, mode === 'input' ? 2 : 1, mode);
    if (mode === 'stop') assert.equal(h.listener.enabled, false);
  }
});
it('分段静默跳过所有音频；旧 reply 仍以单段 neutral 播放', async () => {
  const h = harness(); await h.ready(); h.input('原话');
  h.calls[0].respond({ ...segmented([]), silent: true }); await flush();
  assert.equal(h.utterances.length, 0); assert.equal(h.messages.length, 1);
  h.input('战况'); h.calls[1].respond(outcome('我在这儿。')); await flush();
  assert.equal(h.utterances.length, 1);
  assert.equal(h.utterances[0].text, '我在这儿。');
  assert.equal(h.nodes.get('replies').dataset.emotionIntent, 'neutral');
});
it('播放到中间段后换局或隐藏页面取消余段，迟到 onend 不继续播也不等待', async () => {
  for (const mode of ['battle', 'hide']) {
    const h = harness(); await h.ready(); h.state({ battleId: 'old', round: 1 }, 1); h.input('攻击');
    h.calls[0].respond({ ...segmented([{ text: '一。', emotion: 'happy' }, { text: '二。', emotion: 'hurt' }, { text: '三。', emotion: 'determined' }]), sourceBattleId: 'old' });
    await flush(); h.utterances[0].onend(); await flush();
    assert.equal(h.utterances.length, 2);
    if (mode === 'battle') h.state({ battleId: 'new', round: 1 }, 2); else h.hide();
    h.utterances[1].onend(); await flush();
    assert.equal(h.utterances.length, 2, mode);
    assert.equal(h.calls.length, 1, mode);
  }
});

it('真实音频逐段传递情绪，全部播放完成前不等待且不播放拼接reply', async () => {
  const h=harness(true,true);await h.ready();h.input('防御');
  h.calls[0].respond({...outcome('挡住啦！轮到你指挥我了。','wait_foe'),speech:{version:1,source:'model',segments:[{text:'挡住啦！',emotion:'proud'},{text:'轮到你指挥我了。',emotion:'expectant'}]}});await flush();
  assert.equal(h.cloudItems.length,1);assert.equal(h.utterances.length,0);assert.equal(h.listener.paused,true);
  assert.equal(h.cloudItems[0].item.emotion,'proud');h.cloudItems[0].finish();await flush();
  assert.equal(h.cloudItems.length,2);assert.equal(h.calls.length,1);assert.equal(h.listener.paused,true);
  assert.equal(h.cloudItems[1].item.emotion,'expectant');h.cloudItems[1].finish();await flush();
  assert.equal(h.calls[1].url,'/api/wait');assert.equal(h.listener.paused,false);
  assert.equal(h.messages.filter(x=>x.role==='partner').length,1);
});
it('真实音频失败或取消清空剩余段，不等待、不重做MCP',async()=>{
  for(const cancel of [false,true]){
    const h=harness(true,true);await h.ready();h.input('攻击');
    h.calls[0].respond({...outcome('第一句第二句','wait_foe'),speech:{version:1,source:'model',segments:[{text:'第一句',emotion:'determined'},{text:'第二句',emotion:'excited'}]}});await flush();
    if(cancel)h.hide();else h.cloudItems[0].fail();await flush();
    assert.equal(h.cloudItems.length,1);assert.equal(h.calls.length,1);
    if(cancel)assert.equal(h.cloudItems[0].signal.aborted,true);
    else assert.equal(h.messages.at(-1).role,'system');
  }
});
