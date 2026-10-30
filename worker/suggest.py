"""P0 CLI；离线 DINO → SAM。不宣称材质识别正确。

行为与 2026-10-25 版本一致（同样的 `--output` 必须不存在、同样的 report.json 字段、
同样的 mask-N.png 落盘方式），只是推理与预处理挪进了 `imaging/detect` 以便界面复用。
"""
from __future__ import annotations

import argparse
import hashlib
import json
import pathlib
import sys

from PIL import Image

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

from detect import DEFAULT_BOX_THRESHOLD, DEFAULT_TEXT_THRESHOLD, Analyzer  # noqa: E402
from rle import decode as rle_decode  # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parents[1]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("image", type=pathlib.Path)
    parser.add_argument("--output", type=pathlib.Path, required=True)
    parser.add_argument("--device", choices=["auto", "cpu", "cuda"], default="cuda")
    parser.add_argument(
        "--box-threshold",
        type=float,
        default=DEFAULT_BOX_THRESHOLD,
        help="开发集扫描用；产品默认仍是 0.35",
    )
    parser.add_argument("--text-threshold", type=float, default=DEFAULT_TEXT_THRESHOLD)
    args = parser.parse_args()

    args.output.mkdir(parents=True, exist_ok=False)
    analyzer = Analyzer(ROOT / "resources" / "models", args.device)
    report = analyzer.analyze(
        args.image,
        box_threshold=args.box_threshold,
        text_threshold=args.text_threshold,
        progress=lambda stage, fraction: print(
            f"[{fraction * 100:5.1f}%] {stage}", file=sys.stderr
        ),
    )

    regions = []
    for index, region in enumerate(report["regions"]):
        mask = rle_decode(region.pop("maskRle"))
        Image.fromarray((mask * 255).astype("uint8")).save(args.output / f"mask-{index}.png")
        region["mask"] = f"mask-{index}.png"
        regions.append(region)

    payload = {
        "status": report["status"],
        "inputSha256": hashlib.sha256(args.image.read_bytes()).hexdigest(),
        "transform": report["transform"],
        "regions": regions,
        "seconds": report["seconds"],
        "peakCudaAllocatedBytes": report["peakCudaAllocatedBytes"],
        "thresholds": report["thresholds"],
        "preprocessVersion": report["preprocessVersion"],
        "limitations": (
            "P0 proposals only; not measured glass/mirror accuracy; "
            "no UI/export/package acceptance."
        ),
    }
    (args.output / "report.json").write_text(
        json.dumps(payload, indent=2), encoding="utf-8"
    )
    print(json.dumps(payload))
    return 0


if __name__ == "__main__":
    sys.exit(main())
