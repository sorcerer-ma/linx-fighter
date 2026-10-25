import { SpeechFailure, getSpeechTrace, vendorCode, type SpeechStage } from './diagnostics.js';
import { voiceParameters } from './voices.js';
import { randomUUID } from 'node:crypto';
import { asrInit, asrAudio, parseAsr, asrResults } from './asr-protocol.js';
import { parseTts, pcmWav, ttsRequest } from './tts-protocol.js';
export interface SpeechSocket {
  send(data: Buffer): void;
  close(): void;
  on(event: 'message', callback: (data: Buffer, binary?: boolean) => void): unknown;
  on(event: 'error' | 'close', callback: () => void): unknown;
}
export type ConnectSpeech = (url: string, headers: Record<string, string>, signal: AbortSignal) => Promise<SpeechSocket>;
export interface DoubaoConfig {
  apiKey: string; asrResource: string; ttsResource: string; speaker: string;
}
function headers(config: DoubaoConfig, resource: string): Record<string, string> {
  return { 'X-Api-Key': config.apiKey, 'X-Api-Resource-Id': resource, 'X-Api-Connect-Id': randomUUID() };
}
export async function openAsr(connect: ConnectSpeech, config: DoubaoConfig, signal: AbortSignal,
  emit: (result: { id: string; text: string; final: boolean }) => void, fail: () => void, ended: () => void = () => {}) {
  const socket = await connect('wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async', headers(config, config.asrResource), signal);
  let active = !signal.aborted;
  const results = asrResults();
  const close = () => { active = false; socket.close(); signal.removeEventListener('abort', close); };
  if (!active) { close(); throw Error('asr_cancelled'); }
  signal.addEventListener('abort', close, { once: true });
  const failed = () => { if (active) { close(); fail(); } };
  socket.on('error', failed); socket.on('close', failed);
  socket.on('message', data => {
    if (!active) return;
    try {
      const frame = parseAsr(data);
      if (frame.payload.code !== undefined && frame.payload.code !== 0 && frame.payload.code !== 20000000) throw Error('asr_business_failed');
      for (const result of results(frame.payload)) emit(result);
      if (frame.last) { close(); ended(); }
    } catch { failed(); }
  });
  socket.send(asrInit());
  return {
    audio(pcm: Buffer, last = false) { if (active) socket.send(asrAudio(pcm, last)); },
    close
  };
}
/** One confirmed utterance per connection/session. Only resolves after SessionFinished. */
export async function synthesize(connect: ConnectSpeech, config: DoubaoConfig, text: string, emotion: string, signal: AbortSignal): Promise<Buffer> {
  const parameters = voiceParameters(config.speaker, config.ttsResource, emotion);
  // The documented 2.0 SessionFinished usage receipt is opt-in at the handshake.
  const socket = await connect('wss://openspeech.bytedance.com/api/v3/tts/bidirection', {
    ...headers(config, config.ttsResource), 'X-Control-Require-Usage-Tokens-Return': '*'
  }, signal);
  return new Promise((resolve, reject) => {
    const session = randomUUID(), chunks: Buffer[] = [];
    let phase: SpeechStage = 'tts_connection';
    const failure = (reason: ConstructorParameters<typeof SpeechFailure>[1], fields: ConstructorParameters<typeof SpeechFailure>[2] = {}) => new SpeechFailure(phase, reason, { ...getSpeechTrace(socket), ...fields });
    let active = true, connectionReady = false, started = false, finishing = false, size = 0;
    const finish = (error?: Error) => {
      if (!active) return;
      active = false; clearTimeout(timer); signal.removeEventListener('abort', cancel); socket.close();
      if (error) reject(error);
      else { try { resolve(pcmWav(Buffer.concat(chunks))); } catch { reject(failure('audio')); } }
    };
    const cancel = () => {
      if (active && started && !finishing) socket.send(ttsRequest(101, {}, session));
      finish(failure('cancelled'));
    };
    const timer = setTimeout(() => finish(failure('timeout')), 20000);
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) { cancel(); return; }
    socket.on('error', () => finish(failure('network')));
    socket.on('close', () => finish(failure('closed')));
    socket.on('message', (data, binary) => {
      if (!active) return;
      try {
        if (binary === false) {
          const code = vendorCode(JSON.parse(data.toString('utf8')));
          finish(failure('vendor', { vendorCode: code })); return;
        }
        const frame = parseTts(data);
        if (frame.event === 50 && !connectionReady) {
          connectionReady = true; phase = 'tts_session';
          socket.send(ttsRequest(100, { user: { uid: 'linx-sandbox' }, event: 100,
            namespace: 'BidirectionalTTS', req_params: parameters }, session));
        } else if (frame.event === 51 || (frame.event === 153 && frame.id === session)) {
          const code = vendorCode(JSON.parse(frame.payload.toString('utf8')));
          finish(failure('vendor', { vendorCode: code }));
        }
        else if (frame.id !== session) return;
        else if (frame.event === 150 && connectionReady && !started) {
          started = true; phase = 'tts_stream';
          socket.send(ttsRequest(200, { user: { uid: 'linx-sandbox' }, event: 200,
            // Official example copies the same base parameters into every TaskRequest.
            namespace: 'BidirectionalTTS', req_params: { ...parameters, text } }, session));
          finishing = true; phase = 'tts_finish'; socket.send(ttsRequest(102, {}, session));
        } else if (frame.audio) {
          size += frame.payload.length;
          if (size > 8 * 1024 * 1024) throw failure('audio');
          chunks.push(frame.payload);
        } else if (frame.event === 152) {
          const result = JSON.parse(frame.payload.toString('utf8'));
          const statusFields = ['status_code', 'code', 'error_code'].filter(key => Object.hasOwn(result, key));
          const rejectedStatus = statusFields.find(key => result[key] !== 20000000);
          if (rejectedStatus) throw failure('vendor', { vendorCode: vendorCode({ code: result[rejectedStatus] }) });
          // Current 2.0 example finishes with usage only; retain the explicit success-code form for 1.0.
          const usageOnly = config.ttsResource === 'seed-tts-2.0' && statusFields.length === 0
            && Number.isSafeInteger(result.usage?.text_words) && result.usage.text_words >= 0;
          if (result.error !== undefined || (!statusFields.length && !usageOnly)) throw failure('protocol');
          if (!size) throw failure('audio');
          socket.send(ttsRequest(2)); finish();
        }
      } catch (error) {
        finish(error instanceof SpeechFailure
          ? new SpeechFailure(phase, error.reason, { ...getSpeechTrace(socket), ...error.fields })
          : failure('protocol'));
      }
    });
    socket.send(ttsRequest(1));
  });
}
