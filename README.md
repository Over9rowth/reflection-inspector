# 反光检查镜（reflection-inspector）

发照片之前，先看看反光里有没有不该露的东西。

镜子、玻璃窗、屏幕、金属表面会把身后的房间、屏幕上的内容、对面的人照进去。这个工具在本机找出这些反光区域，由你确认后盖上纯色块或马赛克，再按原图全分辨率导出——导出的文件不带 EXIF。

模型只负责**提建议**，遮挡永远由你点确认。

## 它是什么

- **自动建议 + 人工确认**：Grounding DINO tiny 找出「镜子 / 玻璃」候选框，SAM ViT-B 出像素级掩码；每条建议都要你逐条接受或拒绝。
- **手动兜底永远可用**：没装 Python、没下模型时，应用照常打开，手动框选、纯色块 / 马赛克、全分辨率导出全部可用——只是「自动建议」按钮不可用。
- **高倍放大检查**：把反光区域放大到 1:1 甚至更高，确认倒影里到底有什么。
- **导出不留元数据**：重编码时丢掉 EXIF（含 GPS、机型、拍摄时间），像素尺寸保持原图。
- **零上传**：没有任何上传接口。推理在本机 Python 进程里跑，强制 Hugging Face 离线。

## 它不是什么

- **不是材质识别**：模型只判断「这块看起来像镜子/玻璃」，不保证不漏、不保证不多。**最终判断必须由你自己看**。
- **不保证找出所有反光**：暗光、强反光过曝、曲面镜、远处小面积反光都可能漏。手动框选就是为这种情况准备的。
- **不做人脸/文字检测**：它不告诉你「这里有一张脸」，只告诉你「这里是一块反光面」。
- **不是取证级工具**：导出的遮挡是可逆的像素替换，原图如果已经发出去过，遮挡不能收回。
- **不能处理 RAW / HEIC**：只支持 JPEG、PNG、WebP。

## 安装与使用

- 安装：运行 `交付物` 里的 `ReflectionInspector-<版本>-Setup.exe`（未签名，系统如提示请选择"仍要运行"）。安装后从开始菜单打开「反光检查镜」。
- 卸载：Windows 设置 → 应用 → 已安装的应用 → 反光检查镜 → 卸载。
- 第一次用：
  1. 拖一张照片进窗口；
  2. 想自动找反光就点「自动建议」，不想装环境就直接「手动框选」；
  3. 逐条确认建议，或拖框补上漏掉的区域，选纯色块还是马赛克；
  4. 点「导出遮挡图」。

## 运行环境与模型资源（重要）

安装包**不包含** PyTorch 与模型权重（合计约 1 GB），避免安装包膨胀到无法分发。首次启动若检测到环境不齐，会弹出「运行环境与模型资源」向导：

- **一键下载并校验**：只有你点了按钮才会联网。逐文件按 `resources/model-manifest.json` 里固定的 revision 与 SHA-256 校验，先写 `.part` 再原子改名，校验不过就删掉重来。
- **导入本地离线资源包**：选一个已经含 `grounding-dino-tiny/` 与 `sam-vit-base/` 的目录，只校验与登记，不复制文件。
- **默认下载位置**：`%LOCALAPPDATA%\Over9rowth\ReflectionInspector\models`。
- **稍后再说**：关掉向导即进入纯手动模式，功能不受影响；顶栏「运行环境」随时可以再打开。

自动建议另需 Python 运行时（`.venv`、`RI_PYTHON` 环境变量或安装目录内的 `python/`）。

## 开发命令

```bash
npm install          # 依赖
npm run typecheck    # tsc --noEmit
npm run build        # 先类型检查，再构建主进程与渲染层
npm run test:node    # RLE / 资源判定 / 遮挡绘制（node --test，19 项）
npm run test:py      # worker 侧 unittest（16 项）
npm test             # 两者都跑
npm run smoke        # 真实 Electron + 真实推理 + 真实导出，主进程校验报告
npm run dev          # 构建 + 打开应用
npm run manual       # 生成《用户使用说明书.pdf》到 交付物/
npm run make         # electron-forge 打包（中文路径需先 subst，见 docs/implementation-status.md）
```

## 架构

- `src/domain/rle.mjs`：掩码 RLE 编解码与缩放，与 Python 侧逐字段一致。
- `src/domain/env.mjs`：资源清单汇总、就绪判定、下载计划（纯函数）。
- `src/domain/paint.mjs`：BGRA 像素上的纯色块与马赛克（纯函数）——无 Python 时导出走这条。
- `src/main/env.ts`：环境探测、按需下载与 SHA-256 校验、离线目录导入、本地降级导出。
- `src/main/index.ts`：窗口、IPC、推理进程客户端、Squirrel 快捷方式自管理。
- `src/renderer/main.tsx`：React 界面（画布缩放、框选、建议列表、资源向导）。
- `worker/*.py`：推理服务（probe / analyze / export），通过 127.0.0.1 临时端口通信。

## 已知限制

- 自动建议需要 Python + 两个模型（约 1 GB），首次下载取决于网速。
- 检测阈值对暗光照片偏保守，宁可漏检也不误检——漏掉的请手动补。
- 大图（> 4000px）分析前会等比缩到长边 1600 再回投，小面积反光可能因此丢失。
- Windows 安装包未做代码签名。

## 第三方

- 模型：[IDEA-Research/grounding-dino-tiny](https://huggingface.co/IDEA-Research/grounding-dino-tiny)、[facebook/sam-vit-base](https://huggingface.co/facebook/sam-vit-base)，均为 **Apache-2.0**；固定 revision 与逐文件 SHA-256 见 `resources/model-manifest.json`。
- 运行时：Electron 44.9.3、React 19.1.1、esbuild 0.25.11、Vite 7.1.12、TypeScript 5.9.3、@electron-forge 7.10.2；Python 侧 PyTorch / torchvision / transformers / Pillow 等见 `requirements.lock.txt`。

## 许可

MIT，见 `LICENSE`。模型权重按各自的 Apache-2.0 许可分发。
