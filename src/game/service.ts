import type { Logger } from '../log.js';
import type { BattleStore } from '../store/battles.js';
import { EchoStore } from '../store/echoes.js';
import type { Room, RoomStore } from '../store/rooms.js';
import type { ChatAnswerer } from './chat.js';
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
  narrateOpening,
  narrateOutsideUnavailable,
  narrateRejection,
  narrateRoomCreated,
  narrateRoomFull,
  narrateRoomInvalid,
  narrateRoomJoined,
  narrateRoomMissing,
  narrateStaleAction,
  narrateStatus,
  narrateTurn,
  narrateUnknownAction,
  narrateWaitingRoom,
} from './narrator.js';
import { mirrorEvents, normalizeRoomCode, pvpBattleKey, viewAs } from './pvp.js';
import { BattleTransactions, type BattleTx } from './serialize.js';
import { battleState, type BattleState } from './state.js';
import { dropRoom, tableFor, type Table, type TableDeps } from './table.js';
import { otherSide, type Battle, type BattleAI, type BattleEvent, type Side } from './types.js';

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
  /** 规则外问答；不传则回固定话术（语言模型从 index 注入） */
  chat?: ChatAnswerer;
  /** 双人联机的补账消息；不传则新建一个跟对局同样过期的 */
  echo?: EchoStore;
}

/**
 * 游戏服务：MCP 工具只做参数解析，业务编排都在这里。
 * 开局、出招、应对、战况与说明都从这里进出；结算在 engine，播报在 narrator。
 *
 * 双人联机时，服务端按房主持有唯一一份基准对局，另一位玩家看到的是镜像视角；
 * 两人共用同一份生命值、能量与胜负，不依赖平台侧模型同步状态。
 *
 * 单人局与双人局共用一条出招流水线（见 playOnTable），差别只在「桌子」上：
 * 存在哪个键、坐哪一边、要不要等对手、补账记给谁。
 */
export class GameService {
  private readonly store: BattleStore;
  private readonly rooms: RoomStore;
  private readonly logger: Logger;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly intent?: IntentResolver;
  private readonly ai?: BattleAI;
  private readonly chat?: ChatAnswerer;
  private readonly echo: EchoStore;
  /** 对局事务：排队、读快照、校验、写回都收在这里，业务层不再直接读写存储的对局 */
  private readonly battles: BattleTransactions;
  /** 桌子要用到的存储，构造一张桌子的入口参数 */
  private readonly tables: TableDeps;

  constructor(deps: GameServiceDeps) {
    this.store = deps.store;
    this.rooms = deps.rooms;
    this.logger = deps.logger;
    this.now = deps.now ?? Date.now;
    this.random = deps.random ?? Math.random;
    this.intent = deps.intent;
    this.ai = deps.ai;
    this.chat = deps.chat;
    this.echo = deps.echo ?? new EchoStore({ now: this.now });
    this.battles = new BattleTransactions(deps.store, deps.logger);
    this.tables = { store: deps.store, rooms: deps.rooms, echo: this.echo, logger: deps.logger };
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
  /** 查看当前战况：等待中的房间先把房间号说一遍 */
  status(sessionKey: string, options: SayOptions = {}): ServiceResult {
    const table = tableFor(this.tables, sessionKey);
    const battle = table.battle();
    if (!battle) {
      // 房间还在但基准对局没了：这间房已经废了
      if (table.room) {
        this.rooms.remove(table.room);
        return { text: narrateRoomMissing(table.room), battle: null };
      }
      return { text: narrateNoBattle(), battle: null };
    }

    const view = table.view(sessionKey) ?? battle;
    const catchUp = this.drainCatchUp(sessionKey, options.catchUp !== false);
    const waiting = table.waiting();
    const head = waiting ? `${narrateWaitingRoom(table.room ?? '')}。` : '';
    return { text: `${catchUp}${head}${narrateStatus(view, { waiting })}`, battle: view };
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
      case 'ask':
        return this.askOutside(sessionKey, command.text);
      case 'turn':
        return this.play(sessionKey, command, raw, options);
      case 'unknown':
        return this.play(sessionKey, null, raw, options);
    }
  }

  /**
   * 规则外的问题：交给语言模型答一句，不动对局。
   *
   * 这里刻意不取补账、不碰桌子：问答不消耗回合，也不该把错过的结算
   * 混进一句闲聊里。模型没配或调用失败时回固定话术。
   */
  private async askOutside(sessionKey: string, question: string): Promise<ServiceResult> {
    const view = this.viewFor(sessionKey);
    if (!this.chat) return { text: narrateOutsideUnavailable(), battle: view };
    try {
      const answer = await this.chat.answer(question);
      return { text: answer ?? narrateOutsideUnavailable(), battle: view };
    } catch (error) {
      this.logger.warn('规则外问答失败，回固定话术', {
        sessionKey,
        error: error instanceof Error ? error.message : String(error),
      });
      return { text: narrateOutsideUnavailable(), battle: view };
    }
  }

  /** 招式入口：这一手落到哪张桌上，就在哪张桌上结算 */
  private play(
    sessionKey: string,
    direct: TurnIntent | null,
    raw: string,
    options: SayOptions,
  ): Promise<ServiceResult> {
    // 先按当前所在的桌子取锁；进门之后再确认一次桌子没换
    const queued = tableFor(this.tables, sessionKey);
    return this.battles.run(queued.key, (tx) =>
      this.playOnTable(sessionKey, queued, tx, direct, raw, options),
    );
  }

  /**
   * 一张桌子上的完整一手：认招、结算、写回、播报。
   *
   * 单人局与双人局只在桌子上不同，流水线只写这一遍：先确认排到队时还坐在原位，
   * 结算前确认局面没被换走，写回时再由事务兜底一次，对不上就作废重说。
   */
  private async playOnTable(
    sessionKey: string,
    queued: Table,
    tx: BattleTx,
    direct: TurnIntent | null,
    raw: string,
    options: SayOptions,
  ): Promise<ServiceResult> {
    const table = tableFor(this.tables, sessionKey);
    if (table.key !== tx.key) {
      // 排队期间换桌或撤房：这一手不落到别的桌子上
      this.logger.debug('排到队时已经换桌', { sessionKey, from: queued.key, to: table.key });
      return queued.room
        ? { text: narrateRoomMissing(queued.room), battle: null }
        : { text: narrateStaleAction(), battle: this.viewFor(sessionKey) };
    }

    const seat = table.seat(sessionKey);
    if (!seat) return { text: narrateRoomMissing(table.room ?? ''), battle: null };

    const catchUp = this.drainCatchUp(sessionKey, options.catchUp !== false);
    let canonical = tx.load();
    let prefix = '';

    if (!canonical) {
      // 房间里没有基准对局：这间房已经废了
      if (table.room) {
        this.rooms.remove(table.room);
        this.logger.warn('房间对局已过期', { sessionKey, room: table.room });
        return { text: `${catchUp}${narrateRoomMissing(table.room)}`, battle: null };
      }
      // 单人局：认不出招式就不自动开局，避免随便一句话就开一局
      if (!direct) {
        this.logger.debug('招式无法识别', { sessionKey, raw });
        return { text: `${catchUp}${narrateUnknownAction(null)}`, battle: null };
      }
      const spawned = await this.spawnSolo();
      // 等对手先手的这段时间里玩家可能已经进了房间：这一手不另开
      if (this.rooms.byPlayer(sessionKey)) {
        return { text: narrateStaleAction(), battle: this.viewFor(sessionKey) };
      }
      if (!tx.commit(spawned)) {
        return { text: narrateStaleAction(), battle: this.viewFor(sessionKey) };
      }
      canonical = spawned;
      prefix = narrateAutoStart(spawned);
      this.logger.info('对局自动开始', {
        sessionKey,
        battleId: spawned.id,
        enemy: spawned.enemy.name,
        firstMover: spawned.firstMover,
      });
    }

    const view = viewAs(canonical, seat);
    if (view.phase !== 'battle') {
      return { text: `${catchUp}${prefix}${narrateEnded(view)}`, battle: view };
    }

    const match = direct ?? (await this.resolveWithIntent(raw, view, 'player'));
    if (!match) {
      this.logger.debug('招式无法识别', { sessionKey, room: table.room, raw });
      return { text: `${catchUp}${prefix}${narrateUnknownAction(view)}`, battle: view };
    }

    // 还在等对手进来：这一手不结算，先把房间号再说一遍
    if (table.waiting()) {
      return { text: `${catchUp}${prefix}${narrateWaitingRoom(table.room ?? '')}`, battle: view };
    }

    // 模型回复期间局面可能已经变了：不是刚才那一局就丢弃这次识别
    if (!tx.alive()) {
      this.logger.info('局面已变，丢弃这次识别', {
        sessionKey,
        room: table.room,
        battleId: canonical.id,
        action: match.action,
      });
      return { text: narrateStaleAction(), battle: this.viewFor(sessionKey) };
    }

    const result = await resolveTurn(view, match.action, this.now(), { ai: this.ai });
    if (result.rejection) {
      this.logger.debug('操作不合法', {
        sessionKey,
        room: table.room,
        battleId: view.id,
        round: view.round,
        seat,
        action: match.action,
        reason: result.rejection.reason,
      });
      return { text: `${catchUp}${prefix}${narrateRejection(result.battle, result.rejection)}`, battle: result.battle };
    }

    // 结算自己也 await 过对手决策：座位或对局变了就作废，别把旧快照盖回新局
    const written = table.canonical(result.battle, seat, canonical);
    if (!table.stillHere(sessionKey, seat) || !tx.commit(written)) {
      return { text: narrateStaleAction(), battle: this.viewFor(sessionKey) };
    }
    if (table.room) this.rooms.touch(table.room);

    this.logger.info('玩家出招', {
      sessionKey,
      room: table.room,
      battleId: written.id,
      round: written.round,
      seat,
      action: match.action,
      chant: match.chant,
      phase: written.phase,
      next: written.pending ? `${written.pending.actor} 待应对` : written.active,
    });

    // 这一轮真正结算完了，另一位玩家错过的结果记下来等他开口
    if (!written.pending) this.recordCatchUp(table, seat, written, result.events);

    const chantLine = match.chant ? narrateChant(match.chant) : '';
    const body = narrateTurn(result.battle, result.events);
    return { text: `${catchUp}${prefix}${chantLine}${body}`, battle: result.battle };
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
    const table = tableFor(this.tables, sessionKey);
    const battle = table.battle();
    const seat = table.seat(sessionKey);
    if (!battle || !seat) return null;
    return {
      room: table.room,
      state: battleState(battle, { room: table.room, side: seat, waiting: table.waiting() }),
    };
  }

  /** 单人开局：与出招共用同一把钥匙，对手先手时不会有人插进来读改写 */
  private startSolo(sessionKey: string, opponent?: string): Promise<ServiceResult> {
    return this.battles.runExclusive(sessionKey, () => this.startSoloLocked(sessionKey, opponent));
  }

  private async startSoloLocked(sessionKey: string, opponent?: string): Promise<ServiceResult> {
    // 单人重新开局：撤掉仍在的房间，避免对手对着已失效的局面出招
    const existing = this.rooms.byPlayer(sessionKey);
    if (existing) dropRoom(this.tables, existing, '重新开局');

    const battle = await this.spawnSolo(opponent);

    // 等对手先手的这段时间里玩家可能已经进了房间：以房间为准，不再另开一局
    const room = this.rooms.byPlayer(sessionKey);
    if (room) return this.status(sessionKey);

    this.store.set(sessionKey, battle);
    this.logger.info('对局开始', {
      sessionKey,
      battleId: battle.id,
      enemy: battle.enemy.name,
      firstMover: battle.firstMover,
    });
    return { text: narrateOpening(battle), battle };
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
        text: `${narrateWaitingRoom(existing.code)}。`,
        battle: this.store.get(pvpBattleKey(existing.code)) ?? null,
      };
    }
    if (existing) dropRoom(this.tables, existing, '重新开局');
    // 从单人局切到联机时把旧对局清掉，避免退出房间后还对着过期局面出招
    this.store.delete(sessionKey);
    return this.startPvp(sessionKey);
  }

  /** 开双人房：先建基准对局，再等第二位玩家凭房间号加入 */
  private startPvp(sessionKey: string): ServiceResult {
    const room = this.rooms.create(sessionKey);
    const battle = this.createPvpBattle();
    this.store.set(pvpBattleKey(room.code), battle);
    this.logger.info('房间创建', { sessionKey, room: room.code, battleId: battle.id });
    // 开房时对手还没进来，不能提前播「对决开始」，否则玩家会以为已经有对手了
    return {
      text: `${narrateRoomCreated(room.code)}。`,
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
   * 先在不动任何索引的前提下判完能不能加入（这决定播什么），再交给房间存储
   * 一次占座：它同样会再验一遍，成功时把旧房交出来，这里连着旧对局与补账一起撤。
   * 所以加入失败时，原来的房间、那局对局与补账一点都不会动。
   */
  private joinRoom(sessionKey: string, rawRoom: string): ServiceResult {
    const fallback = this.store.get(sessionKey) ?? null;
    const code = normalizeRoomCode(rawRoom);
    if (!code) {
      this.logger.debug('房间号格式不对', { sessionKey, rawRoom });
      return { text: narrateRoomInvalid(), battle: fallback };
    }

    const target = this.rooms.get(code);
    if (!target) {
      this.logger.info('房间加入失败', { sessionKey, room: code, reason: 'missing' });
      return { text: narrateRoomMissing(code), battle: fallback };
    }
    // 房主自己拿房间号加入：不把它登记成加入者，只提示还在等人
    if (target.hostKey === sessionKey) {
      this.logger.debug('房主自己加入房间', { sessionKey, room: code });
      return {
        text: narrateWaitingRoom(code),
        battle: fallback ?? this.store.get(pvpBattleKey(code)) ?? null,
      };
    }
    if (target.guestKey !== null && target.guestKey !== sessionKey) {
      this.logger.info('房间加入失败', { sessionKey, room: code, reason: 'full' });
      return { text: narrateRoomFull(code), battle: fallback };
    }

    // 房间还在但对局已经过期：这间房废了，换掉它也不该顺手把玩家踢出原来的房间
    const canonical = this.store.get(pvpBattleKey(code));
    if (!canonical) {
      this.rooms.remove(code);
      this.logger.warn('房间存在但对局已过期', { sessionKey, room: code });
      return { text: narrateRoomMissing(code), battle: fallback };
    }

    const claimed = this.rooms.claim(code, sessionKey);
    if (!claimed.ok) {
      // 上面刚验过，走到这里只可能是同一刻被撤房：原有房间保持不动
      this.logger.info('房间加入失败', { sessionKey, room: code, reason: claimed.reason });
      return {
        text: claimed.reason === 'full' ? narrateRoomFull(code) : narrateRoomMissing(code),
        battle: fallback,
      };
    }

    // 席位已经归到新房，旧房连着那局对局与补账一起撤掉
    if (claimed.previous) dropRoom(this.tables, claimed.previous, '换房');

    const view = viewAs(canonical, 'enemy');
    this.store.delete(sessionKey);
    this.rooms.touch(code);
    this.logger.info('房间加入', {
      sessionKey,
      room: code,
      battleId: canonical.id,
      round: canonical.round,
      from: claimed.previous?.code ?? null,
    });
    const fresh = view.history.length === 0 && view.round === 1 && !view.pending;
    const opening = fresh
      ? `${narrateRoomJoined(code)}。${narrateBattleStart(view)}`
      : `${narrateRoomJoined(code)}。${narrateStatus(view)}`;
    return { text: opening, battle: view };
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
  private recordCatchUp(table: Table, seat: Side, base: Battle, events: BattleEvent[]): void {
    const waitingKey = table.echoTo(seat);
    if (!waitingKey) return;
    // 出招方的视角里自己永远是 player，翻到另一方就是那位等着的玩家
    const missed = mirrorEvents(events).filter(
      (event) => event.type !== 'round-start' && event.type !== 'end',
    );
    this.echo.push(waitingKey, narrateTurn(viewAs(base, otherSide(seat)), missed, { hint: false }));
  }

  /** 当前玩家视角的最新局面：房间里按座位镜像，单人是自己的对局 */
  private viewFor(sessionKey: string): Battle | null {
    return tableFor(this.tables, sessionKey).view(sessionKey);
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

/** 当前视角所处的阶段：等自己出招 → active，等自己应对 → response，其余 null */
function stageFor(battle: Battle, side: Side): IntentStage | null {
  if (battle.phase !== 'battle') return null;
  if (battle.pending) return battle.pending.actor === side ? null : 'response';
  return battle.active === side ? 'active' : null;
}
