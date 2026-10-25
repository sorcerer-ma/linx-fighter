import { ACTIONS } from './actions.js';
import { narrateEcho } from './narrator.js';

/**
 * 串音与指令归属：认出「这句话不是冲本机伙伴说的」。
 *
 * 真机现象：两台设备靠近时，另一位玩家的指令会被本机收走并当成自己的指令执行；
 * 更麻烦的是伙伴自己的播报会被同一台装置再收音、再回灌，于是出现错误动作和复读。
 * 服务端拿不到音频，也分不清说话人（说话人归属要靠平台侧声纹，见调研文档），
 * 这里只做一件保守的事：认得像我们自己播报的句子，交给 service 层极短应答。
 *
 * 判定原则——宁可漏判回灌，不可吞掉真指令：
 * - 只认播报独有的结构特征：结算数字、回合提示、房间播报、结局宣告、第三人数述；
 * - 只有招式加第一人称（「我出普攻」「我要大招」）一律不算回灌，那是玩家在指挥我；
 * - 代价上限是「少听一句提示」：命中后只回极短应答，不推进对局、不扣资源、不复读播报。
 *
 * 判定按「句」也算得准：播报的两句会被装置分段收音，任何一句单独回灌都要认出来，
 * 所以规则覆盖到第二句的说明语（「可以说普攻…」「说「开始游戏」可以再来一局」）。
 */

/** 数字可能是阿拉伯数字，也可能被 ASR 转成汉字（「5」念成「五」），两种都要认 */
const NUM = '[0-9一二两三四五六七八九十百]+';

/** 房间号同理：播报念的是数字，转写可能是阿拉伯数字也可能是汉字 */
const CODE = '[0-9]{4}|[一二两三四五六七八九零]{4}';

/** 极短应答本句的规则名：应答被再收一遍时不再开口，见 echoAck */
const ACK_RULE = 'ack';

/**
 * 回灌特征表：每条对应 narrator.ts 的一类真实文案。
 * 改播报文案时同步这张表，否则新句式会被当成玩家指令执行——test/crosstalk.test.ts 会兜住。
 */
export interface EchoRule {
  /** 命中后写进日志的规则名，真机排查串音时用它定位是哪类播报 */
  name: string;
  pattern: RegExp;
}

export const ECHO_RULES: readonly EchoRule[] = [
  // —— 结算与数值：一次念出「掉多少、剩多少」，玩家指挥时不会这么报数 ——
  { name: 'hp-result', pattern: new RegExp(`掉${NUM}点生命值`) },
  // 只报当前数值的半句：「我9点生命值、3点能量」既可能是播报，也可能是我在自报家门，
  // 后面还接着一句明确招式时按指令处理（见 FRAGMENT_RULES）
  { name: 'hp-report', pattern: new RegExp(`${NUM}点生命值`) },
  { name: 'ap-charge', pattern: new RegExp(`能量涨到${NUM}`) },
  // 播报原句是「我只有3点能量，大招要4点。」：带上后面的消耗半句才认，玩家单独问「我只有3点能量」不算
  { name: 'ap-short', pattern: new RegExp(`只有${NUM}点能量.{0,4}要${NUM}点`) },
  { name: 'ap-full', pattern: /能量(已经)?满了/ },
  { name: 'round-ramp', pattern: new RegExp(`伤害每轮加${NUM}`) },
  { name: 'round-line', pattern: new RegExp(`第${NUM}轮`) },
  // —— 回合与待应对：播报在替玩家确认下一步，玩家自己不会这么说 ——
  // 我方出手的首句：「我出大招，接招！」单独被收音时，只靠后面那句会漏判
  { name: 'attack-declared', pattern: new RegExp(`(普攻|强攻|大招|蓄力)接招`) },
  { name: 'pending-prompt', pattern: /还没结算/ },
  { name: 'pending-choice', pattern: /还是承受/ },
  { name: 'await-opponent', pattern: /等对手应对|等对手出招/ },
  { name: 'already-acted', pattern: /已经出招|已经出手/ },
  // 回合提示只认播报的完整说法：裸「轮到我」也是玩家常说的（「轮到我了，普攻」），不能算回灌
  { name: 'turn-hint', pattern: /该我出招|轮到我出招|轮到你出招|轮到我们/ },
  // —— 不生效的说明：这些解释只有播报会说 ——
  { name: 'action-blocked', pattern: /没打出去|两种招式/ },
  { name: 'unheard', pattern: /没听清这一手/ },
  { name: 'not-responded', pattern: /我还没(应对|出招)/ },
  { name: 'stale', pattern: /局面已经变了|这一手没生效/ },
  { name: 'already-used', pattern: /这一局(已经)?用过了/ },

  // —— 结局与开局 ——
  { name: 'ended', pattern: /击倒对手啦|我被击倒了|这一局已经结束|这局输了/ },
  { name: 'battle-start', pattern: /对决开始|没有进行中的对局/ },
  // —— 唤出回念、房间播报、补账、玩法说明 ——
  { name: 'chant', pattern: /朗声喝道/ },
  {
    name: 'room',
    // 只认挑战播报独有的结构：玩家说的「接受挑战，编号1234」是要加入，不能被当回灌吞掉
    // 尾句提示用「说「发起挑战」」「或者换一个编号」这类只有播报才有的说法兜住，逗号分段单独回灌也不会被当成新指令
    // 「换一个编号」单说不算回灌：那是玩家在说话，只是缺编号，交给模型路由
    pattern: new RegExp(
      `挑战已发起|还等着对方接受|接下了编号(${CODE})的挑战|没找到编号(${CODE})的挑战|已经被接受了|编号要.{0,2}四位|让对方说|就能进来|说.{0,2}发起挑战|或者换(?:个|一个)编号`,
    ),
  },
  {
    name: 'room-legacy',
    // 旧版房间播报：历史设备或回放里还可能念到，不能把「我进了房间1234」读成加入指令
    pattern: new RegExp(
      `房间(?:${CODE})(?:开好了|还等着|已经满员)|进了房间(?:${CODE})|没找到房间(?:${CODE})|房间号要.{0,2}四位|把房间号告诉另一位玩家|换一个房间号`,
    ),
  },
  { name: 'catchup', pattern: /刚才那一手/ },
  { name: 'help', pattern: /轮到我主动时|念唤出指令|按你的话/ },
  // 播报的第二句常是「下一步怎么说」的说明，玩家指挥时不会这么念
  { name: 'broadcast-hint', pattern: /可以说(普攻|强攻|大招|蓄力|格挡|闪避|承受)|直接说招式|说招式就行|一次只说一种|重新说一次/ },
  // 主动推送里的催促：玩家不会把「我陪你等着」这类陪伴话当成指令
  { name: 'push-wait', pattern: /还没听到你的指令|我陪你等着|对手还在琢磨|你定我照做/ },
  { name: 'replay-hint', pattern: /说.{0,2}开始游戏|陪你练一局/ },
  // 「现在只能承受，硬吃这一下」：句子后半句是播报才有的说法，玩家自己说「只能承受」不算
  { name: 'must-take', pattern: /只能承受.{0,6}硬吃这一下/ },
  { name: 'charge-hint', pattern: /可以先蓄力|或者换一招/ },
  // —— 攻击结算的胜负感受：闪避、硬扛，都是播报站在一方说的 ——
  { name: 'attack-result', pattern: /对手闪开了|我躲开啦|没躲开|只能硬扛/ },
  // —— 旧版播报：现场可能还有旧固件在念，真机日志里有原句 ——
  { name: 'legacy-attack', pattern: /(对手|你)一记/ },
  { name: 'legacy-ap', pattern: /能量耗尽/ },
  { name: 'legacy-stage', pattern: /主动阶段可以说/ },
  // —— 近亲：玩家把对手当主语在叙述招式，同样不是在指挥我（见文档「真人说对手」） ——
  { name: 'opponent-narration', pattern: /(对手|对面|对方)(出|用|放|来|使|打)?(普攻|强攻|大招|蓄力)/ },
  // —— 我们自己的极短应答：被装置再收一遍时既不算新指令，也不再回应 ——
  { name: ACK_RULE, pattern: /^[嗯恩哦啊呀呃喂]+$/ },
];

/**
 * 玩家自称要做什么时就是在下指令：句子里就算提到对手，也不能当回灌。
 * 只挡「我要 / 我想 / 我来 / 我去 / 我就」与「给我 / 帮我 / 替我 / 让我」这类明确意图，
 * 播报里的第一人称是「我已经 / 我还没 / 我该 / 我只能」，不会撞上。
 */
const SELF_INTENT = /(我|咱)(要|想|来|去|就)|(给|帮|替|让)我/;

/**
 * 玩家在同一句里已经报了自己的应对（「对手普攻，我格挡」）：这是在指挥我，不是叙述。
 * 只在对手叙述类规则上让位——带结算数字的播报仍然按回灌处理。
 */
const SELF_ACTION = /我.{0,6}(格挡|挡|闪避|躲|承受|硬扛|硬抗|扛)/;

/** 这些规则太像真人说话，玩家自己报了应对就让位 */
const SOFT_RULES = new Set(['opponent-narration', 'legacy-attack']);

/**
 * 数值类的片段：玩家自己也这么报数，后面紧跟着一手明确招式时那是在下指令。
 * 真机踩过「我还有14点生命值，普攻」被判成回灌，只回一声「嗯」，普攻没出去。
 * 只放行这几条；结算结果、待应对、结局与说明这类播报独有的结构仍旧一律算回灌。
 * 「只有N点能量，X要N点」不放行：那是拒绝出手的播报，放行会把提示当成玩家指令。
 */
const FRAGMENT_RULES = new Set(['hp-report', 'ap-charge', 'ap-full', 'round-line']);

/** 玩家自报数值的片段，与播报同形 */
const FRAGMENT_MARKS = [
  new RegExp(`${NUM}点生命值`),
  new RegExp(`第${NUM}轮`),
  /能量(?:已经)?满了/,
  new RegExp(`能量涨到${NUM}`),
];

/** 子句分隔：标点与空白都算，ASR 经常不给标点 */
const CLAUSE_SPLIT = /[，,。．.!！?？、；;：:\s]+/;

/**
 * 招式说法：从招式表取多字别名（「攻击」「防御」也是玩家常说的）。
 * 单字别名太宽，会撞上播报里的常用字；「出招」「出手」剔掉——播报里「直接出招」「该我出招」就在边上。
 */
const ACTION_ALIASES = [
  ...new Set(
    Object.values(ACTIONS)
      .flatMap((action) => action.aliases)
      .filter((alias) => alias.length >= 2 && /^[\u4e00-\u9fa5]+$/.test(alias))
      .filter((alias) => alias !== '出招' && alias !== '出手'),
  ),
];

/** 招式说法前面常带的语气、主语、时间词与动词：「那就先出普攻吧」 */
const ACTION_LEAD = /^(?:我|你|咱|那|就|也|都|先|再|直接|马上|赶紧|立刻|用|出|放|来|使|要|想|还是|给我|帮我|咱们)+/;

/** 招式说法后面常带的语气词 */
const ACTION_SUFFIX = /(?:吧|了|啊|呀|哦|呗|嘛|哈|呢)+$/;

/** 这个子句里是不是只剩一手明确的招式（「普攻」「那就攻击吧」） */
function isActionClause(clause: string): boolean {
  const word = clause.trim().replace(ACTION_SUFFIX, '').replace(ACTION_LEAD, '');
  return ACTION_ALIASES.includes(word);
}

/** 这个子句里数值片段之后还剩什么（没有片段返回 null） */
function restAfterFragment(clause: string): string | null {
  let end = -1;
  for (const mark of FRAGMENT_MARKS) {
    const hit = clause.match(mark);
    if (hit?.index !== undefined && hit.index + hit[0].length > end) end = hit.index + hit[0].length;
  }
  return end < 0 ? null : clause.slice(end);
}

/**
 * 数值片段后面紧跟一句明确招式：玩家先报自己的状态、再补一手，这是在指挥我。
 * ASR 给了逗号两块就分成两段（「14点生命值，攻击」），没给标点就粘在同一段（「14点生命值普攻」）。
 */
function hasActionAfterNumber(raw: string): boolean {
  const clauses = raw.split(CLAUSE_SPLIT).map((clause) => clause.trim()).filter(Boolean);
  return clauses.some((clause, index) => {
    const rest = restAfterFragment(clause);
    if (rest === null) return false;
    if (isActionClause(rest)) return true;
    // 数值后面还跟着别的描述，那是播报；只剩语气词才看向下一段
    if (rest.replace(ACTION_SUFFIX, '').replace(ACTION_LEAD, '') !== '') return false;
    const next = clauses[index + 1];
    return next !== undefined && isActionClause(next);
  });
}

/**
 * 玩家在提问：播报极少提问，句子里有疑问就一律不算回灌。
 * 真机踩过的坑：「轮到你了吗」被当成回合提示、「我只有3点能量」被当成能量播报，两声都不回。
 *
 * 问号不写在这里：squash 会把标点一起抹掉，写在字符集里是死分支，
 * 所以问号按原文判（见 ASK_MARK），这里只留口语疑问词。
 */
const PLAYER_QUESTION = /吗|呢|多少|几点|几个|多久|怎么办|轮到谁|该谁/;

/**
 * 播报自己也会提问（「对手强攻还没结算，我该格挡、闪避，还是承受？」），
 * 这类句子带问号也要照旧算回灌，否则会把播报读成战况查询。
 */
const BROADCAST_QUESTIONS = new Set(['pending-prompt', 'pending-choice']);

/** 问号按原文判：归一化文本里已经没有标点了 */
const ASK_MARK = /[?？]/;

/** 回灌应答的静默窗口：同一对局 2 秒内只开口一次 */
const ACK_QUIET_MS = 2_000;

/** 静默记录只留最近的会话，长跑服务里不能只增不减 */
const ACK_TRACK_LIMIT = 500;

/** 上次开口时间，键是对局会话（deviceId#agentId）；多进程部署时各自记各自的 */
const lastAckAt = new Map<string, number>();

/** 与 command.ts 的 compact 同口径：去空白与常见中英标点，念读停顿不影响整句匹配 */
function squash(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[\s，,。．.!！?？、"“”'‘’：:；;～~…·]/g, '');
}

/** 命中哪条回灌规则；没命中返回 null。规则名用于日志，不对外播报 */
export function matchEchoRule(text: string): string | null {
  const normalized = squash(text);
  if (!normalized) return null;
  if (SELF_INTENT.test(normalized)) return null;
  // 玩家在句子里明确补了一句招式：数值类的片段给指令让路，别只回一声「嗯」
  const directed = hasActionAfterNumber(text);
  const rule = ECHO_RULES.find(
    (item) => !(directed && FRAGMENT_RULES.has(item.name)) && item.pattern.test(normalized),
  );
  // 整段播报可能把「…还是承受？」接在别的句子后面，所以按「整段里有没有播报问句」判
  const broadcastQuestion = ECHO_RULES.some(
    (item) => BROADCAST_QUESTIONS.has(item.name) && item.pattern.test(normalized),
  );
  if (!broadcastQuestion) {
    if (ASK_MARK.test(text)) return null;
    if (PLAYER_QUESTION.test(normalized)) return null;
  }
  if (!rule) return null;
  if (SOFT_RULES.has(rule.name) && SELF_ACTION.test(normalized)) return null;
  return rule.name;
}

/** 这句话像不像我们自己的播报（或把对手当主语的叙述） */
export function looksLikeAssistantEcho(text: string): boolean {
  return matchEchoRule(text) !== null;
}

/**
 * 回灌命中后的应答：只说一个字，而且同一对局短时间内不重复开口。
 *
 * 断环：伙伴的「嗯」一样会被装置再收一遍，如果每次都答，两台设备会互相点头。
 * 所以应答本句永不再答，2 秒内的重复回灌也不出声——返回空串表示这次没什么可说的，
 * 平台侧没有可朗读的文本，环路就断在这里。
 */
export function echoAck(sessionKey: string, text: string, now = Date.now()): string {
  if (matchEchoRule(text) === ACK_RULE) return '';
  const last = lastAckAt.get(sessionKey);
  if (last !== undefined && now - last < ACK_QUIET_MS) return '';
  if (lastAckAt.size >= ACK_TRACK_LIMIT) {
    for (const [key, at] of lastAckAt) {
      if (now - at >= ACK_QUIET_MS) lastAckAt.delete(key);
    }
  }
  lastAckAt.set(sessionKey, now);
  return narrateEcho();
}
