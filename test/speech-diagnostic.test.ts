import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { gzipSync } from 'node:zlib';
import express from 'express';
import { WebSocketServer } from 'ws';
import { connectSpeech } from '../sandbox/speech/transport.js';
import { installSpeechRoutes } from '../sandbox/speech.js';
import { int32, sized } from '../sandbox/speech/binary.js';
import { parseTts } from '../sandbox/speech/tts-protocol.js';
// @ts-expect-error Browser module is plain JS.
import { backendPlayback } from '../sandbox/public/playback.js';
// @ts-expect-error Browser module is plain JS.
import { diagnosticText } from '../sandbox/public/speech-diagnostic.js';
const secret = 'fixture-secret-do-not-display';
const config = { apiKey: secret, asrResource: 'volc.seedasr.sauc.duration', ttsResource: 'seed-tts-1.0', speaker: 'zh_female_shuangkuaisisi_emo_v2_mars_bigtts' };
function frame(event: number, id: string, payload = Buffer.from('{}')) {
  return Buffer.concat([Buffer.from([0x11, 0x94, 0x10, 0]), int32(event), sized(Buffer.from(id)), sized(payload)]);
}
async function api(vendorUrl: string) {
  const logs: object[] = [], app = express(); app.use(express.json());
  installSpeechRoutes(app, { asr: 'browser', tts: 'doubao', doubao: config },
    (_url, headers, signal) => connectSpeech(vendorUrl, headers, signal), {
      debug(_message, fields) { logs.push(fields!); }, warn(_message, fields) { logs.push(fields!); }, info() {}, error() {},
    });
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address() as { port: number };
  return { logs, url: `http://127.0.0.1:${address.port}/api/speech/tts`, async close() { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}
function privateDataAbsent(value: unknown) {
  const text = JSON.stringify(value);
  for (const forbidden of [secret, 'private-vendor-body', 'private-text', 'x-private-header', 'X-Api-Key']) assert.equal(text.includes(forbidden), false);
}
test('real 401/403 upgrade failures reach HTTP response, safe logs and browser formatter without bodies or credentials', async () => {
  for (const [status, echoSecret] of [[401, false], [403, false], [403, true]] as const) {
    const vendor = createServer((_req, res) => {
      res.writeHead(status, { 'X-Tt-Logid': echoSecret ? secret : '20261025_MOCK_LOG_ID', 'x-private-header': secret });
      res.end(`private-vendor-body ${secret}`);
    });
    vendor.listen(0, '127.0.0.1'); await once(vendor, 'listening');
    const address = vendor.address() as { port: number }, local = await api(`ws://127.0.0.1:${address.port}`);
    try {
      const response = await fetch(local.url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'private-text' }) });
      assert.equal(response.status, 502);
      const result = await response.json() as any;
      assert.equal(result.diagnostic.stage, 'ws_handshake'); assert.equal(result.diagnostic.httpStatus, status);
      assert.match(result.diagnostic.requestId, /^[a-f\d-]{36}$/);
      assert.match(result.diagnostic.connectId, /^[a-f\d-]{36}$/);
      assert.equal(typeof result.diagnostic.elapsedMs, 'number');
      assert.equal(result.diagnostic.logId, echoSecret ? undefined : '20261025_MOCK_LOG_ID');
      privateDataAbsent(result); privateDataAbsent(local.logs);
      // Use the actual browser fetch adapter, then its formatter; no Audio object should be constructed on failure.
      const originalFetch = globalThis.fetch;
      globalThis.fetch = ((url: any, options: any) => originalFetch(url === '/api/speech/tts' ? local.url : url, options)) as typeof fetch;
      try {
        await assert.rejects(backendPlayback({ text: 'private-text' }, new AbortController().signal), (error: any) => {
          const visible = diagnosticText(error.diagnostic);
          assert.match(visible, new RegExp(`HTTP ${status}`)); assert.match(visible, /ws_handshake/);
          privateDataAbsent(visible); return true;
        });
      } finally { globalThis.fetch = originalFetch; }
    } finally { await local.close(); vendor.closeAllConnections(); await new Promise<void>(resolve => vendor.close(() => resolve())); }
  }
});
test('SessionFailed and protocol failures preserve safe stage/vendor metadata through actual local WS', async () => {
  for (const mode of ['session', 'text', 'malformed']) {
    const malformed = mode === 'malformed';
    const vendor = new WebSocketServer({ port: 0, host: '127.0.0.1' }); await once(vendor, 'listening');
    vendor.on('headers', headers => headers.push('X-Tt-Logid: 20261025_MOCK_WS_LOG'));
    vendor.on('connection', socket => socket.on('message', bytes => {
      const value = Buffer.from(bytes as Buffer), event = value.readInt32BE(4);
      if (event === 1) socket.send(frame(50, 'mock-connect'));
      if (event === 100) {
        const copy = Buffer.from(value); copy[1] = 0x94;
        const session = parseTts(copy).id;
        if (mode === 'text') { socket.send(JSON.stringify({ code: 55000001, message: secret })); return; }
        socket.send(malformed ? Buffer.from([0x11, 0x94, 0x10, 0, 0])
          : frame(153, session, Buffer.from(JSON.stringify({ status_code: 55000001, message: `private-vendor-body ${secret}` }))));
      }
    }));
    const address = vendor.address() as { port: number }, local = await api(`ws://127.0.0.1:${address.port}`);
    try {
      const response = await fetch(local.url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'private-text' }) });
      const result = await response.json() as any;
      assert.equal(response.status, 502); assert.equal(result.diagnostic.stage, 'tts_session');
      assert.equal(result.diagnostic.reason, malformed ? 'protocol' : 'vendor');
      assert.equal(result.diagnostic.vendorCode, malformed ? undefined : 55000001);
      assert.equal(result.diagnostic.logId, '20261025_MOCK_WS_LOG');
      assert.match(diagnosticText(result.diagnostic), malformed ? /protocol/ : /55000001/);
      privateDataAbsent(result); privateDataAbsent(local.logs);
    } finally { await local.close(); for (const socket of vendor.clients) socket.terminate(); await new Promise<void>(resolve => vendor.close(() => resolve())); }
  }
});
test('TTS accepts documented gzip response metadata and preserves numeric binary error codes', () => {
  const payload = gzipSync(Buffer.from('{"status_code":20000000}'));
  const compressed = Buffer.concat([Buffer.from([0x11, 0x94, 0x11, 0]), int32(152), sized(Buffer.from('session')), sized(payload)]);
  assert.equal(JSON.parse(parseTts(compressed).payload.toString()).status_code, 20000000);
  assert.throws(() => parseTts(Buffer.concat([Buffer.from([0x11, 0xf0, 0x10, 0]), int32(45000001), sized(Buffer.from(secret))])), (error: any) => error.fields.vendorCode === 45000001 && !error.message.includes(secret));
});
test('local connection refusal exposes only an allowlisted network code', async () => {
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address() as { port: number };
  await new Promise<void>(resolve => server.close(() => resolve()));
  await assert.rejects(connectSpeech(`ws://127.0.0.1:${address.port}`, { 'X-Api-Key': secret }, new AbortController().signal), (error: any) => {
    assert.equal(error.stage, 'ws_handshake'); assert.equal(error.fields.networkCode, 'ECONNREFUSED');
    privateDataAbsent({ message: error.message, fields: error.fields }); return true;
  });
});

test('bounded HTTP error classifier exposes only documented categories and numeric codes through the real WS factory', async () => {
  for (const scenario of [
    { message: 'requested resource not granted', expected: 'resource_not_granted' },
    { message: 'authenticate request: load grant: requested grant not found', expected: 'grant_not_found' },
    { message: 'quota exceeded for types: concurrency', expected: 'concurrency_quota' },
    { message: 'unknown private-vendor-body', expected: undefined },
    { message: 'requested resource not granted ' + 'x'.repeat(4096), expected: undefined },
  ]) {
    const vendor = createServer((_req, res) => {
      res.writeHead(403); res.end(JSON.stringify({ error: { code: 40301, message: `${scenario.message} ${secret}` } }));
    });
    vendor.listen(0, '127.0.0.1'); await once(vendor, 'listening');
    const address = vendor.address() as { port: number }, local = await api(`ws://127.0.0.1:${address.port}`);
    try {
      const response = await fetch(local.url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'private-text' }) });
      const result = await response.json() as any;
      assert.equal(result.diagnostic.httpStatus, 403);
      assert.equal(result.diagnostic.providerReason, scenario.expected);
      assert.equal(result.diagnostic.vendorCode, scenario.message.length > 4096 ? undefined : 40301);
      if (scenario.expected) assert.ok(diagnosticText(result.diagnostic).includes(scenario.expected));
      privateDataAbsent(result); privateDataAbsent(local.logs);
    } finally { await local.close(); vendor.closeAllConnections(); await new Promise<void>(resolve => vendor.close(() => resolve())); }
  }
});
