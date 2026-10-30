// Copyright (C) 2026 Over9rowth
// SPDX-License-Identifier: GPL-3.0-only
/**
 * 二值掩码的行优先游程编码，与 `worker/rle.py` 严格对应。
 *
 * 格式：{w, h, start, counts}，行优先，start 是首段的值（0/1），counts 是各段长度。
 * 两端都必须满足：counts 之和 == w*h，且 counts 里没有 0。
 * `tests/rle.test.cjs` 用 `tests/fixtures/rle-case.json` 交叉验证两端一致。
 *
 * 这个文件是纯 ESM + JSDoc：渲染层由 Vite 打包，node 测试直接 import，不需要构建步骤。
 */

/**
 * @typedef {{w:number,h:number,start:number,counts:number[]}} Rle
 */

/**
 * @param {Rle} rle
 * @returns {Uint8Array} 长度 w*h 的 0/1 数组
 */
export function decodeRle(rle) {
  const { w, h } = rle;
  if (!Number.isInteger(w) || !Number.isInteger(h) || w <= 0 || h <= 0) {
    throw new Error(`RLE 尺寸非法：${w}×${h}`);
  }
  const counts = rle.counts || [];
  let total = 0;
  for (const c of counts) {
    if (!Number.isInteger(c) || c <= 0) throw new Error('RLE 段长必须都是正整数');
    total += c;
  }
  if (total !== w * h) throw new Error(`RLE 段长之和 ${total} 与 ${w}×${h}=${w * h} 不符`);
  const out = new Uint8Array(w * h);
  let pos = 0;
  let value = rle.start ? 1 : 0;
  for (const c of counts) {
    if (value) out.fill(1, pos, pos + c);
    pos += c;
    value ^= 1;
  }
  return out;
}

/**
 * @param {Uint8Array|number[]} mask 长度 w*h
 * @param {number} w
 * @param {number} h
 * @returns {Rle}
 */
export function encodeRle(mask, w, h) {
  const runs = [];
  const add = (value, length) => {
    if (length <= 0) return;
    const last = runs[runs.length - 1];
    if (last && last[0] === value) last[1] += length;
    else runs.push([value, length]);
  };
  for (let i = 0; i < w * h; i += 1) add(mask[i] ? 1 : 0, 1);
  if (!runs.length) return { w, h, start: 0, counts: [] };
  return { w, h, start: runs[0][0], counts: runs.map((r) => r[1]) };
}

/**
 * 由像素矩形直接构造 RLE，不 materialize 整幅掩码。坐标是半开区间，会先夹到图像范围内。
 * @returns {Rle}
 */
export function rectRle(w, h, x0, y0, x1, y1) {
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(v)));
  const ax0 = clamp(Math.min(x0, x1), 0, w);
  const ax1 = clamp(Math.max(x0, x1), 0, w);
  const ay0 = clamp(Math.min(y0, y1), 0, h);
  const ay1 = clamp(Math.max(y0, y1), 0, h);
  if (ax1 <= ax0 || ay1 <= ay0) {
    return { w, h, start: 0, counts: w * h ? [w * h] : [] };
  }
  const runs = [];
  const add = (value, length) => {
    if (length <= 0) return;
    const last = runs[runs.length - 1];
    if (last && last[0] === value) last[1] += length;
    else runs.push([value, length]);
  };
  add(0, ay0 * w);
  for (let y = ay0; y < ay1; y += 1) {
    add(0, ax0);
    add(1, ax1 - ax0);
    add(0, w - ax1);
  }
  add(0, (h - ay1) * w);
  return { w, h, start: runs[0][0], counts: runs.map((r) => r[1]) };
}

/**
 * 掩码的像素包围盒（半开区间），空掩码返回 null。
 * @param {Rle} rle
 * @returns {[number,number,number,number]|null}
 */
export function rleBBox(rle) {
  const mask = decodeRle(rle);
  const { w, h } = rle;
  let minX = w;
  let minY = h;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      if (!mask[y * w + x]) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  return maxX < 0 ? null : [minX, minY, maxX + 1, maxY + 1];
}

/**
 * 把掩码按目标分辨率采样后写入 ImageData（用于叠加显示）。
 * 显示用降采样，导出仍用全分辨率掩码——两者不是同一份数据，这一点在界面上有说明。
 * @param {ImageData} imageData
 * @param {Rle} rle
 * @param {[number,number,number]} color
 * @param {number} alpha
 */
export function paintRleScaled(imageData, rle, color, alpha = 255) {
  const mask = decodeRle(rle);
  const { w, h } = rle;
  const ow = imageData.width;
  const oh = imageData.height;
  const data = imageData.data;
  const xmap = new Int32Array(ow);
  for (let ox = 0; ox < ow; ox += 1) {
    xmap[ox] = Math.min(w - 1, Math.floor(((ox + 0.5) * w) / ow));
  }
  for (let oy = 0; oy < oh; oy += 1) {
    const sy = Math.min(h - 1, Math.floor(((oy + 0.5) * h) / oh));
    const rowBase = sy * w;
    const outRow = oy * ow * 4;
    for (let ox = 0; ox < ow; ox += 1) {
      if (!mask[rowBase + xmap[ox]]) continue;
      const p = outRow + ox * 4;
      data[p] = color[0];
      data[p + 1] = color[1];
      data[p + 2] = color[2];
      data[p + 3] = alpha;
    }
  }
  return imageData;
}
