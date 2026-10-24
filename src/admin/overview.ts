import { battleState, type FighterState } from '../game/state.js';
import { pvpBattleKey } from '../game/pvp.js';
import type { Battle, BattleMode, BattlePhase, Side } from '../game/types.js';
import { otherSide } from '../game/types.js';
import type { Room } from '../store/rooms.js';

/**
 * 后台监控页的只读读模型。
 *
 * 纯函数：只吃房间与对局的快照，不碰存储、不发请求、不改任何状态。
 * 局面字段一律来自 `game/state.ts` 的 `battleState`，这一层只做「按房间归拢 + 脱敏 + 取界面称呼」，
 * HTTP 层和页面都不再拼业务字段，避免后台页出现第二套规则。
 */

/** 对局存储里的一条只读条目 */
export interface AdminBattleEntry {
  /** 存储键：双人局是 `pvp:<房间号>`，单人局是 `deviceId#agentId` */
  key: string;
  battle: Battle;
}

/** 后台页上的一个座位 */
export interface AdminSeat extends FighterState {
  /** 对局键，已脱敏；空座位与 AI 为 null */
  deviceKey: string | null;
  /** 界面称呼：房主 / 加入者 / 等待加入 / 玩家 / 对手名 */
  name: string;
  side: Side;
  /** 房间已开、对手还没加入 */
  empty: boolean;
  /** 座位由 AI 扮演（单人局） */
  isAi: boolean;
}

/** 已经锁定、等对手应对的一手 */
export interface AdminPending {
  /** 打出这一手的一方 */
  actor: Side;
  /** 出手方在界面上的称呼 */
  actorName: string;
  move: string;
  moveLabel: string;
  damage: number;
}

/** 一张房间卡片 */
export interface AdminRoomOverview {
  /** 房间号；单人局为 null */
  code: string | null;
  /** room = 双人房；solo = 单人练习 */
  kind: 'room' | 'solo';
  mode: BattleMode;
  phase: BattlePhase;
  round: number;
  /** 当前该开口的一方：有待应对的攻击时是对手，否则是轮到主动出手的一方 */
  active: Side;
  /** 房主独自在房里等对手加入 */
  waiting: boolean;
  pending: AdminPending | null;
  winner: Side | null;
  updatedAt: number;
  /** 座位固定两个，玩家侧在前、对手侧在后 */
  players: [AdminSeat, AdminSeat];
}

/** 页面一次轮询拿到的全部内容 */
export interface AdminOverview {
  generatedAt: number;
  /** 房间存储里的房间数 */
  roomCount: number;
  /** 进行中的单人局数 */
  soloCount: number;
  /** 房间还在、对局已过期而没法展示的房间数 */
  staleRooms: number;
  /** 双人房按房间号升序在前，单人局按最近活动时间倒序在后 */
  rooms: AdminRoomOverview[];
}

/**
 * 对局键脱敏：长段只留首尾各四个字符，短段只留首尾各一个字符，空段保持为空。
 *
 * 后台页可能对公网可见，完整设备号没必要暴露；要精确定位时去看服务端日志。
 */
export function maskDeviceKey(key: string): string {
  return key.split('#').map(maskPart).join('#');
}

function maskPart(part: string): string {
  const text = part.trim();
  if (text.length <= 2) return text ? '…' : '';
  // 短 key 也脱敏：只留首尾各一个字符，避免「dev#a」这类值原样露出
  if (text.length <= 8) return `${text.slice(0, 1)}…${text.slice(-1)}`;
  return `${text.slice(0, 4)}…${text.slice(-4)}`;
}

/** 把房间与对局归拢成页面要的房间列表；纯函数，不读时钟以外的东西 */
export function buildAdminOverview(input: {
  rooms: readonly Room[];
  battles: readonly AdminBattleEntry[];
  now?: number;
}): AdminOverview {
  const battleByKey = new Map(input.battles.map((entry) => [entry.key, entry.battle]));
  // 已经属于某个房间的玩家，名下的旧单人局视为作废，不再单独展示
  const memberKeys = new Set<string>();
  for (const room of input.rooms) {
    memberKeys.add(room.hostKey);
    if (room.guestKey) memberKeys.add(room.guestKey);
  }

  const rooms: AdminRoomOverview[] = [];
  const usedKeys = new Set<string>();
  let staleRooms = 0;

  for (const room of [...input.rooms].sort((left, right) => left.code.localeCompare(right.code))) {
    const key = pvpBattleKey(room.code);
    const battle = battleByKey.get(key);
    if (!battle) {
      // 房间还在但对局已经过期，页面没法凭空造一局出来，只记数
      staleRooms += 1;
      continue;
    }
    usedKeys.add(key);
    rooms.push(roomOverview(room, battle));
  }

  const solos = input.battles
    .filter((entry) => !usedKeys.has(entry.key) && !memberKeys.has(entry.key))
    .sort((left, right) => right.battle.updatedAt - left.battle.updatedAt);
  for (const entry of solos) rooms.push(soloOverview(entry));

  return {
    generatedAt: input.now ?? Date.now(),
    roomCount: input.rooms.length,
    soloCount: solos.length,
    staleRooms,
    rooms,
  };
}

function roomOverview(room: Room, battle: Battle): AdminRoomOverview {
  const guestJoined = room.guestKey !== null;
  const state = battleState(battle, { room: room.code, side: 'player', waiting: !guestJoined });
  const host: AdminSeat = {
    ...state.you,
    deviceKey: maskDeviceKey(room.hostKey),
    name: '房主',
    side: 'player',
    empty: false,
    isAi: false,
  };
  const guest: AdminSeat = {
    ...state.opponent,
    deviceKey: guestJoined && room.guestKey ? maskDeviceKey(room.guestKey) : null,
    name: guestJoined ? '加入者' : '等待加入',
    side: 'enemy',
    empty: !guestJoined,
    isAi: false,
  };
  return finish(state, 'room', room.code, host, guest);
}

function soloOverview(entry: AdminBattleEntry): AdminRoomOverview {
  const state = battleState(entry.battle, { room: null, side: 'player', waiting: false });
  const player: AdminSeat = {
    ...state.you,
    deviceKey: maskDeviceKey(entry.key),
    name: '玩家',
    side: 'player',
    empty: false,
    isAi: false,
  };
  const enemy: AdminSeat = {
    ...state.opponent,
    deviceKey: null,
    name: state.opponent.name,
    side: 'enemy',
    empty: false,
    isAi: true,
  };
  return finish(state, 'solo', null, player, enemy);
}

function finish(
  state: ReturnType<typeof battleState>,
  kind: AdminRoomOverview['kind'],
  code: string | null,
  player: AdminSeat,
  opponent: AdminSeat,
): AdminRoomOverview {
  const seats: Record<Side, AdminSeat> = { player, enemy: opponent };
  const pending = state.pending
    ? {
        actor: state.pending.actor,
        actorName: seats[state.pending.actor].name,
        move: state.pending.move,
        moveLabel: state.pending.moveLabel,
        damage: state.pending.damage,
      }
    : null;
  return {
    code,
    kind,
    mode: state.mode,
    phase: state.phase,
    round: state.round,
    // 有待应对的攻击时，该开口的是防守方；否则是轮到主动出手的一方
    active: pending ? otherSide(pending.actor) : state.active,
    waiting: state.waiting,
    pending,
    winner: state.winner,
    updatedAt: state.updatedAt,
    players: [player, opponent],
  };
}
