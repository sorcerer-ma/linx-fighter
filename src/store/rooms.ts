export interface Room {
  /** 四位房间号，玩家之间口播 */
  code: string;
  /** 房主的对局键：deviceId#agentId */
  hostKey: string;
  /** 加入者的对局键；为空表示还在等人 */
  guestKey: string | null;
  createdAt: number;
  updatedAt: number;
}

export type JoinResult = { ok: true; room: Room } | { ok: false; reason: 'missing' | 'full' };

export interface RoomStoreOptions {
  /** 房间空闲多久后清理（毫秒） */
  ttlMs: number;
  now?: () => number;
  random?: () => number;
}

/**
 * 双人对战房间。单实例内存实现，和 BattleStore 一样先用进程内存，
 * 生成四位房间号，同时维护「对局键 → 房间号」的反向索引，出招时不用额外参数。
 */
export class RoomStore {
  private readonly rooms = new Map<string, Room>();
  private readonly playerToRoom = new Map<string, string>();
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly random: () => number;

  constructor(options: RoomStoreOptions) {
    this.ttlMs = options.ttlMs;
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
  }

  /** 房主开房；同一个对局键之前有房间就先撤掉，避免一人占两个房间 */
  create(hostKey: string): Room {
    this.removeByPlayer(hostKey);
    const now = this.now();
    const room: Room = {
      code: this.generateCode(),
      hostKey,
      guestKey: null,
      createdAt: now,
      updatedAt: now,
    };
    this.rooms.set(room.code, room);
    this.playerToRoom.set(hostKey, room.code);
    return room;
  }

  /** 加入房间：房间号不存在与已满分别返回，方便播报不同提示 */
  join(code: string, key: string): JoinResult {
    const room = this.get(code);
    if (!room) return { ok: false, reason: 'missing' };
    if (room.guestKey !== null && room.guestKey !== key) return { ok: false, reason: 'full' };
    room.guestKey = key;
    room.updatedAt = this.now();
    this.playerToRoom.set(key, room.code);
    return { ok: true, room };
  }

  /** 按对局键找当前所在房间，已过期视为不在房间 */
  byPlayer(key: string): Room | undefined {
    const code = this.playerToRoom.get(key);
    if (!code) return undefined;
    const room = this.get(code);
    if (!room) {
      this.playerToRoom.delete(key);
      return undefined;
    }
    return room;
  }

  get(code: string): Room | undefined {
    const room = this.rooms.get(code);
    if (!room) return undefined;
    if (this.isExpired(room)) {
      this.remove(room.code);
      return undefined;
    }
    return room;
  }

  /** 房间有活动时续期，避免下棋下到一半被清理 */
  touch(code: string): void {
    const room = this.rooms.get(code);
    if (room) room.updatedAt = this.now();
  }

  remove(code: string): void {
    const room = this.rooms.get(code);
    if (!room) return;
    this.rooms.delete(code);
    if (this.playerToRoom.get(room.hostKey) === code) this.playerToRoom.delete(room.hostKey);
    if (room.guestKey && this.playerToRoom.get(room.guestKey) === code) {
      this.playerToRoom.delete(room.guestKey);
    }
  }

  /** 清理过期房间，返回清理数量；每次写入顺带扫一遍 */
  sweep(): number {
    let removed = 0;
    for (const room of [...this.rooms.values()]) {
      if (this.isExpired(room)) {
        this.remove(room.code);
        removed += 1;
      }
    }
    return removed;
  }

  get size(): number {
    return this.rooms.size;
  }

  private removeByPlayer(key: string): void {
    const code = this.playerToRoom.get(key);
    if (code) this.remove(code);
  }

  private isExpired(room: Room): boolean {
    return this.now() - room.updatedAt > this.ttlMs;
  }

  /** 生成四位房间号；碰撞就重试，连撞 100 次说明房间很多，退化成按序补位 */
  private generateCode(): string {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const code = String(1000 + Math.floor(this.random() * 9000));
      if (!this.rooms.has(code)) return code;
    }
    for (let n = 1000; n <= 9999; n += 1) {
      if (!this.rooms.has(String(n))) return String(n);
    }
    throw new Error('房间号已用尽');
  }
}
