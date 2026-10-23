import type { LogLevel } from './config.js';

const WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

/**
 * 单行 JSON 日志：一行一条，方便 grep 与日志采集。
 * 框架阶段先用控制台输出，接日志系统时只改这一处。
 */
export function createLogger(level: LogLevel): Logger {
  const threshold = WEIGHT[level];

  const write = (lvl: LogLevel, message: string, fields?: Record<string, unknown>): void => {
    if (WEIGHT[lvl] < threshold) return;
    const line = JSON.stringify({ time: new Date().toISOString(), level: lvl, message, ...fields });
    if (lvl === 'error' || lvl === 'warn') console.error(line);
    else console.log(line);
  };

  return {
    debug: (message, fields) => write('debug', message, fields),
    info: (message, fields) => write('info', message, fields),
    warn: (message, fields) => write('warn', message, fields),
    error: (message, fields) => write('error', message, fields),
  };
}
