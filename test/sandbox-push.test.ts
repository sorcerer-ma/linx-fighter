import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { createPushSpeaker } = await import(new URL('../sandbox/public/push.js', import.meta.url).href);

function setup() {
  const spoken: string[] = [];
  const flags = {
    busy: false,
    speaking: false,
    hearing: false,
    composerOpen: false,
    hidden: false,
  };
  const speaker = createPushSpeaker({
    speak(text: string) {
      flags.speaking = true;
      spoken.push(text);
    },
    busy: () => flags.busy,
    speaking: () => flags.speaking,
    hearing: () => flags.hearing,
    composerOpen: () => flags.composerOpen,
    hidden: () => flags.hidden,
  });
  return { speaker, spoken, flags };
}

describe('页面主动推送的播放入口', () => {
  it('空闲或麦克风只是待机时直接朗读，不把持续聆听当成玩家在说话', () => {
    const { speaker, spoken } = setup();
    assert.equal(speaker.receive('对手来了。'), 'spoken');
    assert.deepEqual(spoken, ['对手来了。']);
  });

  it('正在朗读时只留最新一条，等这一句结束再补', () => {
    const { speaker, spoken, flags } = setup();
    flags.speaking = true;

    assert.equal(speaker.receive('第一句'), 'queued');
    assert.equal(speaker.receive('第二句'), 'queued');
    assert.deepEqual(spoken, []);

    flags.speaking = false;
    assert.equal(speaker.flush(), true);
    assert.deepEqual(spoken, ['第二句']);
  });

  it('玩家在说话、打字或页面隐藏时不抢麦，也不排队', () => {
    for (const flag of ['busy', 'hearing', 'composerOpen', 'hidden'] as const) {
      const { speaker, spoken, flags } = setup();
      flags[flag] = true;
      assert.equal(speaker.receive('该你了。'), 'dropped', flag);
      assert.equal(speaker.flush(), false, flag);
      assert.deepEqual(spoken, [], flag);
    }
  });

  it('排队的一条遇到新阻塞就丢弃，不隔很久再冒出来', () => {
    const { speaker, spoken, flags } = setup();
    flags.speaking = true;
    speaker.receive('还等着你定。');

    flags.speaking = false;
    flags.hearing = true;
    assert.equal(speaker.flush(), false);
    assert.deepEqual(spoken, []);

    flags.hearing = false;
    assert.equal(speaker.flush(), false);
    assert.deepEqual(spoken, []);
  });

  it('空文本和重连清空都不会出声', () => {
    const { speaker, spoken } = setup();
    assert.equal(speaker.receive('   '), 'dropped');

    const queued = setup();
    queued.flags.speaking = true;
    queued.speaker.receive('等我一下。');
    queued.speaker.clear();
    queued.flags.speaking = false;
    assert.equal(queued.speaker.flush(), false);
    assert.deepEqual(queued.spoken, []);

    assert.deepEqual(spoken, []);
  });
});
