import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { gunzipSync, gzipSync } from 'node:zlib';
import { WebSocketServer } from 'ws';
import { connectSpeech } from '../sandbox/speech/transport.js';
import { openAsr, synthesize, type ConnectSpeech, type DoubaoConfig } from '../sandbox/speech/doubao.js';
import { int32, sized } from '../sandbox/speech/binary.js';
import { parseTts } from '../sandbox/speech/tts-protocol.js';
const config: DoubaoConfig = { apiKey: 'non-secret-fixture', asrResource: 'volc.seedasr.sauc.duration', ttsResource: 'seed-tts-1.0', speaker: 'zh_female_shuangkuaisisi_emo_v2_mars_bigtts' };
function frame(event: number, id: string, payload = Buffer.from('{}'), audio = false) {
  return Buffer.concat([Buffer.from([0x11, audio ? 0xb4 : 0x94, audio ? 0 : 0x10, 0]), int32(event), sized(Buffer.from(id)), sized(payload)]);
}
function asrFrame(payload: object, flags = 0) {
  return Buffer.concat([Buffer.from([0x11, 0x90 | flags, 0x11, 0]), sized(gzipSync(JSON.stringify(payload)))]);
}
async function fixture() {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const address = server.address() as { port: number };
  const url = `ws://127.0.0.1:${address.port}`;
  const connect: ConnectSpeech = (vendorUrl, headers, signal) => connectSpeech(url + new URL(vendorUrl).pathname, headers, signal);
  return { server, url, connect, async close() { for (const socket of server.clients) socket.terminate(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}
test('real WS factory sends headers and binary ASR audio to loopback, deduplicates final and drops late results', async () => {
  const local = await fixture();
  const results: any[] = [], controller = new AbortController();
  const closed = new Promise<void>(resolve => local.server.once('connection', (socket, request) => {
    assert.equal(request.headers['x-api-key'], config.apiKey);
    assert.equal(request.headers['x-api-resource-id'], config.asrResource);
    assert.equal(request.headers['x-control-require-usage-tokens-return'], undefined);
    assert.match(String(request.headers['x-api-connect-id']), /^[a-f\d-]{36}$/);
    let initialized = false;
    socket.on('close', resolve);
    socket.on('message', (bytes, binary) => {
      assert.equal(binary, true); const data = Buffer.from(bytes as Buffer);
      if (!initialized) {
        initialized = true; assert.equal(data[1], 0x10);
        const init = JSON.parse(gunzipSync(data.subarray(8)).toString());
        assert.equal(init.audio.rate, 16000); assert.equal(init.request.show_utterances, true); return;
      }
      assert.equal(data[1], 0x20); assert.equal(gunzipSync(data.subarray(8)).length, 3200);
      socket.send(asrFrame({ result: { text: '战', utterances: [] } }));
      const final = asrFrame({ result: { utterances: [{ text: '战况', start_time: 10, definite: true }] } });
      socket.send(final); socket.send(final);
    });
  }));
  try {
    const ready = new Promise<void>(resolve => {
      openAsr(local.connect, config, controller.signal, result => { results.push(result); if (result.final) setImmediate(resolve); }, () => assert.fail('unexpected ASR failure'))
        .then(asr => asr.audio(Buffer.alloc(3200)));
    });
    await ready; controller.abort(); await closed;
    assert.deepEqual(results.map(result => result.final), [false, true]);
  } finally { controller.abort(); await local.close(); }
});
test('real WS TTS handshake sends one text, returns WAV and reports session errors without vendor detail', async () => {
  for (const success of [true, false]) {
    const local = await fixture(); const texts: string[] = [];
    local.server.on('connection', (socket, request) => {
      assert.equal(request.headers['x-api-key'], config.apiKey);
      assert.equal(request.headers['x-api-resource-id'], 'seed-tts-1.0');
      assert.equal(request.headers['x-control-require-usage-tokens-return'], '*');
      let session = '', startParameters: Record<string, unknown>;
      socket.on('message', bytes => {
        const data = Buffer.from(bytes as Buffer), event = data.readInt32BE(4);
        if (event === 1) socket.send(frame(50, 'fixture-connect'));
        else if (event === 100 || event === 200) {
          const converted = Buffer.from(data); converted[1] = 0x94;
          const parsed = parseTts(converted), body = JSON.parse(parsed.payload.toString()); session = parsed.id;
          if (event === 100) {
            startParameters = body.req_params;
            assert.equal(body.req_params.audio_params.emotion, 'happy');
            assert.equal(body.req_params.audio_params.emotion_scale, 4);
            assert.equal(body.req_params.speaker, config.speaker);
            assert.equal(body.req_params.text, undefined);
            socket.send(frame(150, session)); socket.send(frame(150, session));
          } else { assert.deepEqual(body.req_params, { ...startParameters, text: '最终确认台词' }); texts.push(body.req_params.text); }
        } else if (event === 102) {
          socket.send(frame(352, session, Buffer.alloc(320), true));
          socket.send(frame(152, session, Buffer.from(JSON.stringify({ status_code: success ? 20000000 : 55000000, message: 'private-vendor-detail' }))));
        } else if (event === 2) socket.send(frame(52, 'fixture-connect'));
      });
    });
    try {
      const result = synthesize(local.connect, config, '最终确认台词', 'happy', new AbortController().signal);
      if (success) assert.equal((await result).length, 364);
      else await assert.rejects(result, error => error instanceof Error && error.message === 'speech_tts_finish_vendor');
      assert.deepEqual(texts, ['最终确认台词']);
    } finally { await local.close(); }
  }
});
test('WS factory cancellation closes the real local connection; rejected upgrades never leak detail or follow redirects', async () => {
  const local = await fixture(), controller = new AbortController();
  const connected = once(local.server, 'connection');
  try {
    const socket = await connectSpeech(local.url, { 'X-Api-Key': 'fixture' }, controller.signal);
    const [peer] = await connected;
    const closed = once(peer, 'close'); controller.abort(); await closed;
    assert.ok(socket);
    await assert.rejects(connectSpeech(local.url, {}, controller.signal), /cancelled/);
  } finally { await local.close(); }
  let requests = 0;
  const http = createServer((_req, res) => { requests++; res.writeHead(302, { Location: 'http://127.0.0.1:1/private-vendor-detail' }); res.end('private-vendor-detail'); });
  http.listen(0, '127.0.0.1'); await once(http, 'listening');
  try {
    const address = http.address() as { port: number };
    await assert.rejects(connectSpeech(`ws://127.0.0.1:${address.port}`, {}, new AbortController().signal), /speech_ws_handshake_http/);
    assert.equal(requests, 1);
  } finally { await new Promise<void>(resolve => http.close(() => resolve())); }
});
test('aborting ASR HTTP start cancels a real WS upgrade before it can leave an orphan session', { timeout: 3000 }, async () => {
  const express = (await import('express')).default;
  const { installSpeechRoutes } = await import('../sandbox/speech.js');
  const upgrade = createServer();
  let observed: () => void = () => {}, disconnected: () => void = () => {};
  const attempted = new Promise<void>(resolve => { observed = resolve; });
  const closed = new Promise<void>(resolve => { disconnected = resolve; });
  upgrade.on('upgrade', (_req, socket) => { socket.on('close', disconnected); socket.on('end', () => socket.destroy()); socket.on('error', () => {}); socket.resume(); observed(); });
  upgrade.listen(0, '127.0.0.1'); await once(upgrade, 'listening');
  const address = upgrade.address() as { port: number };
  const app = express(); app.use(express.json());
  installSpeechRoutes(app, { asr: 'doubao', tts: 'browser', doubao: config },
    (_url, headers, signal) => connectSpeech(`ws://127.0.0.1:${address.port}`, headers, signal));
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const httpAddress = server.address() as { port: number }, controller = new AbortController();
  try {
    const request = fetch(`http://127.0.0.1:${httpAddress.port}/api/speech/asr/start`, { method: 'POST', signal: controller.signal });
    await attempted; controller.abort(); await assert.rejects(request); await closed;
  } finally {
    controller.abort();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await new Promise<void>(resolve => upgrade.close(() => resolve()));
  }
});

test('2.0 real local WS uses instruction-only StartSession and sends final text once in TaskRequest', async () => {
  for (const emotion of ['happy', 'neutral', 'hurt', 'confused', 'strained', 'unknown_feeling']) {
    const local = await fixture(), texts: string[] = [];
    const voice2 = { ...config, ttsResource: 'seed-tts-2.0', speaker: 'zh_male_yangguangqingnian_uranus_bigtts' };
    local.server.on('connection', (socket, request) => {
      assert.equal(request.headers['x-api-resource-id'], 'seed-tts-2.0');
      assert.equal(request.headers['x-control-require-usage-tokens-return'], '*');
      let session = '', startParameters: Record<string, unknown>;
      socket.on('message', bytes => {
        const data = Buffer.from(bytes as Buffer), event = data.readInt32BE(4);
        if (event === 1) socket.send(frame(50, 'fixture-connect'));
        else if (event === 100 || event === 200) {
          const copy = Buffer.from(data); copy[1] = 0x94;
          const parsed = parseTts(copy), body = JSON.parse(parsed.payload.toString()); session = parsed.id;
          if (event === 100) {
            assert.equal(body.req_params.speaker, voice2.speaker);
            startParameters = body.req_params;
            assert.equal(body.req_params.model, undefined); assert.equal(body.req_params.text, undefined);
            assert.equal(body.req_params.audio_params.emotion, undefined);
            assert.equal(body.req_params.audio_params.emotion_scale, undefined);
            const instructions: Record<string, string> = { happy: '请用开心的语气说这句话。',
              hurt: '请明显表现短促吃痛，声音稍紧、短暂停顿后克制地说完；只朗读原文，不添加喊声或其他字词。', confused: '请用困惑的语气说这句话。', strained: '请明显表现疲惫吃力，轻微气息感、语速放慢，但吐字清楚、结尾仍坚持；只朗读原文，不添加呻吟。' };
            if (instructions[emotion]) assert.deepEqual(JSON.parse(body.req_params.additions), { context_texts: [instructions[emotion]] });
            else assert.equal(body.req_params.additions, undefined);
            socket.send(frame(150, session));
          } else { assert.deepEqual(body.req_params, { ...startParameters, text: '最终台词' }); texts.push(body.req_params.text); }
        } else if (event === 102) {
          socket.send(frame(352, session, Buffer.alloc(320), true));
          socket.send(frame(152, session, Buffer.from('{"status_code":20000000}')));
        }
      });
    });
    try {
      const result = await synthesize(local.connect, voice2, '最终台词', emotion, new AbortController().signal);
      assert.equal(result.length, 364); assert.deepEqual(texts, ['最终台词']);
    } finally { await local.close(); }
  }
});

test('default WS factory accepts only the documented 2.0 usage-only finish, with failure precedence and 1.0 compatibility', async () => {
  for (const scenario of [
    { version2: true, payload: { usage: { text_words: 4 } }, audio: true, success: true },
    { version2: true, payload: { usage: { text_words: 4 }, status_code: 55000000 }, audio: true, success: false },
    { version2: true, payload: { usage: { text_words: 4 } }, audio: false, success: false },
    { version2: true, payload: {}, audio: true, success: false },
    { version2: false, payload: { usage: { text_words: 4 } }, audio: true, success: false },
    { version2: false, payload: { status_code: 20000000 }, audio: true, success: true },
  ]) {
    const local = await fixture(), textRequests: string[] = [];
    const selected = scenario.version2 ? { ...config, ttsResource: 'seed-tts-2.0', speaker: 'zh_male_yangguangqingnian_uranus_bigtts' } : config;
    local.server.on('connection', socket => {
      let session = '';
      socket.on('message', bytes => {
        const data = Buffer.from(bytes as Buffer), event = data.readInt32BE(4);
        if (event === 1) socket.send(frame(50, 'connection'));
        if (event === 100 || event === 200) {
          const copy = Buffer.from(data); copy[1] = 0x94;
          const parsed = parseTts(copy), body = JSON.parse(parsed.payload.toString()); session = parsed.id;
          if (event === 100) socket.send(frame(150, session));
          else textRequests.push(body.req_params.text);
        }
        if (event === 102) {
          if (scenario.audio) socket.send(frame(352, session, Buffer.alloc(100), true));
          socket.send(frame(152, session, Buffer.from(JSON.stringify(scenario.payload))));
        }
      });
    });
    try {
      const result = synthesize(local.connect, selected, '只说一次', 'neutral', new AbortController().signal);
      if (scenario.success) assert.equal((await result).length, 144);
      else await assert.rejects(result);
      assert.deepEqual(textRequests, ['只说一次']);
    } finally { await local.close(); }
  }
});
