// Copyright (C) 2026 Over9rowth
// SPDX-License-Identifier: GPL-3.0-only
// 纯 JS 遮挡绘制：在 BGRA 原始像素上画纯色块 / 马赛克。
// 为什么不用 Python：ADR-G03 要求「没有 Python 与模型时，手动遮挡与导出仍 100% 可用」，
// 所以这条路必须完全不依赖推理进程。纯函数，可在 node 里直接单测。

/** 归一化矩形：允许 (x0>x1)，统一成左上右下并裁到画面内。 */
export function normalizeRect(rect, width, height, expand = 0) {
  const raw = Array.isArray(rect) ? rect : [rect?.x0, rect?.y0, rect?.x1, rect?.y1];
  let x0 = Number(raw[0]);
  let y0 = Number(raw[1]);
  let x1 = Number(raw[2]);
  let y1 = Number(raw[3]);
  if (![x0, y0, x1, y1].every((value) => Number.isFinite(value))) return null;
  if (x0 > x1) [x0, x1] = [x1, x0];
  if (y0 > y1) [y0, y1] = [y1, y0];
  const pad = Number.isFinite(Number(expand)) ? Math.max(0, Math.round(Number(expand))) : 0;
  x0 = Math.max(0, Math.floor(x0) - pad);
  y0 = Math.max(0, Math.floor(y0) - pad);
  x1 = Math.min(width, Math.ceil(x1) + pad);
  y1 = Math.min(height, Math.ceil(y1) + pad);
  if (x1 <= x0 || y1 <= y0) return null;
  return { x0, y0, x1, y1 };
}

/** 纯色块。buf 为 BGRA，color 为 [r,g,b]，alpha 保持原值（不破坏透明通道）。 */
export function fillRect(buf, width, height, rect, color, expand = 0) {
  const box = normalizeRect(rect, width, height, expand);
  if (!box) return 0;
  const [r, g, b] = color ?? [0, 0, 0];
  let pixels = 0;
  for (let y = box.y0; y < box.y1; y += 1) {
    let offset = (y * width + box.x0) * 4;
    for (let x = box.x0; x < box.x1; x += 1) {
      buf[offset] = b;
      buf[offset + 1] = g;
      buf[offset + 2] = r;
      offset += 4;
      pixels += 1;
    }
  }
  return pixels;
}

/** 马赛克：按 block 尺寸分格取块内均值再回填。边缘残块按实际像素数取均值。 */
export function mosaicRect(buf, width, height, rect, block = 12, expand = 0) {
  const box = normalizeRect(rect, width, height, expand);
  if (!box) return 0;
  const size = Math.max(1, Math.round(Number(block) || 12));
  let pixels = 0;
  for (let by = box.y0; by < box.y1; by += size) {
    const yEnd = Math.min(by + size, box.y1);
    for (let bx = box.x0; bx < box.x1; bx += size) {
      const xEnd = Math.min(bx + size, box.x1);
      let sb = 0;
      let sg = 0;
      let sr = 0;
      let count = 0;
      for (let y = by; y < yEnd; y += 1) {
        let offset = (y * width + bx) * 4;
        for (let x = bx; x < xEnd; x += 1) {
          sb += buf[offset];
          sg += buf[offset + 1];
          sr += buf[offset + 2];
          offset += 4;
          count += 1;
        }
      }
      if (!count) continue;
      const nb = Math.round(sb / count);
      const ng = Math.round(sg / count);
      const nr = Math.round(sr / count);
      for (let y = by; y < yEnd; y += 1) {
        let offset = (y * width + bx) * 4;
        for (let x = bx; x < xEnd; x += 1) {
          buf[offset] = nb;
          buf[offset + 1] = ng;
          buf[offset + 2] = nr;
          offset += 4;
          pixels += 1;
        }
      }
    }
  }
  return pixels;
}

/**
 * 应用一组遮挡编辑。
 * @param {Uint8Array|Buffer} buf BGRA 原始像素（会被原地修改）
 * @param {number} width
 * @param {number} height
 * @param {Array<{kind?: string, x0: number, y0: number, x1: number, y1: number, color?: number[], block?: number, expand?: number}>} edits
 * @returns {{editedPixels: number, applied: number, skipped: number}}
 */
export function applyEdits(buf, width, height, edits) {
  const list = Array.isArray(edits) ? edits : [];
  let editedPixels = 0;
  let applied = 0;
  let skipped = 0;
  for (const edit of list) {
    if (!edit || typeof edit !== 'object') {
      skipped += 1;
      continue;
    }
    const cover = edit.cover ?? edit;
    const kind = cover.kind === 'mosaic' ? 'mosaic' : 'solid';
    const expand = Number(cover.expand ?? edit?.expand ?? 0);
    const pixels =
      kind === 'mosaic'
        ? mosaicRect(buf, width, height, [edit.x0, edit.y0, edit.x1, edit.y1], cover.block ?? 12, expand)
        : fillRect(buf, width, height, [edit.x0, edit.y0, edit.x1, edit.y1], cover.color ?? [0, 0, 0], expand);
    if (pixels > 0) {
      applied += 1;
      editedPixels += pixels;
    } else {
      skipped += 1;
    }
  }
  return { editedPixels, applied, skipped };
}
