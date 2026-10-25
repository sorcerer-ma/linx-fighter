import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { gzipSync } from 'node:zlib';
import { asrAudio, asrInit, asrResults, parseAsr } from '../sandbox/speech/asr-protocol.js';
import { int32, sized } from '../sandbox/speech/binary.js';
import { parseTts, pcmWav } from '../sandbox/speech/tts-protocol.js';
import { synthesize, openAsr, type DoubaoConfig, type SpeechSocket } from '../sandbox/speech/doubao.js';
const config: DoubaoConfig = { apiKey: 'fixture', asrResource: 'fixture', ttsResource: 'seed-tts-1.0', speaker: 'zh_female_shuangkuaisisi_emo_v2_mars_bigtts' };
function asrFrame(payload: object, flags = 0) {
  return Buffer.concat([Buffer.from([0x11, 0x90 | flags, 0x11, 0]), ...(flags & 1 ? [int32(-1)] : []), sized(gzipSync(JSON.stringify(payload)))]);
}
function ttsFrame(event: number, id: string, payload: Buffer = Buffer.from('{}'), audio = false) {
  return Buffer.concat([Buffer.from([0x11, audio ? 0xb4 : 0x94, audio ? 0 : 0x10, 0]), int32(event), sized(Buffer.from(id)), sized(payload)]);
}
class Socket extends EventEmitter implements SpeechSocket {
  sent: Buffer[] = [];
  send(data: Buffer) { this.sent.push(data); }
  close() { this.emit('close'); }
}
const tick = () => new Promise(resolve => setImmediate(resolve));
test('ASR gzip envelopes and partial/final IDs preserve repeated same text at different times', () => {
  assert.equal(asrInit().subarray(0, 4).toString('hex'), '11101100');
  assert.equal(asrAudio(Buffer.alloc(3200), true).subarray(0, 4).toString('hex'), '11220100');
  assert.throws(() => asrAudio(Buffer.alloc(1)), /odd_pcm/);
  const payload = { result: { utterances: [{ text: '战况', start_time: 100, definite: true }] } };
  assert.deepEqual(parseAsr(asrFrame(payload, 3)), { payload, last: true });
  assert.throws(() => parseAsr(asrFrame(payload).subarray(0, 10)), /truncated/);
  const consume = asrResults();
  assert.equal(consume({ result: { text: '战' } })[0]?.final, false);
  assert.equal(consume(payload).length, 1); assert.equal(consume(payload).length, 0);
  assert.equal(consume({ result: { utterances: [{ text: '战况', start_time: 500, definite: true }] } }).length, 1);
});
test('TTS parses connect and session IDs independently, raw audio and rejects truncated/odd PCM', () => {
  assert.equal(parseTts(ttsFrame(50, 'connection')).id, 'connection');
  assert.equal(parseTts(ttsFrame(150, 'session')).id, 'session');
  const pcm = Buffer.from([1, 0, 2, 0]);
  const frame = parseTts(ttsFrame(352, 'session', pcm, true));
  assert.equal(frame.audio, true); assert.deepEqual(frame.payload, pcm);
  assert.throws(() => parseTts(ttsFrame(50, 'connection').subarray(0, 9)), /truncated/);
  assert.throws(() => pcmWav(Buffer.alloc(1)), /odd_pcm/);
  assert.equal(pcmWav(pcm).readUInt32LE(24), 24000);
});
test('TTS sends text once after session ready; late audio after cancellation is discarded', async () => {
  const socket = new Socket(), controller = new AbortController();
  const result = synthesize(async () => socket, config, '最终确认台词', 'fear', controller.signal);
  await tick();
  assert.equal(socket.sent[0]?.readInt32BE(4), 1);
  socket.emit('message', ttsFrame(50, 'connection'));
  const startBuffer = Buffer.from(socket.sent[1]!); startBuffer[1] = 0x94;
  const start = parseTts(startBuffer); // event+session layout is shared; server type differs
  const request = JSON.parse(start.payload.toString());
  assert.equal(request.req_params.speaker, config.speaker);
  assert.equal(request.req_params.audio_params.emotion, undefined);
  assert.equal(request.req_params.text, undefined);
  socket.emit('message', ttsFrame(150, start.id));
  assert.equal(socket.sent.filter(value => value.readInt32BE(4) === 200).length, 1);
  socket.emit('message', ttsFrame(352, start.id, Buffer.alloc(100), true));
  socket.emit('message', ttsFrame(152, start.id, Buffer.from('{"status_code":20000000}')));
  assert.equal((await result).length, 144);
  const lateSocket = new Socket(), cancel = new AbortController();
  const late = synthesize(async () => lateSocket, config, '旧台词', 'neutral', cancel.signal);
  await tick(); cancel.abort(); await assert.rejects(late, /cancelled/);
  const count = lateSocket.sent.length;
  lateSocket.emit('message', ttsFrame(50, 'late'));
  assert.equal(lateSocket.sent.length, count);
});
test('ASR ignores late final after cancel and never re-emits duplicate definite utterance', async () => {
  const socket = new Socket(), controller = new AbortController(), values: object[] = [];
  const asr = await openAsr(async () => socket, config, controller.signal, value => values.push(value), () => assert.fail());
  const frame = asrFrame({ result: { utterances: [{ text: '战况', start_time: 100, definite: true }] } });
  socket.emit('message', frame); socket.emit('message', frame); assert.equal(values.length, 1);
  asr.audio(Buffer.alloc(3200)); controller.abort();
  socket.emit('message', asrFrame({ result: { utterances: [{ text: '开始', start_time: 200, definite: true }] } }));
  assert.equal(values.length, 1);
});
test('supported emotions send scale 4; unsupported fear falls back without changing the voice', async () => {
  for (const [requested, applied] of [['happy', 'happy'], ['excited', 'excited'], ['fear', 'neutral'], ['hurt', 'neutral']]) {
    const socket = new Socket(), controller = new AbortController();
    const result = synthesize(async () => socket, config, '只发送一次的台词', requested!, controller.signal);
    await tick(); socket.emit('message', ttsFrame(50, 'connection'));
    const buffer = Buffer.from(socket.sent[1]!); buffer[1] = 0x94;
    const frame = parseTts(buffer), request = JSON.parse(frame.payload.toString());
    assert.equal(request.req_params.speaker, config.speaker);
    assert.equal(request.req_params.audio_params.emotion, applied === 'neutral' ? undefined : applied);
    assert.equal(request.req_params.audio_params.emotion_scale, applied === 'neutral' ? undefined : 4);
    controller.abort(); await assert.rejects(result, /cancelled/);
  }
  let connections = 0;
  await assert.rejects(synthesize(async () => { connections++; return new Socket(); }, { ...config, ttsResource: 'seed-tts-2.0' }, '台词', 'happy', new AbortController().signal), /conflict/);
  assert.equal(connections, 0);
});
test('empty ASR utterances preserves incremental root text strictly as partial, without consuming a final ID', () => {
  const consume = asrResults();
  assert.deepEqual(consume({ result: { text: '战', utterances: [] } }), [{ id: 'partial', text: '战', final: false }]);
  assert.deepEqual(consume({ result: { text: '战况', utterances: [] } }), [{ id: 'partial', text: '战况', final: false }]);
  assert.deepEqual(consume({ result: { text: '', utterances: [] } }), []);
  const final = { result: { text: '战况', utterances: [{ text: '战况', start_time: 0, definite: true }] } };
  assert.deepEqual(consume(final), [{ id: '0', text: '战况', final: true }]);
  assert.deepEqual(consume(final), []);
});

test('2.0 usage-only finish requires valid usage and actual audio, never overrides explicit failures', async () => {
  const voice2 = { ...config, ttsResource: 'seed-tts-2.0', speaker: 'zh_male_yangguangqingnian_uranus_bigtts' };
  const cases = [
    { payload: { usage: { text_words: 7 } }, audio: true, success: true },
    { payload: { usage: { text_words: 0 } }, audio: true, success: true },
    { payload: { usage: { text_words: 7 } }, audio: true, success: false, event: 153 },
    { payload: { status_code: 20000000 }, audio: true, success: true },
    { payload: {}, audio: true, success: false },
    { payload: { usage: {} }, audio: true, success: false },
    { payload: { usage: { text_words: '7' } }, audio: true, success: false },
    { payload: { usage: { text_words: -1 } }, audio: true, success: false },
    { payload: { usage: { text_words: 7 } }, audio: false, success: false },
    { payload: { usage: { text_words: 7 }, error: { message: 'private-body' } }, audio: true, success: false },
    { payload: { usage: { text_words: 7 }, status_code: 55000000 }, audio: true, success: false },
    { payload: { usage: { text_words: 7 }, code: 45000001 }, audio: true, success: false },
    { payload: { usage: { text_words: 7 }, status_code: 20000000, error_code: 55000000 }, audio: true, success: false },
  ];
  for (const scenario of cases) {
    const socket = new Socket();
    const result = synthesize(async () => socket, voice2, '确认台词', 'neutral', new AbortController().signal);
    await tick(); socket.emit('message', ttsFrame(50, 'connection'));
    const startBuffer = Buffer.from(socket.sent[1]!); startBuffer[1] = 0x94;
    const session = parseTts(startBuffer).id;
    socket.emit('message', ttsFrame(150, session));
    if (scenario.audio) socket.emit('message', ttsFrame(352, session, Buffer.alloc(100), true));
    socket.emit('message', ttsFrame(scenario.event ?? 152, session, Buffer.from(JSON.stringify(scenario.payload))));
    if (scenario.success) assert.equal((await result).length, 144);
    else await assert.rejects(result);
    assert.equal(socket.sent.filter(data => data.readInt32BE(4) === 200).length, 1);
  }
});
