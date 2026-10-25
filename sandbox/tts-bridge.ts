// @ts-expect-error Shared browser diagnostic module is plain JS.
import { speechDiagnostic } from './public/speech-diagnostic.js';
import type { Express } from 'express';
import { EMOTIONS } from './platform/speech.js';

/** Fixed loopback service; no caller URL, credential forwarding or redirects. */
export function installTtsBridge(app: Express, enabled: boolean, request: typeof fetch = fetch): void {
  app.post('/api/speech/tts', async (req, res) => {
    if (!enabled) { res.status(503).json({ error: 'speech_bridge_disabled' }); return; }
    const { text, emotion } = req.body ?? {};
    if (typeof text !== 'string' || !text.trim() || text.length > 2000 || !EMOTIONS.includes(emotion)) {
      res.status(400).json({ error: 'invalid_speech_segment' }); return;
    }
    const controller = new AbortController();
    res.on('close', () => { if (!res.writableEnded) controller.abort(); });
    try {
      const response = await request('http://127.0.0.1:18391/api/speech/tts', {
        method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, emotion }),
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30000)]),
      });
      if (!response.ok) {
        // Only the shared allowlisted diagnostic schema can leave the bridge.
        const body = await response.json().catch(() => null) as { diagnostic?: unknown } | null;
        res.status(502).json({ error: 'speech_synthesis_failed', diagnostic: speechDiagnostic(body?.diagnostic) }); return;
      }
      if (response.headers.get('content-type')?.split(';')[0] !== 'audio/wav') {
        res.status(502).json({ error: 'speech_audio_invalid' }); return;
      }
      const audio = Buffer.from(await response.arrayBuffer());
      if (controller.signal.aborted) return;
      for (const suffix of ['Requested', 'Applied']) {
        const value = response.headers.get('X-Speech-Emotion-' + suffix);
        if (value && (EMOTIONS as readonly string[]).includes(value)) res.set('X-Speech-Emotion-' + suffix, value);
      }
      const control = response.headers.get('X-Speech-Control');
      if (control && ['instruction', 'emotion', 'neutral'].includes(control)) res.set('X-Speech-Control', control);
      res.set('Cache-Control', 'no-store').type('audio/wav').send(audio);
    } catch {
      if (!controller.signal.aborted && !res.destroyed) res.status(502).json({ error: 'speech_bridge_unavailable' });
    }
  });
}
