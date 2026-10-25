import { createConversation } from './conversation.js';
import { createListeningSession } from './listening.js';
import { companionView, newSettlement, renderCompanion, opponentDetails } from './companion.js';

/*
 * 共鸣 · 闻声对决 —— 沙箱页面脚本（极简游戏画面版）
 *
 * 页面只负责「看局面 + 说话」，不持有任何对局事实：
 *  1. 身份：?player=1 → web-1；否则 sessionStorage；否则随机 web-xxxx。
 *  2. 输入：唯一路径 POST /api/say，body { deviceId, text }。
 *  3. 局面：GET /api/config 拿 eventsUrl → EventSource 监听 state 事件，revision 单调丢弃。
 *  4. 语音：浏览器 SpeechRecognition 识别（实时填输入框、结束即发送），speechSynthesis 朗读 reply。
 *
 * 身份只写 sessionStorage：localStorage 会让所有标签页变成同一个人。
 */
(function () {
  'use strict';

  var PLAYER_RE = /^[A-Za-z0-9_-]{1,16}$/;
  var DEVICE_RE = /^web-[A-Za-z0-9_-]{1,16}$/;
  var STORE_PLAYER = 'linx.sandbox.playerId';
  var MIC_NO_HTTPS = '当前页面不是 HTTPS，浏览器不给麦克风，点右侧键盘输入继续';
  var MIC_NO_API = '这个浏览器没有网页语音识别（iPhone 上的 Safari 和 Chrome 都这样），点右侧键盘输入继续';
  var TTS_RATE = 1.05;
  // 朗读在 iOS 上可能一直不回调 onend，超时后自己收尾，否则聆听会一直停着
  var TTS_TIMEOUT = 20000;
  // /api/say 长时间无响应时主动断开，避免按钮一直等
  var SAY_TIMEOUT = 25000;

  // 连接状态点：灰=连接中、绿=已连接、红=断开（点本身不显示文字）
  var CONN_LABEL = { connecting: '连接中', connected: '已连接', offline: '断开' };

  var SpeechRecognitionCtor = window.SpeechRecognition || window.webkitSpeechRecognition;

  /* ---------------- DOM ---------------- */

  function $(id) {
    return document.getElementById(id);
  }

  var el = {
    round: $('round'),
    dot: $('dot'),
    status: $('status'),
    alert: $('alert'),
    replies: $('replies'),
    conversationScroll: $('conversation-scroll'),
    composer: $('composer'),
    text: $('text'),
    send: $('send'),
    mic: $('mic'),
    keyboard: $('keyboard'),
    transcript: $('transcript'),
    micStatus: $('mic-status')

  };

  /* ---------------- 状态 ---------------- */

  var deviceId = resolveDeviceId();
  var state = {
    battle: null, // 服务端快照，null 表示还没有对局
    revision: -2
  };
  var config = null;
  var source = null;
  var busy = false; // 正在等 /api/say
  var conversation = createConversation(el.conversationScroll, el.replies, $('conversation-latest'));

  var activeUtterance = null;
  var ttsTimer = null;
  var connected = false;
  var unconfirmed = false;
  var settlement = null;
  var settlementTimer = null;
  var previousBattle = null;
  var listening = false;
  var turnSequence = 0;
  var waitAbort = null;
  var finishPlayback = null;
  var activeReplyBattleId = null;

  /* ---------------- 身份 ---------------- */

  function randomDeviceId() {
    var chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    var out = '';
    var buf = new Uint8Array(4);
    if (window.crypto && window.crypto.getRandomValues) {
      window.crypto.getRandomValues(buf);
      for (var i = 0; i < buf.length; i++) out += chars.charAt(buf[i] % chars.length);
    } else {
      for (var j = 0; j < 4; j++) out += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return 'web-' + out;
  }

  // 优先 ?player=，其次本标签页已记住的身份，最后新生成一个
  function resolveDeviceId() {
    var raw = null;
    try {
      raw = new URLSearchParams(window.location.search).get('player');
    } catch (err) {
      raw = null;
    }
    if (raw && PLAYER_RE.test(raw)) {
      var id = 'web-' + raw;
      writeSession(STORE_PLAYER, id);
      return id;
    }
    var saved = readSession(STORE_PLAYER);
    if (saved && DEVICE_RE.test(saved)) return saved;
    var generated = randomDeviceId();
    writeSession(STORE_PLAYER, generated);
    return generated;
  }

  function readSession(key) {
    try {
      return window.sessionStorage.getItem(key);
    } catch (err) {
      return null;
    }
  }

  function writeSession(key, value) {
    try {
      window.sessionStorage.setItem(key, value);
    } catch (err) {
      /* 隐私模式下写不进去，忽略即可 */
    }
  }

  /* ---------------- 播报区 ---------------- */

  function pushReply(text, tone, role = 'system') {
    conversation.append(role, text, tone);
    revealLatest();
  }

  // 底栏常驻会盖住页面下半截：新消息到达后把它顶到低栏上方，不用再手动往下滚
  function revealLatest() {
    var dock = document.querySelector('.dock');
    if (!dock) return;
    var covered = el.conversationScroll.getBoundingClientRect().bottom - dock.getBoundingClientRect().top + 8;
    if (covered > 0) window.scrollBy(0, covered);
  }

  /* ---------------- 连接状态 ---------------- */

  function setConn(kind) {
    connected = kind === 'connected';
    if (!connected) { settlement = null; clearTimeout(settlementTimer); }
    render();
    el.dot.dataset.state = kind;
    var label = CONN_LABEL[kind] || CONN_LABEL.connecting;
    el.dot.setAttribute('title', label);
    el.dot.setAttribute('aria-label', label);
  }

  /* ---------------- 状态流 ---------------- */

  function loadConfig() {
    return fetch('/api/config', { cache: 'no-store' })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (data) {
        config = data;
        $('agent-mode').textContent = data.agentMode === 'relay' ? '原话透传Agent · 事实约束人设表达' : '事实兜底 · 人设表达未启用';
        connectStream(data);
      })
      .catch(function () {
        // 沙箱没起来：保持页面可用，只提示一句
        setConn('offline');
        pushReply('连不上沙箱，先启动 pnpm sandbox。', 'warn');
      });
  }

  function connectStream(cfg) {
    if (source) source.close();
    setConn('connecting');
    var url = cfg.eventsUrl;
    if (!url) {
      setConn('offline');
      pushReply('沙箱没给状态流地址，局面不会刷新。', 'warn');
      return;
    }
    url +=
      (url.indexOf('?') === -1 ? '?' : '&') +
      'device=' +
      encodeURIComponent(deviceId) +
      '&agent=' +
      encodeURIComponent(cfg.agentId || 'linx-sandbox');
    try {
      source = new EventSource(url);
    } catch (err) {
      setConn('offline');
      return;
    }
    source.onopen = function () {
      // revision 每条连接内自增，重连后必须从头接受
      state.revision = -2;
      previousBattle = null;
      setConn('connected');
    };
    source.onerror = function () {
      setConn(source && source.readyState === 2 ? 'offline' : 'connecting');
    };
    source.addEventListener('state', onStateEvent);
  }

  function onStateEvent(event) {
    var payload;
    try {
      payload = JSON.parse(event.data);
    } catch (err) {
      return;
    }
    if (typeof payload.revision === 'number') {
      if (payload.revision <= state.revision) return; // 丢弃乱序/重复
      state.revision = payload.revision;
    }
    const nextBattleId = payload.battle && payload.battle.battleId;
    if ((waitAbort && state.battle && state.battle.battleId && nextBattleId !== state.battle.battleId) ||
        (activeUtterance && activeReplyBattleId && nextBattleId !== activeReplyBattleId)) cancelTurn();
    unconfirmed = false;
    applyBattle(payload.battle);
  }

  /* ---------------- 发送 ---------------- */

  // 每条输入最多等待一次。新输入、停止或离开页面使旧响应失效。
  function cancelTurn() {
    turnSequence += 1;
    if (waitAbort) waitAbort.abort();
    waitAbort = null;
    stopSpeaking();
    activeReplyBattleId = null;
    return turnSequence;
  }

  function wantsWait(data) {
    return !data.silent && data.protocol &&
      (data.protocol.need === 'wait_guest' || data.protocol.need === 'wait_foe');
  }

  function showOutcome(data, turn, revision) {
    if (turn !== turnSequence || document.hidden) return Promise.resolve('cancelled');
    const currentBattleId = state.battle && state.battle.battleId;
    // 工具执行时的局号来自服务端元信息，不从玩家原话或伙伴台词猜测。
    if (state.revision !== revision && data.sourceBattleId !== undefined &&
        data.sourceBattleId !== (currentBattleId || null)) return Promise.resolve('cancelled');
    unconfirmed = data.ok === false || (data.protocol && data.protocol.reason === 'unknown');
    render();
    if (data.state && state.revision === revision) {
      applyBattle(data.state.battle === undefined ? null : data.state.battle);
    }
    if (data.silent) return Promise.resolve('silent');
    if (typeof data.reply !== 'string' || !data.reply.trim()) return Promise.resolve('silent');
    const systemReply = data.ok === false || data.isError === true;
    pushReply(data.reply, systemReply ? 'warn' : 'normal', systemReply ? 'system' : 'partner');
    activeReplyBattleId = data.sourceBattleId || null;
    return speak(data.reply);
  }

  async function waitForOpponent(turn) {
    if (turn !== turnSequence || document.hidden) return;
    const abort = new AbortController();
    waitAbort = abort;
    const timeout = setTimeout(function () { abort.abort(); }, 40000);
    const revision = state.revision;
    try {
      const res = await fetch('/api/wait', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ deviceId: deviceId }), signal: abort.signal
      });
      const data = await res.json();
      if (abort.signal.aborted || turn !== turnSequence) return;
      if (!res.ok || !data) throw new Error('bad wait response');
      await showOutcome(data, turn, revision);
    } catch (error) {
      if (abort.signal.aborted || turn !== turnSequence) return;
      pushReply('等待连接中断，未重复执行任何行动；可以询问战况。', 'warn');
    } finally {
      clearTimeout(timeout);
      if (waitAbort === abort) waitAbort = null;
    }
  }

  async function say(text) {
    var value = String(text == null ? '' : text);
    if (!value.trim() || busy) return;
    const turn = cancelTurn();
    const revision = state.revision;
    busy = true;
    conversation.append('player', value);
    el.transcript.textContent = '玩家 · 已发送：' + value;
    el.micStatus.textContent = '等待伙伴回复';
    listener.pause();
    closeComposer();
    render();
    const abort = new AbortController();
    const abortTimer = setTimeout(function () { abort.abort(); }, SAY_TIMEOUT);
    let data;
    try {
      const res = await fetch('/api/say', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ deviceId: deviceId, text: value }), signal: abort.signal
      });
      data = await res.json();
      if (!res.ok || !data) throw new Error('bad response');
    } catch (error) {
      if (turn === turnSequence) {
        unconfirmed = true;
        pushReply('连接出了问题，刚才的结果未确认。恢复后先询问战况。', 'warn');
      }
    } finally {
      clearTimeout(abortTimer);
      busy = false;
      render();
    }
    if (data && turn === turnSequence) {
      const playback = await showOutcome(data, turn, revision);
      // 播放错误、取消、超时不冒充播放完成，也不提前挂起。
      if ((playback === 'ended' || playback === 'displayed') && wantsWait(data)) {
        void waitForOpponent(turn);
      }
    }
    if (!activeUtterance && el.composer.hidden) listener.resume();
  }

  /* ---------------- 输入行 ---------------- */

  // 文字输入是语音的降级入口：展开时先停识别，免得把键盘声当指令
  function openComposer(focus) {
    cancelTurn();
    el.keyboard.setAttribute('aria-expanded', 'true');
    if (listener && listener.enabled) listener.pause();
    if (!el.composer.hidden) {
      if (focus) el.text.focus();
      return;
    }
    el.composer.hidden = false;
    if (focus) el.text.focus();
  }

  function closeComposer() {
    if (el.composer.hidden) return;
    el.composer.hidden = true;
    el.keyboard.setAttribute('aria-expanded', 'false');
    el.text.value = '';
    if (listener && !busy && !activeUtterance) listener.resume();
  }

  /* ---------------- 渲染 ---------------- */

  function applyBattle(battle) {
    const event = newSettlement(previousBattle, battle);
    previousBattle = battle;
    state.battle = battle;
    if (event) {
      settlement = event;
      clearTimeout(settlementTimer);
      settlementTimer = setTimeout(() => { settlement = null; render(); }, 1100);
    } else if (!battle) {
      settlement = null;
      clearTimeout(settlementTimer);
    }
    render();
  }

  function render() {
    const battle = state.battle;
    const view = companionView(battle, connected && !unconfirmed, settlement, listening);
    // Microphone state stays independent; settled victory/defeat has visual priority.
    if (busy) view.ultimate = 'unknown';
    renderCompanion($('app'), battle, view);
    $('opponent-debug').textContent = opponentDetails(battle, connected && !unconfirmed);
    el.round.hidden = !battle;
    if (battle) el.round.textContent = '第 ' + battle.round + ' 轮';
    const status = describeStatus(battle);
    el.status.textContent = status.text;
    el.status.dataset.tone = status.tone || 'normal';
    const alert = describeAlert(battle);
    el.alert.hidden = !alert;
    el.alert.textContent = alert;
  }

  function describeStatus(battle) {
    if (!battle) return { text: '还没有对局，说「开始」或「开房间」', tone: 'idle' };
    if (battle.waiting) return { text: '等对手加入', tone: 'wait' };
    if (battle.phase === 'victory') return { text: '伙伴赢了', tone: 'win' };
    if (battle.phase === 'defeat') return { text: '伙伴被击倒了', tone: 'lose' };
    var pending = battle.pending;
    if (pending && pending.actor === 'enemy') return { text: '等你应对', tone: 'alert' };
    if (pending && pending.actor === 'player') return { text: '等对手应招', tone: 'wait' };
    if (battle.active === 'enemy') return { text: '对手行动中', tone: 'wait' };
    return { text: '你的回合', tone: 'you' };
  }

  // 对手已锁定的招式：这是页面唯一需要主动提醒的隐藏信息
  function describeAlert(battle) {
    var pending = battle && battle.pending;
    if (!pending || pending.actor !== 'enemy') return '';
    var move = pending.moveLabel || '招式';
    var text = '对手的一记' + move + '已锁定';
    if (typeof pending.damage === 'number') text += '（伤害 ' + pending.damage + '）';
    return text;
  }

  /* ---------------- 播报（TTS） ---------------- */

  function canSpeak() {
    return typeof window.speechSynthesis !== 'undefined' && typeof window.SpeechSynthesisUtterance === 'function';
  }

  // 音频层仅消费最终话术，以完成/失败/取消事件通知调用方。
  function speak(text) {
    if (!text.trim()) return Promise.resolve('silent');
    stopSpeaking();
    if (!canSpeak()) return Promise.resolve('displayed');
    listener.pause();
    return new Promise(function (resolve) {
      var utter = new window.SpeechSynthesisUtterance(text);
      activeUtterance = utter;
      utter.lang = (config && config.voice && config.voice.lang) || 'zh-CN';
      utter.rate = TTS_RATE;
      utter.onstart = function () {
        if (activeUtterance === utter) el.replies.setAttribute('aria-label', '对话记录，伙伴正在朗读');
      };
      function finish(reason) {
        if (activeUtterance !== utter) return;
        clearTimeout(ttsTimer);
        ttsTimer = null;
        activeUtterance = null;
        finishPlayback = null;
        el.replies.setAttribute('aria-label', '玩家、伙伴与系统的对话记录');
        resolve(reason);
        if (!busy && el.composer.hidden && listener) listener.resume();
      }
      finishPlayback = finish;
      utter.onend = function () { finish('ended'); };
      utter.onerror = function () { finish('error'); };
      ttsTimer = setTimeout(function () {
        finish('timeout');
        try { window.speechSynthesis.cancel(); } catch (err) { /* 浏览器已收尾 */ }
      }, TTS_TIMEOUT);
      try { window.speechSynthesis.speak(utter); }
      catch { finish('error'); }
    });
  }

  function stopSpeaking() {
    if (finishPlayback) finishPlayback('cancelled');
    clearTimeout(ttsTimer);
    ttsTimer = null;
    activeUtterance = null;
    el.replies.setAttribute('aria-label', '玩家、伙伴与系统的对话记录');
    if (canSpeak()) window.speechSynthesis.cancel();
  }

  /* ---------------- 持续聆听 ---------------- */

  // 语音不可用时，底栏提示直接指向键盘入口，免得演示者以为按钮坏了
  function speechReady() {
    return Boolean(SpeechRecognitionCtor) && window.isSecureContext !== false;
  }

  function micPrompt(session) {
    if (session.active) return '正在聆听，点击停止';
    if (session.enabled) return session.paused ? '聆听已开启，等待伙伴回复' : '聆听已开启，正在接续收音';
    if (speechReady()) return '点击开启持续聆听';
    return SpeechRecognitionCtor ? '页面不是 HTTPS，点键盘输入' : '此浏览器不支持语音，点键盘输入';
  }

  var listener = createListeningSession({
    Recognition: SpeechRecognitionCtor,
    onState: function (session) {
      listening = session.active;
      el.mic.dataset.listening = session.active ? 'true' : 'false';
      el.mic.setAttribute('aria-pressed', String(session.enabled));
      el.mic.setAttribute('aria-label', session.enabled ? '停止持续聆听' : '开启持续聆听');
      el.micStatus.textContent = micPrompt(session);
      render();
    },
    onText: function (text, final) {
      el.transcript.textContent = (final ? '玩家 · 已识别：' : '玩家 · 识别中：') + text;
    },
    onFinal: function (text) { say(text); },
    onError: function (code) {
      pushReply(code === 'not-allowed' || code === 'service-not-allowed'
        ? '麦克风权限未允许，聆听已停止。请允许权限后重新开启。'
        : '语音识别已中断，聆听已停止。请检查麦克风后重新开启。', 'warn');
      openComposer(false);
    }
  });

  function stopListening() { cancelTurn(); listener.stop(); }
  function toggleListening() {
    if (listener.enabled) { stopListening(); return; }
    if (!speechReady()) {
      pushReply(SpeechRecognitionCtor ? MIC_NO_HTTPS : MIC_NO_API, 'warn');
      openComposer(true);
      return;
    }
    listener.start();
    if (busy || activeUtterance) listener.pause();
  }

  // 底栏键盘键：开合文字输入行，语音不可用时也能走同一条原话入口
  function toggleComposer() {
    if (el.composer.hidden) openComposer(true);
    else closeComposer();
  }

  /* ---------------- 事件绑定 ---------------- */

  el.mic.addEventListener('click', toggleListening);
  el.mic.addEventListener('pointercancel', stopListening);
  el.keyboard.addEventListener('click', toggleComposer);

  el.composer.addEventListener('submit', function (event) {
    event.preventDefault();
    var value = el.text.value;
    if (!value.trim()) {
      closeComposer();
      return;
    }
    say(value);
  });

  el.text.addEventListener('keydown', function (event) {
    if (event.key !== 'Enter') return;
    if (event.shiftKey) return;
    if (event.isComposing || event.keyCode === 229) return; // 输入法组合中别抢回车
    event.preventDefault();
    el.composer.requestSubmit ? el.composer.requestSubmit() : el.send.click();
  });

  // 页面切走/隐藏时，先把播报和识别停掉，别在后台继续说
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) {
      stopSpeaking();
      stopListening();
      settlement = null;
      clearTimeout(settlementTimer);
      render();
    }
  });
  window.addEventListener('pagehide', function () { stopListening(); stopSpeaking(); });

  // iOS 键盘弹出不会缩小布局视口：用 visualViewport 的差值把底部输入区顶到键盘上方
  function watchKeyboard() {
    var view = window.visualViewport;
    if (!view) return;
    function sync() {
      var covered = Math.max(0, window.innerHeight - view.height - view.offsetTop);
      document.documentElement.style.setProperty('--kb-offset', covered + 'px');
    }
    view.addEventListener('resize', sync);
    view.addEventListener('scroll', sync);
    sync();
  }

  /* ---------------- 启动 ---------------- */

  el.micStatus.textContent = micPrompt({ enabled: false, active: false, paused: false });
  watchKeyboard();
  render();
  setConn('connecting');
  loadConfig();
})();
