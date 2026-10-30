"""Grounding DINO tiny → SAM ViT-B 的离线推理。

与 P0 的 `suggest.py` 是同一套调用顺序、同一套阈值默认值、同一套后处理，区别只有两点：
1. 模型只在首次分析时加载，之后常驻（GUI 里反复调阈值不必每次重付 8 秒加载）；
2. 掩码以 RLE 返回而不是写 PNG，避免在界面与导出之间出现两份不同的掩码。

顺序加载仍保留：DINO 用完先 `del` + `empty_cache()` 再上 SAM，峰值显存与 P0 相同。
两者都加载后仍常驻，是因为"先卸载再加载"会让每次改阈值都多花数秒，而实测峰值
2.68 GiB 在 6 GiB 卡上有余量。显存不足时由调用方决定退回 CPU。

模型不会判断材质。这里的 `category` 只是提示词分组，不是分类结论。
"""
from __future__ import annotations

import gc
import pathlib
import time
from typing import Callable

import numpy as np
import torch
from PIL import Image
from transformers import (
    AutoModelForZeroShotObjectDetection,
    AutoProcessor,
    SamModel,
    SamProcessor,
)

from imaging import load_canonical, make_analysis
from rle import encode as rle_encode

DEFAULT_BOX_THRESHOLD = 0.35
DEFAULT_TEXT_THRESHOLD = 0.25
PROMPTS = (
    ("mirror", "mirror."),
    ("glass", "glass window. glass door. glass panel."),
)

Progress = Callable[[str, float], None]
Cancelled = Callable[[], bool]


class ModelMissing(RuntimeError):
    """本地模型目录不存在或不是完整的 HF 快照。"""


def _noop_progress(stage: str, fraction: float) -> None:  # pragma: no cover - 默认值
    return None


class Analyzer:
    def __init__(self, models_dir: pathlib.Path | str, device: str = "auto") -> None:
        self.models_dir = pathlib.Path(models_dir)
        self.requested_device = device
        self.device = self._resolve_device(device)
        self._detector = None
        self._detector_processor = None
        self._sam = None
        self._sam_processor = None
        self.load_seconds: float | None = None

    @staticmethod
    def _resolve_device(device: str) -> str:
        if device == "auto":
            return "cuda" if torch.cuda.is_available() else "cpu"
        if device == "cuda" and not torch.cuda.is_available():
            raise RuntimeError("请求了 CUDA 但 torch.cuda.is_available() 为假")
        return device

    # -- 模型 -------------------------------------------------------------

    def _model_path(self, name: str) -> pathlib.Path:
        path = self.models_dir / name
        if not path.is_dir():
            raise ModelMissing(
                f"缺少本地模型 {path}；请先运行 worker/download_models.py，"
                "本程序不会在推理时联网补齐"
            )
        return path

    def _load_detector(self, progress: Progress) -> None:
        if self._detector is not None:
            return
        folder = self._model_path("grounding-dino-tiny")
        progress("加载定位模型", 0.05)
        self._detector_processor = AutoProcessor.from_pretrained(
            folder, local_files_only=True
        )
        self._detector = (
            AutoModelForZeroShotObjectDetection.from_pretrained(
                folder, local_files_only=True
            )
            .to(self.device)
            .eval()
        )
        self._detector.config.disable_custom_kernels = True

    def _load_sam(self, progress: Progress) -> None:
        if self._sam is not None:
            return
        folder = self._model_path("sam-vit-base")
        progress("加载分割模型", 0.55)
        self._sam_processor = SamProcessor.from_pretrained(folder, local_files_only=True)
        self._sam = SamModel.from_pretrained(folder, local_files_only=True).to(
            self.device
        ).eval()

    @property
    def models_loaded(self) -> bool:
        return self._detector is not None and self._sam is not None

    def release(self) -> None:
        self._detector = self._detector_processor = None
        self._sam = self._sam_processor = None
        gc.collect()
        if self.device == "cuda":
            torch.cuda.empty_cache()

    # -- 分析 -------------------------------------------------------------

    def analyze(
        self,
        image_path: pathlib.Path | str,
        box_threshold: float = DEFAULT_BOX_THRESHOLD,
        text_threshold: float = DEFAULT_TEXT_THRESHOLD,
        progress: Progress = _noop_progress,
        cancelled: Cancelled = lambda: False,
    ) -> dict:
        started = time.perf_counter()
        if self.device == "cuda":
            torch.cuda.reset_peak_memory_stats()
        rgba, image_info = load_canonical(image_path)
        analysis, transform = make_analysis(rgba)
        width, height = transform["canonicalSize"]
        aw, ah = transform["analysisSize"]
        del rgba

        if not self.models_loaded:
            load_started = time.perf_counter()
            self._load_detector(progress)
            self._load_sam(progress)
            self.load_seconds = time.perf_counter() - load_started
        if cancelled():
            raise RuntimeError("cancelled")

        progress("定位候选", 0.2)
        candidates: list[dict] = []
        for category, text in PROMPTS:
            inputs = self._detector_processor(
                images=analysis, text=text, return_tensors="pt"
            ).to(self.device)
            with torch.inference_mode():
                output = self._detector(**inputs)
            result = self._detector_processor.post_process_grounded_object_detection(
                output,
                inputs.input_ids,
                box_threshold=box_threshold,
                text_threshold=text_threshold,
                target_sizes=[(ah, aw)],
            )[0]
            labels = result.get("text_labels", result.get("labels"))
            for box, score, label in zip(
                result["boxes"].cpu().tolist(),
                result["scores"].cpu().tolist(),
                labels,
            ):
                candidates.append(
                    {
                        "category": category,
                        "label": str(label),
                        "detectorScore": float(score),
                        "analysisBox": [float(v) for v in box],
                    }
                )
            del inputs, output
        if cancelled():
            raise RuntimeError("cancelled")

        progress("生成掩码", 0.6)
        if candidates:
            boxes = [[c["analysisBox"] for c in candidates]]
            inputs = self._sam_processor(
                analysis, input_boxes=boxes, return_tensors="pt"
            ).to(self.device)
            with torch.inference_mode():
                output = self._sam(**inputs)
            masks = self._sam_processor.image_processor.post_process_masks(
                output.pred_masks.cpu(),
                inputs.original_sizes.cpu(),
                inputs.reshaped_input_sizes.cpu(),
            )[0]
            scores = output.iou_scores[0].cpu()
            for index, candidate in enumerate(candidates):
                best = int(scores[index].argmax())
                mask = Image.fromarray(
                    masks[index, best].numpy().astype("uint8") * 255
                ).resize((width, height), Image.Resampling.NEAREST)
                candidate["maskRle"] = rle_encode(np.asarray(mask) > 127)
                candidate["samPredictedIoU"] = float(scores[index, best])
                x0, y0, x1, y1 = candidate["analysisBox"]
                candidate["canonicalBox"] = [
                    x0 * width / aw,
                    y0 * height / ah,
                    x1 * width / aw,
                    y1 * height / ah,
                ]
            del inputs, output, masks, scores
            gc.collect()

        progress("完成", 1.0)
        return {
            "status": "complete-with-suggestions" if candidates else "complete-no-suggestions",
            "transform": transform,
            "regions": candidates,
            "seconds": time.perf_counter() - started,
            "modelLoadSeconds": self.load_seconds,
            "peakCudaAllocatedBytes": (
                int(torch.cuda.max_memory_allocated()) if self.device == "cuda" else None
            ),
            "device": self.device,
            "thresholds": {"box": box_threshold, "text": text_threshold},
            "preprocessVersion": 1,
            "image": image_info,
        }
