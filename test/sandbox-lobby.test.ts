import assert from 'node:assert/strict';
import { it } from 'node:test';

// 大厅纯函数同样直接按 URL 导入，页面与测试共用一份实现。
const {
  parseRoomParam,
  normalizeRoomCode,
  joinCommand,
  inviteLink,
  stripRoomParam,
  lobbyRooms,
  lobbyNotice,
  pageMode,
} = await import(new URL('../sandbox/public/lobby.js', import.meta.url).href);

it('解析邀请链接里的四位房号，非法值返回 null', () => {
  assert.equal(parseRoomParam('?room=1234'), '1234');
  assert.equal(parseRoomParam('room=0421'), '0421');
  assert.equal(parseRoomParam('?player=abc&room=9876#top'), '9876');
  assert.equal(parseRoomParam('?room=123'), null);
  assert.equal(parseRoomParam('?room=12345'), null);
  assert.equal(parseRoomParam('?room=abcd'), null);
  assert.equal(parseRoomParam('?player=abc'), null);
  assert.equal(parseRoomParam(''), null);
  assert.equal(parseRoomParam(null), null);
  assert.equal(parseRoomParam(undefined), null);
});

it('房号输入归一化并生成中文加入原话', () => {
  assert.equal(normalizeRoomCode(' 0042 '), '0042');
  assert.equal(normalizeRoomCode(1234), '1234');
  assert.equal(normalizeRoomCode('12a4'), '');
  assert.equal(normalizeRoomCode(''), '');
  assert.equal(normalizeRoomCode(null), '');
  assert.equal(joinCommand('1234'), '加入房间1234');
  assert.equal(joinCommand(' 0042 '), '加入房间0042');
  assert.equal(joinCommand('123'), '');
  assert.equal(joinCommand('abcd'), '');
});

it('邀请链接只带 room，绝不带 player 身份参数', () => {
  const invited = inviteLink('http://host/?player=1', '1234');
  assert.equal(invited, 'http://host/?room=1234');
  assert.ok(!invited.includes('player='));

  // 其他查询参数也不透传：邀请链接只认 room，避免身份/调试参数跟着传播。
  assert.equal(
    inviteLink('https://host/path?player=abc&lang=zh#x', '0042'),
    'https://host/path?room=0042',
  );
  assert.equal(
    inviteLink('https://host/path?room=9999', '1234'),
    'https://host/path?room=1234',
  );
  assert.equal(inviteLink('https://host/path', '123'), '');
});

it('成功后去掉 room 参数，只留下可 replaceState 的相对地址', () => {
  assert.equal(
    stripRoomParam('https://host/path?player=abc&room=1234'),
    '/path?player=abc',
  );
  assert.equal(stripRoomParam('https://host/path?player=abc'), '/path?player=abc');
  assert.equal(stripRoomParam('https://host/path?room=1234#top'), '/path#top');
});

it('房间列表只保留合法且去重的房间，等待房才可加入', () => {
  const view = lobbyRooms({
    ok: true,
    rooms: [
      { code: '1234', status: 'waiting', round: 1 },
      { code: '1234', status: 'playing', round: 3 },
      { code: '5678', status: 'playing', round: 4 },
      { code: '12', status: 'waiting', round: 1 },
      { code: '9999', status: 'broken', round: 1 },
      null,
    ],
  });
  assert.equal(view.ok, true);
  assert.equal(view.rooms.length, 2);
  assert.equal(view.waiting, 1);
  assert.equal(view.playing, 1);
  const waiting = view.rooms[0];
  assert.equal(waiting.code, '1234');
  assert.equal(waiting.status, 'waiting');
  assert.equal(waiting.joinable, true);
  assert.equal(waiting.statusLabel, '等待加入');
  const playing = view.rooms[1];
  assert.equal(playing.code, '5678');
  assert.equal(playing.status, 'playing');
  assert.equal(playing.joinable, false);
  assert.equal(playing.statusLabel, '对战中');
});

it('大厅接口失败时保留空列表并给出可读说明', () => {
  const failed = lobbyRooms({ ok: false, rooms: [], error: 'upstream_unreachable' });
  assert.equal(failed.ok, false);
  assert.deepEqual(failed.rooms, []);
  assert.equal(failed.waiting, 0);
  assert.equal(failed.playing, 0);
  assert.deepEqual(lobbyRooms(null).rooms, []);
  assert.deepEqual(lobbyRooms({ ok: true }).rooms, []);
  assert.match(lobbyNotice(null), /正在读取房间/);
  assert.match(lobbyNotice({ ok: false }), /读不到/);
});

it('大厅空态给引导，有房间时不占位', () => {
  assert.match(lobbyNotice({ ok: true, rooms: [] }, []), /开一间房/);
  const view = lobbyRooms({ ok: true, rooms: [{ code: '1234', status: 'waiting', round: 1 }] });
  assert.equal(lobbyNotice({ ok: true, rooms: [{ code: '1234' }] }, view.rooms), '');
});

it('页面模式由服务端快照决定：大厅/等待/对战/结束', () => {
  assert.equal(pageMode(null), 'lobby');
  assert.equal(pageMode({ waiting: true, phase: 'battle', mode: 'pvp' }), 'waiting');
  assert.equal(pageMode({ waiting: false, phase: 'battle', mode: 'pvp' }), 'battle');
  assert.equal(pageMode({ waiting: false, phase: 'victory', mode: 'pvp' }), 'ended');
  assert.equal(pageMode({ waiting: false, phase: 'defeat', mode: 'solo' }), 'ended');
});
