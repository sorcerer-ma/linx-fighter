import type { Logger } from '../log.js';
import type { BattleStore } from '../store/battles.js';
import type { EchoStore } from '../store/echoes.js';
import type { Room, RoomStore } from '../store/rooms.js';
import { canonicalize, pvpBattleKey, viewAs } from './pvp.js';
import type { Battle, Side } from './types.js';

/** 一张桌子要用到的存储：对局、房间、双人补账 */
export interface TableDeps {
  store: BattleStore;
  rooms: RoomStore;
  echo: EchoStore;
  logger: Logger;
}

/**
 * 一张桌子：这位玩家现在把话发给哪一局。
 *
 * 单人局与双人局的区别只剩这些：存在哪个键、坐哪一边、看不看镜像、
 * 要不要等对手、补账记给谁。把它们收成一个接口，出招流水线就不用分两条。
 */
export interface Table {
  /** 存储键：单人局是玩家键，双人局是 `pvp:<房间号>` */
  readonly key: string;
  /** 房间号；单人局为 null */
  readonly room: string | null;
  /** 这位玩家坐在哪一边；不在桌上返回 null */
  seat(sessionKey: string): Side | null;
  /** 服务端基准对局（房主视角）；还没开或已过期返回 null */
  battle(): Battle | null;
  /** 这位玩家看到的局面：按座位镜像；不在桌上返回 null */
  view(sessionKey: string): Battle | null;
  /** 还在等对手进来：只有房主独自在房里时为 true */
  waiting(): boolean;
  /** 这一手结算完要补账给谁；没有对手返回 null */
  echoTo(seat: Side): string | null;
  /** 结算回来确认还坐在原位：房间可能被撤、对手可能换房 */
  stillHere(sessionKey: string, seat: Side): boolean;
  /** 把这位玩家的结算结果换回基准视角 */
  canonical(played: Battle, seat: Side, base: Battle): Battle;
}

/** 这位玩家现在在哪张桌上：在房间里就是那张双人桌，否则是单人桌 */
export function tableFor(deps: TableDeps, sessionKey: string): Table {
  const room = deps.rooms.byPlayer(sessionKey);
  return room ? pvpTable(deps, room) : soloTable(deps, sessionKey);
}

/** 房间里的座位：房主是 player，加入者是 enemy，都不匹配返回 null */
export function seatOf(room: Room, sessionKey: string): Side | null {
  if (room.hostKey === sessionKey) return 'player';
  if (room.guestKey === sessionKey) return 'enemy';
  return null;
}

/**
 * 撤掉一间房。
 *
 * 换房、重开都走这里：对局与补账一起清掉，旧房里的对手会收到「没找到房间」，
 * 不会对着已经作废的局面继续等响应。
 */
export function dropRoom(deps: TableDeps, room: Room, reason: string): void {
  deps.store.delete(pvpBattleKey(room.code));
  deps.rooms.remove(room.code);
  // 换局了，上一局没补完的结果不能补到新对局里
  deps.echo.clear(room.hostKey);
  if (room.guestKey) deps.echo.clear(room.guestKey);
  deps.logger.info('房间关闭', { room: room.code, reason });
}

/** 单人桌：自己就是 player，没有镜像、没有对手可等 */
function soloTable(deps: TableDeps, sessionKey: string): Table {
  const key = sessionKey;
  return {
    key,
    room: null,
    seat: (who) => (who === sessionKey ? 'player' : null),
    battle: () => deps.store.get(key) ?? null,
    view: (who) => (who === sessionKey ? deps.store.get(key) ?? null : null),
    waiting: () => false,
    echoTo: () => null,
    stillHere: (who, seat) => who === sessionKey && seat === 'player' && !deps.rooms.byPlayer(who),
    canonical: (played) => played,
  };
}

/** 双人桌：基准对局存房间号下，两位玩家各看各的镜像 */
function pvpTable(deps: TableDeps, room: Room): Table {
  const key = pvpBattleKey(room.code);
  return {
    key,
    room: room.code,
    seat: (who) => seatOf(room, who),
    battle: () => deps.store.get(key) ?? null,
    view: (who) => {
      const seat = seatOf(room, who);
      const canonical = deps.store.get(key);
      return seat && canonical ? viewAs(canonical, seat) : null;
    },
    waiting: () => room.guestKey === null,
    echoTo: (seat) => (seat === 'player' ? room.guestKey : room.hostKey),
    stillHere: (who, seat) => {
      const live = deps.rooms.get(room.code);
      return !!live && seatOf(live, who) === seat;
    },
    canonical: (played, seat, base) => canonicalize(played, seat, base),
  };
}
