/**
 * 主动推送的播放入口。
 *
 * 推送随时可能到达，但不是任何时候都适合开口：
 * - 页面正在等 /api/say、玩家正在说话或正在打字时，只留文字，不抢麦；
 * - 伙伴正在朗读时，排到当前这一句结束后再说，避免打断；
 * - 排队时带上当时的局面版本，播放前版本变了就丢掉，避免把旧提醒补到新局面上；
 * - 页面隐藏或重连时清掉排队，别把上一局的话带到新连接里。
 *
 * 注意 `hearing` 是「真的收到字」，不是「麦克风开着」：持续聆听大部分时间
 * 只是待机，这时可以朗读；真正说话时才让路，否则主动推送永远没机会出声。
 */
export function createPushSpeaker(deps) {
  let queued = null;

  function blocked() {
    return deps.busy() || deps.hearing() || deps.composerOpen() || deps.hidden();
  }

  return {
    receive(text) {
      const value = String(text == null ? '' : text).trim();
      if (!value) return 'dropped';
      if (deps.speaking()) {
        queued = { text: value, version: deps.version() };
        return 'queued';
      }
      if (blocked()) return 'dropped';
      deps.speak(value);
      return 'spoken';
    },

    /** 当前朗读结束后调用；返回是否补播了排队的一条 */
    flush() {
      const entry = queued;
      queued = null;
      if (!entry || deps.speaking() || blocked()) return false;
      // 排队期间局面已经变过：这一句说的是上一手，不能补播
      if (entry.version !== deps.version()) return false;
      deps.speak(entry.text);
      return true;
    },

    clear() {
      queued = null;
    }
  };
}
