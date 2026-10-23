import type { Logger } from '../log.js';
import type { BattleStore } from '../store/battles.js';
import { parseAction } from './actions.js';
import { createBattle, resolveTurn } from './engine.js';
import {
  narrateAutoStart,
  narrateBattleStart,
  narrateEnded,
  narrateHelp,
  narrateNoBattle,
  narrateStatus,
  narrateTurn,
  narrateUnknownAction,
} from './narrator.js';
import type { Battle } from './types.js';

/** 一次工具调用的结果：可直接朗读的文本 + 最新对局状态（无对局时为 null） */
export interface ServiceResult {
  text: string;
  battle: Battle | null;
}

export interface GameServiceDeps {
  store: BattleStore;
  logger: Logger;
  /** 便于单测注入固定时间与随机数，生产用默认值 */
  now?: () => number;
  random?: () => number;
}

/**
 * 游戏服务：MCP 工具只做参数解析，业务编排都在这里。
 * 后续换 Redis 存储、接入真实结算规则，都只改这一层和 engine。
 */
export class GameService {
  private readonly store: BattleStore;
  private readonly logger: Logger;
  private readonly now: () => number;
  private readonly random: () => number;

  constructor(deps: GameServiceDeps) {
    this.store = deps.store;
    this.logger = deps.logger;
    this.now = deps.now ?? Date.now;
    this.random = deps.random ?? Math.random;
  }

  /** 开一局新的对局，覆盖当前会话里的旧对局 */
  start(sessionKey: string, opponent?: string): ServiceResult {
    const battle = createBattle({
      enemyName: opponent,
      now: this.now(),
      seed: Math.floor(this.random() * 0x7fffffff),
    });
    this.store.set(sessionKey, battle);
    this.logger.info('对局开始', { sessionKey, battleId: battle.id, enemy: battle.enemy.name });
    return { text: narrateBattleStart(battle), battle };
  }

  /** 执行一次玩家出招 */
  act(sessionKey: string, rawAction: string): ServiceResult {
    const action = parseAction(rawAction);

    // 招式认不出来：不推进回合，只提示可选招式
    if (!action) {
      const battle = this.store.get(sessionKey) ?? null;
      this.logger.debug('招式无法识别', { sessionKey, rawAction });
      return { text: narrateUnknownAction(battle), battle };
    }

    let battle = this.store.get(sessionKey);
    let prefix = '';

    // 没开局就直接出招：顺手开一局，首句「攻击」也能玩，不让玩家对着空气说话
    if (!battle) {
      battle = createBattle({ now: this.now(), seed: Math.floor(this.random() * 0x7fffffff) });
      prefix = narrateAutoStart(battle);
      this.logger.info('对局自动开始', { sessionKey, battleId: battle.id, enemy: battle.enemy.name });
    }

    if (battle.phase !== 'battle') {
      return { text: narrateEnded(battle), battle };
    }

    const next = resolveTurn(battle, action, this.now());
    this.store.set(sessionKey, next);
    this.logger.info('玩家出招', { sessionKey, battleId: next.id, turn: next.turn, action });

    return { text: `${prefix}${narrateTurn(next, action)}`, battle: next };
  }

  /** 查看当前战况 */
  status(sessionKey: string): ServiceResult {
    const battle = this.store.get(sessionKey) ?? null;
    return { text: battle ? narrateStatus(battle) : narrateNoBattle(), battle };
  }

  /** 玩法说明，用于玩家不知道说什么的场景 */
  help(): ServiceResult {
    return { text: narrateHelp(), battle: null };
  }
}
