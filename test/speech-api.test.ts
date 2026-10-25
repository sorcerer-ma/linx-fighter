import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { installSpeechRoutes, loadSpeechConfig } from '../sandbox/speech.js';
test('speech config is independent and rejects unsupported cloud modes', () => {
  assert.deepEqual(loadSpeechConfig({ SANDBOX_AGENT_API_KEY: 'unrelated' }), { asr: 'browser', tts: 'browser', doubao: undefined });
  assert.throws(() => loadSpeechConfig({ SANDBOX_ASR_MODE: 'doubao' }));
});
test('mock transport streams partial and duplicate final; TTS returns neutral WAV', async () => {
  const app = express(); app.use(express.json());
  installSpeechRoutes(app, { asr: 'mock', tts: 'mock' });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  try {
    const address = server.address() as { port: number };
    const url = `http://127.0.0.1:${address.port}`;
    const events = await (await fetch(`${url}/api/speech/asr`)).text();
    assert.match(events, /"final":false/);
    assert.equal(events.match(/"final":true/g)?.length, 2);
    const response = await fetch(`${url}/api/speech/tts`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: '测试', emotion: 'happy' }) });
    assert.equal(response.headers.get('x-speech-emotion'), 'neutral');
    assert.equal(response.headers.get('x-speech-emotion-requested'), 'happy');
    assert.equal(response.headers.get('x-speech-emotion-applied'), 'neutral');
    const audio = Buffer.from(await response.arrayBuffer());
    assert.equal(audio.toString('ascii', 0, 4), 'RIFF');
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('public config never exposes speech credentials or vendor configuration', async () => {
  const { createSandboxServer } = await import('../sandbox/server.js');
  const { loadSandboxConfig } = await import('../sandbox/config.js');
  const { SandboxClient } = await import('../sandbox/platform/client.js');
  const { createLogger } = await import('../src/log.js');
  const config = loadSandboxConfig({});
  const speech = loadSpeechConfig({ SANDBOX_ASR_MODE: 'doubao', SANDBOX_SPEECH_API_KEY: 'must-not-leak' });
  const client = new SandboxClient({ upstream: config.upstream, agentId: config.agentId, timeoutMs: config.timeoutMs, logger: createLogger('error') });
  const server = createSandboxServer({ config, client, speech }).listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  try {
    const address = server.address() as { port: number };
    const response = await (await fetch(`http://127.0.0.1:${address.port}/api/config`)).text();
    assert.equal(response.includes('must-not-leak'), false);
    assert.equal(response.includes('doubao'), true);
    assert.equal(response.includes('apiKey'), false);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('offline injected TTS handshake reports requested/applied emotion without changing fixed speaker', async () => {
  const { EventEmitter } = await import('node:events');
  const { int32, sized } = await import('../sandbox/speech/binary.js');
  const { parseTts } = await import('../sandbox/speech/tts-protocol.js');
  const starts: any[] = [], texts: string[] = [];
  class FixtureSocket extends EventEmitter {
    session = '';
    frame(event: number, id: string, payload = Buffer.from('{}'), audio = false) {
      return Buffer.concat([Buffer.from([0x11, audio ? 0xb4 : 0x94, audio ? 0 : 0x10, 0]), int32(event), sized(Buffer.from(id)), sized(payload)]);
    }
    send(data: Buffer) {
      const event = data.readInt32BE(4);
      if (event === 1) queueMicrotask(() => this.emit('message', this.frame(50, 'fixture-connection')));
      if (event === 100 || event === 200) {
        const serverFrame = Buffer.from(data); serverFrame[1] = 0x94;
        const frame = parseTts(serverFrame), request = JSON.parse(frame.payload.toString());
        this.session = frame.id;
        if (event === 100) { starts.push(request.req_params); queueMicrotask(() => this.emit('message', this.frame(150, frame.id))); }
        else texts.push(request.req_params.text);
      }
      if (event === 102) queueMicrotask(() => {
        this.emit('message', this.frame(352, this.session, Buffer.alloc(100), true));
        this.emit('message', this.frame(152, this.session, Buffer.from('{"status_code":20000000}')));
      });
    }
    close() { this.emit('close'); }
  }
  const app = express(); app.use(express.json());
  const speaker = 'zh_female_shuangkuaisisi_emo_v2_mars_bigtts';
  const speech = loadSpeechConfig({ SANDBOX_TTS_MODE: 'doubao', SANDBOX_SPEECH_API_KEY: 'fixture-only', SANDBOX_TTS_SPEAKER: speaker });
  const traces: object[] = [];
  installSpeechRoutes(app, speech, async () => new FixtureSocket(), { debug(_message, fields) { traces.push(fields!); }, info() {}, warn() {}, error() {} });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  try {
    const address = server.address() as { port: number };
    for (const [requested, applied] of [['happy', 'happy'], ['fear', 'neutral'], ['hurt', 'neutral']]) {
      const response = await fetch(`http://127.0.0.1:${address.port}/api/speech/tts`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: '固定确认台词', emotion: requested }) });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('x-speech-emotion-requested'), requested);
      assert.equal(response.headers.get('x-speech-emotion-applied'), applied);
      assert.equal((await response.arrayBuffer()).byteLength, 144);
      assert.equal(starts.at(-1).speaker, speaker);
      assert.equal(starts.at(-1).audio_params.emotion, applied === 'neutral' ? undefined : applied);
    }
    const { SPEECH_PROFILES } = await import('../sandbox/speech/profiles.js');
    for (const [profileId, profile] of Object.entries(SPEECH_PROFILES)) {
      const response = await fetch(`http://127.0.0.1:${address.port}/api/speech/tts`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: '固定确认台词', emotion: 'proud', profileId }) });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('x-speech-profile'), profileId);
      assert.equal(response.headers.get('x-speech-speaker'), profile.speaker);
      assert.equal(response.headers.get('x-speech-emotion-applied'), 'proud');
      assert.equal((await response.arrayBuffer()).byteLength, 144);
      assert.equal(starts.at(-1).speaker, profile.speaker);
      assert.equal(starts.at(-1).audio_params.emotion, undefined);
      assert.equal(JSON.parse(starts.at(-1).additions).context_texts.length, 1);
    }
    const invalid = await fetch(`http://127.0.0.1:${address.port}/api/speech/tts`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: '固定确认台词', profileId: 'arbitrary' }) });
    assert.equal(invalid.status, 400);
    assert.equal(starts.length, 6); // Unknown profile never opens a supplier session.
    assert.equal(speech.doubao?.speaker, speaker); // Profile requests don't change defaults.
    assert.deepEqual(texts, Array(6).fill('固定确认台词'));
    assert.equal(traces.length, 12);
    assert.equal(JSON.stringify(traces).includes('fixture-only'), false);
    assert.equal(JSON.stringify(traces).includes('固定确认台词'), false);
    assert.ok(traces.every((trace: any) => trace.source === 'partner' && typeof trace.elapsedMs === 'number'));
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
