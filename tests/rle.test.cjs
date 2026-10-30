// RLE 两端一致性测试。夹具由 Python 侧生成，两边必须逐字段相同。
// 运行：node --test tests/rle.test.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');

const MODULE = pathToFileURL(path.join(__dirname, '..', 'src', 'domain', 'rle.mjs')).href;

async function load() {
  return import(MODULE);
}

test('RLE 与 Python 夹具逐字段一致', async () => {
  const { decodeRle, encodeRle } = await load();
  const fixture = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'fixtures', 'rle-case.json'), 'utf-8')
  );
  const mask = decodeRle(fixture);
  assert.equal(mask.length, fixture.w * fixture.h);
  // 夹具里 7 个像素为 1（Python 侧同样统计过）
  assert.equal(
    mask.reduce((sum, value) => sum + value, 0),
    7
  );
  assert.deepEqual(encodeRle(mask, fixture.w, fixture.h), fixture);
});

test('decodeRle 拒绝非法段长与尺寸不符', async () => {
  const { decodeRle } = await load();
  assert.throws(() => decodeRle({ w: 4, h: 4, start: 0, counts: [3, 3] }), /不符/);
  assert.throws(() => decodeRle({ w: 4, h: 4, start: 0, counts: [0, 16] }), /正整数/);
  assert.throws(() => decodeRle({ w: 0, h: 4, start: 0, counts: [] }), /尺寸非法/);
});

test('rectRle 与暴力构造一致', async () => {
  const { encodeRle, rectRle } = await load();
  const cases = [
    [8, 6, 2, 1, 5, 3],
    [5, 5, 0, 0, 5, 5],
    [5, 5, 3, 3, 3, 3], // 空矩形
    [7, 4, -3, -2, 99, 99], // 越界会被夹住
    [9, 9, 4, 0, 5, 9], // 单列
  ];
  for (const [w, h, x0, y0, x1, y1] of cases) {
    const brute = new Uint8Array(w * h);
    const ax0 = Math.max(0, Math.min(w, Math.min(x0, x1)));
    const ax1 = Math.max(0, Math.min(w, Math.max(x0, x1)));
    const ay0 = Math.max(0, Math.min(h, Math.min(y0, y1)));
    const ay1 = Math.max(0, Math.min(h, Math.max(y0, y1)));
    for (let y = ay0; y < ay1; y += 1) {
      for (let x = ax0; x < ax1; x += 1) brute[y * w + x] = 1;
    }
    assert.deepEqual(
      rectRle(w, h, x0, y0, x1, y1),
      encodeRle(brute, w, h),
      `矩形 ${[w, h, x0, y0, x1, y1].join(',')}`
    );
  }
});

test('rectRle 的段长之和恒等于像素总数', async () => {
  const { rectRle } = await load();
  for (let i = 0; i < 40; i += 1) {
    const w = 1 + (i % 13);
    const h = 1 + ((i * 7) % 11);
    const rle = rectRle(w, h, i % 5, (i * 3) % 5, (i * 2) % 9, (i * 5) % 9);
    assert.equal(
      rle.counts.reduce((sum, value) => sum + value, 0),
      w * h
    );
    assert.ok(rle.counts.every((value) => value > 0));
  }
});

test('paintRleScaled 只涂掩码覆盖的目标像素', async () => {
  const { paintRleScaled, rectRle } = await load();
  // 8×8 掩码左上 4×4 为 1，缩到 4×4 后按像素中心最近邻采样：
  // xmap = [1,3,5,7]、sy = [1,3,5,7]，命中 (行 0-1) × (列 0-1)，即索引 0、1、4、5。
  const frame = { width: 4, height: 4, data: new Uint8ClampedArray(4 * 4 * 4) };
  paintRleScaled(frame, rectRle(8, 8, 0, 0, 4, 4), [10, 20, 30], 200);
  const lit = new Set([0, 1, 4, 5]);
  for (let i = 0; i < 16; i += 1) {
    if (lit.has(i)) {
      assert.equal(frame.data[i * 4], 10, `像素 ${i} 应被涂色`);
      assert.equal(frame.data[i * 4 + 3], 200);
    } else {
      assert.equal(frame.data[i * 4 + 3], 0, `像素 ${i} 不应被涂色`);
    }
  }

  // 顶部 2 行（8×8）只覆盖缩放后第 0 行：oy=0→sy=1 命中，oy=1→sy=3 不命中。
  const half = { width: 4, height: 4, data: new Uint8ClampedArray(4 * 4 * 4) };
  paintRleScaled(half, rectRle(8, 8, 0, 0, 8, 2), [1, 2, 3], 255);
  for (let x = 0; x < 4; x += 1) assert.equal(half.data[x * 4 + 3], 255);
  for (let x = 4; x < 16; x += 1) assert.equal(half.data[x * 4 + 3], 0);
});
