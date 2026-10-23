/**
 * 不连 MCP 的本地演示：直接调用 GameService，打印每个指令的播报。
 * 只用来验证玩法链路与播报文案，和线上 MCP 调用走的是同一套逻辑。
 *
 *   pnpm demo
 */
import { GameService } from '../src/game/service.js';
import { createLogger } from '../src/log.js';
import { BattleStore } from '../src/store/battles.js';

const logger = createLogger('warn');
const store = new BattleStore({ ttlMs: 30 * 60_000 });
const service = new GameService({ store, logger });

const key = 'demo#local';

function print(label: string, text: string): void {
  console.log(`\n=== ${label} ===\n${text}`);
}

print('开局', service.start(key).text);

for (const command of ['攻击', '闪避', '回气', 'attack', '随便说一句']) {
  print(`玩家：${command}`, service.act(key, command).text);
}

print('玩家：战况如何', service.status(key).text);
print('玩家：怎么玩', service.help().text);
print('另一台设备：战况如何', service.status('other-device#local').text);
