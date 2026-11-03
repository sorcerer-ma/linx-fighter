import { wantsWait, runWaitLoop } from './wait-loop.js?v=20261101c';
import { BackendRecognition } from './backend-recognition.js?v=20261101c';
import { backendPlayback } from './playback.js?v=20261101c';
import { diagnosticText } from './speech-diagnostic.js?v=20261101c';
import { createConversation } from './conversation.js?v=20261101c';
import { createListeningSession } from './listening.js?v=20261101c';
import { companionView, newSettlement, renderCompanion, resourceRows } from './companion.js?v=20261101c';
import { parseRoomParam, joinCommand, inviteLink, stripRoomParam, lobbyRooms, pageMode } from './lobby.js?v=20261101c';
import { actionBarView } from './actions.js?v=20261101c';

/*
 * 共鸣 · 闻声对决 —— 沙箱页面脚本（极简游戏画面版）
 *
 * 页面只负责「看局面 + 说话」，不持有任何对局事实：
 *  1. 身份：?player=1 → web-1；否则 sessionStorage；否则随机 web-xxxx。
 *  2. 输入：唯一路径 POST /api/say，body { deviceId, text }。
 *  3. 局面：GET /api/config 拿 eventsUrl → EventSource 监听 state 事件，revision 单调丢弃。
 *  4. 语音：按配置选后台或浏览器识别，partial 只展示，final 单次发送；最终话术分段播放。
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

  var BrowserRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

  // listener 在配置之前创建；每次开始收音时才按已加载配置选择真正的识别器。
  function recognitionConstructor() {
    if (!config || !config.voice) return null;
    if (config.voice.asr === 'doubao') return BackendRecognition;
    if (config.voice.asr === 'browser') return BrowserRecognition;
    return null;
  }
  function ConfiguredRecognition() {
    const Recognition = recognitionConstructor();
    if (!Recognition) throw new Error('asr_not_configured');
    return new Recognition();
  }

  /* ---------------- DOM ---------------- */

  function $(id) {
    return document.getElementById(id);
  }

  var el = {
    round: $('round'),
    dot: $('dot'),
    replies: $('replies'),
    conversationScroll: $('conversation-scroll'),
    composer: $('composer'),
    text: $('text'),
    send: $('send'),
    mic: $('mic'),
    keyboard: $('keyboard'),
    speechProfile: $('speech-profile'),
    // 大厅
    lobby: $('lobby'),
    lobbySummary: $('lobby-summary'),
    openRoom: $('open-room'),
    soloPractice: $('solo-practice'),
    joinForm: $('join-form'),
    roomCode: $('room-code'),
    joinRoom: $('join-room'),
    roomList: $('room-list'),
    roomListWrap: $('room-list-wrap'),
    roomEmpty: $('room-empty'),
    // 等待房
    roomCard: $('room-card'),
    roomCodeLabel: $('room-code-label'),
    roomState: $('room-state'),
    copyInvite: $('copy-invite'),
    cancelRoom: $('cancel-room'),
    copyStatus: $('copy-status'),
    // 出招按钮
    battleActions: $('battle-actions'),
    actionButtons: $('action-buttons'),
    actionUtility: $('action-utility')
  };

  /* ---------------- 状态 ---------------- */

  var deviceId = resolveDeviceId();
  var state = {
    battle: null, // 服务端快照，null 表示还没有对局
    revision: -2
  };
  var config = null;
  var selectedSpeechProfile = null;
  var speechProfiles = [];
  var speechSource = 'legacy';
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
  var cloudPlayback = null;
  var notificationRequest = null;
  var notificationPlaying = false;
  var queuedNotification = null;
  var seenPushIds = [];
  var playerSpeaking = false;
  var PUSH_KINDS = ['opponent-move', 'opponent-joined', 'ult-ready', 'idle-turn', 'idle-respond', 'wait-opponent', 'wait-guest'];
  var activeReplyBattleId = null;

  // 大厅只看房、不参与裁决：没有对局且页面可见时才轮询，且同一时间最多一个请求。
  var LOBBY_POLL_MS = 3000;
  var lobby = { payload: null, loading: false, fetchedAt: 0, timer: null, request: null };
  var lobbySignature = '';
  var currentMode = 'lobby';
  var actionSignature = '';
  var actionButtons = [];
  // 邀请链接只在首次「没有对局也没有房间」的快照后自动加入一次，避免换掉已有对局。
  var invite = { code: parseRoomParam(window.location.search), running: false, done: false };

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
        loadSpeechProfiles(data);
        connectStream(data);
      })
      .catch(function () {
        // 沙箱没起来：保持页面可用，只提示一句
        setConn('offline');
        pushReply('连不上沙箱，先启动 pnpm sandbox。', 'warn');
      });
  }

  function loadSpeechProfiles(data) {
    const expected = ['cancan', 'qingcang', 'tiancai'];
    const profiles = data.speechProfiles;
    if (!Array.isArray(profiles) || profiles.length !== expected.length ||
        expected.some(id => profiles.filter(profile => profile.id === id && typeof profile.name === 'string').length !== 1) ||
        !expected.includes(data.defaultSpeechProfile)) {
      el.speechProfile.disabled = true;
      el.speechProfile.title = '精灵配置不完整';
      return;
    }
    speechProfiles = profiles;
    const options = profiles.map(profile => {
      const option = document.createElement('option');
      option.value = profile.id;
      option.textContent = profile.name;
      return option;
    });
    el.speechProfile.replaceChildren(...options);
    selectedSpeechProfile = data.defaultSpeechProfile;
    el.speechProfile.value = selectedSpeechProfile;
    el.speechProfile.disabled = false;
    el.speechProfile.title = '';
    // 首帧状态可能先于配置到达；配置就绪后再补一次邀请链接自动加入。
    maybeJoinInvite();
  }

  function changeSpeechProfile() {
    const next = el.speechProfile.value;
    if (!speechProfiles.some(profile => profile.id === next)) {
      el.speechProfile.value = selectedSpeechProfile || '';
      return;
    }
    if (next === selectedSpeechProfile) return;
    // 丢弃切换前的 partial；保持用户启用意图，再为新 profile 接续收音。
    listener.pause();
    cancelTurn();
    selectedSpeechProfile = next;
    if (!busy && el.composer.hidden) listener.resume();
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
    source.addEventListener('push', onPushEvent);
  }

  function onStateEvent(event) {
    var payload;
    try {
      payload = JSON.parse(event.data);
    } catch (err) {
      return;
    }
    const freshRevision = typeof payload.revision === 'number' && payload.revision > state.revision;
    if (typeof payload.revision === 'number') {
      if (payload.revision <= state.revision) return; // 丢弃乱序/重复
      state.revision = payload.revision;
    }
    // 通知只对应签发时的局面；同局新结算也会使旧应对提示失效。
    if (freshRevision || (state.battle && payload.battle && state.battle.phase !== payload.battle.phase)) cancelNotifications();
    const nextBattleId = payload.battle && payload.battle.battleId;
    if (state.battle && state.battle.battleId !== nextBattleId) cancelNotifications();
    if ((waitAbort && state.battle && state.battle.battleId && nextBattleId !== state.battle.battleId) ||
        ((activeUtterance || cloudPlayback) && activeReplyBattleId && nextBattleId !== activeReplyBattleId)) cancelTurn();
    unconfirmed = false;
    applyBattle(payload.battle);
    invite.synced = true;
    maybeJoinInvite();
    resumeListeningIfIdle();
  }

  /* ---------------- 发送 ---------------- */

  // 同一输入代次串行续等；新输入、停止或离开页面使旧等待链失效。
  function resumeListeningIfIdle() {
    if (listener && listener.enabled && !document.hidden && !busy && !activeUtterance && !cloudPlayback && el.composer.hidden) listener.resume();
  }

  function cancelTurn() {
    turnSequence += 1;
    cancelNotifications();
    if (waitAbort) waitAbort.abort();
    waitAbort = null;
    stopSpeaking();
    activeReplyBattleId = null;
    return turnSequence;
  }

  function cancelNotifications() {
    queuedNotification = null;
    const active = notificationRequest;
    notificationRequest = null;
    if (active) active.abort();
    if (notificationPlaying) stopSpeaking();
    notificationPlaying = false;
  }

  function notificationIsCurrent(signal) {
    return signal.turn === turnSequence && signal.profileId === selectedSpeechProfile &&
      state.battle && state.battle.battleId === signal.battleId && !document.hidden &&
      el.composer.hidden && !playerSpeaking && Date.now() - signal.receivedAt < 10000;
  }

  function onPushEvent(event) {
    let payload;
    try { payload = JSON.parse(event.data); } catch { return; }
    if (!payload || typeof payload.id !== 'string' || !payload.id ||
        typeof payload.battleId !== 'string' || !PUSH_KINDS.includes(payload.kind) ||
        seenPushIds.includes(payload.id)) return;
    seenPushIds.push(payload.id);
    if (seenPushIds.length > 64) seenPushIds.shift();
    // 这里只读取信号，不使用服务端 payload.text 作为最终话术。
    const signal = { pushId: payload.id, battleId: payload.battleId, kind: payload.kind,
      turn: turnSequence, profileId: selectedSpeechProfile, receivedAt: Date.now() };
    if (!signal.profileId || !notificationIsCurrent(signal) || busy || waitAbort ||
        (notificationRequest && !notificationPlaying)) return;
    if (activeUtterance || cloudPlayback) {
      queuedNotification = signal; // 播放中最多保留一个最新通知，不排长队。
      return;
    }
    void requestNotification(signal);
  }

  function drainNotification() {
    const signal = queuedNotification;
    queuedNotification = null;
    if (!signal || !notificationIsCurrent(signal) || busy || waitAbort || notificationRequest ||
        activeUtterance || cloudPlayback) return;
    void requestNotification(signal);
  }

  async function requestNotification(signal) {
    if (!notificationIsCurrent(signal) || busy || waitAbort || notificationRequest) return;
    const controller = new AbortController();
    notificationRequest = controller;
    const timer = setTimeout(() => controller.abort(), SAY_TIMEOUT);
    const revision = state.revision;
    try {
      const response = await fetch('/api/notify', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ deviceId: deviceId, kind: signal.kind, battleId: signal.battleId,
          pushId: signal.pushId, profileId: signal.profileId }), signal: controller.signal
      });
      const data = await response.json();
      if (controller.signal.aborted || !notificationIsCurrent(signal) || notificationRequest !== controller) return;
      if (!response.ok || !data) throw new Error('bad notification response');
      if (data.sourceBattleId !== signal.battleId) return;
      notificationPlaying = true;
      const playback = await showOutcome(data, signal.turn, revision, signal.profileId);
      if (!['ended', 'displayed', 'silent'].includes(playback)) queuedNotification = null;
      // 通知不是玩家输入，永不由它追加 wait_event 或重发 game_say。
    } catch (error) {
      if (!controller.signal.aborted && notificationIsCurrent(signal)) {
      }
    } finally {
      clearTimeout(timer);
      if (notificationRequest === controller) {
        notificationRequest = null;
        notificationPlaying = false;
        drainNotification();
        if (!busy && !activeUtterance && !cloudPlayback && el.composer.hidden) listener.resume();
      }
    }
  }

  function showOutcome(data, turn, revision, profileId) {
    if (turn !== turnSequence || document.hidden) return Promise.resolve('cancelled');
    if (data.profileId !== undefined && data.profileId !== profileId) {
      pushReply('回复的精灵不匹配，已停止播报。', 'warn', 'system');
      return Promise.resolve('cancelled');
    }
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
    speechSource = data.speech && data.speech.source || 'legacy';
    el.replies.dataset.speechSource = speechSource;
    return speak(data.speech, data.reply, turn, profileId);
  }

  async function waitForOpponent(turn, profileId) {
    if (turn !== turnSequence || document.hidden) return;
    if (waitAbort) waitAbort.abort();
    const abort = new AbortController();
    waitAbort = abort; // Own the whole chain, including playback and gaps between requests.
    const current = () => waitAbort === abort && turn === turnSequence &&
      profileId === selectedSpeechProfile && !abort.signal.aborted && !document.hidden;
    let revision = state.revision;
    try {
      await runWaitLoop({
        isCurrent: current,
        request: async () => {
          revision = state.revision;
          const budget = Number(config && config.waitTimeoutMs) || 315000;
          const timeout = setTimeout(() => abort.abort(), budget);
          try {
            const res = await fetch('/api/wait', {
              method: 'POST', headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ deviceId, profileId }), signal: abort.signal
            });
            const data = await res.json();
            if (!res.ok || !data) throw new Error('bad wait response');
            return data;
          } finally { clearTimeout(timeout); }
        },
        present: async data => {
          const playback = await showOutcome(data, turn, revision, profileId);
          if (current() && ['ended', 'displayed'].includes(playback)) resumeListeningIfIdle();
          return playback;
        }
      });
    } catch (error) {
      if (current()) pushReply('等待连接中断，未重复执行任何行动；可以询问战况。', 'warn');
    } finally {
      if (waitAbort === abort) {
        waitAbort = null;
        drainNotification();
        if (turn === turnSequence && !busy && !activeUtterance && !cloudPlayback && el.composer.hidden) listener.resume();
      }
    }
  }

  async function say(text) {
    var value = String(text == null ? '' : text);
    if (!value.trim() || busy) return;
    if (!selectedSpeechProfile) {
      pushReply('精灵尚未就绪，请先确认配置。', 'warn', 'system');
      return;
    }
    const profileId = selectedSpeechProfile;
    const turn = cancelTurn();
    const revision = state.revision;
    busy = true;
    conversation.append('player', value);
    listener.pause();
    closeComposer();
    render();
    const abort = new AbortController();
    const abortTimer = setTimeout(function () { abort.abort(); }, SAY_TIMEOUT);
    let data;
    try {
      const res = await fetch('/api/say', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ deviceId: deviceId, text: value, profileId: profileId }), signal: abort.signal
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
      const playback = await showOutcome(data, turn, revision, profileId);
      // 播放错误、取消、超时不冒充播放完成，也不提前挂起。
      if ((playback === 'ended' || playback === 'displayed') && wantsWait(data)) {
        queuedNotification = null;
        void waitForOpponent(turn, profileId);
      }
    }
    if (turn === turnSequence) drainNotification();
    // 旧请求可以清除 busy，但不能越过新请求或音频；切换 profile 后仍接续启用意图。
    resumeListeningIfIdle();
    // 邀请链接自动加入需要据此判断加入是否成功；其他调用方忽略返回值即可。
    return data;
  }

  /* ---------------- 大厅与出招按钮 ---------------- */

  function lobbyVisible() {
    return !state.battle && document.visibilityState === 'visible';
  }

  function stopLobbyPolling() {
    if (lobby.timer) {
      clearTimeout(lobby.timer);
      lobby.timer = null;
    }
    if (lobby.request) {
      lobby.request.abort();
      lobby.request = null;
    }
  }

  function scheduleLobby(delay) {
    if (lobby.timer) clearTimeout(lobby.timer);
    lobby.timer = setTimeout(pollLobby, delay);
  }

  // 单请求轮询：上一次没落地之前不再发，页面隐藏或已进对局时立刻停。
  function pollLobby() {
    lobby.timer = null;
    if (lobby.loading || !lobbyVisible()) return;
    lobby.loading = true;
    const controller = new AbortController();
    lobby.request = controller;
    fetch('/api/lobby', { cache: 'no-store', signal: controller.signal, headers: { accept: 'application/json' } })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (data) {
        if (controller.signal.aborted) return;
        lobby.payload = data;
      })
      .catch(function () {
        // 接口还没上线或上游不可达：保留手动开房/房号加入，不让大厅白屏。
        if (controller.signal.aborted) return;
        lobby.payload = { ok: false, rooms: [] };
      })
      .then(function () {
        if (lobby.request === controller) lobby.request = null;
        lobby.loading = false;
        if (controller.signal.aborted || !lobbyVisible()) return;
        lobby.fetchedAt = Date.now();
        renderLobby();
        syncLobbyPolling();
      });
  }

  function syncLobbyPolling() {
    if (!lobbyVisible()) {
      stopLobbyPolling();
      return;
    }
    if (lobby.timer || lobby.loading) return;
    const elapsed = lobby.fetchedAt ? Date.now() - lobby.fetchedAt : LOBBY_POLL_MS;
    if (elapsed >= LOBBY_POLL_MS) pollLobby();
    else scheduleLobby(LOBBY_POLL_MS - elapsed);
  }

  function renderLobby() {
    if (currentMode !== 'lobby') return;
    const view = lobbyRooms(lobby.payload);
    const failed = Boolean(lobby.payload) && lobby.payload.ok === false;
    el.lobbySummary.textContent = failed ? '大厅暂时读不到，可以直接开一间房或用房号加入。' : '';
    el.lobbySummary.dataset.tone = failed ? 'warn' : 'normal';
    el.roomListWrap.hidden = !failed && view.rooms.length === 0;
    el.roomEmpty.hidden = true;
    el.roomEmpty.textContent = '';
    renderRoomItems(view.rooms);
    const locked = busy;
    el.openRoom.disabled = locked;
    el.soloPractice.disabled = locked;
    el.joinRoom.disabled = locked;
    el.roomCode.disabled = locked;
  }

  function renderRoomItems(rooms) {
    const signature = rooms.map(function (room) {
      return room.code + ':' + room.status + ':' + room.round;
    }).join('|') + '|' + (busy ? 'busy' : 'idle');
    if (signature === lobbySignature) return;
    lobbySignature = signature;
    el.roomList.textContent = '';
    rooms.forEach(function (room) {
      const item = document.createElement('li');
      item.className = 'room-item';
      item.dataset.status = room.status;
      const code = document.createElement('span');
      code.className = 'room-item-code';
      code.textContent = room.code;
      const meta = document.createElement('span');
      meta.className = 'room-item-meta';
      meta.textContent = room.status === 'playing' ? '第 ' + room.round + ' 轮' : '等待加入';
      item.appendChild(code);
      item.appendChild(meta);
      if (room.joinable) {
        const join = document.createElement('button');
        join.type = 'button';
        join.className = 'room-item-join';
        join.dataset.code = room.code;
        join.textContent = '加入';
        join.disabled = busy;
        item.appendChild(join);
      } else {
        const tag = document.createElement('span');
        tag.className = 'room-item-tag';
        tag.textContent = '对战中';
        item.appendChild(tag);
      }
      el.roomList.appendChild(item);
    });
  }

  function submitJoin(value) {
    const command = joinCommand(value);
    if (!command) {
      el.lobbySummary.textContent = '请输入 4 位数字房号。';
      el.lobbySummary.dataset.tone = 'warn';
      el.roomCode.focus();
      return;
    }
    el.roomCode.value = '';
    say(command);
  }

  function renderRoomCard() {
    const battle = state.battle;
    const waiting = Boolean(battle && battle.waiting && battle.room);
    el.roomCard.hidden = !waiting;
    if (!waiting) return;
    el.roomCodeLabel.textContent = String(battle.room);
    el.roomState.textContent = battle.mode === 'pvp' ? '等待对手加入' : '等待开始';
    el.copyInvite.disabled = busy;
    el.cancelRoom.disabled = busy;
  }

  function currentInviteLink() {
    const code = state.battle && state.battle.room;
    return code ? inviteLink(window.location.href, code) : '';
  }

  // 浏览器剪贴板不可用时退回临时 textarea，至少让复制按钮真的能复制。
  function fallbackCopy(text) {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.top = '-100px';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch (err) {
      ok = false;
    }
    document.body.removeChild(area);
    return ok;
  }

  function copyInviteLink() {
    const link = currentInviteLink();
    if (!link) {
      el.copyStatus.textContent = '房号还没准备好。';
      return;
    }
    const done = function (ok) {
      el.copyStatus.textContent = ok
        ? '邀请链接已复制：' + link
        : '复制失败，请长按链接手动复制：' + link;
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(link).then(function () { done(true); }, function () { done(fallbackCopy(link)); });
      return;
    }
    done(fallbackCopy(link));
  }

  function clearRoomParam() {
    try {
      const next = stripRoomParam(window.location.href);
      const current = window.location.pathname + window.location.search;
      if (next && next !== current) history.replaceState(history.state, '', next);
    } catch (err) {
      // 地址栏不可写时忽略，不影响已成功的加入
    }
  }

  // 邀请链接只在首次快照确认「没有对局也没有房间」后自动加入一次。
  function maybeJoinInvite() {
    if (!invite.code || invite.done || invite.running) return;
    if (state.battle) {
      invite.done = true;
      invite.code = null;
      return;
    }
    if (!invite.synced || !selectedSpeechProfile || busy || !connected || document.hidden) return;
    invite.running = true;
    const pending = say(joinCommand(invite.code));
    if (!pending || !pending.then) {
      invite.running = false;
      return;
    }
    pending.then(function (data) {
      invite.running = false;
      if (!data) return; // 网络失败：保留房号，等下一次状态快照再试
      const snapshot = data.state;
      if (!snapshot) return; // 结果未知：不冒充成功，也不丢弃房号
      invite.done = true;
      invite.code = null;
      // /api/say 返回的是 {room, battle} 快照；加入成功后 battle 才非空。
      if (snapshot.battle && snapshot.battle.room) {
        clearRoomParam();
      } else {
        pushReply('邀请的房间暂时加入不了，可以开一间房或用别的房号加入。', 'warn', 'system');
      }
    }, function () {
      invite.running = false;
    });
  }

  function setPageMode(mode) {
    currentMode = mode;
    if (document.body.dataset.mode !== mode) document.body.dataset.mode = mode;
  }

  function syncActionBarVisibility() {
    const allowed = currentMode === 'battle' || currentMode === 'ended';
    el.battleActions.hidden = !allowed || actionButtons.length === 0 || !el.composer.hidden;
  }

  function renderActions() {
    const view = actionBarView(state.battle, { busy: busy, connected: connected && !unconfirmed });
    const utility = view.utility || null;
    const signature = view.mode + '|' + view.hint + '|' + (busy ? 'busy' : 'idle') + '|' +
      (utility ? utility.label + ':' + (utility.disabled ? 1 : 0) : '') + '|' +
      view.buttons.map(function (button) {
        return button.id + ':' + button.label + ':' + button.command + ':' + (button.apCost || 0) + ':' +
          (button.disabled ? 1 : 0) + ':' + (button.note || '');
      }).join(',');
    if (signature !== actionSignature) {
      actionSignature = signature;
      actionButtons = view.buttons;
      el.actionButtons.textContent = '';
      el.actionButtons.dataset.count = String(view.buttons.length);
      view.buttons.forEach(function (button) {
        const node = document.createElement('button');
        node.type = 'button';
        node.className = 'action-button';
        node.dataset.command = button.command;
        node.dataset.tone = button.tone || 'neutral';
        node.disabled = button.disabled;
        const label = document.createElement('span');
        label.className = 'action-label';
        label.textContent = button.label;
        node.appendChild(label);
        // 按钮后面直接标出这一手要扣的能量；0 费不标，避免底栏变吵。
        if (button.apCost > 0) {
          const cost = document.createElement('span');
          cost.className = 'action-cost';
          cost.textContent = '⚡' + button.apCost;
          cost.setAttribute('aria-hidden', 'true');
          node.appendChild(cost);
        }
        node.setAttribute('aria-label', button.label +
          (button.apCost > 0 ? '，消耗' + button.apCost + '点能量' : '，不耗能量') +
          (button.note ? '，' + button.note : ''));
        el.actionButtons.appendChild(node);
      });
      // 退出入口单独一行，不混进招式网格，避免误触。
      el.actionUtility.textContent = '';
      el.actionUtility.hidden = !utility;
      if (utility) {
        const leave = document.createElement('button');
        leave.type = 'button';
        leave.className = 'action-utility-button';
        leave.dataset.command = utility.command;
        leave.dataset.confirm = utility.confirm || '';
        leave.disabled = utility.disabled;
        leave.textContent = utility.label;
        el.actionUtility.appendChild(leave);
      }
    }
    syncActionBarVisibility();
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
    syncActionBarVisibility();
    if (focus) el.text.focus();
  }

  function closeComposer() {
    if (el.composer.hidden) return;
    el.composer.hidden = true;
    syncActionBarVisibility();
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
    el.round.hidden = !battle || battle.waiting;
    if (battle && !battle.waiting) el.round.textContent = '第 ' + battle.round + ' 轮';

    // 页面模式完全跟随服务端快照：大厅 / 等待房 / 对战 / 结束。
    const mode = pageMode(battle);
    setPageMode(mode);
    el.lobby.hidden = mode !== 'lobby';
    if (mode === 'lobby') renderLobby();
    renderRoomCard();
    renderActions();
    syncLobbyPolling();
  }

  /* ---------------- 播报（TTS） ---------------- */

  function canSpeak() {
    return typeof window.speechSynthesis !== 'undefined' && typeof window.SpeechSynthesisUtterance === 'function';
  }

  // iOS/Safari 只允许在用户手势里“解锁”语音合成；第一次触摸或按键时先播一个静音段，
  // 之后服务端返回的回复才能真正出声。桌面浏览器没有副作用。
  var speechPrimed = false;
  function primeSpeech() {
    if (speechPrimed || !canSpeak()) return;
    speechPrimed = true;
    try {
      const warm = new window.SpeechSynthesisUtterance(' ');
      warm.volume = 0;
      warm.lang = (config && config.voice && config.voice.lang) || 'zh-CN';
      window.speechSynthesis.speak(warm);
      window.speechSynthesis.resume();
    } catch (error) { /* 浏览器不支持时保持静默，文字照常显示 */ }
  }

  // 单段适配边界为 {text, emotion}，对应未来语音队列 enqueue(text, emotion)。
  // 浏览器只使用 text；emotion 是模型意图，不伪造音色情绪或映射音高/语速。
  function browserSpeechSegment(item) {
    const utter = new window.SpeechSynthesisUtterance(item.text);
    utter.lang = (config && config.voice && config.voice.lang) || 'zh-CN';
    utter.rate = TTS_RATE;
    el.replies.dataset.emotionIntent = item.emotion;
    el.replies.dataset.emotionApplied = 'false';
    return utter;
  }

  function speak(plan, reply, turn, profileId) {
    stopSpeaking();
    // 旧版本只有 reply：明确作为 neutral 单段兼容，不从文字猜情绪。
    const segments = plan && plan.version === 1 && Array.isArray(plan.segments)
      ? plan.segments : [{ text: reply, emotion: 'neutral' }];
    if (!segments.length) return Promise.resolve('silent');
    if (config && config.voice && config.voice.tts === 'backend') return speakBackend(segments, turn, profileId);
    if (!canSpeak()) return Promise.resolve('displayed');
    try { window.speechSynthesis.resume(); } catch (error) { /* 不支持时按无语音处理 */ }
    listener.pause();
    return new Promise(function (resolve) {
      let index = 0;
      let finished = false;
      function finish(reason) {
        if (finished) return;
        finished = true;
        clearTimeout(ttsTimer);
        ttsTimer = null;
        activeUtterance = null;
        finishPlayback = null;
        delete el.replies.dataset.emotionIntent;
        delete el.replies.dataset.emotionApplied;
        el.replies.setAttribute('aria-label', '玩家、伙伴与系统的对话记录');
        resolve(reason);
        if (reason !== 'cancelled' && !notificationPlaying && !queuedNotification && !busy && el.composer.hidden && listener) listener.resume();
      }
      function playNext() {
        if (finished) return;
        if (turn !== turnSequence || document.hidden) { finish('cancelled'); return; }
        if (index === segments.length) { finish('ended'); return; }
        const utter = browserSpeechSegment(segments[index++]);
        activeUtterance = utter;
        utter.onstart = function () {
          if (!finished && activeUtterance === utter) el.replies.setAttribute('aria-label', '对话记录，伙伴正在朗读（浏览器未应用情绪）');
        };
        utter.onend = function () {
          if (finished || activeUtterance !== utter) return;
          clearTimeout(ttsTimer);
          ttsTimer = null;
          // 同步接续下一段，整条话术结束之前不恢复识别，不触发 wait_event。
          playNext();
        };
        utter.onerror = function () {
          if (finished || activeUtterance !== utter) return;
          finish('error');
          try { window.speechSynthesis.cancel(); } catch (err) { /* 浏览器已收尾 */ }
        };
        ttsTimer = setTimeout(function () {
          if (finished || activeUtterance !== utter) return;
          finish('timeout');
          try { window.speechSynthesis.cancel(); } catch (err) { /* 浏览器已收尾 */ }
        }, TTS_TIMEOUT);
        try { window.speechSynthesis.speak(utter); }
        catch { utter.onerror(); }
      }
      finishPlayback = finish;
      playNext();
    });
  }

  async function speakBackend(segments, turn, profileId) {
    const controller = new AbortController();
    cloudPlayback = controller;
    listener.pause();
    try {
      for (const segment of segments) {
        if (controller.signal.aborted || turn !== turnSequence || document.hidden) return 'cancelled';
        await backendPlayback({ text: segment.text, emotion: segment.emotion, profileId: profileId }, controller.signal, function (emotion) {
          if (cloudPlayback !== controller) return;
          el.replies.dataset.emotionIntent = emotion.requested;
          el.replies.dataset.emotionApplied = emotion.applied;
          el.replies.dataset.emotionControl = emotion.control;
          el.replies.dataset.speechProfile = emotion.profileId || profileId;
          el.replies.dataset.speechSpeaker = emotion.speaker || '';
          el.replies.setAttribute('aria-label', '伙伴正在朗读，情绪请求 ' + emotion.requested + '，应用 ' + emotion.applied + '，控制 ' + emotion.control);
        });
      }
      return controller.signal.aborted || turn !== turnSequence ? 'cancelled' : 'ended';
    } catch (error) {
      if (controller.signal.aborted) return 'cancelled';
      const detail = diagnosticText(error.diagnostic);
      pushReply('伙伴语音播放失败，文字回复已保留。' + (detail ? '\n' + detail : ''), 'warn', 'system');
      return 'error';
    } finally {
      if (cloudPlayback === controller) {
        cloudPlayback = null;
        delete el.replies.dataset.emotionIntent;
        delete el.replies.dataset.emotionApplied;
        delete el.replies.dataset.emotionControl;
        el.replies.setAttribute('aria-label', '玩家、伙伴与系统的对话记录');
      }
    }
  }

  function stopSpeaking() {
    if (cloudPlayback) { const current = cloudPlayback; cloudPlayback = null; current.abort(); }
    delete el.replies.dataset.emotionIntent;
    delete el.replies.dataset.emotionApplied;
    delete el.replies.dataset.emotionControl;
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
    if (window.isSecureContext === false || !recognitionConstructor()) return false;
    if (config.voice.asr === 'doubao') return Boolean(window.navigator && window.navigator.mediaDevices &&
      window.navigator.mediaDevices.getUserMedia && window.AudioContext && window.AudioWorkletNode);
    return true;
  }

  var listener = createListeningSession({
    Recognition: ConfiguredRecognition,
    onState: function (session) {
      listening = session.active;
      if (!session.active) playerSpeaking = false;
      el.mic.dataset.listening = session.active ? 'true' : 'false';
      el.mic.setAttribute('aria-pressed', String(session.enabled));
      el.mic.setAttribute('aria-label', session.enabled ? '停止持续聆听' : '开启持续聆听');
      render();
    },
    onText: function (text, final) {
      playerSpeaking = !final && Boolean(text.trim());
      if (playerSpeaking) cancelNotifications();
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
      pushReply(!config ? '语音配置尚未就绪，请稍后再开启麦克风。' : window.isSecureContext === false ? MIC_NO_HTTPS :
        config.voice.asr === 'doubao' ? '此浏览器不支持后台收音，请用支持安全麦克风和 AudioWorklet 的浏览器，或点键盘输入。' : MIC_NO_API, 'warn');
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

  el.speechProfile.addEventListener('change', changeSpeechProfile);
  el.mic.addEventListener('click', toggleListening);
  el.mic.addEventListener('pointercancel', stopListening);
  el.keyboard.addEventListener('click', toggleComposer);

  // 大厅/等待房/出招按钮：全部先变成中文原话，再交给同一条 say 入口。
  el.openRoom.addEventListener('click', function () { say('发起挑战'); });
  el.soloPractice.addEventListener('click', function () { say('开始'); });
  el.joinForm.addEventListener('submit', function (event) {
    event.preventDefault();
    submitJoin(el.roomCode.value);
  });
  el.roomCode.addEventListener('input', function () {
    el.roomCode.value = el.roomCode.value.replace(/\D/g, '').slice(0, 4);
  });
  el.roomList.addEventListener('click', function (event) {
    const target = event.target;
    const button = target && target.closest ? target.closest('button[data-code]') : null;
    if (!button || button.disabled) return;
    el.roomCode.value = button.dataset.code;
    say(joinCommand(button.dataset.code));
  });
  el.copyInvite.addEventListener('click', copyInviteLink);
  el.cancelRoom.addEventListener('click', function () { say('退出房间'); });
  el.actionButtons.addEventListener('click', function (event) {
    const target = event.target;
    const button = target && target.closest ? target.closest('button[data-command]') : null;
    if (!button || button.disabled) return;
    say(button.dataset.command);
  });
  el.actionUtility.addEventListener('click', function (event) {
    const target = event.target;
    const button = target && target.closest ? target.closest('button[data-command]') : null;
    if (!button || button.disabled) return;
    // 进行中退出会判负，必须先确认；结束态的「回到大厅」不带确认文案。
    const confirmText = button.dataset.confirm;
    if (confirmText && !window.confirm(confirmText)) return;
    say(button.dataset.command);
  });

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

  // 页面切走/隐藏时，先把播报和识别停掉，别在后台继续说；回到前台再刷新大厅。
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) {
      stopSpeaking();
      stopListening();
      stopLobbyPolling();
      settlement = null;
      clearTimeout(settlementTimer);
      render();
    } else {
      render();
      maybeJoinInvite();
    }
  });
  window.addEventListener('pagehide', function () { stopLobbyPolling(); stopListening(); stopSpeaking(); });

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

  // 第一次真实点击时解锁浏览器语音；只做一次，不拦截按钮本身。
  document.addEventListener('pointerdown', primeSpeech, { once: true, passive: true });
  document.addEventListener('keydown', primeSpeech, { once: true });
  // 自动化或读屏可能只派发 click；primeSpeech 自带幂等判断。
  document.addEventListener('click', primeSpeech, { once: true, passive: true });
  watchKeyboard();
  render();
  setConn('connecting');
  loadConfig();
})();
