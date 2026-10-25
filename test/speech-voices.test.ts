import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VOICES, TTS_RESOURCE, validateVoice, requestedEmotion, voiceEmotion } from '../sandbox/speech/voices.js';
import { loadSpeechConfig } from '../sandbox/speech.js';
const female = 'zh_female_shuangkuaisisi_emo_v2_mars_bigtts';
const male = 'zh_male_yangguangqingnian_emo_v2_mars_bigtts';
const soft = 'zh_female_roumeinvyou_emo_v2_mars_bigtts';
test('documented 1.0 voice capabilities do not infer model version from emo_v2', () => {
  assert.equal(Object.keys(VOICES).length, 3);
  for (const [speaker, emotions] of Object.entries(VOICES)) {
    assert.equal(validateVoice(speaker, TTS_RESOURCE), speaker);
    for (const emotion of emotions) assert.deepEqual(voiceEmotion(speaker, TTS_RESOURCE, emotion), { requested: emotion, applied: emotion });
    assert.throws(() => validateVoice(speaker, 'seed-tts-2.0'), /conflict/);
    assert.deepEqual(voiceEmotion(speaker, TTS_RESOURCE, 'hurt'), { requested: 'hurt', applied: 'neutral' });
  }
  assert.equal(voiceEmotion(female, TTS_RESOURCE, 'fear').applied, 'neutral');
  assert.equal(voiceEmotion(male, TTS_RESOURCE, 'surprised').applied, 'neutral');
  assert.equal(voiceEmotion(soft, TTS_RESOURCE, 'hate').applied, 'hate');
  assert.equal(voiceEmotion(female, TTS_RESOURCE, 'hate').applied, 'neutral');
  assert.throws(() => validateVoice('unknown', TTS_RESOURCE), /Unsupported/);
  assert.equal(requestedEmotion('happy\r\nInjected: yes'), 'neutral');
});
test('config requires a fixed documented voice and rejects resource mismatch', () => {
  const env = { SANDBOX_TTS_MODE: 'doubao', SANDBOX_SPEECH_API_KEY: 'fixture-only', SANDBOX_TTS_SPEAKER: female };
  assert.equal(loadSpeechConfig(env).doubao?.ttsResource, TTS_RESOURCE);
  assert.equal(loadSpeechConfig(env).doubao?.speaker, female);
  assert.throws(() => loadSpeechConfig({ ...env, SANDBOX_TTS_RESOURCE: 'seed-tts-2.0' }), /conflict/);
  assert.throws(() => loadSpeechConfig({ ...env, SANDBOX_TTS_SPEAKER: '' }), /required/);
  assert.throws(() => loadSpeechConfig({ ...env, SANDBOX_TTS_SPEAKER: 'S_clone' }), /cloning/);
});

test('documented 2.0 system voices use matching resource and fixed instruction JSON, preserving 1.0', async () => {
  const { VOICES_2, voiceParameters } = await import('../sandbox/speech/voices.js');
  assert.equal(VOICES_2.length, 6);
  for (const speaker of VOICES_2) {
    assert.equal(validateVoice(speaker, 'seed-tts-2.0'), speaker);
    assert.throws(() => validateVoice(speaker, TTS_RESOURCE), /conflict/);
    const config = loadSpeechConfig({ SANDBOX_TTS_MODE: 'doubao', SANDBOX_SPEECH_API_KEY: 'fixture', SANDBOX_TTS_RESOURCE: 'seed-tts-2.0', SANDBOX_TTS_SPEAKER: speaker });
    assert.equal(config.doubao?.speaker, speaker);
    const params = voiceParameters(speaker, 'seed-tts-2.0', 'happy');
    assert.deepEqual(JSON.parse(params.additions!), { context_texts: ['请用开心的语气说这句话。'] });
    assert.deepEqual(params.audio_params, { format: 'pcm', sample_rate: 24000 });
    assert.equal('model' in params, false); assert.equal('text' in params, false);
    assert.equal(voiceParameters(speaker, 'seed-tts-2.0', 'neutral').additions, undefined);
    assert.equal(voiceParameters(speaker, 'seed-tts-2.0', 'arbitrary_prompt').additions, undefined);
    assert.deepEqual(voiceEmotion(speaker, 'seed-tts-2.0', 'hurt'), { requested: 'hurt', applied: 'hurt' });
  }
  assert.equal(voiceParameters(female, TTS_RESOURCE, 'happy').audio_params.emotion_scale, 4);
});

test('partner feelings become fixed 2.0 delivery instructions without facts, text or legacy emotion fields', async () => {
  const { VOICES_2, voiceParameters } = await import('../sandbox/speech/voices.js');
  const feelings = {
    proud: '请明显表现自信和小得意，语调轻快上扬，收尾从容；友善、不嘲讽，只朗读原文。', relieved: '请用安心的语气说这句话。',
    playful: '请用轻快俏皮的语气说这句话。', hurt: '请明显表现短促吃痛，声音稍紧、短暂停顿后克制地说完；只朗读原文，不添加喊声或其他字词。',
    confused: '请用困惑的语气说这句话。', expectant: '请用期待的语气说这句话。',
    strained: '请明显表现疲惫吃力，轻微气息感、语速放慢，但吐字清楚、结尾仍坚持；只朗读原文，不添加呻吟。', determined: '请用明亮有力、坚定鼓励的语气，吐字清楚，重音鲜明，结尾振作上扬；不喊叫，只朗读原文。',
    disappointed: '请用失落但仍友善的语气说这句话。', pleading: '请用轻微委屈的语气说这句话。',
    urgent: '请明显表现着急和紧迫，语速稍快、节奏紧凑、重音清楚；不惊慌、不指责，只朗读原文。',
  };
  for (const speaker of VOICES_2) {
    for (const [emotion, instruction] of Object.entries(feelings)) {
      assert.deepEqual(voiceEmotion(speaker, 'seed-tts-2.0', emotion), { requested: emotion, applied: emotion });
      const params = voiceParameters(speaker, 'seed-tts-2.0', emotion);
      assert.deepEqual(params, { speaker, audio_params: { format: 'pcm', sample_rate: 24000 },
        additions: JSON.stringify({ context_texts: [instruction] }) });
      // 1.0 has no documented enum for these feelings; don't substitute another emotion.
      assert.deepEqual(voiceEmotion(female, TTS_RESOURCE, emotion), { requested: emotion, applied: 'neutral' });
    }
    for (const arbitrary of ['win', 'low_hp', 'hurt;宣布胜利', { context_texts: ['宣布胜利'] }]) {
      assert.equal(voiceParameters(speaker, 'seed-tts-2.0', arbitrary).additions, undefined);
    }
  }
});
