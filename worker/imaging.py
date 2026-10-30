"""规范图与分析图。

规范图（canonical）：EXIF 方向已应用、色彩已归到 sRGB、8 位非预乘 RGBA，原分辨率。
之后所有选区坐标、掩码、编辑、导出都在这个坐标系里，绝不用 CSS 像素或缩放后的坐标。

分析图（analysis）：最长边不超过 1600 的 RGB 副本，透明处合成固定中灰。模型只看它，
输出再经 `T⁻¹` 映射回规范图。`transform` 里 x/y 分别记录实际比例——不能拿"宣称的
长边比例"去推算，取整误差会让边界偏一两个像素。

这里的处理顺序与 `suggest.py` 的 P0 实现逐字节一致（`tests/test_imaging.py` 用固定
夹具比对），所以 2026-10-28 记录的确定性结论对本模块继续成立。
"""
from __future__ import annotations

import io
import pathlib

from PIL import Image, ImageCms, ImageOps

ANALYSIS_MAX = 1600
ANALYSIS_BACKDROP = (128, 128, 128, 255)
SUPPORTED_FORMATS = ("JPEG", "PNG", "WEBP")
PREPROCESS_VERSION = 1


class UnsupportedImage(ValueError):
    """容器、位深、帧数或色彩空间超出当前支持范围。"""


def load_canonical(path: pathlib.Path | str) -> tuple[Image.Image, dict]:
    """读取图像并返回 (规范图 RGBA, 说明信息)。原文件只读。"""
    path = pathlib.Path(path)
    with path.open("rb") as stream:
        header = stream.read(29)
    # Pillow 会把 16 位 RGB PNG 静默降到 8 位，所以必须先看 IHDR。
    if header.startswith(b"\x89PNG\r\n\x1a\n") and header[24] != 8:
        raise UnsupportedImage(
            "PNG 位深不是 8；需要用户明确选择生成 8 位分析副本，当前未实现"
        )
    with Image.open(path) as raw:
        fmt = raw.format
        if fmt not in SUPPORTED_FORMATS:
            raise UnsupportedImage(f"不支持的容器 {fmt}；仅接受 JPEG/PNG/WebP 静态 SDR")
        if getattr(raw, "n_frames", 1) != 1:
            raise UnsupportedImage("多帧图像不支持，不会静默取首帧")
        if raw.mode.startswith("I;16") or raw.mode in ("I", "F"):
            raise UnsupportedImage(f"不支持的像素模式 {raw.mode}")
        icc = raw.info.get("icc_profile")
        orientation = (raw.getexif() or {}).get(0x0112, 1)
        normalized = ImageOps.exif_transpose(raw)
        if icc:
            normalized = ImageCms.profileToProfile(
                normalized,
                ImageCms.ImageCmsProfile(io.BytesIO(icc)),
                ImageCms.createProfile("sRGB"),
                outputMode="RGBA",
            )
            color_rule = "icc->sRGB"
        elif normalized.mode == "CMYK":
            raise UnsupportedImage("无 ICC 的 CMYK 图像暂不支持")
        else:
            color_rule = "assumed-sRGB"
        rgba = normalized.convert("RGBA")
    info = {
        "format": fmt,
        "orientationApplied": int(orientation),
        "colorRule": color_rule,
        "hadIccProfile": bool(icc),
    }
    return rgba, info


def make_analysis(rgba: Image.Image) -> tuple[Image.Image, dict]:
    """生成模型输入图与坐标变换。缩放保持与 P0 相同（Pillow 默认重采样）。"""
    width, height = rgba.size
    backdrop = Image.new("RGBA", rgba.size, ANALYSIS_BACKDROP)
    backdrop.alpha_composite(rgba)
    rgb = backdrop.convert("RGB")
    factor = min(1.0, ANALYSIS_MAX / max(rgb.size))
    analysis_size = (round(width * factor), round(height * factor))
    analysis = rgb if analysis_size == (width, height) else rgb.resize(analysis_size)
    aw, ah = analysis.size
    transform = {
        "canonicalSize": [width, height],
        "analysisSize": [aw, ah],
        "scaleX": aw / width,
        "scaleY": ah / height,
        "backdrop": list(ANALYSIS_BACKDROP),
        "origin": "top-left; x right; y down; pixel centers i+0.5,j+0.5",
        "preprocessVersion": PREPROCESS_VERSION,
    }
    return analysis, transform


def analysis_box_to_canonical(box: list[float], transform: dict) -> list[float]:
    """分析图坐标 → 规范图坐标。x/y 分别用自己的比例，不用单一比例。"""
    width, height = transform["canonicalSize"]
    aw, ah = transform["analysisSize"]
    x0, y0, x1, y1 = box
    return [x0 * width / aw, y0 * height / ah, x1 * width / aw, y1 * height / ah]
