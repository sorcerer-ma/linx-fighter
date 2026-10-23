import { loadConfig } from './config.js';
import { GameService } from './game/service.js';
import { createApp } from './http/app.js';
import { createLogger } from './log.js';
import { BattleStore } from './store/battles.js';
import { SERVER_NAME, SERVER_VERSION } from './mcp/server.js';

const config = loadConfig();
const logger = createLogger(config.logLevel);

const store = new BattleStore({ ttlMs: config.battleTtlMs });
const service = new GameService({ store, logger });
const app = createApp({ config, logger, store, service });

const server = app.listen(config.port, config.host, () => {
  logger.info('灵犀对决 MCP 服务已启动', {
    name: SERVER_NAME,
    version: SERVER_VERSION,
    address: `http://${config.host}:${config.port}`,
    sse: '/mcp',
    debugEndpoints: config.enableDebugEndpoints,
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
