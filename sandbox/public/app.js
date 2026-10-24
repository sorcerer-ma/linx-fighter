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
  var MIC_NO_HTTPS = '当前页面不是 HTTPS，浏览器不给麦克风，用文字输入继续';
  var REPLY_LIMIT = 2; // 播报只留最近两条，不做聊天记录
  var TTS_RATE = 1.05;

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
    composer: $('composer'),
    text: $('text'),
    send: $('send'),
    mic: $('mic'),
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
  var replies = []; // [{ text, tone }]，最多 REPLY_LIMIT 条
  var lastReply = '';

  var activeUtterance = null;
  var connected = false;
  var unconfirmed = false;
  var settlement = null;
  var settlementTimer = null;
  var previousBattle = null;
  var listening = false;

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

  function pushReply(text, tone) {
    var value = String(text == null ? '' : text).trim();
    if (!value) return;
    replies.push({ text: value, tone: tone || 'normal' });
    if (replies.length > REPLY_LIMIT) replies = replies.slice(replies.length - REPLY_LIMIT);
    lastReply = value;
    renderReplies();
  }

  function renderReplies() {
    var nodes = replies.map(function (item, index) {
      var li = document.createElement('li');
      li.textContent = item.text;
      li.dataset.tone = item.tone;
      li.dataset.fresh = index === replies.length - 1 ? 'true' : 'false';
      return li;
    });
    el.replies.replaceChildren.apply(el.replies, nodes);
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
    unconfirmed = false;
    applyBattle(payload.battle);
  }

  /* ---------------- 发送 ---------------- */

  function say(text) {
    var value = String(text == null ? '' : text).trim();
    if (!value || busy) return;
    busy = true;
    el.transcript.textContent = '已发送：' + value;
    el.micStatus.textContent = '等待伙伴回复';
    listener.pause();
    closeComposer();
    render();
    fetch('/api/say', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceId: deviceId, text: value })
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
        pushReply(data.reply, data.ok === false ? 'warn' : 'normal');
        speak(data.reply);
      })
      .catch(function () {
        unconfirmed = true;
        pushReply('连接出了问题，刚才的结果未确认。恢复后先询问战况。', 'warn');
      })
      .then(function () {
        busy = false;
        if (!activeUtterance) listener.resume();
        render();
      });
  }

  /* ---------------- 输入行 ---------------- */

  function openComposer(focus) {
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
    el.text.value = '';
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

  function speak(text) {
    if (!canSpeak() || !text.trim()) return;
    stopSpeaking();
    listener.pause();
    var utter = new window.SpeechSynthesisUtterance(text);
    activeUtterance = utter;
    utter.lang = (config && config.voice && config.voice.lang) || 'zh-CN';
    utter.rate = TTS_RATE;
    utter.onstart = function () {
      if (activeUtterance === utter) el.replies.setAttribute('aria-label', '伙伴回复，正在朗读');
    };
    function finish() {
      if (activeUtterance !== utter) return;
      activeUtterance = null;
      el.replies.setAttribute('aria-label', '最近伙伴回复');
      if (!busy) listener.resume();
    }
    utter.onend = utter.onerror = finish;
    try { window.speechSynthesis.speak(utter); }
    catch { finish(); }
  }

  function stopSpeaking() {
    activeUtterance = null;
    el.replies.setAttribute('aria-label', '最近伙伴回复');
    if (canSpeak()) window.speechSynthesis.cancel();
  }

  /* ---------------- 持续聆听 ---------------- */

  var listener = createListeningSession({
    Recognition: SpeechRecognitionCtor,
    onState: function (session) {
      listening = session.active;
      el.mic.dataset.listening = session.active ? 'true' : 'false';
      el.mic.setAttribute('aria-pressed', String(session.enabled));
      el.mic.setAttribute('aria-label', session.enabled ? '停止持续聆听' : '开启持续聆听');
      el.micStatus.textContent = session.active ? '正在聆听，点击停止'
        : session.enabled ? (session.paused ? '聆听已开启，等待伙伴回复' : '聆听已开启，正在接续收音')
        : '点击开启持续聆听';
      render();
    },
    onText: function (text, final) {
      el.transcript.textContent = (final ? '已识别：' : '识别中：') + text;
    },
    onFinal: function (text) { say(text); },
    onError: function (code) {
      pushReply(code === 'not-allowed' || code === 'service-not-allowed'
        ? '麦克风权限未允许，聆听已停止。请允许权限后重新开启。'
        : '语音识别已中断，聆听已停止。请检查麦克风后重新开启。', 'warn');
      openComposer(false);
    }
  });

  function stopListening() { listener.stop(); }
  function toggleListening() {
    if (listener.enabled) { listener.stop(); return; }
    if (!SpeechRecognitionCtor || window.isSecureContext === false) {
      pushReply(MIC_NO_HTTPS, 'warn');
      openComposer(false);
      return;
    }
    listener.start();
    if (busy || activeUtterance) listener.pause();
  }

  /* ---------------- 事件绑定 ---------------- */

  el.mic.addEventListener('click', toggleListening);
  el.mic.addEventListener('pointercancel', stopListening);

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
      settlement = null;
      clearTimeout(settlementTimer);
      render();
    }
  });
  window.addEventListener('pagehide', function () { stopListening(); stopSpeaking(); });

  /* ---------------- 启动 ---------------- */

  render();
  setConn('connecting');
  loadConfig();
})();
