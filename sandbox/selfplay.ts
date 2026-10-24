import { createLogger } from '../src/log.js';
import { loadSandboxConfig } from './config.js';
import type { BattleState } from '../src/game/state.js';
import { SandboxClient, type BattleSnapshot } from './platform/client.js';

/**
 * 自对弈：两个沙箱身份通过 MCP 入口自动打完一局。
 *
 * 为什么需要它：沙箱的目的就是把「开两个浏览器窗口互相对战」变成可脚本化的行为，
 * 让 Agent 不依赖控制台与硬件就能反复跑对局、验证播报与状态同步。
 *
 * 这里刻意只用页面同款接口（say / state），不直接调服务端内部函数：
 * 走的是玩家真正会走的那条链路，跑通才有意义。
 *
 * 每一步都会留一份「谁说了什么、听到什么、之后双方什么状态」的记录，
 * 加 --json 导出后可以据此写对局复盘，不用再靠截图。
 */
const TRANSCRIPT_LIMIT = 80;
const DEFAULT_ROUNDS = 1;
const MAX_STEPS = 200;

interface DuelOptions {
  client: SandboxClient;
  asJson: boolean;
  verbose: boolean;
}

/** 一方的气血与真气，用于复盘里画状态 */
interface SideState {
  name: string;
  hp: number;
  maxHp: number;
  ap: number;
  maxAp: number;
  ultLeft: number;
}

/** 一步的完整记录：原话、播报、以及这一手之后的双方状态 */
interface DuelStep {
  step: number;
  device: string;
  text: string;
  reply: string;
  /** 公共状态以房主视角记：双人局双方看的是同一局的镜像 */
  round: number | null;
  phase: BattleState['phase'] | null;
  active: 'player' | 'enemy' | null;
  pending: { actor: 'player' | 'enemy'; moveLabel: string; damage: number } | null;
  host: SideState | null;
  guest: SideState | null;
  historyCount: number;
}

interface DuelResult {
  round: number;
  room: string;
  players: { host: string; guest: string };
  firstMover: 'host' | 'guest' | null;
  winner: 'host' | 'guest';
  turns: number;
  steps: number;
  mirrorChecks: number;
  hostHp: number;
  guestHp: number;
  transcript: DuelStep[];
}

/** 两名玩家：每局换一对身份，避免上一局的对局与房间串到下一局 */
function playersFor(round: number): [string, string] {
  return [`web-self-${round}-a`, `web-self-${round}-b`];
}

/**
 * 一次合法操作的选择：只依据服务端快照判断，不推算规则。
 * - 有待应对的攻击且不是自己打的 → 选一个应对；
 * - 没有待应对且轮到自己 → 按真气与剩余大招挑一招。
 */
function decide(snapshot: BattleSnapshot | null, counter: number): string | null {
  const battle = snapshot?.battle;
  if (!battle || battle.phase !== 'battle') return null;

  if (battle.pending) {
    if (battle.pending.actor === 'player') return null; // 自己打出的，等对面应对
    // 格挡与闪避各要 1 点真气，真气空了只能硬扛
    if (battle.you.ap < 1) return '承受';
    const responses = ['格挡', '闪避', '承受'];
    return responses[counter % responses.length]!;
  }

  if (battle.active !== 'player') return null; // 轮到对面主动出招

  // 招式真气价目：普攻 1 / 强攻 2 / 大招 4，真气不够就蓄力攒到能放大招
  if (battle.you.ultLeft > 0 && battle.you.ap >= 4) return '大招';
  if (battle.you.ap >= 2) return '强攻';
  if (battle.you.ap >= 1) return '普攻';
  return '蓄力';
}

/** 两名玩家看到的是同一局的镜像视角，逐项对一遍 */
function assertMirror(a: BattleSnapshot | null, b: BattleSnapshot | null): void {
  const left = a?.battle;
  const right = b?.battle;
  if (!left || !right) throw new Error(`两名玩家应同时在对局中：${JSON.stringify({ a: !!a?.battle, b: !!b?.battle })}`);

  const fail = (what: string): never => {
    throw new Error(`镜像不一致：${what}`);
  };
  if (left.room !== right.room) fail(`房间 ${left.room} vs ${right.room}`);
  if (left.round !== right.round) fail(`轮次 ${left.round} vs ${right.round}`);
  if (left.phase !== flipPhase(right.phase)) fail(`阶段 ${left.phase} vs ${right.phase}`);
  if (left.you.hp !== right.opponent.hp) fail(`气血 ${left.you.hp} vs ${right.opponent.hp}`);
  if (left.opponent.hp !== right.you.hp) fail(`气血 ${left.opponent.hp} vs ${right.you.hp}`);
  if (left.you.maxHp !== right.opponent.maxHp) fail('气血上限不一致');
  if (left.you.ap !== right.opponent.ap) fail(`真气 ${left.you.ap} vs ${right.opponent.ap}`);
  if (left.you.ultLeft !== right.opponent.ultLeft) fail('剩余大招不一致');
  if ((left.pending?.actor ?? null) !== flip(right.pending?.actor ?? null)) fail('待应对方向不一致');
  if (left.active !== flip(right.active)) fail('轮次归属不一致');
  if (left.firstMover !== flip(right.firstMover)) fail('先手不一致');
}

/** 胜负是相对各自视角记的：一方 victory，另一方一定是 defeat */
function flipPhase(phase: BattleState['phase']): BattleState['phase'] {
  if (phase === 'victory') return 'defeat';
  if (phase === 'defeat') return 'victory';
  return 'battle';
}

function flip(side: 'player' | 'enemy' | null): 'player' | 'enemy' | null {
  if (side === 'player') return 'enemy';
  if (side === 'enemy') return 'player';
  return null;
}

function short(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length <= TRANSCRIPT_LIMIT ? oneLine : `${oneLine.slice(0, TRANSCRIPT_LIMIT)}…`;
}

function sideState(fighter: BattleState['you'] | undefined): SideState | null {
  if (!fighter) return null;
  const { name, hp, maxHp, ap, maxAp, ultLeft } = fighter;
  return { name, hp, maxHp, ap, maxAp, ultLeft };
}

/** 一步之后的状态，给终端与 --json 复盘用 */
function stateLine(step: DuelStep): string {
  if (!step.host || !step.guest) return '未开局';
  const ult = (side: SideState): string => (side.ultLeft > 0 ? '★' : '☆');
  const pending = step.pending
    ? ` · 待应对：${step.pending.moveLabel}（${step.pending.damage} 伤害，${step.pending.actor === 'player' ? '房主' : '访客'}出手）`
    : step.phase === 'battle'
      ? ` · 轮到${step.active === 'player' ? '房主' : '访客'}出招`
      : '';
  return `R${step.round} · 房主 ${step.host.hp}/${step.host.maxHp} 气${step.host.ap}${ult(step.host)} · 访客 ${step.guest.hp}/${step.guest.maxHp} 气${step.guest.ap}${ult(step.guest)}${pending}`;
}

/** 打一局：开房 → 加入 → 轮流出手直到分出胜负 */
async function playDuel(options: DuelOptions, round: number): Promise<DuelResult> {
  const { client } = options;
  const [host, guest] = playersFor(round);
  const transcript: DuelStep[] = [];

  const capture = async (deviceId: string, text: string, reply: string): Promise<void> => {
    const hostState = await client.state(host);
    const guestState = await client.state(guest);
    const battle = hostState?.battle ?? null;
    const guestBattle = guestState?.battle ?? null;
    transcript.push({
      step: transcript.length + 1,
      device: deviceId,
      text,
      reply,
      round: battle?.round ?? null,
      phase: battle?.phase ?? null,
      active: battle?.active ?? null,
      pending: battle?.pending
        ? { actor: battle.pending.actor, moveLabel: battle.pending.moveLabel, damage: battle.pending.damage }
        : null,
      host: sideState(battle?.you),
      guest: sideState(guestBattle?.you),
      historyCount: battle?.history.length ?? 0,
    });
  };

  const say = async (deviceId: string, text: string): Promise<string> => {
    const result = await client.say(deviceId, text);
    if (!result.ok) throw new Error(`${deviceId} 调用失败：${result.reply}`);
    await capture(deviceId, text, result.reply);
    return result.reply;
  };

  const opened = await say(host, '开房间');
  const room = /房间(\d{4})/.exec(opened)?.[1];
  if (!room) throw new Error(`开房失败，播报里没有房间号：${opened}`);
  await say(guest, `加入房间${room}`);

  // 每局穿插一次「查战况」与一次 ASR 误识别，验证非招式语句不会推进回合
  await say(host, '战况如何');
  await say(guest, '公鸡');

  let steps = 0;
  let checks = 0;
  for (; steps < MAX_STEPS; steps += 1) {
    const hostState = await client.state(host);
    const guestState = await client.state(guest);
    assertMirror(hostState, guestState);
    checks += 1;

    if (hostState?.battle && hostState.battle.phase !== 'battle') break;

    const actor = decide(hostState, steps) ? host : decide(guestState, steps) ? guest : null;
    if (!actor) throw new Error(`第 ${steps} 步两位玩家都没有可执行操作，但对局尚未结束`);
    const snapshot = actor === host ? hostState : guestState;
    const action = decide(snapshot, steps);
    if (!action) throw new Error('内部错误：决定出手时拿到空操作');
    await say(actor, action);
  }

  const finalHost = await client.state(host);
  const finalGuest = await client.state(guest);
  const hostBattle = finalHost?.battle;
  const guestBattle = finalGuest?.battle;
  if (!hostBattle || !guestBattle) throw new Error('结算后应仍能取到对局');
  if (hostBattle.phase === 'battle') throw new Error(`打了 ${MAX_STEPS} 步还没分出胜负`);

  const winner = hostBattle.phase === 'victory' ? 'host' : 'guest';
  assertMirror(finalHost, finalGuest);
  if (guestBattle.phase !== flipPhase(hostBattle.phase)) throw new Error('胜负视角不一致');

  const result: DuelResult = {
    round,
    room,
    players: { host, guest },
    firstMover: hostBattle.firstMover === 'player' ? 'host' : 'guest',
    winner,
    turns: hostBattle.round,
    steps,
    mirrorChecks: checks,
    hostHp: hostBattle.you.hp,
    guestHp: guestBattle.you.hp,
    transcript,
  };

  if (!options.asJson) {
    console.log(`\n第 ${round} 局 · 房间 ${room} · 先手 ${result.firstMover === 'host' ? '房主' : '访客'}`);
    for (const line of transcript) {
      const who = line.device === host ? '房主' : '访客';
      const reply = options.verbose ? line.reply : short(line.reply);
      console.log(`  ${String(line.step).padStart(2, ' ')}. ${who} 说「${line.text}」→ ${reply}`);
      console.log(`      ${stateLine(line)}`);
    }
    console.log(`  结果：${winner === 'host' ? '房主' : '访客'} 胜，${hostBattle.round} 轮结束；镜像校验 ${checks} 次通过`);
  }

  return result;
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const roundsFlag = argv.indexOf('--rounds');
  const rounds = roundsFlag >= 0 ? Math.max(1, Number.parseInt(argv[roundsFlag + 1] ?? '', 10) || DEFAULT_ROUNDS) : DEFAULT_ROUNDS;
  const asJson = argv.includes('--json');
  const verbose = argv.includes('--verbose');

  const config = loadSandboxConfig();
  const client = new SandboxClient({
    upstream: config.upstream,
    agentId: config.agentId,
    timeoutMs: config.timeoutMs,
    // CLI 只要结果，不要每请求日志
    logger: createLogger('error'),
    // 默认模拟无屏终端（硬件那条链路，播报里会补上错过的结算）；要看网页那种不补账的加 --screen
    display: argv.includes('--screen') ? 'screen' : 'voice',
  });

  const summaries: DuelResult[] = [];
  for (let round = 1; round <= rounds; round += 1) {
    summaries.push(await playDuel({ client, asJson, verbose }, round));
  }

  if (asJson) console.log(JSON.stringify({ ok: true, rounds: summaries }, null, 2));
  else console.log(`\n共 ${rounds} 局，全部通过；上游 ${config.upstream}`);
  return 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(`自对弈失败：${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  },
);
