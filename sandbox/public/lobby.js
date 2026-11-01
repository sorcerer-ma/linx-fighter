/**
 * 大厅纯函数：房号解析、邀请链接、房间列表与页面模式。
 *
 * 页面脚本只负责把它们绑到 DOM 上；这里不碰 document、不发请求，
 * 方便 node:test 直接 import 做边界测试。
 */

var ROOM_RE = /^\d{4}$/;

// 只认 ?room=1234 这类四位数字；查询串可带可不带问号。
function queryString(search) {
  var text = String(search == null ? '' : search);
  var index = text.indexOf('?');
  var query = index === -1 ? text : text.slice(index + 1);
  var hash = query.indexOf('#');
  return hash === -1 ? query : query.slice(0, hash);
}

/** 解析 4 位房号，非法或缺失时返回 null */
export function parseRoomParam(search) {
  var code;
  try {
    code = new URLSearchParams(queryString(search)).get('room');
  } catch (err) {
    return null;
  }
  return normalizeRoomCode(code) || null;
}

/** 把输入里的房号归一成 4 位数字；不合法返回空串 */
export function normalizeRoomCode(value) {
  var text = String(value == null ? '' : value).trim();
  return ROOM_RE.test(text) ? text : '';
}

/** 加入房间的原话：加入房间 + 4 位数字；房号不合法返回空串 */
export function joinCommand(value) {
  var code = normalizeRoomCode(value);
  return code ? '加入房间' + code : '';
}

/** 邀请链接：只带 room，不带任何查询参数（尤其 ?player=，否则朋友会变成同一个人） */
export function inviteLink(href, code) {
  var room = normalizeRoomCode(code);
  if (!room) return '';
  try {
    var url = new URL(String(href == null ? '' : href), 'http://localhost/');
    // 清空原查询串：player 等身份参数会让被邀请人复用邀请人的设备身份。
    url.search = '';
    url.hash = '';
    url.searchParams.set('room', room);
    return url.toString();
  } catch (err) {
    return '';
  }
}

/** 去掉链接里的 room 参数，返回可直接交给 history.replaceState 的相对地址 */
export function stripRoomParam(href) {
  try {
    var url = new URL(String(href == null ? '' : href), 'http://localhost/');
    url.searchParams.delete('room');
    return url.pathname + url.search + url.hash;
  } catch (err) {
    return '';
  }
}

/**
 * 归一化 GET /api/lobby 的返回：只保留可信、可加入的字段。
 *
 * 服务端契约是 { ok, rooms:[{code,status,round,createdAt,updatedAt}], waiting, playing }，
 * 页面把重复房号、非法状态和坏数据挡在外面，渲染层不再各自判断。
 */
export function lobbyRooms(payload) {
  var body = payload && typeof payload === 'object' ? payload : null;
  var ok = Boolean(body) && body.ok !== false;
  var source = body && Array.isArray(body.rooms) ? body.rooms : [];
  var rooms = [];
  var seen = {};
  for (var i = 0; i < source.length; i += 1) {
    var item = source[i];
    if (!item || typeof item !== 'object') continue;
    var code = normalizeRoomCode(item.code);
    if (!code || seen[code]) continue;
    if (item.status !== 'waiting' && item.status !== 'playing') continue;
    seen[code] = true;
    var round = Number(item.round);
    rooms.push({
      code: code,
      status: item.status,
      round: Number.isFinite(round) && round > 0 ? Math.floor(round) : 1,
      statusLabel: item.status === 'playing' ? '对战中' : '等待加入',
      // 已经开打或列表本身读不到时不给加入按钮，避免把并发的加入请求送到满房。
      joinable: ok && item.status === 'waiting',
    });
  }
  return {
    ok: ok,
    rooms: rooms,
    waiting: rooms.filter(function (room) { return room.status === 'waiting'; }).length,
    playing: rooms.filter(function (room) { return room.status === 'playing'; }).length,
  };
}

/** 大厅列表的占位/异常说明；有房间时返回空串 */
export function lobbyNotice(payload, rooms) {
  if (!payload) return '正在读取房间…';
  if (payload.ok === false) return '大厅暂时读不到，可以直接开一间房或用房号加入。';
  var list = Array.isArray(rooms) ? rooms : lobbyRooms(payload).rooms;
  if (!list.length) return '现在没有房间。开一间房，把房号或邀请链接发给朋友。';
  return '';
}

/**
 * 页面模式：大厅 / 等待房 / 对战中 / 已结束。
 * 全部来自服务端快照，页面不维护第二份对局状态。
 */
export function pageMode(battle) {
  if (!battle) return 'lobby';
  if (battle.waiting) return 'waiting';
  if (battle.phase === 'victory' || battle.phase === 'defeat') return 'ended';
  return 'battle';
}
