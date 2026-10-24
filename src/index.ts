import { loadConfig } from './config.js';
import { GameService } from './game/service.js';
import { createJevEnemyAI } from './game/enemy-jev.js';
import { createIntentResolver } from './game/intent.js';
import { createApp } from './http/app.js';
import { createLogger } from './log.js';
import { BattleStore } from './store/battles.js';
import { RoomStore } from './store/rooms.js';
import { SERVER_NAME, SERVER_VERSION } from './mcp/server.js';

const config = loadConfig();
const logger = createLogger(config.logLevel);

const store = new BattleStore({ ttlMs: config.battleTtlMs });
const rooms = new RoomStore({ ttlMs: config.battleTtlMs });
// 配了 OpenRouter Key 才启用意图模型；没配时只走规则匹配，不影响可玩性
const intent = config.openrouterApiKey
  ? createIntentResolver({
      apiKey: config.openrouterApiKey,
      model: config.openrouterModel,
      timeoutMs: config.intentTimeoutMs,
      logger,
    })
  : undefined;
// 配了 Key 才让对手也走 JEV 决策；失败/超时由 AI 自己回退本地模型
const ai =
  config.openrouterApiKey && config.enemyAi === 'jev'
    ? createJevEnemyAI({
        apiKey: config.openrouterApiKey,
        model: config.openrouterModel,
        timeoutMs: config.enemyTimeoutMs,
        logger,
      })
    : undefined;
const service = new GameService({ store, rooms, logger, intent, ai });
const app = createApp({ config, logger, store, rooms, service });

const server = app.listen(config.port, config.host, () => {
  logger.info('灵犀对决 MCP 服务已启动', {
    name: SERVER_NAME,
    version: SERVER_VERSION,
    address: `http://${config.host}:${config.port}`,
    sse: '/mcp',
    debugEndpoints: config.enableDebugEndpoints,
    intentModel: intent ? config.openrouterModel : 'disabled',
    enemyAi: ai ? `jev(${config.openrouterModel})` : 'local',
  });
});

/** 优雅退出：停止接收新连接后退出，避免容器里留下孤儿进程 */
function shutdown(signal: string): void {
  logger.info('收到退出信号，开始关闭服务', { signal });
  server.close((error) => {
    if (error) {
      logger.error('关闭服务失败', { error: error.message });
      process.exit(1);
    }
    logger.info('服务已关闭');
    process.exit(0);
  });
  // 兜底：SSE 长连接可能让 close 迟迟不回调，超时强制退出
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
