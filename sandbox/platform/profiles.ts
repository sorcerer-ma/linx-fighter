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
export function companionPrompt(main: string, profileId: SpeechProfileId, companionName?:string): string {
  return main + '\n\n' + profilePrompt(profileId,companionName) + '\n\n【主规则优先】以上气质仅补充措辞和情绪，不替换或覆盖前文主提示词的协议、事实、身份、静默、取消、单次执行与安全边界。名字仍来自主提示词或玩家配置，不因气质或合成音色改名。';
}
