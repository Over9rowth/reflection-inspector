"""常驻推理服务：本地回环 TCP + 行分隔 JSON。

## 为什么不用 stdin/stdout

最初用的是 stdin/stdout 管道。实测在这台机器上不可靠：

1. 主线程 `for line in sys.stdin` 阻塞时，另一个线程 `import torch` 会停住不动
   （faulthandler 抓到的是卡在扩展模块 DLL 加载里，200 秒无进展）；
2. 改成「读取线程 + 主线程推理」后能跑通，但 `import torch` 从 13 秒涨到 70 秒以上；
3. 换 `os.read(0, ...)` 绕开 TextIOWrapper 也一样慢。

改成回环套接字后没有任何读取线程：主线程 accept 一个连接，然后同步读请求、同步推理。
代价是推理进行中收不到 `cancel`（单线程没有机会读），所以取消语义就是**终止进程**，
由主进程负责重启；这一点在界面文案里写明。

## 启动握手

子进程绑定 127.0.0.1 的临时端口，把端口号作为**唯一一行** stdout 输出：

    {"event": "ready", "port": 51234, "protocolVersion": 1}

之后 stdout 不再用于协议（只留作调试输出），全部请求应答走套接字。
"""
from __future__ import annotations

import json
import os
import pathlib
import socket
import sys
import traceback

PROTOCOL_VERSION = 1
APP_ROOT = pathlib.Path(__file__).resolve().parents[1]
REQUIRED_MODELS = ("grounding-dino-tiny", "sam-vit-base")


def _resolve_models_dir() -> pathlib.Path:
    """模型目录按「环境变量 → 应用内 → 用户数据目录」依次找。

    安装版不随包带权重（1 GB），所以允许用户把模型放到
    `%LOCALAPPDATA%\\ReflectionInspector\\models`，或用 RI_MODELS_DIR 指定。
    """
    candidates: list[pathlib.Path] = []
    from_env = os.environ.get("RI_MODELS_DIR")
    if from_env:
        candidates.append(pathlib.Path(from_env))
    candidates.append(APP_ROOT / "resources" / "models")
    local = os.environ.get("LOCALAPPDATA")
    if local:
        candidates.append(pathlib.Path(local) / "ReflectionInspector" / "models")
    for candidate in candidates:
        if (candidate / "grounding-dino-tiny").is_dir():
            return candidate
    return candidates[0]


MODELS_DIR = _resolve_models_dir()

_analyzer = None
_channel: socket.socket | None = None


def emit(payload: dict) -> None:
    """向已连接的客户端写一行 JSON。"""
    if _channel is None:
        return
    data = (json.dumps(payload, ensure_ascii=False) + "\n").encode("utf-8")
    _channel.sendall(data)


def log(message: str) -> None:
    sys.stderr.write(f"[service] {message}\n")
    sys.stderr.flush()


def _models_present() -> dict[str, bool]:
    return {name: (MODELS_DIR / name).is_dir() for name in REQUIRED_MODELS}


def _error(code: str, message: str) -> dict:
    return {"code": code, "message": message}


def _classify(exc: BaseException) -> tuple[str, str]:
    from compose import EditError
    from imaging import UnsupportedImage
    from rle import RleError

    if isinstance(exc, UnsupportedImage):
        return "unsupported-image", str(exc)
    if isinstance(exc, RleError):
        return "bad-mask", str(exc)
    if isinstance(exc, EditError):
        return "bad-edit", str(exc)
    name = type(exc).__name__
    if name == "ModelMissing":
        return "model-missing", str(exc)
    if name == "FileNotFoundError":
        return "not-found", str(exc)
    if name in ("OutOfMemoryError",) or "out of memory" in str(exc).lower():
        return "out-of-memory", str(exc)
    return "internal", f"{name}: {exc}"


def _get_analyzer(device: str):
    global _analyzer
    if _analyzer is None:
        from detect import Analyzer

        _analyzer = Analyzer(MODELS_DIR, device)
    elif device not in ("auto", _analyzer.device):
        _analyzer.release()
        from detect import Analyzer

        _analyzer = Analyzer(MODELS_DIR, device)
    return _analyzer


def handle(request: dict) -> dict:
    global _analyzer
    op = request.get("op")
    request_id = request.get("id")
    if not isinstance(request_id, int):
        raise ValueError("请求缺少整数 id")

    if op == "hello":
        return {
            "protocolVersion": PROTOCOL_VERSION,
            "appRoot": str(APP_ROOT),
            "modelsDir": str(MODELS_DIR),
            "modelsPresent": _models_present(),
            "modelsLoaded": bool(_analyzer and _analyzer.models_loaded),
            "device": _analyzer.device if _analyzer else None,
            "python": sys.version.split()[0],
        }

    if op == "probe":
        from imaging import load_canonical

        image = pathlib.Path(request["image"])
        if not image.is_file():
            raise FileNotFoundError(f"找不到图片 {image}")
        rgba, info = load_canonical(image)
        return {
            "width": rgba.width,
            "height": rgba.height,
            "image": info,
            "bytes": image.stat().st_size,
        }

    if op == "analyze":
        from detect import DEFAULT_BOX_THRESHOLD, DEFAULT_TEXT_THRESHOLD

        image = pathlib.Path(request["image"])
        if not image.is_file():
            raise FileNotFoundError(f"找不到图片 {image}")

        def progress(stage: str, fraction: float) -> None:
            emit(
                {
                    "id": request_id,
                    "event": "progress",
                    "stage": stage,
                    "fraction": float(fraction),
                }
            )

        # 首次分析要先把 torch/transformers 拉起来（本机实测 17—30 秒），这段没有细分进度，
        # 先给一个明确的阶段名，别让界面停在"准备"上什么都不动。
        if _analyzer is None:
            progress("加载推理引擎", 0.02)
        analyzer = _get_analyzer(request.get("device", "auto"))
        return analyzer.analyze(
            image,
            box_threshold=float(request.get("boxThreshold", DEFAULT_BOX_THRESHOLD)),
            text_threshold=float(request.get("textThreshold", DEFAULT_TEXT_THRESHOLD)),
            progress=progress,
        )

    if op == "export":
        from compose import export as export_image

        return export_image(
            pathlib.Path(request["image"]),
            request.get("edits", []),
            pathlib.Path(request["output"]),
            fmt=request.get("format", "png"),
            quality=int(request.get("quality", 92)),
            background=tuple(request.get("background", (255, 255, 255))),
        )

    if op == "release":
        if _analyzer is not None:
            _analyzer.release()
            _analyzer = None
        return {"released": True}

    raise ValueError(f"未知操作 {op!r}")


def _serve(connection: socket.socket) -> None:
    stream = connection.makefile("rwb")
    try:
        for raw in stream:
            text = raw.decode("utf-8", errors="replace").strip()
            if not text:
                continue
            try:
                request = json.loads(text)
            except json.JSONDecodeError as exc:
                log(f"无法解析请求：{exc}")
                continue
            request_id = request.get("id")
            try:
                result = handle(request)
            except BaseException as exc:  # noqa: BLE001 - 边界处必须兜住一切
                code, message = _classify(exc)
                if code == "internal":
                    log(traceback.format_exc())
                emit({"id": request_id, "ok": False, "error": _error(code, message)})
                continue
            emit({"id": request_id, "ok": True, "result": result})
            if request.get("op") == "shutdown":
                return
    finally:
        try:
            stream.close()
        except OSError:
            pass


def main() -> int:
    global _channel
    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server.bind(("127.0.0.1", 0))
    server.listen(1)
    port = server.getsockname()[1]
    # 唯一一行 stdout：父进程靠它拿到端口，之后不再用 stdout 传协议。
    sys.stdout.write(
        json.dumps({"event": "ready", "port": port, "protocolVersion": PROTOCOL_VERSION}) + "\n"
    )
    sys.stdout.flush()
    server.settimeout(120)
    try:
        connection, _ = server.accept()
    except socket.timeout:
        log("120 秒内没有客户端连接，退出")
        return 2
    finally:
        server.close()
    connection.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
    _channel = connection
    try:
        _serve(connection)
    finally:
        _channel = None
        try:
            connection.close()
        except OSError:
            pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
