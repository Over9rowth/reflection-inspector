// 一次性生成图标：resources/icon.svg → 多尺寸 PNG → icon.ico
//
// 为什么要单独一个脚本：Windows 安装包与窗口图标要 ICO，而 ICO 需要多尺寸。
// 项目本身不依赖 sharp（运行时用不到），所以渲染时借用隔壁 compression-microscope
// 已安装的 sharp，通过 NODE_PATH 指定，不往本项目里加构建期依赖。
//
// 用法：
//   NODE_PATH="<compression-microscope>/node_modules" node scripts/make-icon.mjs
//
// 产物（都已提交，正常开发不需要重跑）：
//   resources/icon-16.png … icon-256.png
//   resources/icon.ico
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const sharp = require('sharp');

const root = path.resolve(import.meta.dirname, '..');
const svg = fs.readFileSync(path.join(root, 'resources/icon.svg'));
const sizes = [16, 24, 32, 48, 64, 128, 256];

const pngs = [];
for (const size of sizes) {
  const buf = await sharp(svg, { density: 384 })
    .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
  fs.writeFileSync(path.join(root, `resources/icon-${size}.png`), buf);
  pngs.push({ size, buf });
  console.log(`icon-${size}.png  ${buf.length} 字节`);
}

// ICO 容器：ICONDIR + 每个条目的 ICONDIRENTRY + PNG 负载。
// Vista 起允许条目直接存 PNG（bitCount 仍写 32），Windows 10/11 均支持。
const count = pngs.length;
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0); // reserved
header.writeUInt16LE(1, 2); // type = icon
header.writeUInt16LE(count, 4);

const entries = Buffer.alloc(16 * count);
let offset = 6 + 16 * count;
pngs.forEach(({ size, buf }, i) => {
  const p = i * 16;
  entries.writeUInt8(size >= 256 ? 0 : size, p + 0); // 0 表示 256
  entries.writeUInt8(size >= 256 ? 0 : size, p + 1);
  entries.writeUInt8(0, p + 2); // 调色板数
  entries.writeUInt8(0, p + 3); // reserved
  entries.writeUInt16LE(1, p + 4); // planes
  entries.writeUInt16LE(32, p + 6); // bit count
  entries.writeUInt32LE(buf.length, p + 8);
  entries.writeUInt32LE(offset, p + 12);
  offset += buf.length;
});

const ico = Buffer.concat([header, entries, ...pngs.map((p) => p.buf)]);
fs.writeFileSync(path.join(root, 'resources/icon.ico'), ico);
console.log(`icon.ico  ${ico.length} 字节，${count} 个尺寸`);
