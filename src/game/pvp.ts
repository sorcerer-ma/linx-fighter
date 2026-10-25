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
  const match = /^(?:(?:挑战)?编号|房间号?)?\s*([0-9零〇一幺二两三四五六七八九\s]+)[。.!！]?$/u.exec(raw.trim());
  if (!match) return null;
  const spoken: Record<string,string> = {零:'0',〇:'0',一:'1',幺:'1',二:'2',两:'2',三:'3',四:'4',五:'5',六:'6',七:'7',八:'8',九:'9'};
  const digits = match[1]!.replace(/\s/g,'').replace(/[零〇一幺二两三四五六七八九]/g, ch=>spoken[ch]!);
  return digits.length === ROOM_CODE_LENGTH ? digits : null;
}

/**
 * 玩家原话里是否在发起双人挑战。
 * 主路径是新口令「共鸣对决，发起挑战」；旧的联机 / 开房说法保留兼容。
 */
export function wantsOpenRoom(text: string): boolean {
  return /(发起挑战|挑战你|联机|双人|开个?房|开房|建个?房|创建房|一起打|组队)/.test(text);
}

/** Explicit acceptance intent must not fall through to generic creation/model routing. */
export function wantsJoinRoom(text: string): boolean {
  return /(?:接受挑战|加入(?:双人)?(?:挑战|房间|对局|对战)|进房)/.test(text);
}

/**
 * 从玩家原话里抽挑战编号：主路径是「接受挑战，编号1234」，
 * 旧说法「加入房间1234」「进房1234」继续兼容；普通数字不当编号。
 */
export function roomCodeFromPhrase(text: string): string | null {
  if (!/(接受挑战|加入|进房|房间)/.test(text)) return null;
  // Extract a number at its semantic position, never concatenate unrelated digits
  // (e.g. “编号12，我还有34点能量” must not become room 1234).
  const labelled = [...text.matchAll(/(?:挑战编号|房间号|编号)\s*[:：]?\s*([0-9零〇一幺二两三四五六七八九][0-9零〇一幺二两三四五六七八九\s]*)/gu)];
  if (labelled.length > 1) return null;
  const match = labelled[0] ?? /(?:接受挑战|加入(?:双人)?(?:挑战|房间|对局|对战)?|进房(?:间)?|房间)\s*[，,:：]?\s*([0-9零〇一幺二两三四五六七八九][0-9零〇一幺二两三四五六七八九\s]*)/u.exec(text);
  if (!match) return null;
  const rest = text.slice(match.index! + match[0].length);
  if (/^(?:点|轮|次|回合|生命|能量|血)/.test(rest)) return null;
  return normalizeRoomCode(match[1]!);
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
