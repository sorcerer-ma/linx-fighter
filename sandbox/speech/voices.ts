/** Verified system voices, Doubao Tonelist-1 (2026-10-25). emo_v2 is part of the voice name, not the model version. */
export const TTS_RESOURCE = 'seed-tts-1.0';
export const VOICES = {
  zh_female_shuangkuaisisi_emo_v2_mars_bigtts: ['happy', 'sad', 'angry', 'surprised', 'excited', 'coldness', 'neutral'],
  zh_male_yangguangqingnian_emo_v2_mars_bigtts: ['happy', 'sad', 'angry', 'fear', 'excited', 'coldness', 'neutral'],
  zh_female_roumeinvyou_emo_v2_mars_bigtts: ['happy', 'sad', 'angry', 'surprised', 'fear', 'hate', 'excited', 'coldness', 'neutral'],
} as const;
export const VOICES_2 = [
  'zh_female_qingchezizi_uranus_bigtts',
  'zh_female_zhixingnv_uranus_bigtts',
  'zh_male_yangguangqingnian_uranus_bigtts',
  'zh_female_cancan_uranus_bigtts',
  'zh_male_qingcang_uranus_bigtts',
  'zh_male_tiancaitongsheng_uranus_bigtts',
] as const;
const INSTRUCTIONS: Record<string, string> = {
  happy: '请用开心的语气说这句话。', sad: '请用难过的语气说这句话。',
  angry: '请用生气的语气说这句话。', surprised: '请用惊讶的语气说这句话。',
  fear: '请用害怕的语气说这句话。', excited: '请用兴奋的语气说这句话。',
  coldness: '请用冷淡的语气说这句话。', hate: '请用厌恶的语气说这句话。',
  proud: '请明显表现自信和小得意，语调轻快上扬，收尾从容；友善、不嘲讽，只朗读原文。', relieved: '请用安心的语气说这句话。',
  playful: '请用轻快俏皮的语气说这句话。', hurt: '请明显表现短促吃痛，声音稍紧、短暂停顿后克制地说完；只朗读原文，不添加喊声或其他字词。',
  confused: '请用困惑的语气说这句话。', expectant: '请用期待的语气说这句话。',
  strained: '请明显表现疲惫吃力，轻微气息感、语速放慢，但吐字清楚、结尾仍坚持；只朗读原文，不添加呻吟。', determined: '请用明亮有力、坚定鼓励的语气，吐字清楚，重音鲜明，结尾振作上扬；不喊叫，只朗读原文。',
  disappointed: '请用失落但仍友善的语气说这句话。', pleading: '请用轻微委屈的语气说这句话。',
  urgent: '请明显表现着急和紧迫，语速稍快、节奏紧凑、重音清楚；不惊慌、不指责，只朗读原文。',
};
export type SystemVoice = keyof typeof VOICES | typeof VOICES_2[number];
export function validateVoice(speaker: string, resource: string): SystemVoice {
  const version2 = (VOICES_2 as readonly string[]).includes(speaker);
  if (!version2 && !Object.hasOwn(VOICES, speaker)) throw Error('Unsupported system TTS speaker; choose a documented voice');
  const expected = version2 ? 'seed-tts-2.0' : TTS_RESOURCE;
  if (resource !== expected) throw Error(`TTS speaker/resource conflict: selected voice requires ${expected}`);
  return speaker as SystemVoice;
}
/** Input remains an enum-like token; only a voice-supported value is sent to the supplier. */
export function requestedEmotion(value: unknown): string {
  return typeof value === 'string' && /^[a-z_]{1,32}$/.test(value) ? value : 'neutral';
}
export function voiceEmotion(speaker: string, resource: string, value: unknown) {
  const voice = validateVoice(speaker, resource), requested = requestedEmotion(value);
  const supported = resource === 'seed-tts-2.0'
    ? Object.hasOwn(INSTRUCTIONS, requested)
    : (VOICES[voice as keyof typeof VOICES] as readonly string[]).includes(requested);
  const applied = supported ? requested : 'neutral';
  return { requested, applied };
}

/** 1.0 uses voice emotion enums; 2.0 uses one fixed instruction, never arbitrary caller text. */
export function voiceParameters(speaker: string, resource: string, value: unknown) {
  const emotion = voiceEmotion(speaker, resource, value);
  const audio: Record<string, unknown> = { format: 'pcm', sample_rate: 24000 };
  const params: { speaker: string; audio_params: Record<string, unknown>; additions?: string } = { speaker, audio_params: audio };
  if (resource === 'seed-tts-2.0') {
    if (emotion.applied !== 'neutral') params.additions = JSON.stringify({ context_texts: [INSTRUCTIONS[emotion.applied]] });
  } else {
    audio.speech_rate = 0; audio.loudness_rate = 0;
    if (emotion.applied !== 'neutral') { audio.emotion = emotion.applied; audio.emotion_scale = 4; }
  }
  return params;
}
