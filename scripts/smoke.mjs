// 桌面冒烟：真实 Electron + 真实 Python 推理 + 真实导出。
//
// 由渲染层在 `?smoke=1` 时驱动整条链路（载入夹具 → 自动建议 → 全部采用 →
// 加一条手动区域 → 导出），主进程校验报告后以退出码表示结果。
//
// 用法：node scripts/smoke.mjs
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import electronPath from 'electron';

const root = path.resolve(import.meta.dirname, '..');

// 终端可能跑在 Electron 里（IDE 内置终端），会带 ELECTRON_RUN_AS_NODE=1，
// 使 electron 二进制退化成纯 Node，app 为 undefined。
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
delete env.NODE_OPTIONS;

// 冒烟用自己的 userData 目录：默认目录被宿主占用时 GPU 持久化缓存会反复崩溃。
// 远程/无显卡会话里 Chromium GPU 进程无法启动，用进程内 GPU + 软件光栅绕开。
// 这些只是测试开关，不影响产品代码。
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'ri-smoke-'));
const child = spawn(
  electronPath,
  [
    '--no-sandbox',
    '--disable-gpu',
    '--in-process-gpu',
    '--disable-gpu-sandbox',
    `--user-data-dir=${userData}`,
    '.',
    '--smoke',
  ],
  { cwd: root, env, stdio: 'inherit' }
);

child.on('exit', (code) => {
  try {
    fs.rmSync(userData, { recursive: true, force: true });
  } catch {
    /* 临时目录清理失败不影响结论 */
  }
  process.exit(code ?? 1);
});
