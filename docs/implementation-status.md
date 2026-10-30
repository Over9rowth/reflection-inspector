# P0 实现状态（2026-10-24 首记；2026-10-27 更新，见文末新小节）

本次完成的用户流程：项目独立目录、venv和本地模型CLI源码；官方模型revision、字节数及LFS SHA已核查。真推理尚未执行，不能算自动建议完成。〔2026-10-27 更正：本句中"真推理尚未执行"已被 outputs/ 证据取代——推理已于 10-25 真实执行，见下方 2026-10-27 小节；"不能算自动建议完成"仍然成立，因尚无冻结集评估。〕

实现文件/版本：worker/download_models.py、worker/suggest.py、requirements.in。DINO revision a2bb814dd30d776dcf7e30523b00659f4f141c71；SAM revision 70c1a07f894ebb5b307fd9eaaee97b9dfc16068f。坐标左上原点，规范图应用EXIF后转sRGB，分析图长边≤1600；分别保存实际x/y比例；DINO后处理回分析尺寸，SAM后处理去padding，再最近邻回规范图。CLI参数/模型调用尚未实机验证。

实际执行命令与结果：python -m venv .venv；官方PyTorch安装torch2.7.1/torchvision0.22.1 CUDA12.8；固定transformers4.51.3/numpy2.2.6/Pillow11.2.1/psutil7；python worker/download_models.py。安装/下载进行中，见下列会话记录。

已通过验收：R01—R06均未通过；没有输出mask/真实照片准确率证据。模型SHA来源为官方Hugging Face blobs API；safetensors不执行远端代码；推理设置HF离线且local_files_only。

资源：DINO safetensors 689359096字节 SHA256 1a2412ef99bd74bcd3c2a246fa1e48581f8889a1300c9051974741314fc042f3；SAM safetensors 374979480字节 SHA256 892c410e496344e527255ccdcb2cb7244a609acb5389c7c4fdba1288f861c579。来源与许可证链接固定于脚本，完整实测manifest仅成功校验后生成。源码与权重Apache-2.0许可证页快照README下载待完成，不作最终发行许可结论。

硬件：RTX3060 Laptop GPU，6144MiB；驱动581.83，nvidia-smi报告CUDA兼容13.0；下载前D盘空闲约36.37GB。无推理耗时或峰值显存数据。原用户照片未扫描或上传。

未完成活动：exec session13280=PyTorch官方3.2731GB wheel下载/安装；session54097=Transformers依赖；session51089=固定模型下载。最后额度44%。到50%需停止这些具体进程，保留.part与venv，不宣称已安装成功。恢复时先pip check和pip freeze，再重跑安装/下载，模型下载会验证完整文件，未完成.part当前重新下载，不断点续传。

下一项：等待资源/运行时校验后锁pip freeze；在明确许可的镜子与玻璃真实照片分别跑worker/suggest.py，记录真实报告/掩码/耗时/显存，之后处理坐标与遮挡不变量。合成夹具仅能验证管线，不能算R01的两类照片效果。没有GUI/安装包，阈值未开发集调优。

停止记录：五小时额度实查52%，触发50%停止条件；已终止本项目pip install/download_models.py精确匹配的Python进程，不再执行推理或下载。三份Python源码仅py_compile语法检查通过，不等于运行验证。
停止时找到并终止PID25140（torch安装）与24596（模型下载）；另检查这些PID的Python子进程并终止。最后已有DINO README、config和added_tokens小文件；没有已验证权重或model-manifest成功清单。

## 2026-10-27 状态更新：基线事实登记（由协调者核对，实施者记录）

以下事实由协调者于 2026-10-27 核对确认，取代上文 10-24 记录中的过期表述：

- 依赖与模型实际已于 10-25 完成：`.venv`（Python 3.11.5，torch 2.7.1+cu128、transformers 4.51.3，见 requirements.lock.txt）安装成功；`resources/models/grounding-dino-tiny/model.safetensors` 689,359,096 字节、`resources/models/sam-vit-base/model.safetensors` 374,979,480 字节，字节数与 SHA-256 与 `resources/model-manifest.json` 官方清单一致，模型目录无残留 `.part`。上节"未完成活动"（exec session13280/54097/51089）已由后续会话真实完成。
- `outputs/mirror-p0/report.json` 是一次真实 GPU 推理：输入 4016×6016（tests/fixtures/mirror.jpg），3 条建议（1 mirror + 2 glass），耗时 8.28 秒，`peakCudaAllocatedBytes` 2,880,531,456，附 3 张规范图尺寸掩码。日志见 `docs/mirror-run.log`。
- `outputs/glass-p0/report.json` 同为真实推理：输入 6016×4016（tests/fixtures/glass.jpg），4 条建议（2 mirror + 2 glass），耗时 8.59 秒，`peakCudaAllocatedBytes` 2,880,531,456，附 4 张掩码。日志见 `docs/glass-run.log`。
- 结论修正：推理管线（DINO→SAM、HF 离线、CUDA）已在两张真实照片上端到端运行并产出掩码；但"自动建议完成"仍不成立——R01 两类照片的效果评估、冻结集、阈值开发集调优均未做，R01—R06 验收仍未通过。

## 2026-10-28 复现验证（由协调者完成并核对）

为确认 10-24/25 的 P0 推理可复现，用相同 fixtures 与固定阈值（box 0.35 / text 0.25）各重跑一次 `worker/suggest.py`（HF 离线、local_files_only），输出到新目录，未覆盖旧结果：

- `outputs/mirror-rerun/report.json`：输入 SHA-256 与 mirror-p0 完全一致，3 条建议的类别、detectorScore、analysisBox、canonicalBox 与 10 月报告逐位一致（确定性推理验证通过）；耗时 13.63 秒（对比 8.28 秒，属时钟/热节流正常波动），`peakCudaAllocatedBytes` 同为 2,880,531,456。
- `outputs/glass-rerun/report.json`：4 条建议（2 mirror + 2 glass），9.25 秒，峰值显存同上。注意：glass 照片上 DINO 也提出了 mirror 类别建议（最高 0.4198），符合阈值调优前两类边界重叠的预期，需在正式样本评估中量化。
- 运行日志：`outputs/mirror-rerun.log`、`outputs/glass-rerun.log`。

仍未完成：扩展样本评估（mirror/glass/无目标三类、开发集与冻结集划分）、`docs/model-evaluation.md`、桌面 GUI、坐标不变量与导出测试、安装包。R01—R06 仍未验收。下一步：构建三类扩展评估集并产出评估文档。

## 2026-10-28 开发集评估完成（协调者直接执行）

- 开发集建立：7 张 Wikimedia Commons 图（CC0/CC BY/CC BY-SA，来源/作者/许可/SHA 记录于 `tests/fixtures/sources-eval.json`）。标注流程为先下载→目视核实类别→再推理；目视核实纠正了 1 个错误标注（原拟作负样本的店面图实有大面积玻璃橱窗，改归类 glass → eval-glass-c.jpg）。
- 逐张顺序推理全部成功（`docs/eval-run.log`，输出 `outputs/eval/<name>/`），单张 10.1—11.8 秒，`peakCudaAllocatedBytes` 2.68 GiB。
- 关键观察（详见 `docs/model-evaluation.md`）：镜/玻璃图全部有正确类别命中；负样本（餐厅，背景有小鱼缸）0 建议；**同一物体常同时收到 mirror+glass 重叠建议**；阈值 0.35 下大幕墙欠分割（glass-b 仅 1 区域）。
- 诚实边界：无人工逐框 GT，无命中率/精确率/召回率数字；负样本 n=1 不足以估计误检率；冻结集未建立；detectorScore/SAM IoU 不是准确率；阈值未调优（保持 0.35/0.25）。
- 未完成：冻结集与 GT 标注、阈值扫描、GUI、坐标不变量、导出、安装包。R01—R06 仍未通过。

补充（2026-10-28）：阈值扫描完成（suggest.py 新增 --box-threshold/--text-threshold 开发参数，报告记录实际值）——0.35 为负样本纯度与召回的当前最优平衡（0.30/0.25 时负样本出现 4 个 glass 误检）；mirror/glass 重叠与阈值无关，产品层去重+人工确认为必需。详见 model-evaluation.md。

## 2026-10-28 桌面应用与安装包（协调者执行）

本轮把已验证的推理链路做成了可安装的桌面程序，并补齐了打包环节的两个真问题。

### 架构

- **worker 拆分为模块**：`rle.py`（行主序 RLE 编解码/膨胀）、`imaging.py`（规范图与 EXIF/ICC 处理）、`detect.py`（DINO→SAM，返回 `maskRle` 而非 PNG）、`compose.py`（§5 合成顺序与导出）、`service.py`（常驻服务）。`suggest.py` 保留为同一套实现的命令行薄壳，此前的确定性结论继续有效。
- **推理进程不用 stdin/stdout**：本机实测主线程阻塞读 stdin 时，另一线程 `import torch` 会卡在扩展模块 DLL 加载里（faulthandler 抓到，200 秒无进展）；改成读取线程后 `import torch` 从 13 秒涨到 70 秒以上。最终改为 **127.0.0.1 临时端口 + 单线程**：子进程把端口作为唯一一行 stdout 输出，父进程连上去，之后全走套接字。代价是推理中收不到 `cancel`，取消即终止进程。
- **渲染层拿不到任意路径**：自定义 `ri-asset://` 协议，token→绝对路径的映射只存在于主进程，渲染层只能引用登记过的资源。

### 合成顺序（设计 §5 的唯一实现）

先应用全部遮挡块（含膨胀）→ 再应用马赛克（**从遮挡后的底图采样**）→ 再把遮挡块重绘一遍 → 最后把 alpha==0 处的 RGB 清零。

`tests/test_worker.py` 覆盖：遮挡与马赛克顺序无关性、马赛克从遮挡后底图采样、后应用的遮挡覆盖先前马赛克、透明处 RGB 清零、不修改输入、未知编辑类型拒绝、块尺寸下限。

**替换不变性**：只改动被遮挡掩码覆盖的源像素，导出 PNG 必须逐字节相同。这条测试第一次写错了（用了 `shift=99`，把所有像素都改了，不只是掩码内），改成 `shift=0` 且只篡改掩码内像素（含把 alpha 改成 7，遮挡必须强制回 255）后通过。

### 测试

21 项全部通过：

- Python 16 项（`Ran 16 tests in 0.567s OK`）：RLE 往返/拒绝非法输入/膨胀/夹具稳定性、合成七项、导出与元数据剥离、替换不变性、拒绝覆盖已存在文件、JPEG 透明拍平。
- JS 5 项（`node --test`，`# pass 5 # fail 0`）：RLE 编解码、`rectRle` 边界裁剪、`rleBBox`、`paintRleScaled` 最近邻取样。
- 两端用同一份夹具 `tests/fixtures/rle-case.json` 互验。

### 真实推理与桌面冒烟

- 服务侧：规范图 4016×6016，3 条建议（mirror 0.513/0.920、glass panel 0.478/0.921、glass window 0.395/0.993），推理 12.21 秒，模型加载 5.6 秒，端到端 32.91 秒，峰值显存 3,571,173,888 B。
- 桌面冒烟（打包前）：`SMOKE PASS: 建议 3 条 / 接受 3 条 / 导出 4016×6016 30633682 字节 / 覆盖 1916597 像素 / sha256 95e8a6d6…`
- 安装版冒烟（`%LOCALAPPDATA%\ReflectionInspector\app-0.1.0\ReflectionInspector.exe --smoke`）：同样 PASS，**sha256 与打包前逐位相同**（`95e8a6d61d122485…`），说明打包没有改变像素结果。
- 界面经 CDP 截图逐项核对：载入、自动建议、全部采用（掩码可见地填满镜面与窗玻璃）、手动拖框（2088×722 px）、导出弹窗。

### 打包环节修掉的两个真问题

1. **Squirrel 装完没有快捷方式**。`Setup.exe` 只解包，快捷方式要由应用自己响应 `--squirrel-install` 来建。第一版漏了这个钩子，安装"成功"但开始菜单和桌面都没有入口。补上后改为**直接写 .lnk**：名字用中文产品名，目标指向版本无关的根级 stub（`%LOCALAPPDATA%\ReflectionInspector\ReflectionInspector.exe`），升级换 `app-x.y.z` 目录也不失效；写 lnk 失败才退回 `Update.exe --createShortcut`（那条路径只能用 ASCII 的 exe 名）。注意不能拦 `--squirrel-firstrun`，否则装完打不开。
2. **`ELECTRON_RUN_AS_NODE` 会被继承**。从这个 IDE 的终端启动 `Setup.exe` 时，该变量让安装程序以纯 Node 运行，`--squirrel-install` 变成 `bad option`，退出码 9，安装看起来成功但什么也没建。所有安装/冒烟脚本都必须 `env -u ELECTRON_RUN_AS_NODE -u NODE_OPTIONS`。

另外：`@electron/get` 即使在缓存命中时也会去下载 `SHASUMS256.txt`，校验失败会重下 158 MB，弱网下必然失败。`scripts/make-offline.mjs` 起一个本地回环镜像同时提供 zip 与 SHASUMS，把这条链路彻底变成离线。

### 一次误判，记下来

第一次跑安装版冒烟时报"推理连接已关闭"，我怀疑是打包路径问题。实际原因是**机器资源耗尽**：之前失败的 Electron 进程没退，显存占 4905/6144 MiB、物理内存 99%，Python 在 `from_pretrained` 里分配张量时直接访问违例（0xC0000005，无 Python 异常）。清掉残留进程后一次通过。以后再遇到无 traceback 的进程猝死，先看 `nvidia-smi` 和内存。

### 仍未完成（不因本轮通过而豁免）

- **安装包不携带 Python 运行时**。torch cu128 解包后数 GB，本轮没有随包分发。安装版目前需要 `RI_PYTHON` 指向一个装好依赖的 python.exe，模型需要 `RI_MODELS_DIR` 或放到 `%LOCALAPPDATA%\ReflectionInspector\models`。这是产品化缺口，不是可以忽略的细节。
- 没有人工逐框 GT，`model-evaluation.md` 里的命中/误检仍是开发集观察，不是准确率；冻结集未建立。
- 界面只在 CDP 截图层面核对过，没有做人工交互验收（缩放/平移手感、长列表滚动、拖框吸附）。
- 安装包未签名，Windows SmartScreen 会拦。

### 交付

`交付物/ReflectionInspector-0.1.0-Setup.exe`，155,217,408 字节，SHA-256 `315fc13485c88cc342d8d05167ae379a4622da6328bd208d2897e4420d8d671a`。

---

## 2026-10-29 R-STD 收尾（TASK-RI-01 → 0.2.0）

猫猫初审四条 + 站长拍板的 ADR-G03 方案 A，本轮全部落地。

### 一、ADR-G03 资源管理向导与纯手动降级（MAJOR-RI-02）

之前的产品化缺口是：**没装 Python 或没下模型时，连手动遮挡都做不了**——因为 `probe`（读尺寸）和 `export`（写像素）都走 Python。本轮把这两条都补了本地实现：

| 新文件 | 作用 |
|---|---|
| `src/domain/env.mjs` | 资源清单汇总、逐文件状态判定（`missing`/`size-mismatch`/`sha-mismatch`/`size-ok`/`ok`）、下载计划、体积格式化。纯函数。 |
| `src/domain/paint.mjs` | BGRA 像素上的纯色块与马赛克（矩形归一化、`expand` 越界裁剪、块内均值、边缘残块）。纯函数。 |
| `src/main/env.ts` | 环境探测（Python 与模型分别判）、按需下载（`.part` → SHA-256 → 原子改名）、离线目录导入、本地降级 probe/export。 |
| `tests/env.test.cjs` | 7 项：汇总、全吻合、仅体积吻合、缺文件、大小不符、SHA 不符、空清单、probe 返回缺失。 |
| `tests/paint.test.cjs` | 7 项：矩形归一化、`expand`、纯色块、马赛克均值、边缘残块、`applyEdits` 分派、`cover` 嵌套与非法编辑。 |
| `scripts/smoke-manual.mjs` | 无 Python 降级冒烟（见下）。 |

界面侧：新增「运行环境与模型资源」向导（模态），列出两个模型的固定 revision、Apache-2.0 许可、体积与逐模型状态；三个动作按钮（一键下载并校验 / 导入本地离线资源包 / 打开资源目录）+ 重新检测 + 「稍后再说（用纯手动模式）」。环境不齐时顶栏显示「纯手动模式」徽标并常驻横幅，随时可重新打开向导。

**下载只在用户点击后发生**；每个文件先写 `.part`，边下边算 SHA-256，与 `resources/model-manifest.json` 里的固定值比对，不一致就删掉并报错。默认目录 `%LOCALAPPDATA%\Over9rowth\ReflectionInspector\models`（与 SPEC 一致）。

### 二、开源合规与文档（MAJOR-RI-01 / MAJOR-RI-03）

- `README.md` 整篇重写：不再是 10-24 的 P0 CLI 说明，改为桌面端定位、「它是什么 / 它不是什么」、安装使用、运行环境与模型资源（三种处理方式）、开发命令、架构、已知限制、第三方模型许可。
- 新增 `LICENSE`（MIT，`Copyright (c) 2026 Over9rowth`）与 `.gitattributes`。
- 新增 `resources/manual.html`（零基础排版级说明书：三步上手、做不到什么、资源向导、常见问题、隐私说明）与 `scripts/make-manual-pdf.mjs`（`npm run manual`）。
- 新增 `docs/acceptance-report.md`：对照 R01—R06 逐项举证，含「未验证清单」。
- `package.json`：`version` 0.2.0、`appVersion` 0.2.0、`build` 前置 `tsc --noEmit`、新增 `typecheck`/`manual`/`icon`/`smoke:manual`/`test:node`，`packagerConfig.ignore` 增 `^/node_modules ^/out ^/out-`。

### 三、仓库卫生与交付（MAJOR-RI-04）

- `docs/eval-run.log` 7 处 + `docs/threshold-scan.log` 21 处，合计 **28 处** 本机绝对路径已替换为 `<工作树>`；全项目复扫本机用户名/盘符路径/旧署名 **0 命中**（`SPEC.md` 除外，见待裁决）。
- 交付物三件已产出并登记 SHA-256（见 PROJECT_STATE）。

### 四、本轮实测

| 项 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npx tsc --noEmit` | **0 错** |
| Node 单测 | `npm run test:node` | **19/19**（RLE 5 + 资源判定 7 + 遮挡绘制 7） |
| Python 单测 | `npm run test:py` | **16/16**（0.824 s） |
| 全链路冒烟 | `npm run smoke` | **SMOKE PASS**：建议 3 条 / 接受 3 条 / 导出 4016×6016 / 30,633,682 字节 / 覆盖 1,916,597 像素 / sha256 `95e8a6d6…`（**与 0.1.0 逐位相同**，说明这轮改动没有动到像素结果） |
| 纯手动冒烟（无 Python） | `npm run smoke:manual` | **SMOKE-MANUAL PASS**：本地解码 240×160 → 导出同尺寸 / 857 字节 / 覆盖 6,984 像素 / 2 条编辑；并且**回到导出文件里逐像素核对**：纯色块中心 = (0,0,0) 且 alpha=255，未编辑处仍等于原始渐变 |
| 说明书 PDF | `npm run manual` | 268,287 字节 / 3 页 / `%PDF-1.4` |
| 安装验收 | `python scripts/install-verify.py` | **16/16**（`docs/install-verify.log`） |

安装验收细节：静默安装 exit 0、`app-0.2.0\` 就位、注册表唯一且 `DisplayVersion=0.2.0`、**`Publisher=Over9rowth`**、开始菜单与桌面两条 `.lnk`、经快捷方式启动窗口标题 `反光检查镜` 5 码位一致（0x53cd 0x5149 0x68c0 0x67e5 0x955c）、**安装版 `--smoke-manual` PASS**（结果与源码树逐位相同：857 字节 / 6,984 像素 / sha256 `e77761dd…`）、卸载 exit 0、注册表清除、两条 `.lnk` 删除、残留仅 `.dead` + `Update.exe` + `app-0.2.0\squirrel.exe`。

### 五、本轮踩到的坑

1. **打包后的 Electron 在 Windows 上是 GUI 子系统，`console.log` 抓不到**。第一版安装版冒烟用 stdout 判定，结果只拿到一个 `exit=3221226505`、日志全空。改为把结果写 JSON（`RI_SMOKE_OUT`），由验收脚本读文件判定。
2. **冒烟不能用 `tests/fixtures`**：`^/tests` 在 `packagerConfig.ignore` 里，安装包里根本没有夹具。改为在内存里合成渐变图（`nativeImage.createFromBitmap` → PNG）再走全链路。
3. **「导出文件过小」是我自己判据写错了**：240×160 的线性渐变 PNG 压完只有 857 字节，比随手定的 1000 字节阈值还小。改成**去导出文件里读像素**做断言，比看字节数有意义得多。
4. **TS 5.9 的 `Uint8Array` 参数化**（同 motion-magnifier）：声明裸 `Uint8Array` 传给 `new Blob()` 会报 `TS2322`，要写 `Uint8Array<ArrayBuffer>`。
5. **`net` 用错了模块**：Electron 的 `net.request` 在 `electron` 里，不在 `node:net`；`node:net` 只有 TCP。且 Electron 的 `IncomingMessage` 类型没有 `resume()`。

### 六、待猫猫裁决（不阻断）

- `SPEC.md` 有 3 处 NUL 字节（`目标版本`的版本号首位、`0.2.0` 的 `0` 等），另有若干字符缺失（`reflection` 的 `r`、`resources` 的 `r`、`acceptance` 的 `a`、`tsc` 的 `t`）。按上下文可还原，未改写原文；该文件已排除在清单与源码归档之外。
