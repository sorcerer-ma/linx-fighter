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
 */
const TRANSCRIPT_LIMIT = 80;
const DEFAULT_ROUNDS = 1;
const MAX_STEPS = 200;

interface DuelOptions {
  rounds: number;
  client: SandboxClient;
  asJson: boolean;
}

interface TranscriptLine {
  step: number;
  device: string;
  text: string;
  reply: string;
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

/** 打一局：开房 → 加入 → 轮流出手直到分出胜负 */
async function playDuel(options: DuelOptions, round: number): Promise<Record<string, unknown>> {
  const { client } = options;
  const [host, guest] = playersFor(round);
  const transcript: TranscriptLine[] = [];

  const say = async (deviceId: string, text: string): Promise<string> => {
    const result = await client.say(deviceId, text);
    transcript.push({ step: transcript.length + 1, device: deviceId, text, reply: result.reply });
    if (!result.ok) throw new Error(`${deviceId} 调用失败：${result.reply}`);
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

  const winner = hostBattle.phase === 'victory' ? host : guest;
  assertMirror(finalHost, finalGuest);
  if (guestBattle.phase !== flipPhase(hostBattle.phase)) throw new Error('胜负视角不一致');

  const summary = {
    round,
    room,
    winner,
    turns: hostBattle.round,
    steps,
    mirrorChecks: checks,
    hostHp: hostBattle.you.hp,
    guestHp: guestBattle.you.hp,
  };

  if (!options.asJson) {
    console.log(`\n第 ${round} 局 · 房间 ${room}`);
    for (const line of transcript) {
      console.log(`  ${String(line.step).padStart(2, ' ')}. ${line.device} 说「${line.text}」→ ${short(line.reply)}`);
    }
    console.log(`  结果：${winner} 胜，${hostBattle.round} 轮结束；镜像校验 ${checks} 次通过`);
  }

  return summary;
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const roundsFlag = argv.indexOf('--rounds');
  const rounds = roundsFlag >= 0 ? Math.max(1, Number.parseInt(argv[roundsFlag + 1] ?? '', 10) || DEFAULT_ROUNDS) : DEFAULT_ROUNDS;
  const asJson = argv.includes('--json');

  const config = loadSandboxConfig();
  const client = new SandboxClient({
    upstream: config.upstream,
    agentId: config.agentId,
    timeoutMs: config.timeoutMs,
    // CLI 只要结果，不要每请求日志
    logger: createLogger('error'),
  });

  const summaries: Record<string, unknown>[] = [];
  for (let round = 1; round <= rounds; round += 1) {
    summaries.push(await playDuel({ rounds, client, asJson }, round));
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
