import type { Logger } from '../log.js';
import type { BattleStore } from '../store/battles.js';
import { EchoStore } from '../store/echoes.js';
import type { Room, RoomStore } from '../store/rooms.js';
import { readCommand, type Command, type RefuseReason, type TurnIntent } from './command.js';
import { advanceBattle, createBattle, resolveTurn } from './engine.js';
import type { IntentResolver, IntentStage } from './intent.js';
import {
  narrateActionBlocked,
  narrateAutoStart,
  narrateBattleStart,
  narrateCatchUp,
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
  narrateStaleAction,
  narrateStatus,
  narrateTurn,
  narrateTurnHint,
  narrateUnknownAction,
  narrateWaitingRoom,
} from './narrator.js';
import {
  canonicalize,
  mirrorEvents,
  normalizeRoomCode,
  pvpBattleKey,
  viewAs,
} from './pvp.js';
import { SerialQueue } from './serialize.js';
import { battleState, type BattleState } from './state.js';
import type { Battle, BattleAI, BattleEvent, Side } from './types.js';

/** 一次工具调用的结果：可直接朗读的文本 + 当前玩家视角的最新对局状态 */
export interface ServiceResult {
  text: string;
  battle: Battle | null;
}

/** 只读局面快照：给状态流与调试接口用，不做播报、不推进对局 */
export interface SnapshotResult {
  /** 四位房间号；单人局为 null */
  room: string | null;
  state: BattleState;
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

/**
 * 播报选项：由调用方按载体能力决定。
 *
 * 补账播报是给「没有屏幕」的终端准备的：对方应招的结果当下播给他，他听不到，
 * 只能攒着等他下次开口补一句。有屏客户端（网页）随时能看到局面，不需要再听一遍。
 */
export interface SayOptions {
  /** 默认 true，保持硬件端的原有体验；有屏客户端传 false */
  catchUp?: boolean;
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
  /** 对手 AI；不传则用内置的本地决策模型（JEV 决策模型从 index 注入） */
  ai?: BattleAI;
  /** 双人联机的补账消息；不传则新建一个跟对局同样过期的 */
  echo?: EchoStore;
}

/**
 * 游戏服务：MCP 工具只做参数解析，业务编排都在这里。
 * 开局、出招、应对、战况与说明都从这里进出；结算在 engine，播报在 narrator。
 *
 * 双人联机时，服务端按房主持有唯一一份基准对局，另一位玩家看到的是镜像视角；
 * 两人共用同一份气血、行动点与胜负，不依赖平台侧模型同步状态。
 *
 * 意图模型与对手决策都是异步的，所以对局状态的修改按对局串行排队；
 * 模型返回后还要确认还是同一局、同一个座位，对不上就丢弃这次结果（见 drifted*）。
 */
export class GameService {
  private readonly store: BattleStore;
  private readonly rooms: RoomStore;
  private readonly logger: Logger;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly intent?: IntentResolver;
  private readonly ai?: BattleAI;
  private readonly echo: EchoStore;
  /** 同一场对局的读改写排队执行：钥匙是单人局的玩家键或双人局的对局键 */
  private readonly queue = new SerialQueue();

  constructor(deps: GameServiceDeps) {
    this.store = deps.store;
    this.rooms = deps.rooms;
    this.logger = deps.logger;
    this.now = deps.now ?? Date.now;
    this.random = deps.random ?? Math.random;
    this.intent = deps.intent;
    this.ai = deps.ai;
    this.echo = deps.echo ?? new EchoStore({ now: this.now });
  }

  /**
   * 开一局：单人、开双人房，或凭房间号加入。
   *
   * 平台模型给了结构化参数就按参数走；给的是原话就交给 readCommand，
   * 「开房间 / 加入房间1234」这类说法和服务端自己的识别保持同一套规则。
   */
  async start(sessionKey: string, options: StartOptions = {}): Promise<ServiceResult> {
    const phrase = [options.opponent, options.text].filter(Boolean).join(' ');
    const command = options.room
      ? ({ kind: 'join-room', code: options.room } as const)
      : phrase
        ? readCommand(phrase)
        : null;
    if (command?.kind === 'join-room') return this.joinRoom(sessionKey, command.code);
    if (options.mode === 'pvp' || command?.kind === 'open-room') return this.openRoom(sessionKey);
    return this.startSolo(sessionKey, options.opponent);
  }

  /** 查看当前战况 */
  status(sessionKey: string, options: SayOptions = {}): ServiceResult {
    const room = this.rooms.byPlayer(sessionKey);
    if (room) return this.statusPvp(sessionKey, room, options);

    const battle = this.store.get(sessionKey) ?? null;
    if (!battle) return { text: narrateNoBattle(), battle: null };
    return { text: narrateStatus(battle), battle };
  }

  /** 玩法说明，用于玩家不知道说什么的场景 */
  help(): ServiceResult {
    return { text: narrateHelp(), battle: null };
  }

  /**
   * 原话入口：玩家说了什么就传什么，由服务端判成命令再分派。
   *
   * 平台侧模型不做意图判断，只把原话交进来；判定只发生一次（readCommand），
   * 之后每个分支都不再回头解析这句话。
   */
  async say(sessionKey: string, text: string, options: SayOptions = {}): Promise<ServiceResult> {
    return this.execute(sessionKey, readCommand(text), text, options);
  }

  /**
   * 按命令分派：房间、玩法、战况都在这里收口，只有招式会进对局流水线。
   *
   * 「在不在房间」只决定这一手记到哪张桌上，不再影响这句话怎么理解——
   * 所以已经在房间里的玩家说「加入房间1234」照样能换房。
   */
  private execute(
    sessionKey: string,
    command: Command,
    raw: string,
    options: SayOptions,
  ): ServiceResult | Promise<ServiceResult> {
    switch (command.kind) {
      case 'join-room':
        return this.joinRoom(sessionKey, command.code);
      case 'open-room':
        return this.openRoom(sessionKey);
      case 'help':
        return this.help();
      case 'status':
        return this.status(sessionKey, options);
      case 'start':
        return this.startSolo(sessionKey);
      case 'refused':
        return this.refuse(sessionKey, command.why, options);
      case 'turn':
        return this.play(sessionKey, command, raw, options);
      case 'unknown':
        return this.play(sessionKey, null, raw, options);
    }
  }

  /** 招式入口：在房间里就走双人局，否则走单人局 */
  private play(
    sessionKey: string,
    direct: TurnIntent | null,
    raw: string,
    options: SayOptions,
  ): Promise<ServiceResult> {
    const room = this.rooms.byPlayer(sessionKey);
    if (room) return this.playPvp(sessionKey, room.code, direct, raw, options);
    return this.playSolo(sessionKey, direct, raw, options);
  }

  /**
   * 反问、否定、一句话两招：只播提示，不推进对局，也不因为这句话顺手开一局。
   *
   * 补账照常取走：玩家问一句之后，还是要听到刚才那一手的结果。
   */
  private refuse(sessionKey: string, why: RefuseReason, options: SayOptions): ServiceResult {
    const room = this.rooms.byPlayer(sessionKey);
    this.logger.debug('这句话不该出手', { sessionKey, room: room?.code ?? null, why });
    if (room) {
      const catchUp = this.drainCatchUp(sessionKey, options.catchUp !== false);
      return { text: `${catchUp}${narrateActionBlocked(why)}`, battle: this.viewFor(sessionKey) };
    }
    const battle = this.store.get(sessionKey) ?? null;
    return { text: battle ? narrateActionBlocked(why) : narrateUnknownAction(null), battle };
  }

  /**
   * 当前玩家视角的局面快照；不在任何对局里返回 null。
   *
   * 双人房里基准对局存在房主键下，加入者看到的是镜像视角，
   * 这里按房间成员判断坐在哪一边，和出招时的视角保持一致。
   */
  snapshot(sessionKey: string): SnapshotResult | null {
    const room = this.rooms.byPlayer(sessionKey);
    if (room) {
      const canonical = this.store.get(pvpBattleKey(room.code));
      if (!canonical) return null;
      const side = this.sideOf(room, sessionKey) ?? 'player';
      const waiting = room.guestKey === null;
      return { room: room.code, state: battleState(canonical, { room: room.code, side, waiting }) };
    }

    const battle = this.store.get(sessionKey);
    if (!battle) return null;
    return { room: null, state: battleState(battle, { room: null, side: 'player' }) };
  }

  /** 单人开局：与出招共用同一把队钥匙，对手先手时不会有人插进来读改写 */
  private startSolo(sessionKey: string, opponent?: string): Promise<ServiceResult> {
    return this.queue.run(soloQueueKey(sessionKey), () => this.startSoloLocked(sessionKey, opponent));
  }

  private async startSoloLocked(sessionKey: string, opponent?: string): Promise<ServiceResult> {
    // 单人重新开局：撤掉仍在的房间，避免对手对着已失效的局面出招
    const existing = this.rooms.byPlayer(sessionKey);
    if (existing) this.leaveRoom(existing, '重新开局');

    const battle = await this.spawnSolo(opponent);

    // 等对手先手的这段时间里玩家可能已经进了房间：以房间为准，不再另开一局
    const room = this.rooms.byPlayer(sessionKey);
    if (room) return this.statusPvp(sessionKey, room, {});

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

  /**
   * 开双人房：先建基准对局，再等第二位玩家凭房间号加入。
   *
   * 已经在等人时又喊一次「开房」就复用原房间号，别让玩家每说一次就换一个码；
   * 已经开打则撤掉旧房重开——旧房里等着的对手不会对着作废的局面继续出招。
   */
  private openRoom(sessionKey: string): ServiceResult {
    const existing = this.rooms.byPlayer(sessionKey);
    if (existing && existing.hostKey === sessionKey && existing.guestKey === null) {
      return {
        text: `${narrateWaitingRoom(existing.code)}。等对手进来再开打。`,
        battle: this.store.get(pvpBattleKey(existing.code)) ?? null,
      };
    }
    if (existing) this.leaveRoom(existing, '重新开局');
    // 从单人局切到联机时把旧对局清掉，避免退出房间后还对着过期局面出招
    this.store.delete(sessionKey);
    return this.startPvp(sessionKey);
  }

  /** 单人出招：按玩家串行，模型返回时不会覆盖已经重开的新局 */
  private playSolo(
    sessionKey: string,
    direct: TurnIntent | null,
    raw: string,
    options: SayOptions,
  ): Promise<ServiceResult> {
    return this.queue.run(soloQueueKey(sessionKey), () =>
      this.playSoloLocked(sessionKey, direct, raw, options),
    );
  }

  private async playSoloLocked(
    sessionKey: string,
    direct: TurnIntent | null,
    raw: string,
    options: SayOptions,
  ): Promise<ServiceResult> {
    const battle = this.store.get(sessionKey);

    // 没有对局又认不出招式：不自动开局，避免随便一句话就开一局
    if (!direct && !battle) {
      this.logger.debug('招式无法识别', { sessionKey, raw });
      return { text: narrateUnknownAction(null), battle: null };
    }

    let current = battle;
    let prefix = '';

    // 没有对局时先顺手开一局，首句「攻击」也能玩；上一局已结束则提示重开
    if (!current) {
      const spawned = await this.spawnSolo();
      // 等对手先手的这段时间里玩家可能已经进了房间：这一手不另开
      if (this.rooms.byPlayer(sessionKey)) {
        return { text: narrateStaleAction(), battle: this.viewFor(sessionKey) };
      }
      current = spawned;
      this.store.set(sessionKey, current);
      prefix = narrateAutoStart(current);
      this.logger.info('对局自动开始', {
        sessionKey,
        battleId: current.id,
        enemy: current.enemy.name,
        firstMover: current.firstMover,
      });
    }

    if (current.phase !== 'battle') {
      return { text: narrateEnded(current), battle: current };
    }

    const match = direct ?? (await this.resolveWithIntent(raw, current, 'player'));
    if (!match) {
      this.logger.debug('招式无法识别', { sessionKey, raw });
      return { text: `${prefix}${narrateUnknownAction(current)}`, battle: current };
    }

    // 模型回复期间玩家可能重开、换房：不是刚才那一局就丢弃这次识别，绝不写回旧快照
    if (this.driftedSolo(sessionKey, current)) {
      this.logger.info('局面已变，丢弃这次识别', { sessionKey, battleId: current.id, action: match.action });
      return { text: narrateStaleAction(), battle: this.viewFor(sessionKey) };
    }

    const result = await resolveTurn(current, match.action, this.now(), { ai: this.ai });
    if (result.rejection) {
      this.logger.debug('操作不合法', {
        sessionKey,
        battleId: current.id,
        round: current.round,
        action: match.action,
        reason: result.rejection.reason,
      });
      return { text: `${prefix}${narrateRejection(result.battle, result.rejection)}`, battle: result.battle };
    }

    // 结算里也要等对手决策，写回前再确认一次
    if (this.driftedSolo(sessionKey, current)) {
      return { text: narrateStaleAction(), battle: this.viewFor(sessionKey) };
    }

    this.store.set(sessionKey, result.battle);
    this.logger.info('玩家操作', {
      sessionKey,
      battleId: result.battle.id,
      round: result.battle.round,
      action: match.action,
      chant: match.chant,
    });

    const chantLine = match.chant ? narrateChant(match.chant) : '';
    return {
      text: `${prefix}${chantLine}${narrateTurn(result.battle, result.events)}`,
      battle: result.battle,
    };
  }

  /** 开双人房：先建基准对局，再等第二位玩家凭房间号加入 */
  private startPvp(sessionKey: string): ServiceResult {
    const room = this.rooms.create(sessionKey);
    const battle = this.createPvpBattle();
    this.store.set(pvpBattleKey(room.code), battle);
    this.logger.info('房间创建', { sessionKey, room: room.code, battleId: battle.id });
    // 开房时对手还没进来，不能提前播「对决开始」，否则玩家会以为已经有对手了
    return {
      text: `${narrateRoomCreated(room.code)}。等对手进来再开打。`,
      battle,
    };
  }

  /** 双人基准对局：两边都是人，先手在开局时随机定 */
  private createPvpBattle(): Battle {
    return createBattle({
      enemyName: '对手',
      now: this.now(),
      seed: Math.floor(this.random() * 0x7fffffff),
      mode: 'pvp',
    });
  }

  /**
   * 凭房间号加入：成功即把该玩家接到房主的对局上。
   *
   * 顺序是先验证目标房、再占座、最后才撤旧房：加入失败时原来那间房、
   * 那场对局与补账都不动；撤旧房也顺手清掉旧对局和补账，
   * 保证一个人同一时间只在一个有效房间里，旧房里的对手不会永远等不到响应。
   */
  private joinRoom(sessionKey: string, rawRoom: string): ServiceResult {
    const fallback = this.store.get(sessionKey) ?? null;
    const code = normalizeRoomCode(rawRoom);
    if (!code) {
      this.logger.debug('房间号格式不对', { sessionKey, rawRoom });
      return { text: narrateRoomInvalid(), battle: fallback };
    }

    const current = this.rooms.byPlayer(sessionKey);
    const target = this.rooms.get(code);

    // 房主自己拿房间号加入：不把它登记成加入者，只提示还在等人
    if (target && target.hostKey === sessionKey) {
      this.logger.debug('房主自己加入房间', { sessionKey, room: code });
      return {
        text: narrateWaitingRoom(code),
        battle: fallback ?? this.store.get(pvpBattleKey(code)) ?? null,
      };
    }

    if (!target) {
      this.logger.info('房间加入失败', { sessionKey, room: code, reason: 'missing' });
      return { text: narrateRoomMissing(code), battle: fallback };
    }
    if (target.guestKey !== null && target.guestKey !== sessionKey) {
      this.logger.info('房间加入失败', { sessionKey, room: code, reason: 'full' });
      return { text: narrateRoomFull(code), battle: fallback };
    }

    const canonical = this.store.get(pvpBattleKey(code));
    if (!canonical) {
      this.rooms.remove(code);
      this.logger.warn('房间存在但对局已过期', { sessionKey, room: code });
      return { text: narrateRoomMissing(code), battle: fallback };
    }

    const joined = this.rooms.join(code, sessionKey);
    if (!joined.ok) {
      // 目标房刚刚验证过，走到这里只可能是并发撤房；原有房间保持不动
      this.logger.info('房间加入失败', { sessionKey, room: code, reason: joined.reason });
      return {
        text: joined.reason === 'full' ? narrateRoomFull(code) : narrateRoomMissing(code),
        battle: fallback,
      };
    }

    // 座位先占上，再撤旧房：撤房失败也不会出现一个人同时在两间房里
    if (current && current.code !== code) this.leaveRoom(current, '换房');

    const view = viewAs(canonical, 'enemy');
    this.store.delete(sessionKey);
    this.rooms.touch(code);
    this.logger.info('房间加入', {
      sessionKey,
      room: code,
      battleId: canonical.id,
      round: canonical.round,
      from: current?.code ?? null,
    });
    const fresh = view.history.length === 0 && view.round === 1 && !view.pending;
    const opening = fresh
      ? `${narrateRoomJoined(code)}。${narrateBattleStart(view)}`
      : `${narrateRoomJoined(code)}。${narrateStatus(view)}`;
    return { text: opening, battle: view };
  }

  /** 双人出招：同一房间的请求排队处理，两次结算不会交错写回基准对局 */
  private playPvp(
    sessionKey: string,
    roomCode: string,
    direct: TurnIntent | null,
    raw: string,
    options: SayOptions,
  ): Promise<ServiceResult> {
    return this.queue.run(pvpBattleKey(roomCode), () =>
      this.playPvpLocked(sessionKey, roomCode, direct, raw, options),
    );
  }

  private async playPvpLocked(
    sessionKey: string,
    roomCode: string,
    direct: TurnIntent | null,
    raw: string,
    options: SayOptions,
  ): Promise<ServiceResult> {
    // 排队期间房间可能已经被撤掉（对手换房、房主重开），进队列后重新确认座位
    const live = this.rooms.get(roomCode);
    const side = live ? this.sideOf(live, sessionKey) : null;
    if (!live || !side) {
      this.logger.debug('双人房间已失效', { sessionKey, room: roomCode });
      return { text: narrateRoomMissing(roomCode), battle: null };
    }

    const key = pvpBattleKey(live.code);
    const canonical = this.store.get(key);
    if (!canonical) {
      this.rooms.remove(live.code);
      this.logger.warn('房间对局已过期', { sessionKey, room: live.code });
      return { text: narrateRoomMissing(live.code), battle: null };
    }

    const catchUp = this.drainCatchUp(sessionKey, options.catchUp !== false);
    const view = viewAs(canonical, side);

    const match = direct ?? (await this.resolveWithIntent(raw, view, 'player'));
    if (!match) {
      this.logger.debug('双人招式无法识别', { sessionKey, room: live.code, raw });
      return { text: `${catchUp}${narrateUnknownAction(view)}`, battle: view };
    }
    if (live.guestKey === null) {
      return { text: `${catchUp}${narrateWaitingRoom(live.code)}`, battle: view };
    }

    // 模型回复期间对手可能已经应招、房主可能重开：不是同一局就不结算
    if (this.driftedPvp(sessionKey, live.code, canonical, side)) {
      this.logger.info('双人局面已变，丢弃这次识别', {
        sessionKey,
        room: live.code,
        battleId: canonical.id,
        action: match.action,
      });
      return { text: narrateStaleAction(), battle: this.viewFor(sessionKey) };
    }

    const result = await resolveTurn(view, match.action, this.now(), { ai: this.ai });
    if (result.rejection) {
      this.logger.debug('双人操作不合法', {
        sessionKey,
        room: live.code,
        battleId: view.id,
        round: view.round,
        side,
        action: match.action,
        reason: result.rejection.reason,
      });
      return { text: `${catchUp}${narrateRejection(view, result.rejection)}`, battle: view };
    }

    // 结算自己也 await 过对手决策：写回前再确认一次，别把旧快照盖回新局
    const settled = this.rooms.get(live.code);
    if (!settled || this.driftedPvp(sessionKey, live.code, canonical, side)) {
      return { text: narrateStaleAction(), battle: this.viewFor(sessionKey) };
    }

    this.store.set(key, canonicalize(result.battle, side, canonical));
    this.rooms.touch(settled.code);
    this.logger.info('双人操作', {
      sessionKey,
      room: settled.code,
      battleId: view.id,
      round: result.battle.round,
      side,
      action: match.action,
      chant: match.chant,
      phase: result.battle.phase,
      next: result.battle.pending ? `${result.battle.pending.actor} 待应对` : result.battle.active,
    });

    // 这一轮真正结算完了，另一位玩家错过的结果记下来等他开口
    if (!result.battle.pending) this.recordCatchUp(settled, side, result.battle, result.events);

    const chantLine = match.chant ? narrateChant(match.chant) : '';
    return {
      text: `${catchUp}${chantLine}${this.pvpTurnText(result.battle, result.events)}`,
      battle: result.battle,
    };
  }

  /** 双人战况：房主等待加入时额外提示，其余按视角播报 */
  private statusPvp(sessionKey: string, room: Room, options: SayOptions): ServiceResult {
    const canonical = this.store.get(pvpBattleKey(room.code));
    if (!canonical) {
      this.rooms.remove(room.code);
      return { text: narrateRoomMissing(room.code), battle: null };
    }

    const live = this.rooms.get(room.code) ?? room;
    const side = this.sideOf(live, sessionKey) ?? 'player';
    const view = viewAs(canonical, side);
    const catchUp = this.drainCatchUp(sessionKey, options.catchUp !== false);
    if (live.guestKey === null) {
      return {
        text: `${catchUp}${narrateWaitingRoom(live.code)}。${narrateStatus(view)}`,
        battle: view,
      };
    }
    return { text: `${catchUp}${narrateStatus(view)}`, battle: view };
  }

  /** 规则没认出来时，交给 JEV 模型归一化；不在自己的回合就不打扰模型 */
  private async resolveWithIntent(raw: string, battle: Battle, side: Side): Promise<TurnIntent | null> {
    if (!this.intent) return null;
    const stage = stageFor(battle, side);
    if (!stage) return null;
    let id: Awaited<ReturnType<IntentResolver['resolve']>>;
    try {
      id = await this.intent.resolve(raw, stage);
    } catch (error) {
      this.logger.warn('意图模型调用异常，按没认出来处理', {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
    if (!id) return null;
    this.logger.info('意图模型归一化', { text: raw, action: id, stage });
    return { action: id };
  }

  /** 双人回合播报：轮次信息并进最后一句，保证最多两句 */
  private pvpTurnText(battle: Battle, events: BattleEvent[]): string {
    const narration = narrateTurn(battle, events);
    if (battle.phase !== 'battle' || battle.pending) return narration;
    return `${narration.replace(/。$/, '')}，${narrateTurnHint(battle)}。`;
  }

  /**
   * 取走这位玩家错过的结算；没有就给空串，拼在播报最前面。
   *
   * 有屏客户端照样取走（避免队列越攒越长、下次换回语音终端时补一堆旧账），
   * 只是不拼进播报——它自己能从局面里看到。
   */
  private drainCatchUp(sessionKey: string, want: boolean): string {
    const lines = this.echo.take(sessionKey);
    return want && lines.length > 0 ? narrateCatchUp(lines) : '';
  }

  /**
   * 把这一手的结算记给不在场的另一方。
   *
   * 双人局里出招方的结算只回给本人：对方要等到自己的回合才应招，在那之前
   * 出手方听不到结果，只能先攒着，等他下次开口补一句。只有这一轮真正结算完
   * （没有待应对）才记——刚出招锁定攻击时对方还没应，记了就是复述。
   */
  private recordCatchUp(room: Room, actor: Side, view: Battle, events: BattleEvent[]): void {
    const waitingKey = actor === 'player' ? room.guestKey : room.hostKey;
    if (!waitingKey) return;
    // 出招方的视角里自己永远是 player，镜像一次就是那位等着的玩家
    const missed = mirrorEvents(events).filter(
      (event) => event.type !== 'round-start' && event.type !== 'end',
    );
    this.echo.push(waitingKey, narrateTurn(viewAs(view, 'enemy'), missed));
  }

  /** 房主/加入者对应的视角；不在房间返回 null */
  private sideOf(room: Room, sessionKey: string): Side | null {
    if (room.hostKey === sessionKey) return 'player';
    if (room.guestKey === sessionKey) return 'enemy';
    return null;
  }

  /**
   * 撤掉房间与对应基准对局。
   *
   * 换房、重开都走这里：对局与补账一起清掉，旧房里的对手会收到「没找到房间」，
   * 不会对着已经作废的局面继续等响应。
   */
  private leaveRoom(room: Room, reason: string): void {
    this.store.delete(pvpBattleKey(room.code));
    this.rooms.remove(room.code);
    // 换局了，上一局没补完的结果不能补到新对局里
    this.echo.clear(room.hostKey);
    if (room.guestKey) this.echo.clear(room.guestKey);
    this.logger.info('房间关闭', { room: room.code, reason });
  }

  /**
   * 异步返回后确认还是同一局、同一个人。
   *
   * 对局每次结算或重开都会换一个新对象写回存储，所以对象没换就说明中间没人动过；
   * 玩家中途进了房间也算局面变了——单人局的那一手不该再落到房间里的局面上。
   */
  private driftedSolo(sessionKey: string, snapshot: Battle): boolean {
    if (this.rooms.byPlayer(sessionKey)) return true;
    return this.store.get(sessionKey) !== snapshot;
  }

  /** 双人局还要确认座位没变：对手可能换房，房主可能重开 */
  private driftedPvp(sessionKey: string, roomCode: string, snapshot: Battle, side: Side): boolean {
    if (this.store.get(pvpBattleKey(roomCode)) !== snapshot) return true;
    const room = this.rooms.get(roomCode);
    return !room || this.sideOf(room, sessionKey) !== side;
  }

  /** 当前玩家视角的最新局面：房间里按座位镜像，单人是自己的对局 */
  private viewFor(sessionKey: string): Battle | null {
    const room = this.rooms.byPlayer(sessionKey);
    if (room) {
      const canonical = this.store.get(pvpBattleKey(room.code));
      const side = this.sideOf(room, sessionKey);
      return canonical && side ? viewAs(canonical, side) : null;
    }
    return this.store.get(sessionKey) ?? null;
  }

  /** 创建单人局；对手先手时先推进它第一个主动阶段，避免玩家对着空局面出招 */
  private async spawnSolo(opponent?: string): Promise<Battle> {
    const battle = createBattle({
      enemyName: opponent,
      now: this.now(),
      seed: Math.floor(this.random() * 0x7fffffff),
    });
    if (battle.firstMover !== 'enemy') return battle;
    return (await advanceBattle(battle, this.now())).battle;
  }
}

/** 单人局的队钥匙：同一玩家的开局与出招排队执行 */
function soloQueueKey(sessionKey: string): string {
  return `solo:${sessionKey}`;
}

/** 当前视角所处的阶段：等自己出招 → active，等自己应对 → response，其余 null */
function stageFor(battle: Battle, side: Side): IntentStage | null {
  if (battle.phase !== 'battle') return null;
  if (battle.pending) return battle.pending.actor === side ? null : 'response';
  return battle.active === side ? 'active' : null;
}
