import { createSandboxAgent } from './platform/agent.js';
import { createLogger } from '../src/log.js';
import { loadSandboxConfig } from './config.js';
import { SandboxClient, type BattleSnapshot } from './platform/client.js';

/**
 * 沙箱命令行：不打开浏览器也能把整条链路跑一遍，给 Agent 做自主模拟用。
 *
 * 输出是给人看的，所以这里用 console（服务端日志仍然走 createLogger）。
 */
const USAGE = `灵矽沙箱命令行

用法：
  tsx sandbox/cli.ts say   [--device web-cli] "玩家原话"   把一句话交给服务端，打印播报与局面
  tsx sandbox/cli.ts wait  [--device web-cli]              等待一次对手事件（先读完上一条回复）
  tsx sandbox/cli.ts state [--device web-cli]              打印当前局面 JSON
  tsx sandbox/cli.ts tools                                 打印服务端 MCP 工具

选项：
  --device <id>   玩家身份，默认 web-cli；双人模拟时用 web-p1 / web-p2
  --voice        模拟无屏硬件：保留补账播报（页面默认有屏，不补账）
  --json          打印原始 JSON（调试用）
`;

interface ParsedArgs {
  command: string;
  positionals: string[];
  flags: Record<string, string | true>;
}

/** 纯开关，不吃后面的参数（否则 `--voice "强攻"` 会把原话当成它的值） */
const BOOLEAN_FLAGS = new Set(['json', 'voice', 'verbose', 'help']);

function parseArgs(argv: string[]): ParsedArgs {
  const [command = '', ...rest] = argv;
  const positionals: string[] = [];
  const flags: Record<string, string | true> = {};

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index]!;
    if (!arg.startsWith('--')) {
      positionals.push(arg);
      continue;
    }
    const name = arg.slice(2);
    const next = rest[index + 1];
    if (!BOOLEAN_FLAGS.has(name) && next !== undefined && !next.startsWith('--')) {
      flags[name] = next;
      index += 1;
    } else {
      flags[name] = true;
    }
  }

  return { command, positionals, flags };
}

function flagText(flags: ParsedArgs['flags'], name: string): string | undefined {
  const value = flags[name];
  return typeof value === 'string' ? value : undefined;
}

/** 一句话概括局面，CLI 每次调用后打一行，方便脚本里连着跑 */
function describeState(state: BattleSnapshot | null): string {
  if (!state?.battle) return state?.room ? `房间 ${state.room} · 暂无对局` : '暂无对局';
  const battle = state.battle;
  const parts: string[] = [];
  if (battle.room) parts.push(`房间 ${battle.room}`);
  parts.push(`第${battle.round}轮`);
  parts.push(phaseText(battle));
  parts.push(`你 ${battle.you.hp}/${battle.you.maxHp} 能量${battle.you.ap}`);
  parts.push(`${battle.opponent.name} ${battle.opponent.hp}/${battle.opponent.maxHp}`);
  return parts.join(' · ');
}

function phaseText(battle: NonNullable<BattleSnapshot['battle']>): string {
  if (battle.phase === 'victory') return '你赢了';
  if (battle.phase === 'defeat') return '你输了';
  if (battle.pending) return battle.pending.actor === 'enemy' ? `对手${battle.pending.moveLabel}已锁定` : '等对手应对';
  return battle.active === 'player' ? '你的回合' : '对手行动中';
}

async function main(argv: string[]): Promise<number> {
  const { command, positionals, flags } = parseArgs(argv);
  if (!command || command === 'help' || flags.help) {
    console.log(USAGE);
    return command ? 0 : 1;
  }

  const config = loadSandboxConfig();
  // CLI 只要结果，不要服务端的每请求日志
  const logger = createLogger('error');
  const display = flags.voice === true ? 'voice' : config.display;
  const client = new SandboxClient({
    agent: createSandboxAgent(config.agent),
    upstream: config.upstream,
    agentId: config.agentId,
    timeoutMs: config.timeoutMs,
    logger,
    display,
  });
  const deviceId = flagText(flags, 'device') ?? 'web-cli';
  const asJson = flags.json === true;

  if (command === 'say' || command === 'wait') {
    const text = flagText(flags, 'text') ?? positionals.join(' ').trim();
    if (command === 'say' && !text) {
      console.error('缺少要说的内容，例如：tsx sandbox/cli.ts say --device web-p1 "共鸣对决，发起挑战"');
      return 1;
    }

    const abort = new AbortController();
    const cancel = () => abort.abort();
    if (command === 'wait') process.once('SIGINT', cancel);
    const result = await (command === 'wait'
      ? client.wait(deviceId, { signal: abort.signal })
      : client.say(deviceId, text)).finally(() => process.removeListener('SIGINT', cancel));
    if (asJson) {
      console.log(JSON.stringify(result, null, 2));
      return result.ok ? 0 : 1;
    }

    if (command === 'say') console.log(`玩家 ${deviceId}：${text}`);
    console.log(result.silent ? '（静默，不播报）' : `伙伴：${result.reply}`);
    if (result.protocol?.need === 'wait_guest' || result.protocol?.need === 'wait_foe') {
      console.log('（需要等待：读完本句后可运行 wait；CLI wait读取一次；持续串行续挂由Agent或页面负责）');
    }
    if (display === 'voice') console.log('（模拟无屏硬件：补账播报开启）');
    console.log(`局面：${describeState(result.state)}`);
    if (!result.ok) console.error(`（上游：${config.upstream}）`);
    return result.ok ? 0 : 1;
  }

  if (command === 'state') {
    try {
      const state = await client.state(deviceId);
      console.log(JSON.stringify(state, null, 2));
      return 0;
    } catch (error) {
      console.error(`取局面失败：${error instanceof Error ? error.message : String(error)}`);
      return 1;
    }
  }

  if (command === 'tools') {
    try {
      const tools = await client.tools();
      if (asJson) {
        console.log(JSON.stringify(tools, null, 2));
        return 0;
      }
      for (const tool of tools) {
        const title = tool.title ? `（${tool.title}）` : '';
        console.log(`${tool.name}${title}`);
      }
      return 0;
    } catch (error) {
      console.error(`取工具清单失败：${error instanceof Error ? error.message : String(error)}`);
      return 1;
    }
  }

  console.error(`未知命令：${command}\n`);
  console.log(USAGE);
  return 1;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  },
);
