import type { Logger } from '../log.js';
import type { BattleStore } from '../store/battles.js';
import type { Room, RoomStore } from '../store/rooms.js';
import { matchAction, type ActionMatch } from './actions.js';
import { advanceBattle, createBattle, resolveTurn } from './engine.js';
import type { IntentResolver, IntentStage } from './intent.js';
import {
  narrateAutoStart,
  narrateBattleStart,
  narrateChant,
  narrateEnded,
  narrateHelp,
  narrateNoBattle,
  narrateRejection,
  narrateRoomCreated,
  narrateRoomFull,
  narrateRoomInvalid,
  narrateRoomJoined,
  narrateRoomMissing,
  narrateStatus,
  narrateTurn,
  narrateTurnHint,
  narrateUnknownAction,
  narrateWaitingRoom,
} from './narrator.js';
import { canonicalize, normalizeRoomCode, pvpBattleKey, roomCodeFromPhrase, viewAs, wantsOpenRoom } from './pvp.js';
import type { Battle, BattleEvent, Side } from './types.js';

/** 一次工具调用的结果：可直接朗读的文本 + 当前玩家视角的最新对局状态 */
export interface ServiceResult {
  text: string;
  battle: Battle | null;
}

/** 开局参数：单人可指定对手名；双人可开房或加入房间 */
export interface StartOptions {
  opponent?: string;
  mode?: 'solo' | 'pvp';
  /** 四位房间号，填了就加入房间，忽略 mode */
  room?: string;
  /** 玩家原话：平台模型不确定结构化参数时塞进来，服务端兜底识别「开房间 / 加入房间」 */
  text?: string;
}

export interface GameServiceDeps {
  store: BattleStore;
  rooms: RoomStore;
  logger: Logger;
  /** 便于单测注入固定时间与随机数，生产用默认值 */
  now?: () => number;
  random?: () => number;
  /** JEV 意图模型；不传则只走规则匹配 */
  intent?: IntentResolver;
}

/**
 * 游戏服务：MCP 工具只做参数解析，业务编排都在这里。
 * 开局、出招、应对、战况与说明都从这里进出；结算在 engine，播报在 narrator。
 *
 * 双人联机时，服务端按房主持有唯一一份基准对局，另一位玩家看到的是镜像视角；
 * 两人共用同一份气血、行动点与胜负，不依赖平台侧模型同步状态。
 */
export class GameService {
  private readonly store: BattleStore;
  private readonly rooms: RoomStore;
  private readonly logger: Logger;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly intent?: IntentResolver;

  constructor(deps: GameServiceDeps) {
    this.store = deps.store;
    this.rooms = deps.rooms;
    this.logger = deps.logger;
    this.now = deps.now ?? Date.now;
    this.random = deps.random ?? Math.random;
    this.intent = deps.intent;
  }

  /** 开一局：单人、开双人房，或凭房间号加入 */
  start(sessionKey: string, options: StartOptions = {}): ServiceResult {
    if (options.room) return this.joinRoom(sessionKey, options.room);

    // 语音链路常把整句话塞进参数：先看原话里有没有房间号和联机意图
    const phrase = [options.opponent, options.text].filter(Boolean).join(' ');
    const phraseRoom = roomCodeFromPhrase(phrase);
    if (phraseRoom) return this.joinRoom(sessionKey, phraseRoom);

    // 已在房间里又开新局：先撤掉旧房间与旧对局，避免对手对着已失效的局面出招
    const existing = this.rooms.byPlayer(sessionKey);
    if (existing) this.leaveRoom(existing, '重新开局');

    if (options.mode === 'pvp' || wantsOpenRoom(phrase)) {
      // 从单人局切到联机时把旧对局清掉，避免退出房间后还对着过期局面出招
      this.store.delete(sessionKey);
      return this.startPvp(sessionKey);
    }

    const battle = this.spawnSolo(options.opponent);
    this.store.set(sessionKey, battle);
    this.logger.info('对局开始', {
      sessionKey,
      battleId: battle.id,
      enemy: battle.enemy.name,
      firstMover: battle.firstMover,
    });
    const text = [
      narrateBattleStart(battle),
      battle.pending ? narrateTurn(battle, []) : '说普攻、强攻、大招或蓄力出招。',
    ].join('');
    return { text, battle };
  }

  /** 执行一次玩家出招或应对 */
  async act(sessionKey: string, rawAction: string): Promise<ServiceResult> {
    const room = this.rooms.byPlayer(sessionKey);
    if (room) return this.actPvp(sessionKey, room, rawAction);

    // 平台模型可能把「开房间」「加入房间1234」原话直接传进 action，这里兜底成联机操作
    const phraseRoom = roomCodeFromPhrase(rawAction);
    if (phraseRoom) return this.joinRoom(sessionKey, phraseRoom);
    if (wantsOpenRoom(rawAction)) {
      this.store.delete(sessionKey);
      return this.startPvp(sessionKey);
    }

    const direct = matchAction(rawAction);
    // 没有对局又认不出招式：不自动开局，避免随便一句话就开一局
    if (!direct && !this.store.get(sessionKey)) {
      this.logger.debug('招式无法识别', { sessionKey, rawAction });
      return { text: narrateUnknownAction(null), battle: null };
    }

    let battle = this.store.get(sessionKey);
    let prefix = '';

    // 没有对局时先顺手开一局，首句「攻击」也能玩；上一局已结束则提示重开
    if (!battle) {
      battle = this.spawnSolo();
      this.store.set(sessionKey, battle);
      prefix = narrateAutoStart(battle);
      this.logger.info('对局自动开始', {
        sessionKey,
        battleId: battle.id,
        enemy: battle.enemy.name,
        firstMover: battle.firstMover,
      });
    }

    if (battle.phase !== 'battle') {
      return { text: narrateEnded(battle), battle };
    }

    const match = direct ?? (await this.resolveWithIntent(rawAction, battle, 'player'));
    if (!match) {
      this.logger.debug('招式无法识别', { sessionKey, rawAction });
      return { text: `${prefix}${narrateUnknownAction(battle)}`, battle };
    }

    const result = resolveTurn(battle, match.id, this.now());
    if (result.rejection) {
      this.logger.debug('操作不合法', {
        sessionKey,
        battleId: battle.id,
        round: battle.round,
        action: match.id,
        reason: result.rejection.reason,
      });
      return { text: `${prefix}${narrateRejection(result.battle, result.rejection)}`, battle: result.battle };
    }

    this.store.set(sessionKey, result.battle);
    this.logger.info('玩家操作', {
      sessionKey,
      battleId: result.battle.id,
      round: result.battle.round,
      action: match.id,
      chant: match.chant,
    });

    const chantLine = match.chant ? narrateChant(match.chant) : '';
    return {
      text: `${prefix}${chantLine}${narrateTurn(result.battle, result.events)}`,
      battle: result.battle,
    };
  }

  /** 查看当前战况 */
  status(sessionKey: string): ServiceResult {
    const room = this.rooms.byPlayer(sessionKey);
    if (room) return this.statusPvp(sessionKey, room);

    const battle = this.store.get(sessionKey) ?? null;
    if (!battle) return { text: narrateNoBattle(), battle: null };
    return { text: narrateStatus(battle), battle };
  }

  /** 玩法说明，用于玩家不知道说什么的场景 */
  help(): ServiceResult {
    return { text: narrateHelp(), battle: null };
  }

  /** 开双人房：先建基准对局，再等第二位玩家凭房间号加入 */
  private startPvp(sessionKey: string): ServiceResult {
    const room = this.rooms.create(sessionKey);
    const battle = createBattle({
      enemyName: '对手',
      now: this.now(),
      seed: Math.floor(this.random() * 0x7fffffff),
      mode: 'pvp',
    });
    this.store.set(pvpBattleKey(room.code), battle);
    this.logger.info('房间创建', { sessionKey, room: room.code, battleId: battle.id });
    return {
      text: `${narrateRoomCreated(room.code)}。${narrateBattleStart(battle)}`,
      battle,
    };
  }

  /** 凭房间号加入：成功即把该玩家接到房主的对局上 */
  private joinRoom(sessionKey: string, rawRoom: string): ServiceResult {
    const fallback = this.store.get(sessionKey) ?? null;
    const code = normalizeRoomCode(rawRoom);
    if (!code) {
      this.logger.debug('房间号格式不对', { sessionKey, rawRoom });
      return { text: narrateRoomInvalid(), battle: fallback };
    }

    // 房主自己拿房间号加入：不把它登记成加入者，只提示还在等人
    const existing = this.rooms.get(code);
    if (existing && existing.hostKey === sessionKey) {
      this.logger.debug('房主自己加入房间', { sessionKey, room: code });
      return {
        text: narrateWaitingRoom(code),
        battle: fallback ?? this.store.get(pvpBattleKey(code)) ?? null,
      };
    }

    const joined = this.rooms.join(code, sessionKey);
    if (!joined.ok) {
      this.logger.info('房间加入失败', { sessionKey, room: code, reason: joined.reason });
      return {
        text: joined.reason === 'full' ? narrateRoomFull(code) : narrateRoomMissing(code),
        battle: fallback,
      };
    }

    const canonical = this.store.get(pvpBattleKey(code));
    if (!canonical) {
      this.rooms.remove(code);
      this.logger.warn('房间存在但对局已过期', { sessionKey, room: code });
      return { text: narrateRoomMissing(code), battle: fallback };
    }

    if (joined.room.hostKey === sessionKey) {
      this.logger.debug('房主自己加入房间', { sessionKey, room: code });
      return { text: narrateWaitingRoom(code), battle: canonical };
    }

    const view = viewAs(canonical, 'enemy');
    this.store.delete(sessionKey);
    this.rooms.touch(code);
    this.logger.info('房间加入', {
      sessionKey,
      room: code,
      battleId: canonical.id,
      round: canonical.round,
    });
    const fresh = view.history.length === 0 && view.round === 1 && !view.pending;
    const opening = fresh
      ? `${narrateRoomJoined(code)}。${narrateBattleStart(view)}`
      : `${narrateRoomJoined(code)}。${narrateStatus(view)}`;
    return { text: opening, battle: view };
  }

  /** 双人出招：按对局键判断视角，结算后写回基准对局 */
  private async actPvp(sessionKey: string, room: Room, rawAction: string): Promise<ServiceResult> {
    const canonical = this.store.get(pvpBattleKey(room.code));
    if (!canonical) {
      this.rooms.remove(room.code);
      this.logger.warn('房间对局已过期', { sessionKey, room: room.code });
      return { text: narrateRoomMissing(room.code), battle: null };
    }

    const live = this.rooms.get(room.code) ?? room;
    const side = this.sideOf(live, sessionKey);
    if (!side) {
      // 理论上 byPlayer 已经保证，留一条兜底避免把别人房间当成自己的
      return { text: narrateRoomMissing(live.code), battle: canonical };
    }

    const view = viewAs(canonical, side);
    const match = matchAction(rawAction) ?? (await this.resolveWithIntent(rawAction, view, 'player'));
    if (!match) {
      this.logger.debug('双人招式无法识别', { sessionKey, room: live.code, rawAction });
      return { text: narrateUnknownAction(view), battle: view };
    }
    if (live.guestKey === null) {
      return { text: narrateWaitingRoom(live.code), battle: view };
    }

    const result = resolveTurn(view, match.id, this.now());
    if (result.rejection) {
      this.logger.debug('双人操作不合法', {
        sessionKey,
        room: live.code,
        battleId: view.id,
        round: view.round,
        side,
        action: match.id,
        reason: result.rejection.reason,
      });
      return { text: narrateRejection(view, result.rejection), battle: view };
    }

    this.store.set(pvpBattleKey(live.code), canonicalize(result.battle, side, canonical));
    this.rooms.touch(live.code);
    this.logger.info('双人操作', {
      sessionKey,
      room: live.code,
      battleId: view.id,
      round: result.battle.round,
      side,
      action: match.id,
      chant: match.chant,
      phase: result.battle.phase,
      next: result.battle.pending ? `${result.battle.pending.actor} 待应对` : result.battle.active,
    });

    const chantLine = match.chant ? narrateChant(match.chant) : '';
    return {
      text: `${chantLine}${this.pvpTurnText(result.battle, result.events)}`,
      battle: result.battle,
    };
  }

  /** 双人战况：房主等待加入时额外提示，其余按视角播报 */
  private statusPvp(sessionKey: string, room: Room): ServiceResult {
    const canonical = this.store.get(pvpBattleKey(room.code));
    if (!canonical) {
      this.rooms.remove(room.code);
      return { text: narrateRoomMissing(room.code), battle: null };
    }

    const live = this.rooms.get(room.code) ?? room;
    const side = this.sideOf(live, sessionKey) ?? 'player';
    const view = viewAs(canonical, side);
    if (live.guestKey === null) {
      return {
        text: `${narrateWaitingRoom(live.code)}。${narrateStatus(view)}`,
        battle: view,
      };
    }
    return { text: `${narrateStatus(view)}`, battle: view };
  }

  /** 规则没认出来时，交给 JEV 模型归一化；不在自己的回合就不打扰模型 */
  private async resolveWithIntent(rawAction: string, battle: Battle, side: Side): Promise<ActionMatch | null> {
    if (!this.intent) return null;
    const stage = stageFor(battle, side);
    if (!stage) return null;
    let id: Awaited<ReturnType<IntentResolver['resolve']>>;
    try {
      id = await this.intent.resolve(rawAction, stage);
    } catch (error) {
      this.logger.warn('意图模型调用异常，按没认出来处理', {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
    if (!id) return null;
    this.logger.info('意图模型归一化', { text: rawAction, action: id, stage });
    return { id };
  }

  /** 双人回合播报：轮次信息并进最后一句，保证最多两句 */
  private pvpTurnText(battle: Battle, events: BattleEvent[]): string {
    const narration = narrateTurn(battle, events);
    if (battle.phase !== 'battle' || battle.pending) return narration;
    return `${narration.replace(/。$/, '')}，${narrateTurnHint(battle)}。`;
  }

  /** 房主/加入者对应的视角；不在房间返回 null */
  private sideOf(room: Room, sessionKey: string): Side | null {
    if (room.hostKey === sessionKey) return 'player';
    if (room.guestKey === sessionKey) return 'enemy';
    return null;
  }

  /** 撤掉房间与对应基准对局 */
  private leaveRoom(room: Room, reason: string): void {
    this.store.delete(pvpBattleKey(room.code));
    this.rooms.remove(room.code);
    this.logger.info('房间关闭', { room: room.code, reason });
  }

  /** 创建单人局；对手先手时先推进它第一个主动阶段，避免玩家对着空局面出招 */
  private spawnSolo(opponent?: string): Battle {
    const battle = createBattle({
      enemyName: opponent,
      now: this.now(),
      seed: Math.floor(this.random() * 0x7fffffff),
    });
    if (battle.firstMover !== 'enemy') return battle;
    return advanceBattle(battle, this.now()).battle;
  }
}

/** 当前视角所处的阶段：等自己出招 → active，等自己应对 → response，其余 null */
function stageFor(battle: Battle, side: Side): IntentStage | null {
  if (battle.phase !== 'battle') return null;
  if (battle.pending) return battle.pending.actor === side ? null : 'response';
  return battle.active === side ? 'active' : null;
}
