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
  var STORE_TTS = 'linx.sandbox.tts';
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
    players: $('players'),
    status: $('status'),
    alert: $('alert'),
    replies: $('replies'),
    composer: $('composer'),
    text: $('text'),
    send: $('send'),
    mic: $('mic'),
    kb: $('kb'),
    sound: $('sound'),
    youName: $('you-name'),
    youHpNum: $('you-hp-num'),
    youHpBar: $('you-hp-bar'),
    youHpFill: $('you-hp-fill'),
    youDots: $('you-dots'),
    youUlt: $('you-ult'),
    foeName: $('foe-name'),
    foeHpNum: $('foe-hp-num'),
    foeHpBar: $('foe-hp-bar'),
    foeHpFill: $('foe-hp-fill'),
    foeDots: $('foe-dots'),
    foeUlt: $('foe-ult')
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
  var ttsOn = readFlag(STORE_TTS, true);
  var rec = null; // 正在进行的识别
  var recText = '';
  var recFailed = false;

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

  function readFlag(key, fallback) {
    var raw = readSession(key);
    if (raw === '1') return true;
    if (raw === '0') return false;
    return fallback;
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
    applyBattle(payload.battle);
  }

  /* ---------------- 发送 ---------------- */

  function say(text) {
    var value = String(text == null ? '' : text).trim();
    if (!value || busy) return;
    busy = true;
    el.mic.disabled = true;
    closeComposer();
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
        if (data.state) applyBattle(data.state.battle === undefined ? null : data.state.battle);
        pushReply(data.reply, data.ok === false ? 'warn' : 'normal');
        speak(data.reply);
      })
      .catch(function () {
        pushReply('连不上沙箱，确认 pnpm sandbox 在跑。', 'warn');
      })
      .then(function () {
        busy = false;
        el.mic.disabled = false;
      });
  }

  /* ---------------- 输入行 ---------------- */

  function openComposer(focus) {
    if (!el.composer.hidden) {
      if (focus) el.text.focus();
      return;
    }
    el.composer.hidden = false;
    el.kb.setAttribute('aria-expanded', 'true');
    if (focus) el.text.focus();
  }

  function closeComposer() {
    if (el.composer.hidden) return;
    el.composer.hidden = true;
    el.kb.setAttribute('aria-expanded', 'false');
    el.text.value = '';
  }

  function toggleComposer() {
    if (el.composer.hidden) openComposer(true);
    else closeComposer();
  }

  /* ---------------- 渲染 ---------------- */

  function applyBattle(battle) {
    state.battle = battle || null;
    render();
  }

  function render() {
    var battle = state.battle;
    var has = !!battle;

    if (has) {
      el.round.hidden = false;
      el.round.textContent = '第 ' + battle.round + ' 轮';
    } else {
      el.round.hidden = true;
    }

    el.players.hidden = !has;
    if (has) {
      renderPlayer('you', battle.you, battle.round, battle.history);
      renderPlayer('foe', battle.opponent, battle.round, battle.history);
    }

    var status = describeStatus(battle);
    el.status.textContent = status.text;
    el.status.dataset.tone = status.tone || 'normal';

    var alert = describeAlert(battle);
    el.alert.hidden = !alert;
    el.alert.textContent = alert || '';
  }

  function describeStatus(battle) {
    if (!battle) return { text: '还没有对局，说「开始」或「开房间」', tone: 'idle' };
    if (battle.waiting) return { text: '等对手加入', tone: 'wait' };
    if (battle.phase === 'victory') return { text: '你赢了', tone: 'win' };
    if (battle.phase === 'defeat') return { text: '你输了', tone: 'lose' };
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

  function renderPlayer(key, side, round, history) {
    var data = side || {};
    var name = data.name || (key === 'you' ? '你' : '对手');
    var hp = numberOr(data.hp, 0);
    var maxHp = Math.max(1, numberOr(data.maxHp, 1));
    var ap = numberOr(data.ap, 0);
    var maxAp = Math.max(1, numberOr(data.maxAp, 5));
    var ultLeft = numberOr(data.ultLeft, 0);

    var nameEl = key === 'you' ? el.youName : el.foeName;
    var numEl = key === 'you' ? el.youHpNum : el.foeHpNum;
    var barEl = key === 'you' ? el.youHpBar : el.foeHpBar;
    var fillEl = key === 'you' ? el.youHpFill : el.foeHpFill;
    var dotsEl = key === 'you' ? el.youDots : el.foeDots;
    var ultEl = key === 'you' ? el.youUlt : el.foeUlt;

    nameEl.textContent = name;
    numEl.textContent = hp + '/' + maxHp;
    var pct = Math.max(0, Math.min(100, Math.round((hp / maxHp) * 100)));
    fillEl.style.width = pct + '%';
    fillEl.dataset.low = pct <= 30 ? 'true' : 'false';
    barEl.setAttribute('aria-valuemax', String(maxHp));
    barEl.setAttribute('aria-valuenow', String(hp));

    // 能量：一共 5 个点，亮起来的是当前能量
    if (dotsEl.childElementCount !== maxAp) {
      var dots = [];
      for (var i = 0; i < maxAp; i++) {
        var dot = document.createElement('i');
        dots.push(dot);
      }
      dotsEl.replaceChildren.apply(dotsEl, dots);
    }
    for (var j = 0; j < dotsEl.children.length; j++) {
      dotsEl.children[j].dataset.on = j < ap ? 'true' : 'false';
    }
    dotsEl.setAttribute('aria-label', '能量 ' + ap + '/' + maxAp);

    var ready = ultLeft > 0;
    ultEl.textContent = ready ? '大招可用' : '大招已用';
    ultEl.dataset.used = ready ? 'false' : 'true';
  }

  function numberOr(value, fallback) {
    return typeof value === 'number' && isFinite(value) ? value : fallback;
  }

  /* ---------------- 播报（TTS） ---------------- */

  function canSpeak() {
    return typeof window.speechSynthesis !== 'undefined' && typeof window.SpeechSynthesisUtterance === 'function';
  }

  function speak(text) {
    if (!ttsOn || !canSpeak()) return;
    var value = String(text == null ? '' : text).trim();
    if (!value) return;
    try {
      window.speechSynthesis.cancel(); // 每次新回复前打断上一条
      var utter = new window.SpeechSynthesisUtterance(value);
      utter.lang = (config && config.voice && config.voice.lang) || 'zh-CN';
      utter.rate = TTS_RATE;
      window.speechSynthesis.speak(utter);
    } catch (err) {
      /* TTS 不可用时静默降级 */
    }
  }

  function stopSpeaking() {
    if (!canSpeak()) return;
    try {
      window.speechSynthesis.cancel();
    } catch (err) {
      /* 忽略 */
    }
  }

  function renderSound() {
    el.sound.dataset.on = ttsOn ? 'true' : 'false';
    el.sound.setAttribute('aria-pressed', ttsOn ? 'true' : 'false');
    el.sound.setAttribute('aria-label', ttsOn ? '语音播报开' : '语音播报关');
  }

  /* ---------------- 语音识别 ---------------- */

  function micAvailable() {
    return !!SpeechRecognitionCtor && window.isSecureContext !== false;
  }

  function setListening(on) {
    el.mic.dataset.listening = on ? 'true' : 'false';
    el.mic.setAttribute('aria-pressed', on ? 'true' : 'false');
    el.mic.setAttribute('aria-label', on ? '正在聆听，再点一下停止' : '按住或点击说话');
  }

  function startListening() {
    if (busy) return;
    if (!micAvailable()) {
      // 内网 HTTP 页面拿不到麦克风：麦克风留着，点到就在播报区说清楚
      pushReply(MIC_NO_HTTPS, 'warn');
      return;
    }
    stopListening(); // 上一轮没结束就重开
    recText = '';
    recFailed = false;
    var instance;
    try {
      instance = new SpeechRecognitionCtor();
    } catch (err) {
      pushReply(MIC_NO_HTTPS, 'warn');
      return;
    }
    instance.lang = 'zh-CN';
    instance.interimResults = true;
    instance.continuous = false;
    instance.maxAlternatives = 1;

    instance.onresult = function (event) {
      var text = '';
      for (var i = 0; i < event.results.length; i++) {
        text += event.results[i][0].transcript;
      }
      recText = text.replace(/\s+/g, ' ').trim();
      setInputText(recText); // 边说边填进输入框
    };
    instance.onerror = function (event) {
      recFailed = true;
      var code = event && event.error;
      if (code === 'not-allowed' || code === 'service-not-allowed') {
        pushReply(MIC_NO_HTTPS, 'warn');
      } else if (code !== 'no-speech' && code !== 'aborted') {
        pushReply('没听清，再说一次。', 'warn');
      }
    };
    instance.onend = function () {
      if (rec === instance) rec = null;
      setListening(false);
      var text = recText.trim();
      recText = '';
      if (text) {
        var failed = recFailed;
        recFailed = false;
        if (!failed && !busy) {
          el.text.value = '';
          say(text); // 说完即发送，无需再按一次
        }
      }
    };

    rec = instance;
    try {
      instance.start();
    } catch (err) {
      rec = null;
      setListening(false);
      pushReply('麦克风没启动起来，用文字输入继续。', 'warn');
      return;
    }
    openComposer(false);
    setListening(true);
  }

  function stopListening() {
    var instance = rec;
    if (!instance) return;
    rec = null; // 先摘掉引用，避免 onend 里重复处理
    try {
      instance.abort();
    } catch (err) {
      /* 忽略 */
    }
    setListening(false);
  }

  function toggleListening() {
    if (rec) stopListening();
    else startListening();
  }

  function setInputText(text) {
    el.text.value = text;
  }

  /* ---------------- 事件绑定 ---------------- */

  // 麦克风：按住说话（松手停）、轻点开始/再点停止都支持
  (function bindMic() {
    var holdTimer = null;
    var held = false;

    el.mic.addEventListener('pointerdown', function (event) {
      if (event.button !== undefined && event.button !== 0) return;
      event.preventDefault();
      if (rec) {
        stopListening();
        return;
      }
      startListening();
      held = false;
      if (holdTimer) clearTimeout(holdTimer);
      holdTimer = setTimeout(function () {
        held = true; // 按住超过 450ms 算「按住说话」，松手就停
      }, 450);
    });

    el.mic.addEventListener('pointerup', function () {
      if (holdTimer) {
        clearTimeout(holdTimer);
        holdTimer = null;
      }
      if (held && rec) stopListening();
      held = false;
    });

    el.mic.addEventListener('pointercancel', function () {
      if (holdTimer) {
        clearTimeout(holdTimer);
        holdTimer = null;
      }
      held = false;
      stopListening();
    });

    // 键盘（Enter/Space）触发的 click 没有 pointerdown，单独补一条
    el.mic.addEventListener('click', function (event) {
      if (event.detail === 0) toggleListening();
    });
  })();

  el.kb.addEventListener('click', function () {
    toggleComposer();
  });

  el.sound.addEventListener('click', function () {
    ttsOn = !ttsOn;
    writeSession(STORE_TTS, ttsOn ? '1' : '0');
    renderSound();
    if (!ttsOn) stopSpeaking();
    else if (lastReply) speak(lastReply);
  });

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
    }
  });
  window.addEventListener('pagehide', stopSpeaking);

  /* ---------------- 启动 ---------------- */

  renderSound();
  render();
  setConn('connecting');
  loadConfig();
})();
