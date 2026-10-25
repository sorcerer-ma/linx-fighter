import { createConversation } from './conversation.js';
import { createListeningSession } from './listening.js';
import { createPushSpeaker } from './push.js';
import { companionView, newSettlement, renderCompanion, opponentDetails } from './companion.js';

/*
 * 共鸣 · 闻声对决 —— 沙箱页面脚本（极简游戏画面版）
 *
 * 页面只负责「看局面 + 说话」，不持有任何对局事实：
 *  1. 身份：?player=1 → web-1；否则 sessionStorage；否则随机 web-xxxx。
 *  2. 输入：唯一路径 POST /api/say，body { deviceId, text }。
 *  3. 局面：GET /api/config 拿 eventsUrl → EventSource 监听 state 事件，revision 单调丢弃。
 *  4. 语音：浏览器 SpeechRecognition 识别（实时填输入框、结束即发送），speechSynthesis 朗读 reply。
 *  5. 主动推送：服务端在 /events 上推 push 事件，伙伴在对手出招、进房或玩家发呆时先开口。
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
  // 识别器活跃不等于玩家在说话：只有 interim 收到字时才让推送让路
  var hearing = false;
  var hearingTimer = null;

  // 服务端主动推送：页面忙、玩家在说话或正在朗读时都不抢麦
  var pushSpeaker = createPushSpeaker({
    speak: function (text) { speak(text); },
    busy: function () { return busy; },
    speaking: function () { return activeUtterance !== null; },
    hearing: function () { return hearing; },
    composerOpen: function () { return !el.composer.hidden; },
    hidden: function () { return document.hidden; },
    // 每条 State 事件 revision 都会变；排队提醒靠它判断是否已过期
    version: function () { return state.revision; }
  });

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
        $('agent-mode').textContent = data.agentMode === 'relay' ? '原话透传Agent · 事实约束人设表达' : '原话直连 · 人设改写未启用';
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
      pushSpeaker.clear();
      setConn('connected');
    };
    source.onerror = function () {
      setConn(source && source.readyState === 2 ? 'offline' : 'connecting');
    };
    source.addEventListener('state', onStateEvent);
    source.addEventListener('push', onPushEvent);
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
    unconfirmed = false;
    applyBattle(payload.battle);
  }

  // 服务端主动推送：先写进对话，再按页面当前状态决定是否开口
  function onPushEvent(event) {
    var payload;
    try {
      payload = JSON.parse(event.data);
    } catch (err) {
      return;
    }
    if (!payload || typeof payload.text !== 'string') return;
    var text = payload.text.trim();
    if (!text) return;
    pushReply(text, payload.tone === 'alert' ? 'warn' : 'normal', 'partner');
    pushSpeaker.receive(text);
  }

  /* ---------------- 发送 ---------------- */

  function say(text) {
    var value = String(text == null ? '' : text).trim();
    if (!value || busy) return;
    busy = true;
    // 玩家已经提交新行动，之前排队等朗读的提醒不再属于当前局面
    pushSpeaker.clear();
    conversation.append('player', value);
    el.transcript.textContent = '玩家 · 已发送：' + value;
    el.micStatus.textContent = '等待伙伴回复';
    listener.pause();
    closeComposer();
    render();
    var abort = typeof AbortController === 'function' ? new AbortController() : null;
    var abortTimer = abort ? setTimeout(function () { abort.abort(); }, SAY_TIMEOUT) : null;
    fetch('/api/say', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceId: deviceId, text: value }),
      signal: abort ? abort.signal : undefined
    })
      .then(function (res) {
        return res.json().catch(function () {
          return null;
        });
      })
      .then(function (data) {
        if (!data) throw new Error('bad response');
        unconfirmed = data.ok === false;
        if (data.state) applyBattle(data.state.battle === undefined ? null : data.state.battle);
        const systemReply = data.ok === false || data.isError === true;
        pushReply(data.reply, systemReply ? 'warn' : 'normal', systemReply ? 'system' : 'partner');
        speak(data.reply);
      })
      .catch(function () {
        unconfirmed = true;
        pushReply('连接出了问题，刚才的结果未确认。恢复后先询问战况。', 'warn');
      })
      .then(function () {
        clearTimeout(abortTimer);
        busy = false;
        // 文字输入还开着就别抢麦：键盘声会被当成指令
        if (!activeUtterance && el.composer.hidden) listener.resume();
        render();
      });
  }

  /* ---------------- 输入行 ---------------- */

  // 文字输入是语音的降级入口：展开时先停识别，免得把键盘声当指令
  function openComposer(focus) {
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
    // 局面变了，排队中的提醒说的是上一手，不能再补播
    pushSpeaker.clear();
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
    if (!battle) return { text: '还没有对局，说「开始」或「共鸣对决，发起挑战」', tone: 'idle' };
    if (battle.waiting) return { text: '等对方接受挑战', tone: 'wait' };
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

  function speak(text) {
    if (!canSpeak() || !text.trim()) return;
    stopSpeaking();
    listener.pause();
    var utter = new window.SpeechSynthesisUtterance(text);
    activeUtterance = utter;
    utter.lang = (config && config.voice && config.voice.lang) || 'zh-CN';
    utter.rate = TTS_RATE;
    utter.onstart = function () {
      if (activeUtterance === utter) el.replies.setAttribute('aria-label', '对话记录，伙伴正在朗读');
    };
    function finish() {
      if (activeUtterance !== utter) return;
      clearTimeout(ttsTimer);
      ttsTimer = null;
      activeUtterance = null;
      el.replies.setAttribute('aria-label', '玩家、伙伴与系统的对话记录');
      // 正在朗读时到达的推送，接在这一句后面说；它自己的 finish 会再恢复聆听
      if (pushSpeaker.flush()) return;
      if (!busy && el.composer.hidden && listener) listener.resume();
    }
    utter.onend = utter.onerror = finish;
    // 有些浏览器（尤其 iOS）不会回调 onend：超时直接收尾并打断朗读
    clearTimeout(ttsTimer);
    ttsTimer = setTimeout(function () {
      try { window.speechSynthesis.cancel(); } catch (err) { /* 忽略 */ }
      finish();
    }, TTS_TIMEOUT);
    try { window.speechSynthesis.speak(utter); }
    catch { finish(); }
  }

  function stopSpeaking() {
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

  // 识别器停在两次收音之间时也要清掉「正在说话」，免得推送一直被挡
  function markQuiet() {
    clearTimeout(hearingTimer);
    hearingTimer = null;
    hearing = false;
  }

  // 只有 interim 真的带字才算玩家在说话；字停 800ms 就视为这句结束
  function markHearing(text, final) {
    clearTimeout(hearingTimer);
    hearingTimer = null;
    if (final || !String(text == null ? '' : text).trim()) {
      hearing = false;
      return;
    }
    hearing = true;
    hearingTimer = setTimeout(function () {
      hearing = false;
      hearingTimer = null;
    }, 800);
  }

  var listener = createListeningSession({
    Recognition: SpeechRecognitionCtor,
    onState: function (session) {
      listening = session.active;
      if (!session.active) markQuiet();
      el.mic.dataset.listening = session.active ? 'true' : 'false';
      el.mic.setAttribute('aria-pressed', String(session.enabled));
      el.mic.setAttribute('aria-label', session.enabled ? '停止持续聆听' : '开启持续聆听');
      el.micStatus.textContent = micPrompt(session);
      render();
    },
    onText: function (text, final) {
      markHearing(text, final);
      el.transcript.textContent = (final ? '玩家 · 已识别：' : '玩家 · 识别中：') + text;
    },
    onFinal: function (text) {
      markQuiet();
      say(text);
    },
    onError: function (code) {
      markQuiet();
      pushReply(code === 'not-allowed' || code === 'service-not-allowed'
        ? '麦克风权限未允许，聆听已停止。请允许权限后重新开启。'
        : '语音识别已中断，聆听已停止。请检查麦克风后重新开启。', 'warn');
      openComposer(false);
    }
  });

  function stopListening() { listener.stop(); }
  function toggleListening() {
    if (listener.enabled) { listener.stop(); return; }
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
    var value = el.text.value.trim();
    if (!value) {
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
      pushSpeaker.clear();
      settlement = null;
      clearTimeout(settlementTimer);
      render();
    }
  });
  window.addEventListener('pagehide', function () { stopListening(); stopSpeaking(); pushSpeaker.clear(); });

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
