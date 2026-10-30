"""二值掩码的行优先游程编码（RLE）。

为什么自己定一个而不是照搬 COCO 的 `counts`：COCO 是**列优先**且隐含"首段是 0"，
Python 与 JS 两端各写一次极容易把方向或起始值搞反，而错位的掩码在界面上看不出来
（形状相似），只会让导出结果错。这里改成：

    {"w": 宽, "h": 高, "start": 首段的值(0/1), "counts": [段长, ...]}

行优先、起始值显式写出。约束只有两条，两端都校验：
1. `counts` 之和必须等于 `w*h`；
2. `counts` 里不允许出现 0（否则交替关系会失效）。

`tests/test_rle.py` 与 `tests/rle.test.cjs` 用同一组固定输入交叉验证两端一致。
"""
from __future__ import annotations

import numpy as np


class RleError(ValueError):
    """RLE 结构不合法。"""


def encode(mask: np.ndarray) -> dict:
    """把 2D 掩码编码为 RLE。非零视为 1。"""
    arr = np.asarray(mask)
    if arr.ndim != 2:
        raise RleError(f"掩码必须是二维，实际 {arr.ndim} 维")
    h, w = arr.shape
    flat = (arr.reshape(-1) != 0).astype(np.uint8)
    if flat.size == 0:
        return {"w": int(w), "h": int(h), "start": 0, "counts": []}
    change = np.flatnonzero(np.diff(flat)) + 1
    bounds = np.concatenate(([0], change, [flat.size]))
    counts = np.diff(bounds).astype(np.int64).tolist()
    return {"w": int(w), "h": int(h), "start": int(flat[0]), "counts": counts}


def decode(rle: dict) -> np.ndarray:
    """把 RLE 还原为 h×w 的 uint8 掩码（0/1）。"""
    try:
        w = int(rle["w"])
        h = int(rle["h"])
        counts = list(rle["counts"])
    except (KeyError, TypeError) as exc:
        raise RleError(f"RLE 缺字段或类型不对：{exc}") from exc
    if w <= 0 or h <= 0:
        raise RleError(f"RLE 尺寸非法：{w}×{h}")
    if any((not isinstance(c, int)) or c <= 0 for c in counts):
        raise RleError("RLE 段长必须都是正整数")
    total = sum(counts)
    if total != w * h:
        raise RleError(f"RLE 段长之和 {total} 与 {w}×{h}={w * h} 不符")
    out = np.zeros(w * h, dtype=np.uint8)
    pos = 0
    value = 1 if int(rle.get("start", 0)) else 0
    for count in counts:
        if value:
            out[pos:pos + count] = 1
        pos += count
        value ^= 1
    return out.reshape(h, w)


def dilate(mask: np.ndarray, pixels: int) -> np.ndarray:
    """方形结构元的二值膨胀，按像素数扩展。用于"外扩覆盖"边界。"""
    out = (np.asarray(mask) != 0)
    if pixels <= 0:
        return out
    for _ in range(int(pixels)):
        padded = np.pad(out, 1, mode="constant", constant_values=False)
        grown = np.zeros_like(out)
        for dy in (0, 1, 2):
            for dx in (0, 1, 2):
                grown |= padded[dy:dy + out.shape[0], dx:dx + out.shape[1]]
        out = grown
    return out
