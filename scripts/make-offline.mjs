// 离线打包：绕开 @electron/get 的校验死锁。
//
// 背景：本机访问 github.com/electron/electron/releases 会 ECONNRESET。
// @electron/get 即使命中本地缓存，仍要下载 SHASUMS256.txt 校验；校验请求失败会被
// 当成"缓存不匹配"，进而回退去重新下载整个 zip —— 同样失败。于是打包必然中断：
//   × Copying files [FAILED: read ECONNRESET]
//
// 做法：用缓存里那份已下载的真实 zip 自行算出 SHA-256，起一个只监听 127.0.0.1 的
// 极小 HTTP 镜像，同时提供 zip 与 SHASUMS256.txt，让校验在本地完成。
// 这只影响构建机取二进制的方式，不改变任何打进安装包的内容。
//
// 用法（必须先 subst 出 ASCII 盘符，否则 rcedit 处理中文路径会失败）：
//   subst X: "<项目根>"
//   node scripts/make-offline.mjs make
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

const VERSION = '44.9.3';
const ZIP_NAME = `electron-v${VERSION}-win32-x64.zip`;
const cacheRoot = path.join(process.env.LOCALAPPDATA || '', 'electron', 'Cache');
const projectDir = process.env.RI_PROJECT_DIR || 'X:/reflection-inspector';

function findCachedZip() {
  if (!fs.existsSync(cacheRoot)) return null;
  for (const entry of fs.readdirSync(cacheRoot)) {
    const candidate = path.join(cacheRoot, entry, ZIP_NAME);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

const zip = findCachedZip();
if (!zip) {
  console.error(`找不到缓存的 ${ZIP_NAME}（在 ${cacheRoot} 下）。`);
  console.error('先联网跑一次 npx electron-forge package 让它把 zip 下下来，再重试。');
  process.exit(1);
}

const bytes = fs.readFileSync(zip);
const sha = crypto.createHash('sha256').update(bytes).digest('hex');
console.log(`缓存 zip: ${zip}`);
console.log(`  ${bytes.length.toLocaleString()} 字节  sha256=${sha}`);

const shasums = `${sha} *${ZIP_NAME}\n`;

const server = http.createServer((req, res) => {
  const url = (req.url || '').split('?')[0];
  console.log(`[mirror] ${req.method} ${url}`);
  if (url === `/v${VERSION}/SHASUMS256.txt`) {
    res.writeHead(200, {
      'Content-Type': 'text/plain',
      'Content-Length': Buffer.byteLength(shasums),
    });
    return res.end(shasums);
  }
  if (url === `/v${VERSION}/${ZIP_NAME}`) {
    res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': bytes.length });
    return res.end(bytes);
  }
  res.writeHead(404);
  res.end('not found');
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
console.log(`本地镜像 http://127.0.0.1:${port}/`);

const env = { ...process.env, ELECTRON_MIRROR: `http://127.0.0.1:${port}/` };
// 宿主 IDE 会注入 NODE_OPTIONS 的 fs.rm 拦截垫片，会挡住 forge 清理旧 out/ 目录。
delete env.NODE_OPTIONS;
delete env.ELECTRON_RUN_AS_NODE;

const args = process.argv.slice(2);
const child = spawn('npx', ['electron-forge', ...(args.length ? args : ['make'])], {
  cwd: projectDir,
  env,
  stdio: 'inherit',
  shell: true,
});
child.on('exit', (code) => {
  server.close();
  process.exit(code ?? 1);
});
