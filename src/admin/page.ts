import { ADMIN_RATE_LIMIT } from './ratelimit.js';

/**
 * 后台监控页：内嵌 HTML + 原生 JS，3 秒轮询 `/admin/api/rooms`。
 *
 * 不引入前端框架、静态目录与构建步骤：Docker 运行时只拷 `dist`，页面必须跟着服务代码走。
 * 页面只有 GET，没有任何写操作入口；所有动态文本都先转义再拼 HTML，避免对局里的名字被当成标签执行。
 */
export const ADMIN_PAGE_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex, nofollow" />
<title>对局监控 · 共鸣：闻声对决</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; padding: 16px; font: 15px/1.5 -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; background: #f4f5f7; color: #1f2329; }
  header { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 16px; margin-bottom: 12px; }
  h1 { margin: 0; font-size: 20px; }
  .meta { color: #646a73; font-size: 13px; }
  .error { padding: 10px 12px; margin-bottom: 12px; border-radius: 8px; background: #fde2e2; color: #8b1a1a; font-size: 14px; }
  .rooms { display: grid; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); gap: 12px; }
  .card { background: #fff; border: 1px solid #e5e6eb; border-radius: 10px; padding: 12px; }
  .card.ended { opacity: .85; }
  .row { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; }
  .title { font-weight: 600; font-size: 16px; }
  .badge { font-size: 12px; padding: 1px 8px; border-radius: 999px; background: #eef3ff; color: #2b5cd9; }
  .badge.waiting { background: #fff4e5; color: #a55b00; }
  .badge.ended { background: #f2f3f5; color: #4e5969; }
  .badge.live { background: #e8f7ee; color: #0f7b3f; }
  .sub { color: #646a73; font-size: 12px; margin-top: 2px; }
  .seat { flex: 1 1 44%; min-width: 150px; border: 1px solid #e5e6eb; border-radius: 8px; padding: 8px; margin-top: 8px; }
  .seat.active { border-color: #2b5cd9; box-shadow: inset 0 0 0 1px #2b5cd9; }
  .seat.empty { border-style: dashed; color: #86909c; }
  .seat .name { font-weight: 600; }
  .seat .key { color: #86909c; font-size: 12px; word-break: break-all; }
  .stat { display: flex; justify-content: space-between; font-size: 13px; margin-top: 4px; }
  .bar { display: block; height: 6px; border-radius: 3px; background: #eef0f3; overflow: hidden; margin-top: 2px; }
  .bar > i { display: block; height: 100%; background: #f54a45; }
  .bar.ap > i { background: #2b7fd9; }
  .pending { margin-top: 8px; padding: 6px 8px; border-radius: 8px; background: #fff4e5; color: #824700; font-size: 13px; }
  .winner { margin-top: 8px; font-weight: 600; color: #0f7b3f; }
  .empty-state { padding: 24px; text-align: center; color: #646a73; background: #fff; border: 1px dashed #e5e6eb; border-radius: 10px; }
  footer { color: #86909c; font-size: 12px; margin-top: 16px; }
  @media (max-width: 420px) { .seat { flex-basis: 100%; } }
</style>
</head>
<body>
<header>
  <h1>对局监控</h1>
  <div class="meta" id="meta">连接中…</div>
</header>
<div class="error" id="error" hidden></div>
<main class="rooms" id="rooms"><p class="empty-state">正在加载…</p></main>
<footer>只读页面：生命值、能量与胜负都由服务端裁定，这里只能围观，不能出招。每 3 秒自动刷新。未配置 ADMIN_TOKEN 时本页公开可见，挑战编号也会一起公开——知道编号的人可能抢先接受、占掉对手位。</footer>
<script>
(function () {
  'use strict';
  var REFRESH_MS = 3000;
  var token = new URLSearchParams(window.location.search).get('token') || '';
  var loading = false;
  var roomsEl = document.getElementById('rooms');
  var metaEl = document.getElementById('meta');
  var errorEl = document.getElementById('error');

  // 所有动态内容都过一遍转义：对手名字来自玩家输入，不能直接当 HTML 用
  function esc(value) {
    return String(value === null || value === undefined ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function two(n) { return n < 10 ? '0' + n : String(n); }

  function timeText(ms) {
    if (!ms) return '—';
    var d = new Date(ms);
    return two(d.getHours()) + ':' + two(d.getMinutes()) + ':' + two(d.getSeconds());
  }

  function showError(message) {
    errorEl.textContent = message;
    errorEl.hidden = false;
  }

  function clearError() {
    errorEl.hidden = true;
    errorEl.textContent = '';
  }

  function percent(value, max) {
    if (!max || max <= 0) return 0;
    return Math.max(0, Math.min(100, Math.round((value / max) * 100)));
  }

  function seatHtml(seat, highlight, hint) {
    var classes = 'seat' + (highlight ? ' active' : '') + (seat.empty ? ' empty' : '');
    var html = '<div class="' + classes + '">';
    html += '<div class="name">' + esc(seat.name) + (hint ? ' · ' + esc(hint) : '') + '</div>';
    html += '<div class="key">' + esc(seat.deviceKey || '—') + (seat.isAi ? ' · AI' : '') + '</div>';
    html += '<div class="stat"><span>生命值</span><span>' + esc(seat.hp) + ' / ' + esc(seat.maxHp) + '</span></div>';
    html += '<span class="bar"><i style="width:' + percent(seat.hp, seat.maxHp) + '%"></i></span>';
    html += '<div class="stat"><span>能量</span><span>' + esc(seat.ap) + ' / ' + esc(seat.maxAp) + '</span></div>';
    html += '<span class="bar ap"><i style="width:' + percent(seat.ap, seat.maxAp) + '%"></i></span>';
    html += '<div class="stat"><span>大招剩余</span><span>' + esc(seat.ultLeft) + ' 次</span></div>';
    html += '</div>';
    return html;
  }

  function roomHtml(room) {
    var players = room.players || [];
    var playing = room.phase === 'battle';
    var html = '<section class="card' + (playing ? '' : ' ended') + '">';
    html += '<div class="row">';
    html += '<span class="title">' + (room.kind === 'room' ? '挑战 ' + esc(room.code) : '单人练习') + '</span>';
    html += '<span class="badge">' + (room.mode === 'pvp' ? '双人挑战' : '对手是 AI') + '</span>';
    if (room.waiting) html += '<span class="badge waiting">等对方接受</span>';
    if (playing) html += '<span class="badge live">第 ' + esc(room.round) + ' 轮</span>';
    if (!playing) html += '<span class="badge ended">已分胜负</span>';
    html += '</div>';
    html += '<div class="sub">更新于 ' + timeText(room.updatedAt) + '</div>';
    for (var i = 0; i < players.length; i += 1) {
      var seat = players[i];
      var isActive = playing && !room.waiting && seat.side === room.active;
      var hint = isActive ? (room.pending ? '该应对' : '该出手') : '';
      html += seatHtml(seat, isActive, hint);
    }
    if (room.waiting) {
      html += '<div class="pending">挑战已发起，等对方凭编号接受；接受前不会自动补 AI。</div>';
    } else if (room.pending) {
      html += '<div class="pending">' + esc(room.pending.actorName) + ' 的「' + esc(room.pending.moveLabel) + '」已锁定：伤害 ' + esc(room.pending.damage) + '，等对方应对。</div>';
    }
    if (room.winner) {
      var winnerSeat = room.winner === 'player' ? players[0] : players[1];
      html += '<div class="winner">胜者：' + esc(winnerSeat ? winnerSeat.name : room.winner) + '</div>';
    }
    html += '</section>';
    return html;
  }

  function render(data) {
    var list = data.rooms || [];
    var meta = '挑战 ' + data.roomCount + ' · 单人 ' + data.soloCount;
    if (data.staleRooms) meta += ' · 对局已过期 ' + data.staleRooms;
    meta += ' · 生成于 ' + timeText(data.generatedAt);
    metaEl.textContent = meta;
    if (!list.length) {
      roomsEl.innerHTML = '<p class="empty-state">当前没有进行中的对局。开一局后这里会自动出现。</p>';
      return;
    }
    var html = '';
    for (var i = 0; i < list.length; i += 1) html += roomHtml(list[i]);
    roomsEl.innerHTML = html;
  }

  function url() {
    return '/admin/api/rooms' + (token ? '?token=' + encodeURIComponent(token) : '');
  }

  function load() {
    if (loading) return;
    loading = true;
    fetch(url(), { cache: 'no-store' })
      .then(function (response) {
        if (response.status === 401) {
          showError('需要口令：在地址后加上 ?token=… 再打开本页。');
          return null;
        }
        if (response.status === 429) {
          showError('刷新太频繁，已限速（每分钟最多 ${ADMIN_RATE_LIMIT.limit} 次），稍后自动重试。');
          return null;
        }
        if (!response.ok) {
          showError('服务返回 HTTP ' + response.status + '，稍后自动重试。');
          return null;
        }
        return response.json();
      })
      .then(function (data) {
        if (!data) return;
        clearError();
        render(data);
      })
      .catch(function () {
        showError('连不上服务，3 秒后重试。');
      })
      .then(function () {
        loading = false;
      });
  }

  load();
  window.setInterval(load, REFRESH_MS);
})();
</script>
</body>
</html>
`;

/** 口令不对时的提示页：只给一句人话，不泄露配置细节 */
export function adminDeniedPage(message: string): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex, nofollow" />
<title>需要口令 · 对局监控</title>
</head>
<body style="font:15px/1.6 -apple-system, 'PingFang SC', 'Microsoft YaHei', sans-serif; padding: 24px;">
<h1 style="font-size:18px;">后台监控页需要口令</h1>
<p>${escapeHtml(message)}</p>
</body>
</html>
`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
