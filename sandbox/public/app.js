/*
 * 灵犀语音硬件模拟器 · 沙箱页面脚本
 *
 * 职责（全部只做前端，不持有任何对局事实）：
 *  1. 身份：?player= → web-<player>；否则 sessionStorage；否则随机 web-xxxx。
 *  2. 输入：所有话语只走 POST /api/say，快捷词只填输入框。
 *  3. 状态：GET /api/config 取地址，EventSource 订阅 state 事件，只读渲染。
 *  4. 语音：SpeechRecognition 收音（不可用时降级成文字），speechSynthesis 播报。
 *  5. 调试：可折叠面板，展示地址、revision、最近一次 trace、工具名。
 *
 * 约定：服务端返回的任何文本一律 textContent 渲染，不拼 innerHTML。
 */
(function () {
  'use strict';

  // ---------------- 常量 ----------------

  var STORE_PLAYER = 'linx.sandbox.playerId';
  var STORE_TTS = 'linx.sandbox.ttsOn';
  var STORE_AUTOSEND = 'linx.sandbox.autoSend';
  var PLAYER_RE = /^[A-Za-z0-9_-]{1,16}$/;
  var SLOT_MAX = 4;
  var HISTORY_LIMIT = 6;
  var TRACE_LIMIT = 4000;
  var DEFAULT_LANG = 'zh-CN';
  var TTS_RATE = 1.05;
  var MIC_NEED_HTTPS = '当前页面不是 HTTPS，浏览器不给麦克风；先用文字，或按 README 配 HTTPS';

  var CONN_LABEL = {
    offline: '未连接',
    connecting: '连接中',
    connected: '已连接',
    reconnecting: '重连中'
  };

  var STAGE_LABEL = {
    idle: '待唤醒',
    listening: '聆听中',
    thinking: '思考中',
    speaking: '播报中'
  };

  var ACTOR_LABEL = { player: '你', enemy: '对手' };

  var DBG_IDS = {
    sandbox: 'dbg-sandbox',
    upstream: 'dbg-upstream',
    events: 'dbg-events',
    device: 'dbg-device',
    agent: 'dbg-agent',
    revision: 'dbg-revision',
    conn: 'dbg-conn'
  };

  // ---------------- 通用小工具 ----------------

  function $(id) {
    return document.getElementById(id);
  }

  function trim(text) {
    return String(text == null ? '' : text).replace(/^[\s\u3000]+|[\s\u3000]+$/g, '');
  }

  function num(value, fallback) {
    var n = Number(value);
    return isFinite(n) ? n : (fallback == null ? 0 : fallback);
  }

  function clamp(value, min, max) {
    return value < min ? min : value > max ? max : value;
  }

  function repeat(char, count) {
    var out = '';
    for (var i = 0; i < count; i++) out += char;
    return out;
  }

  function make(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = String(text);
    return node;
  }

  function readBool(key, fallback) {
    try {
      var raw = sessionStorage.getItem(key);
      if (raw === '1') return true;
      if (raw === '0') return false;
    } catch (err) {
      /* 隐私模式可能禁用 storage，忽略 */
    }
    return fallback;
  }

  function writeBool(key, value) {
    try {
      sessionStorage.setItem(key, value ? '1' : '0');
    } catch (err) {
      /* 存不了就算了，刷新后回到默认值 */
    }
  }

  function describeError(err) {
    var message = err && err.message ? String(err.message) : '未知错误';
    if (/Failed to fetch|NetworkError|Load failed|load failed|Network request failed/i.test(message)) {
      return '连不上沙箱端口';
    }
    return message;
  }

  function fetchJson(url, options) {
    return fetch(url, options).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.text().then(function (raw) {
        if (!raw) return {};
        try {
          return JSON.parse(raw);
        } catch (err) {
          throw new Error('响应不是 JSON');
        }
      });
    });
  }

  // ---------------- 轻提示 ----------------

  var toastNode = null;
  var toastTimer = 0;

  function toast(message) {
    if (!toastNode) {
      toastNode = make('div', 'toast');
      toastNode.setAttribute('role', 'status');
    }
    toastNode.textContent = message;
    if (!toastNode.parentNode) document.body.appendChild(toastNode);
    if (toastTimer) window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(function () {
      if (toastNode && toastNode.parentNode) toastNode.parentNode.removeChild(toastNode);
    }, 2600);
  }

  function shorten(value) {
    return value.length > 30 ? value.slice(0, 30) + '…' : value;
  }

  function copyText(value) {
    var text = String(value == null ? '' : value);
    if (!text || text === '—') {
      toast('没有可复制的内容');
      return;
    }
    function done() {
      toast('已复制：' + shorten(text));
    }
    function fallback() {
      var area = document.createElement('textarea');
      area.value = text;
      area.setAttribute('readonly', '');
      area.style.position = 'fixed';
      area.style.top = '-1000px';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      var ok = false;
      try {
        ok = document.execCommand('copy');
      } catch (err) {
        ok = false;
      }
      if (area.parentNode) area.parentNode.removeChild(area);
      if (ok) done();
      else toast('复制失败，请手动选中');
    }
    if (navigator.clipboard && navigator.clipboard.writeText && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(done, fallback);
      return;
    }
    fallback();
  }

  // ---------------- 身份 ----------------

  function randomDeviceId() {
    var alphabet = '0123456789abcdefghijklmnopqrstuvwxyz';
    var bytes = null;
    try {
      bytes = new Uint8Array(4);
      window.crypto.getRandomValues(bytes);
    } catch (err) {
      bytes = null;
    }
    var out = '';
    for (var i = 0; i < 4; i++) {
      var n = bytes ? bytes[i] : Math.floor(Math.random() * 256);
      out += alphabet.charAt(n % alphabet.length);
    }
    return 'web-' + out;
  }

  function loadStoredPlayer() {
    try {
      var stored = sessionStorage.getItem(STORE_PLAYER);
      return stored && PLAYER_RE.test(stored.replace(/^web-/, '')) ? stored : '';
    } catch (err) {
      return '';
    }
  }

  function storePlayer(deviceId) {
    try {
      sessionStorage.setItem(STORE_PLAYER, deviceId);
    } catch (err) {
      /* sessionStorage 不可用时身份只在本次内存里生效 */
    }
  }

  function slotOf(text) {
    var match = /^web-([1-4])$/.exec(text) || /^([1-4])$/.exec(text);
    return match ? Number(match[1]) : 0;
  }

  /**
   * 身份优先级：?player= > sessionStorage > 随机 web-xxxx。
   * 注意：config.defaultDeviceId 只作展示，不采用 —— 否则所有不带参数的
   * 标签页会共用同一个身份，多开就变成同一个人。
   */
  function resolveIdentity() {
    var raw = null;
    try {
      raw = new URLSearchParams(window.location.search).get('player');
    } catch (err) {
      raw = null;
    }
    if (raw !== null && PLAYER_RE.test(raw)) {
      var fromParam = 'web-' + raw;
      storePlayer(fromParam);
      return { deviceId: fromParam, label: '玩家 ' + raw, slot: slotOf(fromParam), fromParam: true };
    }
    var stored = loadStoredPlayer();
    if (stored) {
      return { deviceId: stored, label: stored.slice(-4), slot: slotOf(stored), fromParam: false };
    }
    var generated = randomDeviceId();
    storePlayer(generated);
    return { deviceId: generated, label: generated.slice(-4), slot: 0, fromParam: false };
  }

  // ---------------- 语音能力探测 ----------------

  var SpeechRecognitionCtor = window.SpeechRecognition || window.webkitSpeechRecognition || null;
  var synth = null;
  try {
    synth = window.speechSynthesis || null;
  } catch (err) {
    synth = null;
  }
  var ttsSupported = !!(synth && typeof window.SpeechSynthesisUtterance === 'function');

  function isSecurePage() {
    if (typeof window.isSecureContext === 'boolean') return window.isSecureContext;
    var host = window.location.hostname;
    return window.location.protocol === 'https:' || host === 'localhost' || host === '127.0.0.1';
  }

  function micAvailable() {
    return !!SpeechRecognitionCtor && isSecurePage();
  }

  function micNotice() {
    if (!SpeechRecognitionCtor) {
      return '这个浏览器没有语音识别，先用文字输入（Chrome、Safari、Edge 支持）。';
    }
    return MIC_NEED_HTTPS;
  }

  // ---------------- DOM ----------------

  var appEl = $('app');
  var connEl = $('conn');
  var connLabelEl = $('conn-label');
  var badgeEl = $('player-badge');
  var newWindowEl = $('new-window');
  var noticeEl = $('notice');
  var noticeTextEl = $('notice-text');
  var noticeRetryEl = $('notice-retry');

  var orbEl = $('orb');
  var stageStateEl = $('stage-state');
  var stageHintEl = $('stage-hint');

  var replyCardEl = $('reply-card');
  var replyTextEl = $('reply-text');
  var replyMetaEl = $('reply-meta');
  var replayEl = $('replay');

  var composerEl = $('composer');
  var inputEl = $('input');
  var sendEl = $('send');
  var autoSendEl = $('auto-send');
  var ttsEl = $('tts');
  var ttsSwitchEl = $('tts-switch');
  var chipsEl = $('chips');

  var boardBodyEl = $('board-body');
  var debugEl = $('debug');
  var toolsEl = $('dbg-tools');
  var traceEl = $('dbg-trace');

  // ---------------- 状态 ----------------

  var state = {
    identity: null,
    lang: DEFAULT_LANG,
    config: null,
    configError: '',
    streamError: '',
    sayError: '',
    es: null,
    conn: 'offline',
    revision: -1,
    battle: undefined,
    busy: false,
    listening: false,
    speaking: false,
    lastReply: '',
    toolsState: 'idle'
  };

  var ttsOn = readBool(STORE_TTS, true);
  var autoSendOn = readBool(STORE_AUTOSEND, true);
  var speakTimer = 0;
  var recognition = null;
  var recognitionError = false;

  // ---------------- 调试面板写入 ----------------

  function dbg(key, value) {
    var node = $(DBG_IDS[key]);
    if (!node) return;
    var text = value == null ? '' : String(value);
    node.textContent = text === '' ? '—' : text;
  }

  function setConn(kind) {
    state.conn = kind;
    connEl.dataset.state =
      kind === 'connected' ? 'connected' : kind === 'reconnecting' ? 'reconnecting' : 'offline';
    connLabelEl.textContent = CONN_LABEL[kind] || CONN_LABEL.offline;
    // 极窄屏会隐藏文字标签，title 里保留同一份状态便于悬停或读屏查看
    connEl.title = '状态流：' + (CONN_LABEL[kind] || CONN_LABEL.offline);
    dbg('conn', (CONN_LABEL[kind] || CONN_LABEL.offline) + ' · ' + kind);
  }

  function setTrace(trace) {
    if (!trace) {
      traceEl.textContent = '还没有发过话。';
      return;
    }
    var text;
    try {
      text = JSON.stringify(trace, null, 2);
    } catch (err) {
      text = String(trace);
    }
    if (text.length > TRACE_LIMIT) {
      text = text.slice(0, TRACE_LIMIT) + '\n…已截断（原始 ' + text.length + ' 字符）';
    }
    traceEl.textContent = text;
  }

  // ---------------- 提示条 ----------------

  function refreshNotice() {
    var text = '';
    if (state.configError) {
      text = '沙箱未启动：' + state.configError + '。先运行 pnpm sandbox，再刷新页面或点「重试连接」。';
    } else if (state.streamError) {
      text = state.streamError;
    } else if (state.sayError) {
      text = state.sayError;
    }
    if (text) {
      noticeTextEl.textContent = text;
      noticeEl.hidden = false;
    } else {
      noticeTextEl.textContent = '';
      noticeEl.hidden = true;
    }
  }

  // ---------------- 设备舞台状态机 ----------------

  function currentStage() {
    if (state.listening) return 'listening';
    if (state.busy) return 'thinking';
    if (state.speaking) return 'speaking';
    return 'idle';
  }

  function setStage() {
    var stage = currentStage();
    orbEl.dataset.state = stage;
    orbEl.setAttribute('aria-pressed', String(stage === 'listening'));

    var micOk = micAvailable();
    orbEl.dataset.unavailable = String(!micOk);
    orbEl.setAttribute(
      'aria-label',
      micOk
        ? stage === 'listening'
          ? '麦克风：正在聆听，点一下停止'
          : '麦克风：点一下开始说话'
        : '麦克风不可用：' + micNotice()
    );

    stageStateEl.textContent = STAGE_LABEL[stage];

    var hint;
    var tone = '';
    if (!micOk) {
      hint = micNotice();
      tone = 'warn';
    } else if (!ttsSupported) {
      hint = '当前浏览器不支持语音播报，只看文字。';
      tone = 'warn';
    } else if (stage === 'thinking') {
      hint = '沙箱在理解这句话，等播报回来。';
    } else if (stage === 'listening') {
      hint = '正在听，说完自动发送；再点一次圆环可以提前结束。';
    } else if (stage === 'speaking') {
      hint = '正在播报，想再听一遍就点「重播」。';
    } else {
      hint = '点圆环说话，或直接在下面打字；Enter 发送。';
    }
    stageHintEl.textContent = hint;
    if (tone) stageHintEl.dataset.tone = tone;
    else stageHintEl.removeAttribute('data-tone');
  }

  // ---------------- 语音播报 ----------------

  function pickZhVoice() {
    if (!synth || typeof synth.getVoices !== 'function') return null;
    var voices;
    try {
      voices = synth.getVoices();
    } catch (err) {
      return null;
    }
    if (!voices || !voices.length) return null;
    var i;
    for (i = 0; i < voices.length; i++) {
      if (voices[i] && /^zh/i.test(voices[i].lang || '')) return voices[i];
    }
    for (i = 0; i < voices.length; i++) {
      if (voices[i] && /zh|Chinese|中文/i.test((voices[i].lang || '') + ' ' + (voices[i].name || ''))) {
        return voices[i];
      }
    }
    return null;
  }

  function stopSpeaking() {
    if (speakTimer) {
      window.clearTimeout(speakTimer);
      speakTimer = 0;
    }
    if (synth) {
      try {
        synth.cancel();
      } catch (err) {
        /* 部分浏览器在没有播报时 cancel 会抛错，忽略 */
      }
    }
    state.speaking = false;
    setStage();
  }

  function speak(text, force) {
    if (!ttsSupported || !text) return;
    if (!force && !ttsOn) return;
    if (synth) {
      try {
        synth.cancel();
      } catch (err) {
        /* 忽略 */
      }
    }
    var utter;
    try {
      utter = new window.SpeechSynthesisUtterance(text);
    } catch (err) {
      return;
    }
    utter.lang = state.lang || DEFAULT_LANG;
    utter.rate = TTS_RATE;
    utter.pitch = 1;
    var voice = pickZhVoice();
    if (voice) utter.voice = voice;
    utter.onstart = function () {
      state.speaking = true;
      setStage();
    };
    utter.onend = function () {
      state.speaking = false;
      if (speakTimer) {
        window.clearTimeout(speakTimer);
        speakTimer = 0;
      }
      setStage();
    };
    utter.onerror = function () {
      state.speaking = false;
      if (speakTimer) {
        window.clearTimeout(speakTimer);
        speakTimer = 0;
      }
      setStage();
    };
    state.speaking = true;
    setStage();
    if (speakTimer) window.clearTimeout(speakTimer);
    // 兜底：某些浏览器不回调 onend，按字数估一个上限把状态收回来
    speakTimer = window.setTimeout(function () {
      speakTimer = 0;
      state.speaking = false;
      setStage();
    }, Math.min(60000, 4000 + String(text).length * 240));
    try {
      synth.speak(utter);
    } catch (err) {
      state.speaking = false;
      setStage();
    }
  }

  // ---------------- 语音识别 ----------------

  function stopRecognition() {
    if (recognition) {
      try {
        recognition.stop();
      } catch (err) {
        /* 忽略 */
      }
    }
  }

  function startRecognition() {
    if (!micAvailable()) {
      toast(micNotice());
      return;
    }
    if (state.busy) {
      toast('沙箱还在思考，等播报回来再说。');
      return;
    }
    stopSpeaking();
    try {
      recognition = new SpeechRecognitionCtor();
    } catch (err) {
      toast('语音识别启动失败，先用文字。');
      return;
    }
    recognition.lang = state.lang || DEFAULT_LANG;
    recognition.interimResults = true;
    recognition.continuous = false;
    recognition.maxAlternatives = 1;
    recognitionError = false;

    recognition.onstart = function () {
      state.listening = true;
      setStage();
    };

    recognition.onresult = function (event) {
      var text = '';
      var results = event && event.results ? event.results : [];
      for (var i = 0; i < results.length; i++) {
        var alt = results[i] && results[i][0];
        if (alt && alt.transcript) text += alt.transcript;
      }
      inputEl.value = text.slice(0, 200);
      autoGrow();
    };

    recognition.onerror = function (event) {
      recognitionError = true;
      state.listening = false;
      setStage();
      var code = event && event.error ? String(event.error) : '';
      if (code === 'aborted') return;
      if (code === 'no-speech') toast('没听到声音，再说一次。');
      else if (code === 'not-allowed' || code === 'service-not-allowed') {
        toast('浏览器没有授权麦克风，先用文字。');
      } else if (code === 'network') {
        toast('语音识别服务连不上（内网常见），先用文字。');
      } else {
        toast('语音识别出错了，先用文字。');
      }
    };

    recognition.onend = function () {
      state.listening = false;
      setStage();
      var text = trim(inputEl.value);
      if (!recognitionError && autoSendOn && text && !state.busy) sendCurrent();
    };

    try {
      recognition.start();
      state.listening = true;
      setStage();
    } catch (err) {
      state.listening = false;
      setStage();
      toast('语音识别启动失败，先用文字。');
    }
  }

  function toggleListening() {
    if (!micAvailable()) {
      toast(micNotice());
      return;
    }
    if (state.listening) stopRecognition();
    else startRecognition();
  }

  // ---------------- 输入与请求 ----------------

  function autoGrow() {
    var max = 140;
    inputEl.style.height = 'auto';
    var next = Math.min(max, Math.max(44, inputEl.scrollHeight));
    inputEl.style.height = next + 'px';
    inputEl.style.overflowY = inputEl.scrollHeight > max ? 'auto' : 'hidden';
  }

  function fillInput(text) {
    inputEl.value = text;
    autoGrow();
    try {
      inputEl.focus();
      inputEl.setSelectionRange(text.length, text.length);
    } catch (err) {
      /* 忽略 */
    }
  }

  function setBusy(busy) {
    state.busy = !!busy;
    sendEl.disabled = state.busy;
    sendEl.textContent = state.busy ? '思考中' : '发送';
    if (state.busy) composerEl.classList.add('is-busy');
    else composerEl.classList.remove('is-busy');
    composerEl.setAttribute('aria-busy', String(state.busy));
  }

  /**
   * 页面里唯一允许调用 /api/say 的入口。
   * 不抛异常：网络失败、非 200、非 JSON 都折成一条能播报的 reply。
   */
  function postSay(text) {
    var startedAt = Date.now();
    return fetch('/api/say', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId: state.identity.deviceId, text: text })
    })
      .then(function (res) {
        return res.text().then(function (raw) {
          var data = null;
          if (raw) {
            try {
              data = JSON.parse(raw);
            } catch (err) {
              data = null;
            }
          }
          if (data && typeof data.reply === 'string') {
            data.__status = res.status;
            return data;
          }
          if (!res.ok) {
            return {
              ok: false,
              reply: '沙箱接口返回 HTTP ' + res.status + '，先看看 pnpm sandbox 的输出。',
              error: 'sandbox_http_' + res.status
            };
          }
          return {
            ok: false,
            reply: '沙箱返回了无法解析的响应，再试一次。',
            error: 'bad_response'
          };
        });
      })
      .catch(function () {
        return {
          ok: false,
          reply: '连不上沙箱（8100 端口）。先把沙箱启起来，再说一遍。',
          error: 'sandbox_unreachable'
        };
      })
      .then(function (data) {
        data.__ms = Date.now() - startedAt;
        return data;
      });
  }

  function replyMeta(data) {
    var bits = [];
    bits.push(data.ok === false ? 'ok:false' : data.isError ? 'isError' : data.tool || 'game_say');
    if (typeof data.__ms === 'number') bits.push(data.__ms + 'ms');
    if (data.error) bits.push(String(data.error));
    return bits.join(' · ');
  }

  function handleReply(data) {
    var failed = data.ok === false;
    var reply = typeof data.reply === 'string' ? trim(data.reply) : '';
    if (!reply) reply = failed ? '沙箱这次没给播报内容，再试一次。' : '（沙箱返回了空播报）';

    state.lastReply = reply;
    replyTextEl.textContent = reply;
    replyCardEl.dataset.tone = failed ? 'warn' : 'ok';
    replyMetaEl.textContent = replyMeta(data);
    replayEl.disabled = false;

    state.sayError = failed ? reply : '';
    refreshNotice();

    // 立即用这次返回的局面刷新，SSE 随后会推更新的一份
    if (data.state && typeof data.state === 'object') {
      if (Object.prototype.hasOwnProperty.call(data.state, 'battle')) {
        applyBattle(data.state.battle);
      }
    }
    setTrace(data.trace);
    speak(reply);
  }

  /** 兜底：哪怕渲染环节出 bug，也不能让「思考中」把按钮卡死 */
  function safeHandleReply(data) {
    try {
      handleReply(data);
    } catch (err) {
      state.lastReply = '';
      replyTextEl.textContent = '页面处理回复时出错：' + describeError(err);
      replyCardEl.dataset.tone = 'warn';
      replyMetaEl.textContent = 'page_error';
      replayEl.disabled = true;
      replayEl.title = '没有可重播的播报';
    }
  }

  function sendCurrent() {
    var text = trim(inputEl.value);
    if (!text) {
      inputEl.focus();
      return;
    }
    if (state.busy) return;

    // 先清空，发送期间可以接着打下一句
    inputEl.value = '';
    autoGrow();
    if (recognitionError) recognitionError = false;

    setBusy(true);
    setStage();

    postSay(text).then(
      function (data) {
        safeHandleReply(data);
      },
      function (err) {
        safeHandleReply({
          ok: false,
          reply: '页面处理回复时出错：' + describeError(err),
          error: 'page_error'
        });
      }
    ).then(function () {
      setBusy(false);
      setStage();
    });
  }

  // ---------------- 只读局面渲染 ----------------

  function phaseBadgeInfo(battle) {
    // 服务端明确告知对手还没进来；这时说「你的回合」会让人以为可以出招
    if (battle.waiting === true) return { text: '等对手加入', tone: 'wait' };
    if (battle.phase && battle.phase !== 'battle') return { text: '对局结束', tone: 'wait' };
    var pending = battle.pending;
    if (pending && pending.actor === 'enemy') return { text: '等你应对', tone: 'alert' };
    if (pending && pending.actor === 'player') return { text: '等对手应对', tone: 'wait' };
    if (battle.active === 'enemy') return { text: '对手行动中', tone: 'enemy' };
    if (battle.active === 'player') return { text: '你的回合', tone: 'you' };
    return { text: '观看中', tone: 'wait' };
  }

  function chipButton(word, extraClass) {
    var chip = make('button', 'chip' + (extraClass ? ' ' + extraClass : ''), word);
    chip.type = 'button';
    chip.setAttribute('aria-label', '把「' + word + '」填进输入框');
    chip.addEventListener('click', function () {
      fillInput(word);
    });
    return chip;
  }

  function renderHead(battle) {
    var head = make('div', 'board-head');

    if (battle.mode === 'pvp' && battle.room) {
      var room = String(battle.room);
      var pill = make('div', 'room-pill');
      pill.appendChild(make('span', 'room-label', '房间'));
      pill.appendChild(make('span', 'room-code', room));
      var copyBtn = make('button', 'btn btn-mini room-copy', '复制');
      copyBtn.type = 'button';
      copyBtn.setAttribute('aria-label', '复制邀请语：加入房间' + room);
      copyBtn.addEventListener('click', function () {
        copyText('加入房间' + room);
      });
      pill.appendChild(copyBtn);
      head.appendChild(pill);
    }

    head.appendChild(make('span', 'round-pill', '第 ' + num(battle.round, 1) + ' 轮'));

    var info = phaseBadgeInfo(battle);
    var badge = make('span', 'phase-badge', info.text);
    badge.dataset.tone = info.tone;
    head.appendChild(badge);

    return head;
  }

  function fighterCard(role, data, isYou) {
    var side = data && typeof data === 'object' ? data : {};
    var card = make('div', 'fighter ' + (isYou ? 'fighter--you' : 'fighter--opponent'));
    var who = isYou ? '你' : '对手';

    card.appendChild(make('div', 'fighter-name', side.name || who));

    var hp = Math.max(0, num(side.hp, 0));
    var maxHp = Math.max(1, num(side.maxHp, 1));
    var row = make('div', 'hp-row');
    row.appendChild(make('span', null, '气血'));
    row.appendChild(make('span', 'hp-num', hp + '/' + maxHp));
    card.appendChild(row);

    var bar = make('div', 'hp-bar');
    var fill = make('div', 'hp-fill');
    var pct = clamp(Math.round((hp / maxHp) * 100), 0, 100);
    fill.style.width = pct + '%';
    fill.dataset.low = String(pct <= 30);
    bar.appendChild(fill);
    bar.setAttribute('role', 'img');
    bar.setAttribute('aria-label', (side.name || who) + '的气血 ' + hp + ' / ' + maxHp);
    card.appendChild(bar);

    var meta = make('div', 'meta-row');
    meta.appendChild(make('span', null, '真气'));
    var ap = clamp(num(side.ap, 0), 0, 99);
    var maxAp = clamp(num(side.maxAp, 0), 0, 20);
    var dots = make('span', 'ap-dots');
    for (var i = 0; i < maxAp; i++) {
      var dot = make('i', 'ap-dot');
      dot.dataset.on = String(i < ap);
      dots.appendChild(dot);
    }
    meta.appendChild(dots);
    meta.appendChild(make('span', null, ap + '/' + maxAp));

    var ultLeft = clamp(num(side.ultLeft, 0), 0, 9);
    var ult = make('span', 'ult', ultLeft > 0 ? repeat('★', ultLeft) : '☆');
    ult.dataset.empty = String(ultLeft === 0);
    ult.title = '大招剩余 ' + ultLeft + ' 次';
    meta.appendChild(ult);

    card.appendChild(meta);
    return card;
  }

  function pendingBanner(battle) {
    var pending = battle.pending;
    if (!pending || pending.actor !== 'enemy') return null;

    var label = pending.moveLabel || '攻击';
    var damage = num(pending.damage, 0);

    var box = make('div', 'banner banner--pending');
    box.appendChild(make('div', 'banner-title', '对手的一记' + label + '已锁定（伤害 ' + damage + '）'));
    box.appendChild(
      make('p', 'banner-sub', '格挡减伤、闪避躲开、承受硬扛。下面的词只会填进输入框，按发送才算说出口。')
    );

    var actions = make('div', 'banner-actions');
    var words = ['格挡', '闪避', '承受'];
    for (var i = 0; i < words.length; i++) actions.appendChild(chipButton(words[i], 'chip--alert'));
    box.appendChild(actions);

    return box;
  }

  function resultBanner(battle) {
    if (!battle.phase || battle.phase === 'battle') return null;
    var win = battle.winner ? battle.winner === 'player' : battle.phase === 'victory';
    var box = make('div', 'banner banner--result');
    box.dataset.win = String(win);
    box.appendChild(make('div', 'banner-title', win ? '这局你赢了' : '这局你输了'));
    box.appendChild(
      make(
        'p',
        'banner-sub',
        win
          ? '对手的气血见底了。说「开始游戏」再来一局。'
          : '气血耗尽了。说「开始游戏」再来一局，换个打法试试。'
      )
    );
    return box;
  }

  /**
   * 双人房间等对手加入：服务端在快照里给 `waiting`，
   * 这里不再按「第 1 轮 + 没战报」去猜（对手进来后那套推断会一直成立）。
   */
  function waitingForOpponentBanner(battle) {
    if (battle.waiting !== true) return null;

    var box = make('div', 'banner banner--notice');
    box.appendChild(make('div', 'banner-title', '房间已开好，把房间号告诉另一个窗口'));
    box.appendChild(
      make(
        'p',
        'banner-sub',
        '在另一个窗口说「加入房间' + String(battle.room) + '」，或者点上面的复制按钮。对手进来之前，局面不会变化。'
      )
    );
    return box;
  }

  function historyBlock(battle) {
    var wrap = make('div', 'history');
    wrap.appendChild(make('div', 'history-title', '战报 · 最近 ' + HISTORY_LIMIT + ' 条'));

    var list = Array.isArray(battle.history) ? battle.history.slice(-HISTORY_LIMIT) : [];
    if (!list.length) {
      wrap.appendChild(make('div', 'history-empty', '还没有战报，说一招试试。'));
      return wrap;
    }

    for (var i = 0; i < list.length; i++) {
      var item = list[i];
      if (!item || typeof item !== 'object') continue;
      var row = make('div', 'history-row');
      row.appendChild(make('span', 'history-round', '第' + num(item.round, 0) + '轮'));
      row.appendChild(make('span', 'history-sep', '·'));

      var actor = ACTOR_LABEL[item.actor] || '对方';
      var defender = item.actor === 'enemy' ? '你' : '对手';
      row.appendChild(make('span', 'history-act', actor + ' ' + (item.actionLabel || item.action || '出招')));
      row.appendChild(make('span', 'history-sep', '·'));

      if (item.dodged) row.appendChild(make('span', 'history-act', defender + '闪开'));
      else if (item.responseLabel || item.response) {
        row.appendChild(make('span', 'history-act', defender + ' ' + (item.responseLabel || item.response)));
      }

      var damage = num(item.damage, 0);
      if (damage > 0) {
        row.appendChild(make('span', 'history-sep', '·'));
        row.appendChild(make('span', 'history-dmg', '-' + damage));
      }
      if (item.crit) row.appendChild(make('span', 'history-crit', '暴击'));

      wrap.appendChild(row);
    }
    return wrap;
  }

  function waitingBoard() {
    var box = make('div', 'board-empty');
    if (state.configError) {
      box.appendChild(make('div', 'board-empty-title', '沙箱未启动'));
      box.appendChild(
        make('p', 'board-empty-text', '连不上沙箱接口（' + state.configError + '）。先在终端跑 pnpm sandbox，然后刷新本页。')
      );
      var retry = make('button', 'btn btn-mini', '重试连接');
      retry.type = 'button';
      retry.addEventListener('click', reconnectAll);
      box.appendChild(retry);
      box.appendChild(make('p', 'board-empty-text board-empty-dim', '页面在接口不通时也能打开，只是拿不到局面。'));
      return box;
    }
    box.appendChild(make('div', 'board-empty-title', '正在等局面'));
    box.appendChild(make('p', 'board-empty-text', '沙箱已连上，等游戏服务推第一份局面过来。'));
    return box;
  }

  function emptyBoard() {
    var box = make('div', 'board-empty');
    box.appendChild(make('div', 'board-empty-title', '还没有开局'));
    box.appendChild(
      make('p', 'board-empty-text', '说「开始游戏」单挑 AI，或者说「开房间」拉另一个窗口进来对打。')
    );

    var row = make('div', 'chips');
    var words = ['开始游戏', '开房间', '说明'];
    for (var i = 0; i < words.length; i++) row.appendChild(chipButton(words[i]));
    box.appendChild(row);

    box.appendChild(make('p', 'board-empty-text board-empty-dim', '局面由游戏服务推送，这里只读展示。'));
    return box;
  }

  function renderBoard() {
    boardBodyEl.textContent = '';

    if (state.battle === undefined) {
      boardBodyEl.appendChild(waitingBoard());
      syncChips(undefined);
      return;
    }
    if (state.battle === null || typeof state.battle !== 'object') {
      boardBodyEl.appendChild(emptyBoard());
      syncChips(null);
      return;
    }

    var battle = state.battle;
    boardBodyEl.appendChild(renderHead(battle));

    var fighters = make('div', 'fighters');
    fighters.appendChild(fighterCard('you', battle.you, true));
    fighters.appendChild(fighterCard('opponent', battle.opponent, false));
    boardBodyEl.appendChild(fighters);

    var banner = pendingBanner(battle) || resultBanner(battle) || waitingForOpponentBanner(battle);
    if (banner) boardBodyEl.appendChild(banner);

    boardBodyEl.appendChild(historyBlock(battle));
    syncChips(battle);
  }

  function applyBattle(battle) {
    state.battle = battle === undefined ? null : battle;
    renderBoard();
  }

  /** 主输入区的快捷词会随局面变化；它们只填输入框，不发送。 */
  function syncChips(battle) {
    chipsEl.textContent = '';
    var words;
    if (battle === undefined || battle === null) {
      words = ['开始游戏', '开房间', '说明'];
    } else if (battle.phase && battle.phase !== 'battle') {
      words = ['开始游戏', '战况如何', '说明'];
    } else if (battle.pending && battle.pending.actor === 'enemy') {
      words = ['格挡', '闪避', '承受'];
    } else if (battle.pending && battle.pending.actor === 'player') {
      words = ['战况如何', '说明'];
    } else {
      words = ['普攻', '强攻', '蓄力', '大招', '战况如何'];
    }
    for (var i = 0; i < words.length; i++) chipsEl.appendChild(chipButton(words[i]));
  }

  // ---------------- 配置与状态流 ----------------

  function closeStream() {
    if (!state.es) return;
    try {
      state.es.close();
    } catch (err) {
      /* 忽略 */
    }
    state.es = null;
  }

  function loadConfig() {
    state.configError = '';
    refreshNotice();
    return fetchJson('/api/config')
      .then(function (data) {
        if (!data || data.ok === false) throw new Error('config 返回异常');
        state.config = data;
        state.lang = data.voice && data.voice.lang ? String(data.voice.lang) : DEFAULT_LANG;
        dbg('sandbox', (data.sandbox || 'linx-sandbox') + ' ' + (data.version || ''));
        dbg('upstream', data.upstream);
        dbg('events', data.eventsUrl);
        dbg('agent', data.agentId);
        state.configError = '';
        refreshNotice();
        return data;
      })
      .catch(function (err) {
        state.config = null;
        state.configError = describeError(err);
        setConn('offline');
        renderBoard();
        refreshNotice();
        return null;
      });
  }

  function connectStream() {
    closeStream();
    var config = state.config;
    if (!config) return;
    state.streamError = '';
    refreshNotice();

    if (!config.eventsUrl) {
      state.streamError = 'config 里没有 eventsUrl，局面不会自动刷新。';
      setConn('offline');
      refreshNotice();
      renderBoard();
      return;
    }

    var url =
      config.eventsUrl +
      (config.eventsUrl.indexOf('?') >= 0 ? '&' : '?') +
      'device=' +
      encodeURIComponent(state.identity.deviceId) +
      '&agent=' +
      encodeURIComponent(config.agentId || '');
    dbg('events', url);

    var source;
    try {
      source = new window.EventSource(url);
    } catch (err) {
      state.streamError = '状态流地址不可用：' + describeError(err);
      setConn('offline');
      refreshNotice();
      return;
    }

    state.es = source;
    setConn('connecting');
    renderBoard();

    source.onopen = function () {
      if (state.es !== source) return;
      // revision 每条连接内自增，重连后从头开始，所以要重置
      state.revision = -1;
      state.streamError = '';
      setConn('connected');
      refreshNotice();
      renderBoard();
    };

    source.onerror = function () {
      if (state.es !== source) return;
      // EventSource 自带重连，这里只反映状态，不重建连接
      if (source.readyState === 2) {
        state.streamError = '状态流连接已断开，局面不会自动刷新。点「重试连接」重新订阅。';
        setConn('offline');
        refreshNotice();
      } else {
        setConn('reconnecting');
      }
    };

    source.addEventListener('state', function (event) {
      if (state.es !== source) return;
      var data = null;
      try {
        data = JSON.parse(event.data);
      } catch (err) {
        return;
      }
      if (!data || typeof data !== 'object') return;

      var revision = num(data.revision, NaN);
      if (isFinite(revision)) {
        if (revision <= state.revision) return; // 丢弃乱序的旧快照
        state.revision = revision;
        dbg('revision', String(revision));
      }

      state.streamError = '';
      if (state.conn !== 'connected') setConn('connected');
      applyBattle(data.battle);
    });
  }

  function reconnectAll() {
    closeStream();
    state.streamError = '';
    state.sayError = '';
    setConn('offline');
    refreshNotice();
    renderBoard();
    loadConfig().then(function (config) {
      if (config) connectStream();
    });
  }

  // ---------------- 调试面板 ----------------

  function loadTools() {
    if (state.toolsState === 'ready' || state.toolsState === 'loading') return;
    state.toolsState = 'loading';
    toolsEl.textContent = '加载中…';
    fetchJson('/api/tools')
      .then(function (data) {
        var tools = data && Array.isArray(data.tools) ? data.tools : [];
        var names = [];
        for (var i = 0; i < tools.length; i++) {
          var tool = tools[i];
          if (tool && tool.name) names.push(String(tool.name));
        }
        state.toolsState = 'ready';
        toolsEl.textContent = names.length ? names.join('\n') : '接口没有返回工具。';
      })
      .catch(function (err) {
        state.toolsState = 'failed';
        toolsEl.textContent = '工具列表取不到（' + describeError(err) + '），不影响使用。';
      });
  }

  // ---------------- 事件绑定 ----------------

  function bindEvents() {
    // 发送：Enter 发送，Shift+Enter 换行（输入法组字时不误发）
    composerEl.addEventListener('submit', function (event) {
      event.preventDefault();
      sendCurrent();
    });

    inputEl.addEventListener('keydown', function (event) {
      if (event.key !== 'Enter' || event.shiftKey || event.isComposing || event.keyCode === 229) return;
      event.preventDefault();
      sendCurrent();
    });

    inputEl.addEventListener('input', autoGrow);

    orbEl.addEventListener('click', toggleListening);

    replayEl.addEventListener('click', function () {
      if (!state.lastReply) return;
      if (!ttsSupported) {
        toast('当前浏览器不支持语音播报');
        return;
      }
      speak(state.lastReply, true);
    });

    autoSendEl.addEventListener('change', function () {
      autoSendOn = !!autoSendEl.checked;
      writeBool(STORE_AUTOSEND, autoSendOn);
    });

    ttsEl.addEventListener('change', function () {
      ttsOn = !!ttsEl.checked;
      writeBool(STORE_TTS, ttsOn);
      if (!ttsOn) stopSpeaking();
    });

    noticeRetryEl.addEventListener('click', reconnectAll);

    debugEl.addEventListener('toggle', function () {
      if (debugEl.open) loadTools();
    });

    var copyButtons = document.querySelectorAll('.dbg-copy[data-copy]');
    for (var i = 0; i < copyButtons.length; i++) {
      (function (button) {
        button.addEventListener('click', function () {
          var target = $(button.getAttribute('data-copy'));
          copyText(target ? target.textContent : '');
        });
      })(copyButtons[i]);
    }

    window.addEventListener('beforeunload', function () {
      closeStream();
      if (synth) {
        try {
          synth.cancel();
        } catch (err) {
          /* 忽略 */
        }
      }
    });
  }

  function setupSwitches() {
    autoSendEl.checked = autoSendOn;
    ttsEl.checked = ttsSupported ? ttsOn : false;
    if (!ttsSupported) {
      ttsEl.disabled = true;
      ttsEl.checked = false;
      if (ttsSwitchEl) ttsSwitchEl.title = '当前浏览器不支持语音播报';
      ttsOn = false;
    }
  }

  function setupIdentity() {
    var identity = resolveIdentity();
    state.identity = identity;

    badgeEl.textContent = identity.fromParam ? identity.label : identity.deviceId.slice(-4);
    badgeEl.title = '设备 ID：' + identity.deviceId;
    dbg('device', identity.deviceId);
    dbg('agent', '（等 config）');

    var nextSlot = identity.slot + 1;
    if (nextSlot > SLOT_MAX) {
      newWindowEl.disabled = true;
      newWindowEl.title = '最多 4 个窗口，要更多请手动带 ?player= 打开';
      newWindowEl.setAttribute('aria-label', '已经开到第 4 个窗口');
      return;
    }
    newWindowEl.addEventListener('click', function () {
      window.open('/?player=' + nextSlot, '_blank', 'noopener');
    });
    newWindowEl.title = '新开一个窗口，玩家 ' + nextSlot;
    newWindowEl.setAttribute('aria-label', '在新窗口打开玩家 ' + nextSlot);
  }

  function boot() {
    setupIdentity();
    setupSwitches();
    bindEvents();

    setConn('offline');
    dbg('sandbox', '（等 config）');
    dbg('upstream', '（等 config）');
    dbg('events', '（等 config）');
    dbg('revision', '—');
    setStage();
    autoGrow();
    syncChips(undefined);
    renderBoard();
    refreshNotice();

    loadConfig().then(function (config) {
      if (config) connectStream();
    });
  }

  boot();
})();
