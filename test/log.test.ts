import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { LogLevel } from '../src/config.js';
import { createLogger } from '../src/log.js';

interface Captured {
  logs: string[];
  errors: string[];
}

/** 临时接管控制台，收集日志行，测完还原 */
function capture(level: LogLevel, run: (logger: ReturnType<typeof createLogger>) => void): Captured {
  const logs: string[] = [];
  const errors: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;

  console.log = ((line: string) => {
    logs.push(line);
  }) as typeof console.log;
  console.error = ((line: string) => {
    errors.push(line);
  }) as typeof console.error;

  try {
    run(createLogger(level));
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }

  return { logs, errors };
}

describe('日志', () => {
  it('低于级别的日志直接丢弃', () => {
    const { logs, errors } = capture('warn', (logger) => {
      logger.debug('调试');
      logger.info('信息');
    });
    assert.equal(logs.length, 0);
    assert.equal(errors.length, 0);
  });

  it('warn 与 error 走 stderr，输出单行 JSON', () => {
    const { logs, errors } = capture('warn', (logger) => {
      logger.warn('警告', { code: 'W1' });
      logger.error('错误');
    });

    assert.equal(logs.length, 0);
    assert.equal(errors.length, 2);

    const warn = JSON.parse(errors[0]!) as Record<string, unknown>;
    assert.equal(warn.level, 'warn');
    assert.equal(warn.message, '警告');
    assert.equal(warn.code, 'W1');
    assert.ok(typeof warn.time === 'string');

    const error = JSON.parse(errors[1]!) as Record<string, unknown>;
    assert.equal(error.level, 'error');
  });

  it('debug 级别输出全部日志到 stdout', () => {
    const { logs, errors } = capture('debug', (logger) => {
      logger.debug('调试');
      logger.info('信息', { turn: 1 });
    });

    assert.equal(errors.length, 0);
    assert.equal(logs.length, 2);
    const info = JSON.parse(logs[1]!) as Record<string, unknown>;
    assert.equal(info.level, 'info');
    assert.equal(info.turn, 1);
  });
});
