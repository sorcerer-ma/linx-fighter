import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 构建可独立运行的沙箱产物。
 *
 * 生产机只安装生产依赖（没有 tsx），所以沙箱必须编译成 JS 再启动。
 * 编译产物落在 dist-sandbox/：src 与 sandbox 一起编译，静态页与提示词
 * 按运行时用到的相对路径复制到对应位置。
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);

rmSync('dist-sandbox', { recursive: true, force: true });
execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.sandbox.json'], {
  stdio: 'inherit',
});

cpSync('sandbox/public', 'dist-sandbox/sandbox/public', { recursive: true });
mkdirSync('dist-sandbox/config', { recursive: true });
cpSync('config/linx-agent-prompt.md', 'dist-sandbox/config/linx-agent-prompt.md');
cpSync('config/companion-profiles', 'dist-sandbox/config/companion-profiles', { recursive: true });

console.log('沙箱构建完成：node dist-sandbox/sandbox/server.js');
