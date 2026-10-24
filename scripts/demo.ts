/**
 * 不连 MCP 的本地演示：直接调用 GameService，打印每个指令的播报。
 * 只用来验证玩法链路与播报文案，和线上 MCP 调用走的是同一套逻辑。
 *
 *   pnpm demo
 */
import { GameService } from '../src/game/service.js';
import { createLogger } from '../src/log.js';
import { BattleStore } from '../src/store/battles.js';
import { RoomStore } from '../src/store/rooms.js';

const logger = createLogger('warn');
const store = new BattleStore({ ttlMs: 30 * 60_000 });
const rooms = new RoomStore({ ttlMs: 30 * 60_000 });
const service = new GameService({ store, rooms, logger });

const key = 'demo#local';

function print(label: string, text: string): void {
  console.log(`\n=== ${label} ===\n${text}`);
}

print('开局', (await service.start(key)).text);

for (const command of ['攻击', '闪避', '回气', 'attack', '随便说一句']) {
  print(`玩家：${command}`, (await service.act(key, command)).text);
}

// 双人联机演示：开房、第二位玩家加入、两人各出一招
const host = 'demo-host#local';
const guest = 'demo-guest#local';
print('房主开房', (await service.start(host, { mode: 'pvp' })).text);
const roomCode = service.status(host).text.match(/房间(\d{4})/)?.[1] ?? '';
print('对手加入', (await service.start(guest, { room: roomCode })).text);
print('房主出招', (await service.act(host, '强攻')).text);
print('对手应对', (await service.act(guest, '格挡')).text);

print('玩家：战况如何', service.status(key).text);
print('玩家：怎么玩', service.help().text);
print('另一台设备：战况如何', service.status('other-device#local').text);
