import { readFileSync } from 'node:fs';

/** Match the three approved voice/profile pairs; this is not a wider voice menu. */
export const SPEECH_PROFILES = {
  cancan: { name: '知性灿灿 · 温暖机灵', speaker: 'zh_female_cancan_uranus_bigtts', promptFile: 'cancan.md' },
  qingcang: { name: '擎苍 · 沉稳有斗志', speaker: 'zh_male_qingcang_uranus_bigtts', promptFile: 'qingcang.md' },
  tiancai: { name: '天才童声 · 活泼勇敢', speaker: 'zh_male_tiancaitongsheng_uranus_bigtts', promptFile: 'tiancai.md' },
} as const;
export type SpeechProfileId = keyof typeof SPEECH_PROFILES;
export const DEFAULT_SPEECH_PROFILE: SpeechProfileId = 'cancan';
export function speechProfile(value: unknown) {
  if (typeof value !== 'string' || !Object.hasOwn(SPEECH_PROFILES, value)) return undefined;
  const profileId = value as SpeechProfileId;
  return { profileId, resource: 'seed-tts-2.0', ...SPEECH_PROFILES[profileId] };
}
export function resolveProfileId(value: unknown): SpeechProfileId {
  if (value === undefined) return DEFAULT_SPEECH_PROFILE;
  const profile = speechProfile(value);
  if (!profile) throw new RangeError('未知伙伴气质');
  return profile.profileId;
}

// Read the four bounded, versioned files once. Request values never become paths.
const read = (file: string) => readFileSync(new URL(`../../config/companion-profiles/${file}`, import.meta.url), 'utf8').trim();
const shared = read('shared.md');
const fragments: Record<SpeechProfileId, string> = {
  cancan: read(SPEECH_PROFILES.cancan.promptFile),
  qingcang: read(SPEECH_PROFILES.qingcang.promptFile),
  tiancai: read(SPEECH_PROFILES.tiancai.promptFile),
};
/** Style supplement only. It is always composed with the actual main prompt. */
export function profilePrompt(profileId: SpeechProfileId): string {
  return shared + '\n\n' + fragments[resolveProfileId(profileId)];
}
export function companionPrompt(main: string, profileId: SpeechProfileId): string {
  return main + '\n\n' + profilePrompt(profileId) + '\n\n【主规则优先】以上气质仅补充措辞和情绪，不替换或覆盖前文主提示词的协议、事实、身份、静默、取消、单次执行与安全边界。名字仍来自主提示词或玩家配置，不因气质或合成音色改名。';
}
