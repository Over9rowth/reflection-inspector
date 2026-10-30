"""驱动 service.py 跑一次真实分析，打印摘要。

用途：在不开 Electron 的情况下确认「Python 服务 + 模型 + RLE」这条链路。
`--smoke` 模式下额外校验：返回的每条建议掩码都能被 RLE 还原且尺寸与规范图一致。

服务用回环 TCP（见 worker/service.py 顶部说明），所以这里先读一行 stdout 拿端口，
再连套接字发请求。
"""
from __future__ import annotations

import argparse
import json
import pathlib
import socket
import subprocess
import sys
import time

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "worker"))

from rle import decode as rle_decode  # noqa: E402


def _connect(process: subprocess.Popen, timeout: float) -> socket.socket:
    assert process.stdout is not None
    deadline = time.time() + timeout
    while time.time() < deadline:
        line = process.stdout.readline()
        if not line:
            raise SystemExit(f"服务在握手前退出（code={process.poll()}）")
        line = line.strip()
        if not line.startswith("{"):
            continue
        message = json.loads(line)
        if message.get("event") == "ready":
            port = int(message["port"])
            channel = socket.create_connection(("127.0.0.1", port), timeout=timeout)
            channel.settimeout(timeout)
            return channel
    raise SystemExit("服务 30 秒内没有报告端口")


def run(image: pathlib.Path, device: str, timeout: float) -> dict:
    python = ROOT / ".venv" / "Scripts" / "python.exe"
    process = subprocess.Popen(
        [str(python), "-u", str(ROOT / "worker" / "service.py")],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        text=True,
        encoding="utf-8",
        bufsize=1,
        cwd=str(ROOT),
    )
    channel = _connect(process, 30)
    stream = channel.makefile("rwb")
    stages: list[str] = []

    def send(payload: dict) -> None:
        stream.write((json.dumps(payload) + "\n").encode("utf-8"))
        stream.flush()

    def read_until(request_id: int) -> dict:
        while True:
            raw = stream.readline()
            if not raw:
                raise SystemExit("连接在收到应答前关闭")
            message = json.loads(raw.decode("utf-8"))
            if message.get("event") == "progress":
                stages.append(f"{message['stage']} {message['fraction']:.0%}")
                continue
            if message.get("id") == request_id:
                return message

    send({"id": 1, "op": "analyze", "image": str(image), "device": device})
    result = read_until(1)
    send({"id": 2, "op": "shutdown"})
    try:
        stream.close()
    except OSError:
        pass
    try:
        channel.close()
    except OSError:
        pass
    try:
        process.wait(timeout=60)
    except subprocess.TimeoutExpired:
        process.kill()

    if not result.get("ok"):
        raise SystemExit(f"分析失败：{result['error']}")
    payload = result["result"]
    payload["_stages"] = stages
    return payload


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("image", type=pathlib.Path)
    parser.add_argument("--device", default="auto", choices=["auto", "cpu", "cuda"])
    parser.add_argument("--timeout", type=float, default=900)
    parser.add_argument("--smoke", action="store_true")
    args = parser.parse_args()

    started = time.perf_counter()
    payload = run(args.image.resolve(), args.device, args.timeout)
    wall = time.perf_counter() - started
    width, height = payload["transform"]["canonicalSize"]
    print(f"规范图 {width}×{height} · 分析图 {payload['transform']['analysisSize']}")
    print(f"状态 {payload['status']} · 建议 {len(payload['regions'])} 条")
    print(
        f"推理 {payload['seconds']:.2f}s · 模型加载 "
        f"{payload['modelLoadSeconds'] and round(payload['modelLoadSeconds'], 2)} · 端到端 {wall:.2f}s"
    )
    print(f"设备 {payload['device']} · 峰值显存 {payload['peakCudaAllocatedBytes']}")
    print(f"阶段 {payload['_stages']}")
    for index, region in enumerate(payload["regions"]):
        mask = rle_decode(region["maskRle"])
        area = int(mask.sum())
        print(
            f"  [{index}] {region['category']:6s} {region['label']!r:22s} "
            f"det={region['detectorScore']:.3f} iou={region['samPredictedIoU']:.3f} "
            f"掩码 {mask.shape[1]}×{mask.shape[0]} 覆盖 {area} 像素"
        )
        if args.smoke:
            assert mask.shape == (height, width), f"掩码尺寸 {mask.shape} 与规范图不符"
            assert area > 0, "掩码为空"
    if args.smoke:
        assert payload["status"] in (
            "complete-with-suggestions",
            "complete-no-suggestions",
        )
        print("SMOKE PASS: 服务链路 + 模型 + RLE 还原 全部通过")
    return 0


if __name__ == "__main__":
    sys.exit(main())
