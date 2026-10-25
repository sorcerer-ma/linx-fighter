import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import vm from 'node:vm';

const recognitionSource = readFileSync(new URL('../sandbox/public/backend-recognition.js', import.meta.url), 'utf8').replace('export class', 'class');
const listeningSource = readFileSync(new URL('../sandbox/public/listening.js', import.meta.url), 'utf8').replace('export function', 'function');
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise<void>(resolve => setImmediate(resolve)); };
function harness(deferredCapture = false, denied = false) {
  const requests: any[] = [], sources: any[] = [], states: any[] = [], texts: any[] = [], finals: string[] = [], errors: string[] = [];
  const timers = new Map<number, () => void>(); let timerId = 0, stopped = 0, closed = 0, disconnected = 0, captures = 0;
  const stream = { getTracks() { return [{ stop() { stopped++; } }]; } };
  let grant: () => void = () => {};
  const media = new Promise(resolve => { grant = () => resolve(stream); });
  class EventSource {
    onopen?: () => void; onmessage?: (event: any) => void; onerror?: () => void; closed = false;
    constructor(public url: string) { sources.push(this); }
    close() { this.closed = true; }
  }
  class AudioContext {
    audioWorklet = { addModule: async (url: string) => { assert.equal(url, '/pcm-worklet.js'); } };
    destination = {};
    constructor(options: any) { assert.equal(options.sampleRate, 16000); }
    createMediaStreamSource() { return { connect() {} }; }
    createGain() { return { gain: { value: 1 }, connect() {} }; }
    resume() { return Promise.resolve(); }
    close() { closed++; return Promise.resolve(); }
  }
  class AudioWorkletNode {
    port = { onmessage: null };
    constructor(_context: unknown, name: string) { assert.equal(name, 'pcm-capture'); }
    connect() {} disconnect() { disconnected++; }
  }
  const fetch = async (url: string, options: any) => {
    requests.push({ url, options });
    return { ok: true, json: async () => ({ id: 'capture-' + sources.length }) };
  };
  const context = vm.createContext({ navigator: { mediaDevices: { getUserMedia() {
    captures++;
    return denied ? Promise.reject(new Error('permission_denied')) : deferredCapture ? media : Promise.resolve(stream);
  } } }, AbortController, AudioContext, AudioWorkletNode, EventSource, fetch,
    setTimeout(fn: () => void) { const id = ++timerId; timers.set(id, fn); return id; }, clearTimeout(id: number) { timers.delete(id); },
    onState: (state: any) => states.push(state), onText: (text: string, final: boolean) => texts.push({ text, final }),
    onFinal: (text: string) => finals.push(text), onError: (error: string) => errors.push(error),
  });
  const session = vm.runInContext(recognitionSource + '\n' + listeningSource + '\ncreateListeningSession({Recognition: BackendRecognition,onState,onText,onFinal,onError})', context);
  return { session, sources, requests, states, texts, finals, errors, grant,
    get counts() { return { stopped, closed, disconnected, captures }; },
    result(text: string, final: boolean, index = sources.length - 1) { sources[index].onmessage({ data: JSON.stringify({ text, final }) }); },
    end() { sources.at(-1).onmessage({ data: JSON.stringify({ end: true }) }); },
    tick() { const active = [...timers.values()]; timers.clear(); active.forEach(fn => fn()); },
  };
}
it('后台识别接入实际持续聆听：partial不执行、final只交一次，暂停收音并清理采集资源', async () => {
  const h = harness(); h.session.start(); await flush();
  assert.equal(h.states.at(-1).active, false);
  h.sources[0].onopen(); assert.equal(h.states.at(-1).active, true);
  h.result('强化', false); assert.equal(h.finals.length, 0); assert.equal(h.texts.at(-1).text, '强化');
  h.result('强化攻击', true); h.result('强化攻击', true); await flush();
  assert.deepEqual(h.finals, ['强化攻击']);
  assert.equal(h.session.enabled, true); assert.equal(h.states.at(-1).active, false);
  assert.equal(h.sources[0].closed, true); assert.equal(h.counts.stopped, 1); assert.equal(h.counts.disconnected, 1);
  assert.equal(h.requests.filter(r => r.options.method === 'DELETE').length, 1);
  h.session.resume(); await flush(); h.sources[1].onopen();
  assert.equal(h.states.at(-1).active, true);
  h.session.stop(); assert.equal(h.session.enabled, false); assert.equal(h.sources[1].closed, true);
});
it('播报暂停保留开启意图，恢复重新采集；自然结束接续，手动停止后不被旧回调重启', async () => {
  const h = harness(); h.session.start(); await flush(); h.sources[0].onopen();
  h.session.pause(); assert.equal(h.session.enabled, true); assert.equal(h.states.at(-1).active, false);
  h.session.resume(); await flush(); h.sources[1].onopen(); h.end();
  h.tick(); await flush(); assert.equal(h.sources.length, 3);
  h.session.stop(); h.tick(); await flush();
  h.sources[1].onmessage({ data: JSON.stringify({ text: '旧final', final: true }) });
  assert.equal(h.finals.length, 0); assert.equal(h.session.enabled, false); assert.equal(h.sources.length, 3);
});
it('权限失败停止而不无限重试；等待麦克风期间取消后停止迟到的流', async () => {
  const denied = harness(false, true); denied.session.start(); await flush(); denied.tick(); await flush();
  assert.equal(denied.session.enabled, false); assert.deepEqual(denied.errors, ['backend-failed']); assert.equal(denied.counts.captures, 1);
  const pending = harness(true); pending.session.start(); pending.session.stop(); pending.grant(); await flush();
  assert.equal(pending.counts.stopped, 1); assert.equal(pending.sources.length, 0); assert.equal(pending.requests.length, 0);
});
it('PCM worklet按实际采样率降到16kHz，100ms一块，输出单声道小端16位', () => {
  const messages: ArrayBuffer[] = []; let Processor: any;
  const context = vm.createContext({ sampleRate: 48000, ArrayBuffer, DataView,
    AudioWorkletProcessor: class { port = { postMessage(buffer: ArrayBuffer) { messages.push(buffer); } }; },
    registerProcessor(name: string, ctor: any) { assert.equal(name, 'pcm-capture'); Processor = ctor; },
  });
  vm.runInContext(readFileSync(new URL('../sandbox/public/pcm-worklet.js', import.meta.url), 'utf8'), context);
  const processor = new Processor(); processor.process([[new Float32Array(4800).fill(0.5)]]);
  assert.equal(messages.length, 1); assert.equal(messages[0]!.byteLength, 3200);
  assert.equal(new DataView(messages[0]!).getInt16(0, true), 16384); assert.equal(processor.samples.length, 0);
});
