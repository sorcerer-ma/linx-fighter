import { loadConfig } from './config.js';
import { GameService } from './game/service.js';
import { createChatAnswerer } from './game/chat.js';
import { createJevEnemyAI } from './game/enemy-jev.js';
import { createCommandRouter } from './game/router.js';
import { createApp } from './http/app.js';
import { createLogger } from './log.js';
import { BattleStore } from './store/battles.js';
import { EchoStore } from './store/echoes.js';
import { RoomStore } from './store/rooms.js';
import { SERVER_NAME, SERVER_VERSION } from './mcp/server.js';

const config = loadConfig();
const logger = createLogger(config.logLevel);

const store = new BattleStore({ ttlMs: config.battleTtlMs });
const rooms = new RoomStore({ ttlMs: config.battleTtlMs });
// 配了 Command Code Key 才启用模型层；没配时规则认不出就回「没听清」
const router = config.commandCodeApiKey
  ? createCommandRouter({
      apiKey: config.commandCodeApiKey,
      baseUrl: config.commandCodeBaseUrl,
      model: config.commandCodeDecisionModel,
      timeoutMs: config.routerTimeoutMs,
      logger,
    })
  : undefined;
// 对手决策同样走决策模型；失败/超时由 AI 自己回退本地模型
const ai =
  config.commandCodeApiKey && config.enemyAi === 'jev'
    ? createJevEnemyAI({
        apiKey: config.commandCodeApiKey,
        baseUrl: config.commandCodeBaseUrl,
        model: config.commandCodeDecisionModel,
        timeoutMs: config.enemyTimeoutMs,
        logger,
      })
    : undefined;
// 规则外的问题交给语言模型：只答闲聊与常识，不碰对局数值
const chat = config.commandCodeApiKey
  ? createChatAnswerer({
      apiKey: config.commandCodeApiKey,
      baseUrl: config.commandCodeBaseUrl,
      model: config.commandCodeChatModel,
      timeoutMs: config.chatTimeoutMs,
      logger,
    })
  : undefined;
// 补账消息跟对局一起过期：玩家一直不开口，错过的结算也没必要再念
const echoes = new EchoStore({ ttlMs: config.battleTtlMs });
const service = new GameService({ store, rooms, logger, router, ai, chat, echo: echoes });
const app = createApp({ config, logger, store, rooms, service });

const server = app.listen(config.port, config.host, () => {
  logger.info('灵犀对决 MCP 服务已启动', {
    name: SERVER_NAME,
    version: SERVER_VERSION,
    address: `http://${config.host}:${config.port}`,
    sse: '/mcp',
    debugEndpoints: config.enableDebugEndpoints,
    routerModel: router ? config.commandCodeDecisionModel : 'disabled',
    enemyAi: ai ? `jev(${config.commandCodeDecisionModel})` : 'local',
    chatModel: chat ? config.commandCodeChatModel : 'disabled',
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
