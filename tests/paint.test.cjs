// 遮挡绘制单测：纯色块、马赛克、矩形归一化与边界。
// 运行：node --test tests/paint.test.cjs
const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');

const MODULE = pathToFileURL(path.join(__dirname, '..', 'src', 'domain', 'paint.mjs')).href;

/** 造一块 BGRA 画布，像素值按坐标编码，便于断言「谁被改了」。 */
function makeCanvas(width, height) {
  const buf = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      buf[offset] = 10 + y; // B
      buf[offset + 1] = 20 + x; // G
      buf[offset + 2] = 30; // R
      buf[offset + 3] = 255; // A
    }
  }
  return buf;
}

function pixel(buf, width, x, y) {
  const offset = (y * width + x) * 4;
  return [buf[offset + 2], buf[offset + 1], buf[offset], buf[offset + 3]];
}

test('normalizeRect 允许反向坐标并裁到画面内', async () => {
  const { normalizeRect } = await import(MODULE);
  assert.deepEqual(normalizeRect([8, 6, 2, 1], 10, 10), { x0: 2, y0: 1, x1: 8, y1: 6 });
  assert.deepEqual(normalizeRect([-5, -5, 4, 4], 10, 10), { x0: 0, y0: 0, x1: 4, y1: 4 });
  assert.deepEqual(normalizeRect([5, 5, 99, 99], 10, 10), { x0: 5, y0: 5, x1: 10, y1: 10 });
  assert.equal(normalizeRect([3, 3, 3, 9], 10, 10), null);
  assert.equal(normalizeRect([NaN, 0, 1, 1], 10, 10), null);
});

test('expand 按像素外扩，且不会越界', async () => {
  const { normalizeRect } = await import(MODULE);
  assert.deepEqual(normalizeRect([4, 4, 6, 6], 10, 10, 2), { x0: 2, y0: 2, x1: 8, y1: 8 });
  assert.deepEqual(normalizeRect([0, 0, 2, 2], 10, 10, 5), { x0: 0, y0: 0, x1: 7, y1: 7 });
});

test('fillRect 只改矩形内的 RGB，保留 alpha 与矩形外像素', async () => {
  const { fillRect } = await import(MODULE);
  const width = 8;
  const height = 8;
  const buf = makeCanvas(width, height);
  const pixels = fillRect(buf, width, height, [2, 3, 5, 6], [200, 100, 50]);
  assert.equal(pixels, 9);
  assert.deepEqual(pixel(buf, width, 2, 3), [200, 100, 50, 255]);
  assert.deepEqual(pixel(buf, width, 4, 5), [200, 100, 50, 255]);
  // 边界外不动
  assert.deepEqual(pixel(buf, width, 1, 3), [30, 21, 13, 255]);
  assert.deepEqual(pixel(buf, width, 5, 6), [30, 25, 16, 255]);
});

test('mosaicRect 把块内像素抹成同一均值', async () => {
  const { mosaicRect } = await import(MODULE);
  const width = 8;
  const height = 8;
  const buf = makeCanvas(width, height);
  const pixels = mosaicRect(buf, width, height, [0, 0, 4, 4], 4);
  assert.equal(pixels, 16);
  const first = pixel(buf, width, 0, 0);
  for (let y = 0; y < 4; y += 1) {
    for (let x = 0; x < 4; x += 1) {
      assert.deepEqual(pixel(buf, width, x, y), first);
    }
  }
  // 块外不受影响
  assert.deepEqual(pixel(buf, width, 4, 0), [30, 24, 10, 255]);
});

test('mosaicRect 边缘残块按实际像素数取均值', async () => {
  const { mosaicRect } = await import(MODULE);
  const width = 6;
  const height = 6;
  const buf = makeCanvas(width, height);
  const pixels = mosaicRect(buf, width, height, [0, 0, 5, 5], 4);
  assert.equal(pixels, 25);
  const block = pixel(buf, width, 4, 4); // 5×5 里第二块是 1×1
  assert.deepEqual(block, [30, 24, 14, 255]);
});

test('applyEdits 按 kind 分派并汇总覆盖像素', async () => {
  const { applyEdits } = await import(MODULE);
  const width = 10;
  const height = 10;
  const buf = makeCanvas(width, height);
  const report = applyEdits(buf, width, height, [
    { kind: 'solid', x0: 0, y0: 0, x1: 2, y1: 2, color: [1, 2, 3] },
    { kind: 'mosaic', x0: 4, y0: 4, x1: 8, y1: 8, block: 2 },
  ]);
  assert.equal(report.applied, 2);
  assert.equal(report.skipped, 0);
  assert.equal(report.editedPixels, 4 + 16);
  assert.deepEqual(pixel(buf, width, 0, 0), [1, 2, 3, 255]);
});

test('applyEdits 也接受 cover 嵌套与空/非法编辑', async () => {
  const { applyEdits } = await import(MODULE);
  const width = 4;
  const height = 4;
  const buf = makeCanvas(width, height);
  const report = applyEdits(buf, width, height, [
    { x0: 1, y0: 1, x1: 3, y1: 3, cover: { kind: 'solid', color: [9, 9, 9], expand: 1 } },
    { x0: 0, y0: 0, x1: 0, y1: 0, cover: { kind: 'solid', color: [0, 0, 0] } },
    null,
  ]);
  assert.equal(report.applied, 1);
  assert.equal(report.skipped, 2);
  assert.deepEqual(pixel(buf, width, 0, 0), [9, 9, 9, 255]);
});
