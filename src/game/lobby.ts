import { pvpBattleKey } from './pvp.js';
import type { Battle } from './types.js';
import type { Room } from '../store/rooms.js';

/**
 * 公开大厅的只读读模型。
 *
 * 纯函数：只吃房间与对局的快照，不碰存储、不发请求、不改任何状态，也不推进对局。
 * 手机页面靠它按房间号找对手，所以对外只给「房间号 + 状态 + 轮次 + 时间」，
 * 房主与加入者的设备身份一律不出这一层——要精确定位去看服务端日志。
 */

/** 大厅里一间房的公开状态：还在等人，或已经有对手开打 */
export type LobbyStatus = 'waiting' | 'playing';

/** 大厅列表里的一间房：没有任何设备身份字段 */
export interface LobbyRoom {
  /** 四位房间号，页面直接显示给玩家念 */
  code: string;
  status: LobbyStatus;
  /** 当前轮次，来自该房间的对局 */
  round: number;
  /** 开房时间；等待房按它排序，先开的先看到 */
  createdAt: number;
  /** 房间最近活动时间；对战中的房子按它排序，最近有动作的在前 */
  updatedAt: number;
}

/** 页面一次轮询拿到的全部内容 */
export interface LobbySnapshot {
  generatedAt: number;
  /** 等待房在前（createdAt 升序），对战中的房在后（updatedAt 降序） */
  rooms: LobbyRoom[];
  /** rooms 里等待中的房间数 */
  waiting: number;
  /** rooms 里对战中的房间数 */
  playing: number;
}

/** 默认返回上限：手机一屏看不完更多，大厅也不该被长列表撑成后台表格 */
export const LOBBY_DEFAULT_LIMIT = 50;

/**
 * 把房间与对局归拢成大厅列表。
 *
 * 只认 `pvp:<房间号>` 键且仍在 `battle` 阶段的对局：开房后对局已过期的房间、
 * 已经分出胜负的对局都跳过——玩家点进去也没得打。
 * 排序先等待房（先开的靠前，新手更可能被看见）再对战中的房（最近有动作的靠前），
 * 最后按 `limit` 截断；`waiting` 与 `playing` 是截断后列表里的计数。
 */
export function buildLobby(input: {
  rooms: readonly Room[];
  battles: readonly { key: string; battle: Battle }[];
  now?: number;
  limit?: number;
}): LobbySnapshot {
  const battleByKey = new Map(input.battles.map((entry) => [entry.key, entry.battle]));
  const waiting: LobbyRoom[] = [];
  const playing: LobbyRoom[] = [];

  for (const room of input.rooms) {
    const battle = battleByKey.get(pvpBattleKey(room.code));
    if (!battle || battle.phase !== 'battle') continue;
    const entry: LobbyRoom = {
      code: room.code,
      status: room.guestKey === null ? 'waiting' : 'playing',
      round: battle.round,
      createdAt: room.createdAt,
      updatedAt: room.updatedAt,
    };
    (entry.status === 'waiting' ? waiting : playing).push(entry);
  }

  // 同一时刻开的房、同一时刻有动作的房都要有稳定次序，页面不会每次轮询都跳位
  waiting.sort((left, right) => left.createdAt - right.createdAt || left.code.localeCompare(right.code));
  playing.sort((left, right) => right.updatedAt - left.updatedAt || left.code.localeCompare(right.code));

  const rooms = [...waiting, ...playing].slice(0, clampLimit(input.limit));
  return {
    generatedAt: input.now ?? Date.now(),
    rooms,
    waiting: rooms.filter((room) => room.status === 'waiting').length,
    playing: rooms.filter((room) => room.status === 'playing').length,
  };
}

/** 上限归一：缺省用默认值，小数向下取整，非有限值退回默认，负数当 0 */
function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return LOBBY_DEFAULT_LIMIT;
  return Math.max(0, Math.floor(limit));
}
