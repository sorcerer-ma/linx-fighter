import { speechDiagnostic } from './speech-diagnostic.js';

export async function backendPlayback(item, signal, onEmotion = () => {}) {
  const response = await fetch('/api/speech/tts', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(item), signal: AbortSignal.any([signal, AbortSignal.timeout(30000)])
  });
  if (!response.ok) {
    const value = await response.json().catch(() => null);
    const error = new Error('synthesis_failed');
    error.diagnostic = speechDiagnostic(value?.diagnostic);
    throw error;
  }
  if (signal.aborted) return;
  onEmotion({ requested: response.headers.get('X-Speech-Emotion-Requested') || item.emotion,
    applied: response.headers.get('X-Speech-Emotion-Applied') || 'neutral',
    profileId: response.headers.get('X-Speech-Profile'), speaker: response.headers.get('X-Speech-Speaker'),
    control: response.headers.get('X-Speech-Control') || 'neutral' });
  const url = URL.createObjectURL(await response.blob());
  try {
    await new Promise((resolve, reject) => {
      const audio = new Audio(url);
      let timer;
      const finish = error => {
        clearTimeout(timer); signal.removeEventListener('abort', cancel);
        audio.pause(); audio.removeAttribute('src');
        error ? reject(error) : resolve();
      };
      const cancel = () => finish(new Error('cancelled'));
      if (signal.aborted) { cancel(); return; }
      signal.addEventListener('abort', cancel, { once: true });
      audio.onended = () => finish();
      audio.onerror = () => finish(new Error('playback_failed'));
      timer = setTimeout(() => finish(new Error('playback_timeout')), 20000);
      audio.play().catch(() => finish(new Error('playback_blocked')));
    });
  } finally { URL.revokeObjectURL(url); }
}
