"""遮挡合成与导出。

顺序规则（14 号设计 §5，这里是唯一实现，编辑器预览与最终导出必须走同一条路径）：

1. 汇总所有**实心**编辑的掩码并外扩（默认 1 个原图像素），把这些源像素直接替换成填充色；
   多个实心区域重叠时，后一个覆盖前一个。
2. 从**已替换过实心像素的底图**上执行马赛克，绝不回到原图取样——否则"先大范围马赛克、
   再局部实心"时，局部原内容会提前混进相邻像素。
3. 最后重画实心层，保证实心始终高于马赛克。
4. 全透明像素的 RGB 归零，避免靠 alpha 藏内容。

一个马赛克编辑内部按"进入该编辑时的底图快照"取样，所以同一编辑的结果与块遍历顺序无关，
是可复现的；两个马赛克编辑重叠时，后一个读前一个的结果。

导出不复制源文件的 EXIF / GPS / XMP / IPTC / ICC / 缩略图：成品从规范图数组新建，
只写应用自己生成的标准 sRGB 内容。
"""
from __future__ import annotations

import base64
import io
import os
import pathlib
import tempfile

import numpy as np
from PIL import Image

from rle import decode as rle_decode
from rle import dilate

SUPPORTED_OUTPUTS = ("png", "jpeg", "webp")
DEFAULT_EXPAND_PX = 1
PREVIEW_MAX = 1024


class EditError(ValueError):
    """编辑描述不合法。"""


def _solid_mask(edit: dict, shape: tuple[int, int]) -> np.ndarray:
    rle = edit.get("rle")
    if not isinstance(rle, dict):
        raise EditError("实心编辑缺少 rle")
    mask = rle_decode(rle) != 0
    if mask.shape != shape:
        raise EditError(f"掩码尺寸 {mask.shape} 与图像 {shape} 不符")
    return dilate(mask, int(edit.get("expand", DEFAULT_EXPAND_PX)))


def solid_union(edits: list[dict], shape: tuple[int, int]) -> np.ndarray:
    """所有实心编辑（含外扩）的并集。导出不变性测试也用它。"""
    union = np.zeros(shape, dtype=bool)
    for edit in edits:
        if edit.get("kind") == "solid":
            union |= _solid_mask(edit, shape)
    return union


def _apply_solid(rgba: np.ndarray, edits: list[dict]) -> np.ndarray:
    for edit in edits:
        if edit.get("kind") != "solid":
            continue
        color = edit.get("color") or [0, 0, 0]
        if len(color) != 3:
            raise EditError("实心颜色必须是 [r,g,b]")
        mask = _solid_mask(edit, rgba.shape[:2])
        rgba[mask, 0] = int(color[0])
        rgba[mask, 1] = int(color[1])
        rgba[mask, 2] = int(color[2])
        rgba[mask, 3] = 255
    return rgba


def _apply_mosaic(rgba: np.ndarray, edit: dict) -> np.ndarray:
    rle = edit.get("rle")
    if not isinstance(rle, dict):
        raise EditError("马赛克编辑缺少 rle")
    mask = rle_decode(rle) != 0
    if mask.shape != rgba.shape[:2]:
        raise EditError(f"掩码尺寸 {mask.shape} 与图像 {rgba.shape[:2]} 不符")
    block = int(edit.get("block", 16))
    if block < 2:
        raise EditError("马赛克块尺寸至少 2 个原图像素")
    height, width = mask.shape
    ys, xs = np.nonzero(mask)
    if ys.size == 0:
        return rgba
    snapshot = rgba.copy()  # 本次编辑取样基准：已含此前所有实心与马赛克
    key = (ys // block).astype(np.int64) * (width // block + 2) + (xs // block)
    _, inverse = np.unique(key, return_inverse=True)
    counts = np.bincount(inverse)
    pixels = snapshot[ys, xs].astype(np.float64)
    for channel in range(3):
        sums = np.bincount(inverse, weights=pixels[:, channel])
        mean = np.round(sums / counts).clip(0, 255).astype(np.uint8)
        rgba[ys, xs, channel] = mean[inverse]
    return rgba


def compose(canonical_rgba: np.ndarray, edits: list[dict]) -> np.ndarray:
    """按固定顺序应用编辑，返回新的 RGBA 数组。不改动入参。"""
    rgba = np.array(canonical_rgba, dtype=np.uint8, copy=True)
    if rgba.ndim != 3 or rgba.shape[2] != 4:
        raise EditError("规范图必须是 H×W×4 的 RGBA")
    solid = [e for e in edits if e.get("kind") == "solid"]
    mosaic = [e for e in edits if e.get("kind") == "mosaic"]
    unknown = [e for e in edits if e.get("kind") not in ("solid", "mosaic")]
    if unknown:
        raise EditError(f"未知编辑类型 {unknown[0].get('kind')!r}")
    _apply_solid(rgba, solid)
    for edit in mosaic:
        _apply_mosaic(rgba, edit)
    _apply_solid(rgba, solid)  # 实心层始终高于马赛克
    transparent = rgba[:, :, 3] == 0
    rgba[transparent, 0] = 0
    rgba[transparent, 1] = 0
    rgba[transparent, 2] = 0
    return rgba


def _encode(arr: np.ndarray, fmt: str, quality: int, background: tuple[int, int, int]) -> bytes:
    image = Image.fromarray(arr, mode="RGBA")
    buffer = io.BytesIO()
    if fmt == "png":
        image.save(buffer, format="PNG", optimize=False)
    elif fmt == "jpeg":
        flat = Image.new("RGB", image.size, background)
        flat.paste(image, mask=image.split()[3])
        flat.save(buffer, format="JPEG", quality=int(quality), subsampling=0)
    else:
        image.save(buffer, format="WEBP", quality=int(quality), method=4)
    return buffer.getvalue()


def _preview_png(decoded: Image.Image) -> str:
    preview = decoded.convert("RGBA")
    factor = min(1.0, PREVIEW_MAX / max(preview.size))
    if factor < 1.0:
        preview = preview.resize(
            (max(1, round(preview.width * factor)), max(1, round(preview.height * factor))),
            Image.Resampling.LANCZOS,
        )
    buffer = io.BytesIO()
    preview.save(buffer, format="PNG")
    return base64.b64encode(buffer.getvalue()).decode("ascii")


def export(
    image_path: pathlib.Path | str,
    edits: list[dict],
    output_path: pathlib.Path | str,
    fmt: str = "png",
    quality: int = 92,
    background: tuple[int, int, int] = (255, 255, 255),
) -> dict:
    """合成并写盘。返回报告，其中 `previewPngBase64` 来自**已落盘的字节**。

    预览必须从成品字节解码，否则"预览好看、成品不对"这类问题永远测不出来。
    """
    from imaging import load_canonical

    if fmt not in SUPPORTED_OUTPUTS:
        raise EditError(f"不支持的输出格式 {fmt}")
    image_path = pathlib.Path(image_path)
    output_path = pathlib.Path(output_path)
    if output_path.resolve() == image_path.resolve():
        raise EditError("禁止覆盖源文件，请另选路径")

    rgba, info = load_canonical(image_path)
    arr = np.asarray(rgba, dtype=np.uint8)
    composed = compose(arr, edits)

    payload = _encode(composed, fmt, quality, background)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    handle, temp_name = tempfile.mkstemp(
        dir=output_path.parent, prefix=".ri-export-", suffix=".part"
    )
    os.close(handle)
    temp_path = pathlib.Path(temp_name)
    try:
        temp_path.write_bytes(payload)
        with Image.open(temp_path) as check:
            check.load()
            decoded = check.copy()
            decoded_format = check.format
        problems: list[str] = []
        if decoded.size != rgba.size:
            problems.append(f"尺寸不符 {decoded.size} vs {rgba.size}")
        if fmt == "png" and decoded.mode != "RGBA":
            problems.append(f"PNG 模式应为 RGBA，实际 {decoded.mode}")
        exif = decoded.getexif()
        if exif:
            problems.append(f"成品残留 EXIF {len(exif)} 项")
        if decoded.info.get("icc_profile"):
            problems.append("成品残留 ICC 配置")
        if problems:
            raise EditError("成品自检未通过：" + "；".join(problems))
        os.replace(temp_path, output_path)
    finally:
        if temp_path.exists():
            temp_path.unlink()

    preview = _preview_png(decoded)
    arr_out = np.asarray(composed)
    solid = solid_union(edits, arr.shape[:2])
    return {
        "output": str(output_path),
        "format": decoded_format,
        "width": int(decoded.width),
        "height": int(decoded.height),
        "bytes": len(payload),
        "sha256": _sha256(output_path),
        "canonicalSize": list(rgba.size),
        "sourceColorRule": info["colorRule"],
        "metadataStripped": True,
        "editedPixels": int(solid.sum()),
        "edits": len(edits),
        "alphaPreserved": bool(fmt == "png"),
        "previewPngBase64": preview,
    }


def _sha256(path: pathlib.Path) -> str:
    import hashlib

    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()
