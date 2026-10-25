import { diagnostic } from './speech/diagnostics.js';
import type { Logger } from '../src/log.js';
import { TTS_RESOURCE, validateVoice, requestedEmotion, voiceEmotion } from './speech/voices.js';
import { speechProfile } from './speech/profiles.js';
import express from 'express';
import { randomUUID } from 'node:crypto';
import { openAsr, synthesize, type ConnectSpeech, type DoubaoConfig } from './speech/doubao.js';
import type { Express } from 'express';

export interface SpeechConfig { asr: 'browser' | 'mock' | 'doubao'; tts: 'browser' | 'mock' | 'doubao'; doubao?: DoubaoConfig; simulation?: 'local-ws' }
/** No credentials, audio files or upstream calls in the local simulator. */
export function loadSpeechConfig(env: NodeJS.ProcessEnv = process.env): SpeechConfig {
  function mode(raw: string | undefined): SpeechConfig['asr'] {
    if (!raw || raw === 'browser') return 'browser';
    if (raw === 'mock' || raw === 'doubao') return raw;
    throw new Error('Speech mode must be browser, mock or doubao');
  }
  const asr = mode(env.SANDBOX_ASR_MODE), tts = mode(env.SANDBOX_TTS_MODE);
  const doubao = asr === 'doubao' || tts === 'doubao' ? {
    apiKey: env.SANDBOX_SPEECH_API_KEY?.trim() || '',
    asrResource: 'volc.seedasr.sauc.duration',
    ttsResource: env.SANDBOX_TTS_RESOURCE?.trim() || TTS_RESOURCE,
    speaker: env.SANDBOX_TTS_SPEAKER?.trim() || ''
  } : undefined;
  if (doubao && !doubao.apiKey) throw Error('Missing SANDBOX_SPEECH_API_KEY');
  if (tts === 'doubao' && (!doubao?.speaker || doubao.speaker.startsWith('S_'))) throw Error('A system TTS speaker is required; voice cloning is not supported');
  if (tts === 'doubao' && doubao) validateVoice(doubao.speaker, doubao.ttsResource);
  return { asr, tts, doubao };
}
function silence(): Buffer {
  const samples = 8000, buffer = Buffer.alloc(44 + samples * 2);
  buffer.write('RIFF'); buffer.writeUInt32LE(buffer.length - 8, 4); buffer.write('WAVEfmt ', 8);
  buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(16000, 24); buffer.writeUInt32LE(32000, 28);
  buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36); buffer.writeUInt32LE(samples * 2, 40);
  return buffer;
}
export function installSpeechRoutes(app: Express, config: SpeechConfig, connect?: ConnectSpeech, logger?: Logger, routes: { tts?: boolean } = {}): void {
  if (routes.tts !== false) app.post('/api/speech/tts', async (req, res) => {
    const requested = requestedEmotion(req.body?.emotion);
    const profile = speechProfile(req.body?.profileId);
    if (req.body?.profileId !== undefined && !profile) { res.status(400).json({ error: 'invalid_speech_profile' }); return; }
    if (config.tts === 'doubao') {
      if (!connect || !config.doubao) { res.status(503).json({ error: 'speech_transport_unavailable' }); return; }
      // Capture the chosen pair for this request; never mutate process defaults or another turn.
      const doubao = profile ? { ...config.doubao, speaker: profile.speaker, ttsResource: profile.resource } : config.doubao;
      const text = req.body?.text;
      if (typeof text !== 'string' || !text.trim() || text.length > 2000) { res.sendStatus(400); return; }
      const controller = new AbortController(), requestId = randomUUID(), started = Date.now();
      const trace = (stage: string) => logger?.debug('沙箱语音链路', { requestId, source: 'partner', stage, elapsedMs: Date.now() - started });
      trace('tts_started');
      res.on('close', () => { if (!res.writableEnded) { controller.abort(); trace('tts_cancelled'); } });
      try {
        const emotion = voiceEmotion(doubao.speaker, doubao.ttsResource, requested);
        const wav = await synthesize(connect, doubao, text, emotion.applied, controller.signal);
        trace('tts_synthesized');
        if (!controller.signal.aborted) res.set({ 'Cache-Control': 'no-store', 'X-Speech-Emotion': emotion.applied,
          'X-Speech-Emotion-Requested': emotion.requested, 'X-Speech-Emotion-Applied': emotion.applied,
          'X-Speech-Speaker': doubao.speaker, ...(profile ? { 'X-Speech-Profile': profile.profileId } : {}),
          'X-Speech-Control': doubao.ttsResource === 'seed-tts-2.0' ? 'instruction' : 'emotion' }).type('audio/wav').send(wav);
      } catch (error) { if (!controller.signal.aborted) {
        const detail = diagnostic(error, requestId, started);
        logger?.warn('沙箱语音失败', { source: 'partner', ...detail });
        res.status(502).json({ error: 'speech_synthesis_failed', diagnostic: detail });
      } }
      return;
    }
    if (config.tts !== 'mock') { res.sendStatus(404); return; }
    if (typeof req.body?.text !== 'string' || !req.body.text.trim() || req.body.text.length > 2000) {
      res.status(400).json({ error: 'invalid_text' }); return;
    }
    // Mock is deliberately silent; it cannot claim emotional or vendor voice fidelity.
    res.set({ 'Cache-Control': 'no-store', 'X-Speech-Emotion': 'neutral', 'X-Speech-Voice': 'mock-silence',
      'X-Speech-Emotion-Requested': requested, 'X-Speech-Emotion-Applied': 'neutral', 'X-Speech-Control': 'neutral' });
    res.type('audio/wav').send(silence());
  });
  const sessions = new Map<string, { asr: Awaited<ReturnType<typeof openAsr>>; controller: AbortController;
    write?: (data: object) => void; pending: object[]; end: () => void }>();
  app.post('/api/speech/asr/start', async (_req, res) => {
    if (config.asr !== 'doubao' || !connect || !config.doubao) { res.sendStatus(503); return; }
    if (sessions.size >= 20) { res.sendStatus(429); return; }
    const id = randomUUID(), controller = new AbortController(), pending: object[] = [], started = Date.now();
    const trace = (stage: string) => logger?.debug('沙箱语音链路', { requestId: id, source: 'player', stage, elapsedMs: Date.now() - started });
    trace('asr_started');
    let timer: ReturnType<typeof setTimeout>;
    const end = () => { if (!controller.signal.aborted) trace('asr_closed'); clearTimeout(timer); controller.abort(); sessions.delete(id); };
    res.on('close', () => { if (!res.writableEnded) end(); });
    try {
      const asr = await openAsr(connect, config.doubao, controller.signal, data => {
        const session = sessions.get(id);
        if (session?.write) session.write(data); else pending.push(data);
      }, () => { trace('asr_failed'); sessions.get(id)?.write?.({ error: 'asr_failed' }); end(); },
      () => { sessions.get(id)?.write?.({ end: true }); end(); });
      if (controller.signal.aborted) { asr.close(); return; }
      trace('asr_connected');
      sessions.set(id, { asr, controller, pending, end });
      timer = setTimeout(() => { sessions.get(id)?.write?.({ end: true }); end(); }, 60000);
      res.json({ id });
    } catch { trace('asr_failed'); end(); if (!res.destroyed) res.status(502).json({ error: 'asr_connection_failed' }); }
  });
  app.get('/api/speech/asr/:id', (req, res) => {
    const session = sessions.get(req.params.id);
    if (!session) { res.sendStatus(404); return; }
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' }); res.flushHeaders();
    session.write = data => res.write(`data: ${JSON.stringify(data)}\n\n`);
    session.pending.forEach(session.write); session.pending.length = 0;
    res.on('close', session.end);
    session.controller.signal.addEventListener('abort', () => res.end(), { once: true });
  });
  app.post('/api/speech/asr/:id/audio', express.raw({ type: 'application/octet-stream', limit: '16kb' }), (req, res) => {
    const session = sessions.get(req.params.id);
    if (!session) { res.sendStatus(404); return; }
    if (!Buffer.isBuffer(req.body) || req.body.length % 2) { res.sendStatus(400); return; }
    try { session.asr.audio(req.body, req.query.last === '1'); res.sendStatus(204); }
    catch { session.end(); res.sendStatus(502); }
  });
  app.delete('/api/speech/asr/:id', (req, res) => { sessions.get(req.params.id)?.end(); res.sendStatus(204); });
  app.get('/api/speech/asr', (req, res) => {
    if (config.asr !== 'mock') { res.sendStatus(404); return; }
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
    res.flushHeaders();
    const emit = (value: object) => res.write(`data: ${JSON.stringify(value)}\n\n`);
    const partial = setTimeout(() => emit({ id: 'mock-1', text: '战', final: false }), 100);
    const final = setTimeout(() => {
      const result = { id: 'mock-1', text: '战况', final: true };
      emit(result); emit(result); res.end();
    }, 400);
    req.on('close', () => { clearTimeout(partial); clearTimeout(final); });
  });
}
