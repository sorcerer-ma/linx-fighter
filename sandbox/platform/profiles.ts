import { speechProfile, profilePrompt, type SpeechProfileId } from '../speech/profiles.js';

// Agent and audio share the same approved pairs and versioned style fragments.
export { SPEECH_PROFILES, speechProfile, profilePrompt, type SpeechProfileId } from '../speech/profiles.js';
export const DEFAULT_SPEECH_PROFILE: SpeechProfileId = 'cancan';
export function resolveProfileId(value: unknown): SpeechProfileId {
  if (value === undefined) return DEFAULT_SPEECH_PROFILE;
  const profile = speechProfile(value);
  if (!profile) throw new RangeError('未知伙伴气质');
  return profile.profileId;
}
/** The fixed first two layers remain byte-identical for every voice profile. */
export const PERSONA_HEADING = '【第三层：可变人格】';
export function companionPrompt(main: string, profileId: SpeechProfileId, companionName?:string): string {
  const boundary = main.indexOf(PERSONA_HEADING);
  // Legacy custom prompts remain usable; production's default full template has all three layers.
  const fixed = boundary < 0 ? main : main.slice(0, boundary).trimEnd();
  return fixed + '\n\n' + PERSONA_HEADING + '\n' + profilePrompt(profileId, companionName)
    + '\n\n【主规则优先】人格只补充措辞和情绪，不覆盖执行契约、世界观、事实、身份、静默、持续等待与取消。';
}
