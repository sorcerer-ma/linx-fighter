import { otherSide, type Battle, type BattleEvent, type Side } from './types.js';

/** 房间号长度：四位数字，语音里好念也好记 */
export const ROOM_CODE_LENGTH = 4;

/** 双人联机对局在 BattleStore 里的键：按房间存，不按设备存 */
export function pvpBattleKey(code: string): string {
  return `pvp:${code}`;
}

/**
 * 房间号归一：接受阿拉伯数字，也容忍语音识别给出的中文数字。
 * 不足或超过四位直接判为无效，交给播报层提示重说。
 */
export function normalizeRoomCode(raw: string): string | null {
  const digits = raw
    .replace(/[零一二三四五六七八九]/g, (ch) => String('零一二三四五六七八九'.indexOf(ch)))
    .replace(/[^0-9]/g, '');
  return digits.length === ROOM_CODE_LENGTH ? digits : null;
}

/** 玩家原话里是否在说「开房间 / 联机」。语音链路常把整句话塞进参数，服务端兜底识别。 */
export function wantsOpenRoom(text: string): boolean {
  return /(联机|双人|开个?房|开房|建个?房|创建房|一起打|组队)/.test(text);
}

/** 从玩家原话里抽房间号：必须带「房间 / 加入 / 进」语义，避免把普通数字当房间号 */
export function roomCodeFromPhrase(text: string): string | null {
  if (!/(房间|加入|进房)/.test(text)) return null;
  return normalizeRoomCode(text);
}

/**
 * 把某一方视角的结算事件镜像到另一方。
 * 事件里的 side 是「谁做的」，换视角时只翻 side，伤害与损失生命值这些结果不动；
 * 逐轮增益（round-start）是对局共有的，不带视角，原样留着。
 */
export function mirrorEvents(events: BattleEvent[]): BattleEvent[] {
  return events.map((event) => {
    switch (event.type) {
      case 'charge':
      case 'attack':
      case 'pending':
        return { ...event, side: otherSide(event.side) };
      case 'end':
        return { ...event, winner: otherSide(event.winner) };
      case 'round-start':
        return event;
      default: {
        // 新增事件类型时这里会编译报错，提醒补上换视角规则
        const exhaustive: never = event;
        return exhaustive;
      }
    }
  });
}

/**
 * 把服务端基准对局镜像成某一方的视角。
 * 双人联机里两位玩家各自通过 deviceId#agentId 读状态，引擎只认 player/enemy，
 * 因此第二位玩家看到的是左右互换后的局面：生命值、能量、先手、待应对一起翻转。
 */
export function viewAs(battle: Battle, side: Side): Battle {
  return side === 'player' ? battle : swapSides(battle);
}

/**
 * 把某一方视角的结算结果换回服务端基准视角。
 * 名字恢复成基准对局里的名字，避免互相看到「对手」后写回存储。
 */
export function canonicalize(view: Battle, side: Side, base: Battle): Battle {
  const battle = side === 'player' ? view : swapSides(view);
  return {
    ...battle,
    player: { ...battle.player, name: base.player.name },
    enemy: { ...battle.enemy, name: base.enemy.name },
  };
}

function swapSides(battle: Battle): Battle {
  return {
    ...battle,
    // 胜负记在基准视角上，换视角必须一起翻：否则输的一方会被告知「我赢了」
    phase: battle.phase === 'victory' ? 'defeat' : battle.phase === 'defeat' ? 'victory' : 'battle',
    player: { ...battle.enemy, id: 'player', name: '你' },
    enemy: { ...battle.player, id: 'enemy', name: '对手' },
    firstMover: otherSide(battle.firstMover),
    active: otherSide(battle.active),
    activePhases: {
      player: battle.activePhases.enemy,
      enemy: battle.activePhases.player,
    },
    pending: battle.pending ? { ...battle.pending, actor: otherSide(battle.pending.actor) } : null,
    history: battle.history.map((record) => ({ ...record, actor: otherSide(record.actor) })),
  };
}
