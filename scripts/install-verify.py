# -*- coding: utf-8 -*-
"""反光检查镜 安装/卸载验收（参照 18-新产品开发与验收规范 第六节清单）。
reg.exe 被本机安全策略禁止，注册表读写用 winreg。
用法：python scripts/install-verify.py
"""
import ctypes
import os
import shutil
import subprocess
import sys
import time
import winreg

VERSION = "0.2.0"
PRODUCT = "反光检查镜"
EXE = "ReflectionInspector.exe"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SETUP_SRC = os.path.join(ROOT, "out", "make", "squirrel.windows", "x64", f"ReflectionInspector-{VERSION} Setup.exe")
SETUP_DST = os.path.join(os.environ["TEMP"], "ReflectionInspectorSetup.exe")
APP_DIR = os.path.join(os.environ["LOCALAPPDATA"], "ReflectionInspector")
LNK_START = os.path.join(os.environ["APPDATA"], r"Microsoft\Windows\Start Menu\Programs", f"{PRODUCT}.lnk")
LNK_DESKTOP = os.path.join(os.environ["USERPROFILE"], "Desktop", f"{PRODUCT}.lnk")

results = []
def record(name, ok, detail=""):
    results.append((name, ok, detail))
    print(f"{'PASS' if ok else 'FAIL'} | {name} | {detail}", flush=True)

env = {k: v for k, v in os.environ.items() if k not in ("ELECTRON_RUN_AS_NODE", "NODE_OPTIONS")}

print("[check] 复制安装包到 ASCII 路径", flush=True)
shutil.copyfile(SETUP_SRC, SETUP_DST)
record("Setup.exe 可访问", os.path.getsize(SETUP_DST) > 100_000_000, f"{os.path.getsize(SETUP_DST)} 字节")

print("[check] 静默安装", flush=True)
proc = subprocess.run([SETUP_DST, "--silent"], env=env, capture_output=True, text=True, timeout=300)
record("安装退出码 0", proc.returncode == 0, f"exit={proc.returncode}")
time.sleep(4)
app_ver = os.path.join(APP_DIR, f"app-{VERSION}")
record(f"安装目录与 app-{VERSION} 存在", os.path.isdir(app_ver), app_ver)
record("主程序存在", os.path.isfile(os.path.join(app_ver, EXE)), "")

def uninstall_keys():
    path = r"Software\Microsoft\Windows\CurrentVersion\Uninstall"
    hits = []
    with winreg.OpenKey(winreg.HKEY_CURRENT_USER, path) as key:
        for i in range(winreg.QueryInfoKey(key)[0]):
            sub = winreg.EnumKey(key, i)
            try:
                with winreg.OpenKey(winreg.HKEY_CURRENT_USER, path + "\\" + sub) as k:
                    name, _ = winreg.QueryValueEx(k, "DisplayName")
                    if PRODUCT in str(name) or "ReflectionInspector" in sub:
                        fields = {"sub": sub, "DisplayName": str(name)}
                        for f in ("DisplayVersion", "Publisher"):
                            try:
                                fields[f] = str(winreg.QueryValueEx(k, f)[0])
                            except OSError:
                                fields[f] = ""
                        hits.append(fields)
            except OSError:
                continue
    return hits

time.sleep(2)
hits = uninstall_keys()
record("注册表卸载项唯一", len(hits) == 1, str(hits))
if hits:
    record(f"DisplayVersion = {VERSION}", hits[0].get("DisplayVersion") == VERSION, hits[0].get("DisplayVersion", ""))
    record("Publisher = Over9rowth", hits[0].get("Publisher") == "Over9rowth", hits[0].get("Publisher", ""))
record("开始菜单快捷方式", os.path.isfile(LNK_START), LNK_START)
record("桌面快捷方式", os.path.isfile(LNK_DESKTOP), LNK_DESKTOP)

print("[check] 从快捷方式启动并核对窗口标题（码位比对）", flush=True)
subprocess.Popen(["cmd", "/c", "start", "", LNK_START], env=env, creationflags=subprocess.CREATE_NO_WINDOW)
hwnd = 0
for _ in range(30):
    time.sleep(1)
    hwnd = ctypes.windll.user32.FindWindowW(None, PRODUCT)
    if hwnd:
        break
record(f"窗口标题「{PRODUCT}」", hwnd != 0,
       f"FindWindowW={'找到' if hwnd else '未找到'} 期望码位={[hex(ord(c)) for c in PRODUCT]}")
subprocess.run(["taskkill", "/F", "/IM", EXE], capture_output=True)
time.sleep(3)

print("[check] 安装版跑纯手动模式冒烟（无 Python 依赖）", flush=True)
# 打包后的 Electron 在 Windows 上是 GUI 子系统，stdout 抓不到，结果走 JSON 文件。
smoke_out = os.path.join(os.environ["TEMP"], "ri-install-smoke.json")
if os.path.exists(smoke_out):
    os.remove(smoke_out)
smoke_env = dict(env)
smoke_env["RI_SMOKE_OUT"] = smoke_out
sm = subprocess.run(
    [os.path.join(app_ver, EXE), "--smoke-manual", "--no-sandbox", "--disable-gpu", "--disable-gpu-sandbox", "--in-process-gpu"],
    env=smoke_env, capture_output=True, text=True, timeout=300,
)
payload = {}
if os.path.exists(smoke_out):
    try:
        import json
        payload = json.load(open(smoke_out, encoding="utf-8"))
    except Exception as exc:  # noqa: BLE001
        payload = {"ok": False, "error": f"结果文件解析失败: {exc}"}
detail = f"exit={sm.returncode} | {payload}"
ok = sm.returncode == 0 and payload.get("ok") is True and int(payload.get("editedPixels") or 0) > 0
record("安装版 SMOKE-MANUAL PASS", ok, detail)
time.sleep(1)
subprocess.run(["taskkill", "/F", "/IM", EXE], capture_output=True)
time.sleep(3)

print("[check] 卸载", flush=True)
proc = subprocess.run([os.path.join(APP_DIR, "Update.exe"), "--uninstall"], env=env, capture_output=True, text=True, timeout=300)
record("卸载退出码 0", proc.returncode == 0, f"exit={proc.returncode}")
time.sleep(4)
record("注册表卸载项已清除", len(uninstall_keys()) == 0, "")
record("开始菜单快捷方式已删除", not os.path.isfile(LNK_START), "")
record("桌面快捷方式已删除", not os.path.isfile(LNK_DESKTOP), "")

residue = sorted(os.listdir(APP_DIR)) if os.path.isdir(APP_DIR) else []
ALLOWED = {".dead", "Update.exe", "squirrel.exe", "v8_context_snapshot.bin", "app.ico"}
def allowed(name):
    if name in (".dead", "Update.exe"):
        return True
    p = os.path.join(APP_DIR, name)
    if os.path.isdir(p) and name.startswith("app-"):
        return all(x in ALLOWED for x in os.listdir(p))
    return name == "app.ico"
record("残留仅为 Squirrel 固有项", all(allowed(x) for x in residue), str(residue))
if os.path.isdir(APP_DIR):
    detail = {x: (sorted(os.listdir(os.path.join(APP_DIR, x))) if os.path.isdir(os.path.join(APP_DIR, x)) else "-") for x in residue}
    print(f"[check] 残留明细：{detail}", flush=True)

print("\n===== 验收汇总 =====", flush=True)
fails = [r for r in results if not r[1]]
for name, ok, _ in results:
    print(("PASS" if ok else "FAIL"), "|", name)
print(f"\n{len(results) - len(fails)}/{len(results)} 项通过")
sys.exit(1 if fails else 0)
