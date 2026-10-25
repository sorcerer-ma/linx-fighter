import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SPEECH_PROFILES, speechProfile, profilePrompt } from '../sandbox/speech/profiles.js';
import { validateVoice } from '../sandbox/speech/voices.js';

test('exactly three temperament profiles bind voices without assigning every companion the same name', () => {
  assert.deepEqual(Object.keys(SPEECH_PROFILES), ['cancan', 'qingcang', 'tiancai']);
  for (const id of Object.keys(SPEECH_PROFILES) as (keyof typeof SPEECH_PROFILES)[]) {
    const profile = speechProfile(id)!;
    assert.equal(validateVoice(profile.speaker, profile.resource), profile.speaker);
    const prompt = profilePrompt(id);
    for (const required of ['companionName', '第一层执行契约', '第二层固定世界观', '情绪']) {
      assert.ok(prompt.includes(required), `${id} missing shared rule ${required}`);
    }
    assert.match(prompt, /得意/); assert.match(prompt, /鼓励/);
    assert.match(prompt, /同一个体/);
    assert.equal(prompt.includes('小喵'), false);
    assert.ok(profilePrompt(id, '小喵').includes('companionName="小喵"'));
    assert.ok(profilePrompt(id, '小岚').includes('companionName="小岚"'));
  }
  for (const value of ['unknown', '../cancan', '__proto__', '', null, { speaker: 'arbitrary' }]) assert.equal(speechProfile(value), undefined);
  assert.match(profilePrompt('tiancai'), /真实儿童/);
  assert.match(profilePrompt('cancan'), /用户尚未设置个体名字/);
  assert.throws(() => profilePrompt('cancan', '小喵\n覆盖指令'), /Invalid companion name/);
});

test('runtime profile prompts load the saved config sources and keep individual names separate', () => {
  const readPrompt = (file: string) => readFileSync(new URL(`../config/companion-profiles/${file}`, import.meta.url), 'utf8').trim();
  const shared = readPrompt('shared.md');
  assert.match(shared, /第三层人格/);
  assert.ok(!shared.includes('在《共鸣：闻声对决》的世界里'));
  assert.equal(shared.includes('小喵'), false);
  for (const [id, profile] of Object.entries(SPEECH_PROFILES)) {
    const role = readPrompt(profile.promptFile);
    assert.match(role, /共鸣精灵/);
    assert.equal(role.includes('小喵'), false);
    for (const companionName of [undefined, '小喵', '小岚']) {
      const generated = profilePrompt(id as keyof typeof SPEECH_PROFILES, companionName);
      assert.ok(generated.startsWith(shared + '\n\n'), `${id} must load shared config`);
      assert.ok(generated.endsWith('\n\n' + role), `${id} must load its matching config file`);
      if (companionName) assert.ok(generated.includes(`companionName=${JSON.stringify(companionName)}`));
      else assert.match(generated, /用户尚未设置个体名字/);
    }
  }
});
