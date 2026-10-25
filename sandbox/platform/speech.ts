/** Provider-independent emotion contract, aligned with speech branch 2ee1acd.
 * This is intent; actual TTS support is reported separately by the adapter. */
export const EMOTIONS = [
  'neutral', 'happy', 'sad', 'angry', 'surprised', 'fear', 'excited', 'coldness', 'hate',
  'proud', 'relieved', 'playful', 'hurt', 'confused', 'expectant', 'strained',
  'determined', 'disappointed', 'pleading', 'urgent',
] as const;
export type Emotion = typeof EMOTIONS[number];
export interface SpeechSegment { text: string; emotion: Emotion }
export interface SpeechPlan {
  version: 1;
  source: 'model' | 'legacy' | 'fallback';
  segments: SpeechSegment[];
}

export type SpeechRejectionReason = 'speech_empty' | 'speech_json' | 'speech_schema' | 'speech_segments' | 'speech_text' | 'speech_emotion';
export type SpeechParseResult =
  | { ok: true; speech: SpeechPlan; text: string }
  | { ok: false; reason: SpeechRejectionReason };

/** Safe program/transport fallback. Neutral never claims model-chosen emotion. */
export function fallbackSpeech(text: string): SpeechPlan {
  return { version: 1, source: 'fallback', segments: text ? [{ text, emotion: 'neutral' }] : [] };
}

/** Parse the model's sole internal format. Ordinary legacy text is explicit,
 * never a fallback for malformed JSON, extra instructions or unknown emotion. */
export function parseSpeechOutput(raw: string): SpeechParseResult {
  const content = raw.trim();
  if (!content) return { ok: false, reason: 'speech_empty' };
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    // Mixed prose plus structured data is malformed model output, not legacy
    // speech. Do not allow an introduction to make JSON reach the narrator.
    const embeddedJson = /(?:\{|\[)\s*(?:"[^"]*"\s*:|\{|\[|")/.test(content);
    if (/^[{["`]/.test(content) || content.includes('```') || embeddedJson || /"segments"\s*:/.test(content)) {
      return { ok: false, reason: 'speech_json' };
    }
    return { ok: true, text: content, speech: { version: 1, source: 'legacy', segments: [{ text: content, emotion: 'neutral' }] } };
  }
  if (!record(value) || !exactKeys(value, ['segments'])) return { ok: false, reason: 'speech_schema' };
  const segments = value.segments;
  if (!Array.isArray(segments) || segments.length < 1 || segments.length > 4) return { ok: false, reason: 'speech_segments' };
  const parsed: SpeechSegment[] = [];
  for (const segment of segments) {
    if (!record(segment) || !exactKeys(segment, ['text','emotion'])) return { ok: false, reason: 'speech_schema' };
    if (typeof segment.text !== 'string' || !segment.text.trim()) return { ok: false, reason: 'speech_text' };
    if (typeof segment.emotion !== 'string' || !(EMOTIONS as readonly string[]).includes(segment.emotion)) return { ok: false, reason: 'speech_emotion' };
    parsed.push({ text: segment.text, emotion: segment.emotion as Emotion });
  }
  // No segmentation can bypass joined-text length or fact validation in Agent.
  return { ok: true, text: parsed.map(segment => segment.text).join(''), speech: { version: 1, source: 'model', segments: parsed } };
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function exactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every(key => Object.hasOwn(value, key));
}
