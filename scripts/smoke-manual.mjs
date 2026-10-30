// 纯手动模式冒烟：验证「没有 Python / 没有模型时，手动遮挡与导出仍然可用」（ADR-G03）。
//
// 与 smoke.mjs 的区别：那条链路要真实推理进程；这条完全不启动 worker，
// 只走主进程的本地解码（nativeImage）+ 本地绘制（src/domain/paint.mjs）导出。
//
// 用法：node scripts/smoke-manual.mjs
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import electronPath from 'electron';

const root = path.resolve(import.meta.dirname, '..');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
delete env.NODE_OPTIONS;
// 把 RI_PYTHON 指到不存在的路径，把「不依赖 Python」这件事在环境变量层面也说明白；
// 真正的保证是这条分支根本不构造推理客户端。
env.RI_PYTHON = path.join(os.tmpdir(), 'definitely-not-python.exe');

const resultFile = path.join(os.tmpdir(), `ri-manual-result-${Date.now()}.json`);
env.RI_SMOKE_OUT = resultFile;

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'ri-manual-'));
const child = spawn(
  electronPath,
  ['--no-sandbox', '--disable-gpu', '--in-process-gpu', '--disable-gpu-sandbox', `--user-data-dir=${userData}`, '.', '--smoke-manual'],
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
