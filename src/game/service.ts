import { protocolReply, protocolEvents, protocolSide, type GameReply, type ProtocolEvent, type ProtocolReason } from './protocol.js';
import { actionLabel } from './actions.js';
import { isUltimateReady } from './rules.js';
import type { PushKind } from './push.js';
import { presentation, type Presentation } from './presentation.js';
import type { AttributionMode } from '../config.js';
import type { Logger } from '../log.js';
import type { BattleStore } from '../store/battles.js';
import { EchoStore } from '../store/echoes.js';
import type { Room, RoomStore } from '../store/rooms.js';
import { matchSpokenAction, type SpokenMatch, type SpokenStage } from './asr.js';
import type { ChatAnswerer } from './chat.js';
import { readCommand, type Command, type RefuseReason, type TurnIntent } from './command.js';
import { matchEchoRule } from './crosstalk.js';
import { advanceBattle, createBattle, resolveTurn } from './engine.js';
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
import type { CommandRouter, RouterStage } from './router.js';
import { screenSeat } from './seat.js';
import { BattleTransactions, type BattleTx } from './serialize.js';
import { battleState, type BattleState } from './state.js';
import { dropRoom, tableFor, type Table, type TableDeps } from './table.js';
import { otherSide, type Battle, type BattleAI, type BattleEvent, type Side, type ActionId } from './types.js';

/** 一次工具调用的结果：可直接朗读的文本 + 当前玩家视角的最新对局状态 */
export interface ServiceResult {
  reply?: GameReply;
  /** Internal narration metadata; facts are never reconstructed from text. */
  protocol?: {
    reason?: ProtocolReason; action?: ActionId; events?: ProtocolEvent[];
    text?: boolean; silent?: boolean; consume?: boolean;
    currentSay?: string; terminalNarration?: boolean;
  };
  presentation?: Presentation;
  text: string;
  battle: Battle | null;
}

/** 只读局面快照：给状态流与调试接口用，不做播报、不推进对局 */
export interface SnapshotResult {
  /** 四位挑战编号；单人局为 null */
  room: string | null;
  state: BattleState;
}

/** 开局参数：单人可指定对手名；双人可发起挑战或接受挑战 */
export interface StartOptions {
  opponent?: string;
  mode?: 'solo' | 'pvp';
  /** 四位挑战编号，填了就接受该编号的挑战，忽略 mode */
  room?: string;
  /** 玩家原话：平台模型不确定结构化参数时塞进来，服务端兜底识别「发起挑战 / 接受挑战」 */
  text?: string;
  speaker?: string;
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
  speaker?: string;
}

/**
 * 模型异步返回的一手：它只能落回模型开始思考时的那一局。
 *
 * 等模型的这段时间里玩家可能重开、换房，或者对局过期；光在排队之前比一次
 * 挡不住「重开排在中间」这种交错。所以把当时那一局一起带进事务，取到锁之后
 * 再核对一次（见 playOnTable），对不上就作废让玩家重说。
 */
interface RoutedHand {
  /** 模型开始思考时这句话落在哪张桌上，这一手仍按这张桌子取锁 */
  table: Table;
  /** 当时那一局的 id；当时还没有对局则为 null */
  battleId: string | null;
}

interface SeatBindings { battleId: string; player?: string; enemy?: string; }

export interface GameServiceDeps {
  store: BattleStore;
  rooms: RoomStore;
  logger: Logger;
  /** 便于单测注入固定时间与随机数，生产用默认值 */
  now?: () => number;
  random?: () => number;
  /** 混合路由的模型侧；不传则规则认不出时报没听清 */
  router?: CommandRouter;
  /** 对手 AI；不传则用内置的本地决策模型（JEV 决策模型从 index 注入） */
  ai?: BattleAI;
  /** 规则外问答；不传则回固定话术（语言模型从 index 注入） */
  chat?: ChatAnswerer;
  /** 双人联机的补账消息；不传则新建一个跟对局同样过期的 */
  echo?: EchoStore;
  /** 座位归属策略；不传按 off 走原行为 */
  attribution?: AttributionMode;
  /** 端侧同音纠错；不传用 asr.ts 的实现，传 null 关掉这一层 */
  fuzzy?: SpokenMatcher | null;
  speakers?: string[];
}

/**
 * 端侧同音纠错：模型路由要几百毫秒，先把「重机 / 可党 / 硬航」这类同音转写
 * 在毫秒级还原成招式。只负责还原动作，不判断该不该出招。
 */
export type SpokenMatcher = (text: string, stage?: SpokenStage) => SpokenMatch | null;

const DEFAULT_SPOKEN_MATCHER: SpokenMatcher = (text, stage) => matchSpokenAction(text, stage);

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
  private readonly router?: CommandRouter;
  private readonly ai?: BattleAI;
  private readonly chat?: ChatAnswerer;
  private readonly echo: EchoStore;
  private readonly attribution: AttributionMode;
  private readonly fuzzy: SpokenMatcher | null;
  private readonly speakers: string[];
  private readonly seatSpeakers = new Map<string, SeatBindings>();
  private readonly delivered = new Map<string, string>();
  private readonly notificationIds = new Map<string, {battleId:string;stage:string;ids:Set<string>}>();
  /** 对局事务：排队、读快照、校验、写回都收在这里，业务层不再直接读写存储的对局 */
  private readonly battles: BattleTransactions;
  /** 桌子要用到的存储，构造一张桌子的入口参数 */
  private readonly tables: TableDeps;
  private readonly factQueue = new Map<string, { battleId: string; events: ProtocolEvent[]; at: number }>();
  private readonly waiters = new Map<string, Set<() => void>>();

  constructor(deps: GameServiceDeps) {
    this.store = deps.store;
    this.rooms = deps.rooms;
    this.logger = deps.logger;
    this.now = deps.now ?? Date.now;
    this.random = deps.random ?? Math.random;
    this.router = deps.router;
    this.ai = deps.ai;
    this.chat = deps.chat;
    this.echo = deps.echo ?? new EchoStore({ now: this.now });
    this.attribution = deps.attribution ?? 'off';
    this.fuzzy = deps.fuzzy === undefined ? DEFAULT_SPOKEN_MATCHER : deps.fuzzy;
    this.speakers = deps.speakers ?? [];
    this.battles = new BattleTransactions(deps.store, deps.logger);
    this.tables = { store: deps.store, rooms: deps.rooms, echo: this.echo, logger: deps.logger };
  }

  /**
   * 开一局：单人、发起双人挑战，或凭编号接受挑战。
   *
   * 平台模型给了结构化参数就按参数走；给的是原话就交给 readCommand，
   * 「发起挑战 / 接受挑战，编号1234」这类说法和服务端自己的识别保持同一套规则。
   */
  async start(sessionKey: string, options: StartOptions = {}): Promise<ServiceResult> {
    if (!this.speakerListed(options.speaker)) return this.silentResult(sessionKey);
    const phrase = [options.opponent, options.text].filter(Boolean).join(' ');
    const command = options.room
      ? ({ kind: 'join-room', code: options.room } as const)
      : phrase
        ? readCommand(phrase)
        : null;
    const result = command?.kind === 'join-room' ? this.joinRoom(sessionKey, command.code)
      : options.mode === 'pvp' || command?.kind === 'open-room' ? this.openRoom(sessionKey)
      : await this.startSolo(sessionKey, options.opponent);
    if (result.battle && !result.protocol?.reason) this.bindSeat(sessionKey, options.speaker);
    return this.finish(sessionKey, result);
  }

  /** 查看当前战况 */
  /** 查看当前战况：等待中的房间先把房间号说一遍 */
  status(sessionKey: string, options: SayOptions = {}): ServiceResult {
    if (!this.speakerListed(options.speaker)) return this.silentResult(sessionKey);
    return this.finish(sessionKey, this.statusInternal(sessionKey, options));
  }

  private statusInternal(sessionKey: string, options: SayOptions = {}): ServiceResult {
    const table = tableFor(this.tables, sessionKey);
    const battle = table.battle();
    if (!battle) {
      // 房间还在但基准对局没了：这间房已经废了
      if (table.room) {
        this.rooms.remove(table.room);
        this.seatSpeakers.delete(pvpBattleKey(table.room));
        return { text: narrateRoomMissing(table.room), battle: null, protocol: { reason: 'room_missing' } };
      }
      return { text: narrateNoBattle(), battle: null, presentation:presentation('status',null) };
    }

    const view = table.view(sessionKey) ?? battle;
    const catchUp = this.drainCatchUp(sessionKey, options.catchUp !== false);
    const waiting = table.waiting();
    const head = waiting ? `${narrateWaitingRoom(table.room ?? '')}。` : '';
    return { text: `${catchUp}${head}${narrateStatus(view, { waiting })}`, battle: view,
      protocol: { currentSay: `${head}${narrateStatus(view, { waiting })}`, terminalNarration: view.phase !== 'battle' },
      presentation: presentation('status', view, {waiting,renderings:[`${catchUp}${head}${narrateStatus(view,{waiting,expressive:true})}`]}) };
  }

  /** 玩法说明，用于玩家不知道说什么的场景 */
  help(options: SayOptions = {}): ServiceResult {
    if (!this.speakerListed(options.speaker)) return {text:'',battle:null,reply:{v:2,ok:true,silent:true}};
    return { text: narrateHelp(), battle: null, reply: protocolReply(null, { text: narrateHelp() }) };
  }

  /**
   * 原话入口：玩家说了什么就传什么，由服务端判成命令再分派。
   *
   * 平台侧模型不做意图判断，只把原话交进来；判定只发生一次（readCommand），
   * 之后每个分支都不再回头解析这句话。
   */
  async say(sessionKey: string, text: string, options: SayOptions = {}): Promise<ServiceResult> {
    if (!this.speakerListed(options.speaker)) return this.silentResult(sessionKey);
    if (!text.trim() || [...text].length > 200) return this.invalidInput(sessionKey, options);
    return this.finish(sessionKey, await this.execute(sessionKey, readCommand(text), text, options));
  }

  /**
   * 按命令分派：挑战、玩法、战况都在这里收口，只有招式会进对局流水线。
   *
   * 「在不在房间」只决定这一手记到哪张桌上，不再影响这句话怎么理解——
   * 所以已经在房间里的玩家说「接受挑战，编号1234」照样能换房。
   *
   * `routed` 只有模型路由回来的命令才带：开局、发起挑战会改对局归属，执行前要
   * 核对还是不是问模型时那一局（见 discardIfStale）。
   */
  private execute(
    sessionKey: string,
    command: Command,
    raw: string,
    options: SayOptions,
    routed?: RoutedHand,
  ): ServiceResult | Promise<ServiceResult> {
    if (this.speakerGate(sessionKey, command, options.speaker) === 'silent') return this.silentResult(sessionKey);
    // 座位归属（ATTRIBUTION_MODE=strict）：不是冲本机说的、或只报了座位号，到这里就收住。
    // 单人局没有房间也没有对方座位，seat 传 null 让它原样放行
    const table = tableFor(this.tables, sessionKey);
    const screened = screenSeat(this.attribution, table.room ? table.seat(sessionKey) : null, raw, command);
    if (screened.kind === 'silent') return { text: '', battle: this.viewFor(sessionKey), protocol: { silent: true, consume: false } };
    if (screened.kind === 'say') return { text: screened.text, battle: this.viewFor(sessionKey), protocol: { text: true, consume: false } };
    command = screened.command;
    // 座位口令只是归属标签：摘掉之后的原话才是要理解的那句（「红方，开大」按「开大」认）
    raw = screened.text;

    switch (command.kind) {
      // 归属分支：疑似自家播报回灌，v2 完全静默，不推进对局（判定规则见 crosstalk.ts）
      case 'echo':
        this.logger.info('疑似播报回灌', { sessionKey, chars: raw.length, rule: matchEchoRule(raw) });
        return { text: '', battle: this.viewFor(sessionKey), protocol: { silent: true, consume: false } };
      case 'join-room': {
        const result = this.joinRoom(sessionKey, command.code);
        if (result.battle && !result.protocol?.reason) this.bindSeat(sessionKey, options.speaker);
        return result;
      }
      case 'open-room': {
        const result = this.openRoom(sessionKey, routed);
        if (result.battle && !result.protocol?.reason) this.bindSeat(sessionKey, options.speaker);
        return result;
      }
      case 'help': {
        const battle = this.viewFor(sessionKey);
        return { text: narrateHelp(), battle, reply: protocolReply(battle, { room: table.room, waiting: table.waiting(), text: narrateHelp() }) };
      }
      case 'status':
        return this.statusInternal(sessionKey, options);
      case 'start':
        return this.startSolo(sessionKey, undefined, routed).then(result => {
          if (result.battle && !result.protocol?.reason) this.bindSeat(sessionKey, options.speaker);
          return result;
        });
      case 'refused':
        return this.refuse(sessionKey, command.why, options);
      case 'ask':
        return this.askOutside(sessionKey, command.text);
      case 'turn':
        return this.play(sessionKey, command, raw, options);
      case 'route':
        return this.routeCommand(sessionKey, command.question, raw, options);
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
    if (!this.chat) return { text: narrateOutsideUnavailable(), battle: view, protocol: { text: true, consume: false } };
    try {
      const answer = await this.chat.answer(question);
      return { text: answer ?? narrateOutsideUnavailable(), battle: view, protocol: { text: true, consume: false } };
    } catch (error) {
      this.logger.warn('规则外问答失败，回固定话术', {
        sessionKey,
        error: error instanceof Error ? error.message : String(error),
      });
      return { text: narrateOutsideUnavailable(), battle: view, protocol: { text: true, consume: false } };
    }
  }

  /** 招式入口：这一手落到哪张桌上，就在哪张桌上结算 */
  private play(
    sessionKey: string,
    direct: TurnIntent | null,
    raw: string,
    options: SayOptions,
    routed?: RoutedHand,
  ): Promise<ServiceResult> {
    // 先按当前所在的桌子取锁；进门之后再确认一次桌子没换
    const queued = routed?.table ?? tableFor(this.tables, sessionKey);
    return this.battles.run(queued.key, (tx) =>
      this.playOnTable(sessionKey, queued, tx, direct, raw, options, routed),
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
    routed?: RoutedHand,
  ): Promise<ServiceResult> {
    const table = tableFor(this.tables, sessionKey);
    if (table.key !== tx.key) {
      // 排队期间换桌或撤房：这一手不落到别的桌子上
      this.logger.debug('排到队时已经换桌', { sessionKey, from: queued.key, to: table.key });
      // 人还在别的房间：那句话说的是旧局面，让他重说；旧房彻底没了才报房间不在
      if (queued.room && !this.rooms.byPlayer(sessionKey)) {
        return { text: narrateRoomMissing(queued.room), battle: null, protocol: { reason: 'room_missing' } };
      }
      return { text: narrateStaleAction(), battle: this.viewFor(sessionKey), protocol: { reason: 'failed' } };
    }

    const seat = table.seat(sessionKey);
    if (!seat) return { text: narrateRoomMissing(table.room ?? ''), battle: null, protocol: { reason: 'room_missing' } };

    let canonical = tx.load();
    // 排到队时已经是另一局（这中间重开、换房或过期）：这一手说的是旧局面，
    // 落到新局上就是凭空出招。只能在这里核——进队后加载的是最新那一局，
    // tx.alive() 保护的也只是这一份快照，排队前比一次挡不住重开抢在中间。
    if (routed && routed.battleId !== (canonical?.id ?? null)) {
      this.logger.info('排到队时已经是另一局，丢弃这一手', {
        sessionKey,
        room: table.room,
        expected: routed.battleId,
        current: canonical?.id ?? null,
      });
      return { text: narrateStaleAction(), battle: this.viewFor(sessionKey), protocol: { reason: 'failed' } };
    }

    if (this.speakerGate(sessionKey, direct ? {kind:'turn',...direct} : {kind:'route',question:false}, options.speaker) === 'silent') return this.silentResult(sessionKey);
    const catchUp = this.drainCatchUp(sessionKey, options.catchUp !== false);
    let prefix = '';

    if (!canonical) {
      // 房间里没有基准对局：这间房已经废了
      if (table.room) {
        this.rooms.remove(table.room);
        this.seatSpeakers.delete(pvpBattleKey(table.room));
        this.logger.warn('房间对局已过期', { sessionKey, room: table.room });
        return { text: `${catchUp}${narrateRoomMissing(table.room)}`, battle: null, protocol: { reason: 'room_missing', currentSay: narrateRoomMissing(table.room) } };
      }
      // 单人局：认不出招式就不自动开局，避免随便一句话就开一局
      if (!direct) {
        this.logger.debug('招式无法识别', { sessionKey, raw });
        return { text: `${catchUp}${narrateUnknownAction(null)}`, battle: null, protocol: { reason: 'unclear', currentSay: narrateUnknownAction(null) }, presentation:presentation('retry',null,{rejection:'unrecognized'}) };
      }
      const spawned = await this.spawnSolo();
      // 等对手先手的这段时间里玩家可能已经进了房间：这一手不另开
      if (this.rooms.byPlayer(sessionKey)) {
        return { text: narrateStaleAction(), battle: this.viewFor(sessionKey), protocol: { reason: 'failed' } };
      }
      if (!tx.commit(spawned)) {
        return { text: narrateStaleAction(), battle: this.viewFor(sessionKey), protocol: { reason: 'failed' } };
      }
      canonical = spawned;
      prefix = narrateAutoStart(spawned);
      this.bindSeat(sessionKey, options.speaker);
      this.logger.info('对局自动开始', {
        sessionKey,
        battleId: spawned.id,
        enemy: spawned.enemy.name,
        firstMover: spawned.firstMover,
      });
    }

    const view = viewAs(canonical, seat);
    if (view.phase !== 'battle') {
      return { text: `${catchUp}${prefix}${narrateEnded(view)}`, battle: view, protocol: { reason: 'ended', currentSay: `${prefix}${narrateEnded(view)}`, terminalNarration: true }, presentation:presentation('status',view) };
    }

    const match = direct;
    if (!match) {
      this.logger.debug('招式无法识别', { sessionKey, room: table.room, raw });
      return { text: `${catchUp}${prefix}${narrateUnknownAction(view)}`, battle: view, protocol: { reason: 'unclear', currentSay: `${prefix}${narrateUnknownAction(view)}` }, presentation:presentation('retry',view,{waiting:table.waiting(),rejection:'unrecognized'}) };
    }

    // 还在等对手进来：这一手不结算，先把房间号再说一遍
    if (table.waiting()) {
      return { text: `${catchUp}${prefix}${narrateWaitingRoom(table.room ?? '')}`, battle: view, protocol: { reason: 'waiting', currentSay: `${prefix}${narrateWaitingRoom(table.room ?? '')}` }, presentation:presentation('status',view,{waiting:true}) };
    }

    // 模型回复期间局面可能已经变了：不是刚才那一局就丢弃这次识别
    if (!tx.alive()) {
      this.logger.info('局面已变，丢弃这次识别', {
        sessionKey,
        room: table.room,
        battleId: canonical.id,
        action: match.action,
      });
      return { text: narrateStaleAction(), battle: this.viewFor(sessionKey), protocol: { reason: 'failed' } };
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
      return { text: `${catchUp}${prefix}${narrateRejection(result.battle, result.rejection)}`, battle: result.battle, protocol: { reason: rejectReason(result.rejection.reason), action: result.rejection.action, currentSay: `${prefix}${narrateRejection(result.battle, result.rejection)}` }, presentation:presentation('rejected',result.battle,{rejection:result.rejection.reason}) };
    }

    // 结算自己也 await 过对手决策：座位或对局变了就作废，别把旧快照盖回新局
    const written = table.canonical(result.battle, seat, canonical);
    if (!table.stillHere(sessionKey, seat) || !tx.commit(written)) {
      return { text: narrateStaleAction(), battle: this.viewFor(sessionKey), protocol: { reason: 'failed' } };
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
    const other = table.echoTo(seat);
    if (other) this.enqueueFacts(other, written.id, protocolEvents(mirrorEvents(result.events)));
    this.wakeTable(table);

    const chantLine = match.chant ? narrateChant(match.chant) : '';
    const body = narrateTurn(result.battle, result.events);
    return { text: `${catchUp}${prefix}${chantLine}${body}`, battle: result.battle,
      protocol: { currentSay: `${prefix}${chantLine}${body}`, events: [...(prefix ? [this.startEvent(result.battle)] : []), ...(match.chant ? [{ t: 'chant' as const, text: match.chant }] : []), ...protocolEvents(result.events)] },
      presentation:presentation('turn',result.battle,{events:result.events,renderings:[`${catchUp}${prefix}${chantLine}${narrateTurn(result.battle,result.events,{expressive:true})}`]}) };
  }

  /** 名单为空表示不设限；名单非空时只认名单里的名字（平台声纹给的那个） */
  private speakerListed(speaker?: string): boolean {
    if (this.speakers.length === 0) return true;
    const name = (speaker ?? '').trim();
    return Boolean(name) && this.speakers.includes(name!);
  }

  /**
   * 说话人校验：没登记的声音不回应，挡掉环境里其他人的说话声、回声与
   * 设备串音，避免它们被当成指令、把局面推进到对不上的状态。
   *
   * 已登记的人也要看轮次：不是自己的回合、或者出招人不是本机座位绑定的
   * 那个人，同样不回应。只有「会动用回合」的说法受轮次约束，
   * 查战况、问玩法、开局、加入房间照旧。
   */
  private speakerGate(sessionKey: string, command: Command, speaker?: string): 'pass' | 'silent' {
    if (this.speakers.length === 0) return 'pass';
    if (!this.speakerListed(speaker)) {
      this.logger.info('说话人不在名单里，保持静默', { sessionKey, speaker: (speaker ?? '').trim() || null });
      return 'silent';
    }
    const name = (speaker ?? '').trim();

    const turnLike =
      command.kind === 'turn' || command.kind === 'refused' || (command.kind === 'route' && !command.question);
    if (!turnLike) return 'pass';

    const table = tableFor(this.tables, sessionKey);
    const battle = table.battle();
    const seat = table.seat(sessionKey);
    if (!battle || !seat) return 'pass';

    const owner = this.seatsFor(table, battle)?.[seat];
    if (owner && owner !== name) {
      this.logger.info('这一手不是本机玩家说的，保持静默', { sessionKey, seat, owner, speaker: name });
      return 'silent';
    }

    const view = viewAs(battle, seat);
    const myTurn = view.pending ? view.pending.actor !== 'player' : view.active === 'player';
    if (!myTurn) {
      this.logger.info('没轮到这个座位，保持静默', {
        sessionKey,
        seat,
        speaker: name,
        active: view.active,
        pending: view.pending?.actor ?? null,
      });
      return 'silent';
    }

    // 开局前就存在的老对局没有绑定记录：第一次开口的人认领这个座位
    if (!owner) this.bindSeat(sessionKey, name);
    return 'pass';
  }

  /**
   * 取这一局已登记的座位绑定。
   *
   * 换局、对局过期或撤房后，旧绑定在下一次访问时作废：按未绑定处理，
   * 新一局可以重新认领座位，不会被上一局的声音挡住。
   */
  private seatsFor(table: Table, battle: Battle | null): SeatBindings | null {
    const seats = this.seatSpeakers.get(table.key);
    if (!seats) return null;
    if (!battle || seats.battleId !== battle.id) {
      this.seatSpeakers.delete(table.key);
      return null;
    }
    return seats;
  }

  /** 把这次说话人绑到他坐的那一边；同一局里已经绑了别人就不覆盖，避免串音改掉座位 */
  private bindSeat(sessionKey: string, speaker?: string): void {
    const name = (speaker ?? '').trim();
    if (!name) return;
    const table = tableFor(this.tables, sessionKey);
    const seat = table.seat(sessionKey);
    if (!seat) return;
    const battle = table.battle();
    if (!battle) return;
    // 换局后 seatsFor 会先把旧绑定丢掉，这里拿到的只可能是这一局的席位
    const seats = this.seatsFor(table, battle) ?? { battleId: battle.id };
    if (seats[seat] === name) return;
    if (seats[seat]) {
      this.logger.warn('座位已经绑定了别的说话人', {
        sessionKey,
        key: table.key,
        seat,
        bound: seats[seat],
        speaker: name,
      });
      return;
    }
    seats[seat] = name;
    this.seatSpeakers.set(table.key, seats);
    this.logger.info('说话人已绑定座位', { sessionKey, key: table.key, seat, speaker: name });
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
      const view = this.viewFor(sessionKey);
      return { text: `${catchUp}${narrateActionBlocked(why)}`, battle: view, protocol: { reason: why, currentSay: narrateActionBlocked(why) }, presentation:presentation('rejected',view,{waiting:room.guestKey===null,rejection:why}) };
    }
    const battle = this.store.get(sessionKey) ?? null;
    return { text: battle ? narrateActionBlocked(why) : narrateUnknownAction(null), battle, protocol: { reason: why }, presentation:presentation('rejected',battle,{rejection:why}) };
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
  private startSolo(sessionKey: string, opponent?: string, routed?: RoutedHand): Promise<ServiceResult> {
    return this.battles.runExclusive(sessionKey, () => this.startSoloLocked(sessionKey, opponent, routed));
  }

  private async startSoloLocked(
    sessionKey: string,
    opponent?: string,
    routed?: RoutedHand,
  ): Promise<ServiceResult> {
    // 模型回来时玩家可能自己重开过、进了别人的房间：这时再开局会把刚开的新局重置，
    // 下面的 dropRoom 甚至会把别人房间里的那一局一起撤掉
    const stale = this.discardIfStale(sessionKey, routed, '开局');
    if (stale) return stale;

    // 单人重新开局：撤掉仍在的房间，避免对手对着已失效的局面出招
    const existing = this.rooms.byPlayer(sessionKey);
    if (existing) dropRoom(this.tables, existing, '重新开局');

    const battle = await this.spawnSolo(opponent);

    // 等对手先手的这段时间里玩家可能已经进了房间：以房间为准，不再另开一局
    const room = this.rooms.byPlayer(sessionKey);
    if (room) return this.status(sessionKey);

    this.store.set(sessionKey, battle);
    this.factQueue.delete(sessionKey);
    this.wake(sessionKey);
    if (existing) this.clearRoomFacts(existing);
    this.logger.info('对局开始', {
      sessionKey,
      battleId: battle.id,
      enemy: battle.enemy.name,
      firstMover: battle.firstMover,
    });
    return { text: narrateOpening(battle), battle, protocol: { events: [this.startEvent(battle)] }, presentation:presentation('opening',battle) };
  }

  /**
   * 发起双人挑战：先建基准对局，再等对方凭编号接受。
   *
   * 已经在等人时又喊一次「发起挑战」就复用原编号，别让玩家每说一次就换一个码；
   * 已经开打则撤掉旧房重开——旧房里等着的对手不会对着作废的局面继续出招。
   */
  private openRoom(sessionKey: string, routed?: RoutedHand): ServiceResult {
    // 同开局：模型回来时已经不是当时那一局（多半是刚进了别人的房间），
    // 这时再发起挑战会把玩家从原来的房间里撤出来，连对手那一局一起清掉
    const stale = this.discardIfStale(sessionKey, routed, '发起挑战');
    if (stale) return stale;

    const existing = this.rooms.byPlayer(sessionKey);
    if (existing && existing.hostKey === sessionKey && existing.guestKey === null) {
      return {
        text: `${narrateWaitingRoom(existing.code)}。`,
        battle: this.store.get(pvpBattleKey(existing.code)) ?? null,
        presentation:presentation('status',this.store.get(pvpBattleKey(existing.code)) ?? null,{waiting:true}),
      };
    }
    if (existing) {
      dropRoom(this.tables, existing, '重新开局');
      this.clearRoomFacts(existing);
    }
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
      battle, protocol: { events: [{ t: 'room', code: room.code }] },
      presentation:presentation('opening',battle,{waiting:true}),
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
      return { text: narrateRoomInvalid(), battle: this.viewFor(sessionKey), protocol: { reason: 'room_bad' } };
    }

    const target = this.rooms.get(code);
    if (!target) {
      this.logger.info('房间加入失败', { sessionKey, room: code, reason: 'missing' });
      return { text: narrateRoomMissing(code), battle: this.viewFor(sessionKey), protocol: { reason: 'room_missing' } };
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
      return { text: narrateRoomFull(code), battle: this.viewFor(sessionKey), protocol: { reason: 'room_full' } };
    }

    // 房间还在但对局已经过期：这间房废了，换掉它也不该顺手把玩家踢出原来的房间
    const canonical = this.store.get(pvpBattleKey(code));
    if (!canonical) {
      this.rooms.remove(code);
      this.seatSpeakers.delete(pvpBattleKey(code));
      this.logger.warn('房间存在但对局已过期', { sessionKey, room: code });
      return { text: narrateRoomMissing(code), battle: this.viewFor(sessionKey), protocol: { reason: 'room_missing' } };
    }

    const joining = target.guestKey === null;
    const claimed = this.rooms.claim(code, sessionKey);
    if (!claimed.ok) {
      // 上面刚验过，走到这里只可能是同一刻被撤房：原有房间保持不动
      this.logger.info('房间加入失败', { sessionKey, room: code, reason: claimed.reason });
      return {
        text: claimed.reason === 'full' ? narrateRoomFull(code) : narrateRoomMissing(code),
        battle: this.viewFor(sessionKey), protocol: { reason: claimed.reason === 'full' ? 'room_full' : 'room_missing' },
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
    if (claimed.previous) this.clearRoomFacts(claimed.previous);
    this.factQueue.delete(sessionKey);
    if (joining) this.enqueueFacts(target.hostKey, canonical.id, [this.startEvent(canonical)]);
    this.wake(target.hostKey);
    const fresh = view.history.length === 0 && view.round === 1 && !view.pending;
    const opening = fresh
      ? `${narrateRoomJoined(code)}。${narrateBattleStart(view)}`
      : `${narrateRoomJoined(code)}。${narrateStatus(view)}`;
    return { text: opening, battle: view, protocol: { events: joining ? [{ t: 'join', code }, ...(fresh ? [this.startEvent(view)] : [])] : [] }, presentation:presentation('opening',view) };
  }

  /**
   * 混合路由：本地规则没定下来的句子，按当前阶段交给模型挑一类命令。
   *
   * 阶段由对局状态决定：没有对局只允许开局、查询或闲聊；轮到自己才给招式；
   * 待应对只给防守；上一局结束了只给查询、玩法、开局和闲聊；提问只给「问什么」
   * ——问句和结束局都不会被判成出手。
   * 模型没配、超时或认不出，一律按「没听清」处理，不消耗资源、不推进对局。
   */
  private async routeCommand(
    sessionKey: string,
    question: boolean,
    raw: string,
    options: SayOptions,
  ): Promise<ServiceResult> {
    // 先记住这句话落在哪张桌上、当时是哪一局：模型思考期间换房或重开，
    // 这一手要按旧局丢弃，不能写进新局——出招在进事务之后核对（见 playOnTable），
    // 开局、开房在真正动手之前核对（见 discardIfStale）
    const table = tableFor(this.tables, sessionKey);
    const routed: RoutedHand = { table, battleId: table.battle()?.id ?? null };
    const stage = routeStage(table.view(sessionKey), question);
    // 端侧同音纠错排在模型前面：规则认不出时它只要几毫秒，
    // 用不着为一个「公鸡」等一次模型往返。
    // 只在轮到自己出招的两个阶段猜：问句问的是意思，等待阶段那句话多半不是本机说的。
    const spokenStage = spokenStageOf(stage);
    const spoken = !spokenStage || !this.fuzzy ? null : this.fuzzy(raw, spokenStage);
    if (spoken) {
      this.logger.info('端侧同音纠错命中', {
        sessionKey,
        stage,
        action: spoken.id,
        via: spoken.via,
        score: spoken.score,
      });
      // 判同音也只花几毫秒，仍按当时那一局核对，和模型回来的一手走同一条路
      return this.play(sessionKey, { action: spoken.id }, raw, options, routed);
    }
    let command: Command | null = null;
    if (this.router) {
      try {
        command = await this.router.resolve(raw, stage);
      } catch (error) {
        this.logger.warn('命令路由调用异常，按没认出来处理', {
          stage,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (!command) {
      // 交给招式流水线收尾：带上补账，播「没听清」，对局原样不动
      return this.play(sessionKey, null, raw, options);
    }
    if (command.kind === 'turn') return this.play(sessionKey, command, raw, options, routed);
    // 开局、开房会改对局归属，也要带着当时那一局过去核对（见 discardIfStale）
    return this.execute(sessionKey, command, raw, options, routed);
  }

  /**
   * 模型回来时已经不是当时那一局，就作废这一手；返回 null 表示还能照做。
   *
   * 开局与开房都会改对局归属：等模型的这段时间里玩家可能已自己重开、换房，
   * 或者进了别人的双人房，此时再执行会把刚开的新局重置，甚至把两个人的房间
   * 一起撤掉。查询与闲聊只是回答当前局面，不走这一关。
   */
  private discardIfStale(
    sessionKey: string,
    routed: RoutedHand | undefined,
    action: string,
  ): ServiceResult | null {
    if (!routed) return null;
    const table = tableFor(this.tables, sessionKey);
    const battleId = table.battle()?.id ?? null;
    if ((table.room ?? null) === (routed.table.room ?? null) && battleId === routed.battleId) return null;
    this.logger.info('排到队时已经不是当时那一局，丢弃这一手', {
      sessionKey,
      action,
      expected: routed.battleId,
      current: battleId,
    });
    return { text: narrateStaleAction(), battle: this.viewFor(sessionKey), protocol: { reason: 'failed' } };
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

  private startEvent(view: Battle): ProtocolEvent {
    return { t: 'start', foe: view.enemy.name, first: protocolSide(view.firstMover) };
  }

  private finish(sessionKey: string, result: ServiceResult): ServiceResult {
    if (result.reply) {
      if(!result.reply.silent && (!result.reply.text || Boolean(result.reply.events?.length)) && result.battle) this.delivered.set(sessionKey,this.deliverySignature(sessionKey,result.battle));
      return result;
    }
    const table = tableFor(this.tables, sessionKey);
    const extra = result.protocol ?? {};
    const missed = extra.consume === false || extra.silent
      ? [] : this.takeFacts(sessionKey, result.battle?.id ?? null);
    const hasMissedEnd = missed.some(event => event.t === 'end');
    const currentSay = hasMissedEnd && extra.terminalNarration
      ? '说「开始游戏」可以再来一局。' : extra.currentSay ?? result.text;
    result.reply = protocolReply(result.battle, {
      room: table.room, waiting: table.waiting(),
      // Legacy text may already include narration catch-up; use only the explicit current part.
      say: `${this.factualFallback(missed)}${currentSay}`,
      ...(extra.text ? { text: result.text } : {}),
      reason: extra.reason, action: extra.action, silent: extra.silent,
      events: [...missed, ...(extra.events ?? protocolEvents(result.presentation?.facts.events ?? []))],
    });
    if(!result.reply.silent && (!result.reply.text || Boolean(result.reply.events?.length)) && result.battle) this.delivered.set(sessionKey,this.deliverySignature(sessionKey,result.battle));
    return result;
  }

  /** The fallback is derived from the same facts as the Agent, never parsed from old speech. */
  private factualFallback(events: ProtocolEvent[]): string {
    return events.map(event => {
      switch (event.t) {
        case 'start': return `对决开始，对手是${event.foe}，${event.first === 'you' ? '我' : '对手'}先手。`;
        case 'room': return `房间${event.code}已创建。`;
        case 'join': return `已加入房间${event.code}。`;
        case 'round': return event.bonus > 0 ? `第${event.n}轮，伤害加成${event.bonus}。` : '';
        case 'charge': return `${event.by === 'you' ? '我' : '对手'}蓄力，能量${event.ap}。`;
        case 'hit': {
          const attacker = event.by === 'you' ? '我' : '对手';
          const defender = event.by === 'you' ? '对手' : '我';
          const response = event.r === 'dodge' ? (event.miss ? '闪避成功' : '闪避失败')
            : event.r === 'guard' ? '格挡' : event.forced ? '没有能量，只能承受' : '承受';
          return `${attacker}${actionLabel(event.mv)}，${defender}${response}${event.crit ? '，暴击' : ''}，受到${event.dmg}点伤害。`;
        }
        case 'end': return event.win === 'you' ? '我赢了。' : '我输了。';
        case 'timeout': return event.what === 'guest' ? '对手还没加入。' : '对手还没出手。';
        case 'chant': return `${event.text}。`;
      }
    }).join('');
  }

  private enqueueFacts(key: string, battleId: string, events: ProtocolEvent[]): void {
    for (const [queuedKey, entry] of this.factQueue) {
      if (this.now() - entry.at > 30 * 60 * 1000) this.factQueue.delete(queuedKey);
    }
    const previous = this.factQueue.get(key);
    this.factQueue.set(key, {
      battleId, events: [...(previous?.battleId === battleId ? previous.events : []), ...events], at: this.now(),
    });
    this.wake(key);
  }

  private takeFacts(key: string, battleId: string | null): ProtocolEvent[] {
    const entry = this.factQueue.get(key);
    // A delayed result from an old battle must not remove a newer battle's facts.
    if (!entry || entry.battleId !== battleId) return [];
    this.factQueue.delete(key);
    return this.now() - entry.at <= 30 * 60 * 1000 ? entry.events : [];
  }

  private wake(key: string): void {
    for (const callback of this.waiters.get(key) ?? []) callback();
  }

  private clearRoomFacts(room: Room): void {
    this.seatSpeakers.delete(pvpBattleKey(room.code));
    this.factQueue.delete(room.hostKey);
    if (room.guestKey) this.factQueue.delete(room.guestKey);
    this.wake(room.hostKey);
    if (room.guestKey) this.wake(room.guestKey);
  }

  private wakeTable(table: Table): void {
    const room = table.room ? this.rooms.get(table.room) : null;
    if (room) {
      this.wake(room.hostKey);
      if (room.guestKey) this.wake(room.guestKey);
    }
  }

  /** Reject without executing an input prefix or consuming pending facts. */
  invalidInput(sessionKey: string, options: SayOptions = {}): ServiceResult {
    if (!this.readerAllowed(sessionKey, options.speaker)) return this.silentResult(sessionKey);
    const table = tableFor(this.tables, sessionKey);
    const view = table.view(sessionKey);
    const text = '没听清，这一手请再说一次。';
    return {
      text, battle: view,
      reply: protocolReply(view, { room: table.room, waiting: table.waiting(), reason: 'unclear', say: text }),
    };
  }

  /** A bounded read: it never advances the game or retries an action. */
  async waitEvent(
    sessionKey: string,
    options: { signal?: AbortSignal; timeoutMs?: number; speaker?: string } = {},
  ): Promise<ServiceResult> {
    if (!this.readerAllowed(sessionKey, options.speaker)) return this.silentResult(sessionKey);
    const initial = tableFor(this.tables, sessionKey);
    const originalId = initial.battle()?.id ?? null;
    // RoomStore updates its room object in place, so capture this value rather than its closure.
    const initialWaiting = initial.waiting();
    const initialReply = protocolReply(initial.view(sessionKey), { room: initial.room, waiting: initialWaiting });
    const waiting = initialReply.need === 'wait_guest' || initialReply.need === 'wait_foe';
    const result = () => {
      const current=tableFor(this.tables,sessionKey);
      const view=current.view(sessionKey);
      const need=protocolReply(view,{room:current.room,waiting:current.waiting()}).need;
      const queued=this.factQueue.get(sessionKey);
      // A wait/notification/query already delivered this exact change. A second reader stays quiet.
      if(need!=='wait_guest' && need!=='wait_foe' && view
        && this.delivered.get(sessionKey)===this.deliverySignature(sessionKey,view)
        && !(queued?.battleId===view.id && queued.events.length>0)) return this.silentResult(sessionKey);
      return this.finish(sessionKey, this.statusInternal(sessionKey, { catchUp: true }));
    };
    if (options.signal?.aborted) {
      return {
        text: '', battle: initial.view(sessionKey),
        reply: protocolReply(initial.view(sessionKey), {
          room: initial.room, waiting: initialWaiting, silent: true,
        }),
      };
    }
    if (!waiting || this.factQueue.get(sessionKey)?.battleId === originalId) return result();
    return new Promise<ServiceResult>((resolve) => {
      let settled = false;
      const callbacks = this.waiters.get(sessionKey) ?? new Set<() => void>();
      this.waiters.set(sessionKey, callbacks);
      const done = (cancelled = false, timeout = false) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', abort);
        callbacks.delete(check);
        if (!callbacks.size) this.waiters.delete(sessionKey);
        const current = tableFor(this.tables, sessionKey);
        const view = current.view(sessionKey);
        if (cancelled || current.key !== initial.key || (view?.id ?? null) !== originalId) {
          resolve({
            text: '', battle: view,
            reply: protocolReply(view, {
              room: current.room, waiting: current.waiting(),
              silent: true,
            }),
          });
          return;
        }
        const response = result();
        if (timeout && response.reply) {
          response.reply.events = [
            ...(response.reply.events ?? []),
            { t: 'timeout', what: initialReply.need === 'wait_guest' ? 'guest' : 'foe' },
          ];
        }
        resolve(response);
      };
      const check = () => {
        const current = tableFor(this.tables, sessionKey);
        if (current.key !== initial.key || (current.battle()?.id ?? null) !== originalId
          || this.factQueue.get(sessionKey)?.battleId === originalId || current.waiting() !== initialWaiting) done();
      };
      const abort = () => done(true);
      const timer = setTimeout(() => done(false, true), Math.max(0, Math.min(options.timeoutMs ?? 30000, 30000)));
      callbacks.add(check);
      options.signal?.addEventListener('abort', abort, { once: true });
      check();
    });
  }

  /** Legacy internal callers share the same factual queue and cancellation semantics. */
  wait(sessionKey:string, options:{timeoutMs:number;signal?:AbortSignal;speaker?:string}):Promise<ServiceResult> {
    return this.waitEvent(sessionKey,options);
  }

  private silentResult(sessionKey:string):ServiceResult {
    return {text:'',battle:this.viewFor(sessionKey),reply:{v:2,ok:true,silent:true}};
  }

  /** Notifications and waits are reads: gate ownership, but do not require our turn. */
  private readerAllowed(sessionKey:string,speaker?:string):boolean {
    if (!this.speakerListed(speaker)) return false;
    if (this.speakers.length === 0) return true;
    const table=tableFor(this.tables,sessionKey);
    const seat=table.seat(sessionKey);
    const owner=seat ? this.seatsFor(table,table.battle())?.[seat] : undefined;
    return !owner || owner === speaker?.trim();
  }

  private deliverySignature(sessionKey:string,battle:Battle|null):string {
    if(!battle) return '';
    const table=tableFor(this.tables,sessionKey);
    return JSON.stringify([battle.id,table.room,table.waiting(),battle.phase,battle.round,battle.active,
      battle.pending,battle.updatedAt,battle.history.length,battle.player.hp,battle.player.ap,battle.player.ultLeft,
      battle.enemy.hp,battle.enemy.ap,battle.enemy.ultLeft]);
  }

  /** Pure fact request; callers cannot supply narration, numbers or an action. */
  notification(sessionKey:string,kind:PushKind,options:SayOptions & {battleId:string;pushId:string}):ServiceResult {
    const table=tableFor(this.tables,sessionKey);
    const battle=table.view(sessionKey);
    if(!this.readerAllowed(sessionKey,options.speaker) || !battle || battle.id!==options.battleId
      || battle.phase!=='battle' || !options.pushId) return this.silentResult(sessionKey);
    const stage=this.deliverySignature(sessionKey,battle);
    const previous=this.notificationIds.get(sessionKey);
    const ids=previous?.battleId===battle.id && previous.stage===stage ? previous.ids : new Set<string>();
    if(ids.has(options.pushId)) return this.silentResult(sessionKey);
    const facts=protocolReply(battle,{room:table.room,waiting:table.waiting()});
    const valid=kind==='opponent-joined' ? battle.mode==='pvp' && !table.waiting() && battle.round===1 && battle.history.length===0 && !battle.pending && this.factQueue.get(sessionKey)?.events.some(event=>event.t==='start') === true
      : kind==='opponent-move' || kind==='idle-respond' ? facts.need==='respond'
      : kind==='idle-turn' ? facts.need==='move'
      : kind==='wait-guest' ? facts.need==='wait_guest'
      : kind==='wait-opponent' ? facts.need==='wait_foe'
      : kind==='ult-ready' ? isUltimateReady(battle.player)
      : false;
    if(!valid) return this.silentResult(sessionKey);
    if((kind==='opponent-joined'||kind==='opponent-move') && this.delivered.get(sessionKey)===stage) {
      return this.silentResult(sessionKey);
    }
    ids.add(options.pushId);
    // A stage has at most the seven engine kinds and two idle reminders; bound replay memory.
    if(ids.size>32) ids.delete(ids.values().next().value!);
    this.notificationIds.set(sessionKey,{battleId:battle.id,stage,ids});
    const say=kind==='ult-ready' ? (facts.need==='move' ? '我的能量够了，共鸣冲击准备好了，你想怎么做？' : '我的能量够了，共鸣冲击资源已就绪，等轮到主动行动再出招。')
      : kind==='idle-turn' ? '我准备好了，你想让我怎么做？'
      : kind==='idle-respond' ? '对手的招式还没结算，我该怎么应对？'
      : kind==='wait-guest' ? `挑战编号${table.room}，我还在等对手接受挑战。`
      : kind==='wait-opponent' ? '我还在等对手，先稳住。'
      : kind==='opponent-joined' ? '对手已接受挑战，现在可以对决了。'
      : '对手已经出招，还没有结算，我该怎么应对？';
    return this.finish(sessionKey,{text:say,battle,protocol:{currentSay:say}});
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

/** 路由阶段 → 端侧同音纠错的阶段：只有轮到自己出招的两个阶段才猜招 */
function spokenStageOf(stage: RouterStage): SpokenStage | undefined {
  if (stage === 'active') return 'active';
  if (stage === 'response') return 'response';
  return undefined;
}

/** 当前视角所处的路由阶段：提问优先，其次看有没有对局、打没打完、等谁动 */
function routeStage(battle: Battle | null, question: boolean): RouterStage {
  if (question) return 'question';
  if (!battle) return 'none';
  // 上一局已经结束：只允许重开、开房、查询、玩法与闲聊，菜单里没有任何招式
  if (battle.phase !== 'battle') return 'ended';
  if (battle.pending) return battle.pending.actor === 'player' ? 'waiting' : 'response';
  return battle.active === 'player' ? 'active' : 'waiting';
}

function rejectReason(reason: import('./types.js').RejectReason): ProtocolReason {
  switch (reason) {
    case 'wrong-stage': case 'full-ap': return 'wrong_stage';
    case 'waiting-opponent': return 'waiting';
    case 'insufficient-ap': return 'no_ap';
    case 'no-ult': return 'no_ult';
    case 'ended': return 'ended';
  }
}
