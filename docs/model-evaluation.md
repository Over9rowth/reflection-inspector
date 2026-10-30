# 反光检查镜：模型能力评估（开发集快照）

日期：2026-10-28。模型：Grounding DINO tiny (a2bb814d) + SAM ViT-B (70c1a07f)，阈值 box 0.35 / text 0.25（未调优），HF 离线，CUDA（RTX 3060 Laptop 6 GiB，驱动 581.83）。

**声明**：detectorScore 与 SAM predicted IoU 均不是准确率。本页是开发集（development set）上的行为快照，样本同时用于观察与调参时不得再宣称验收；冻结集尚未建立。人工逐框真值（GT）标注未做，因此**没有**命中率/精确率/召回率数字，只有逐样本类别级观察。

## 开发集样本（共 7 张，来源与许可见 tests/fixtures/sources-eval.json）

| 文件 | 类别（目视核实后） | 内容 | 许可 |
|---|---|---|---|
| eval-mirror-a.jpg | mirror | 公厕双面壁挂镜 + 右侧磨砂百叶窗 | CC BY-SA 4.0 |
| eval-mirror-b.jpg | mirror | 老旧单面镜（银层局部脱落） | CC BY-SA 4.0 |
| eval-mirror-c.jpg | mirror | 浴室镜柜 | CC0 |
| eval-glass-a.jpg | glass | 整面玻璃幕墙（数百窗格） | CC0 |
| eval-glass-b.jpg | glass | 夜景玻璃幕墙商场 | CC BY-SA 4.0 |
| eval-glass-c.jpg | glass | 商场店面玻璃橱窗（原拟作负样本，目视核实后改归类为 glass） | CC BY 2.0 |
| eval-none-b.jpg | none | 餐厅内景：无镜、无窗；注意背景有小鱼缸（玻璃） | CC BY-SA 4.0 |

标注流程：先下载 → 目视核实类别（由此纠正了 1 个错误标注，见 glass-c）→ 再推理。负样本仅 1 张（n=1），不足以估计误检率；这是已知薄点。

## 逐样本结果（worker/suggest.py，逐张顺序推理，输出 outputs/eval/<name>/）

| 样本 | 建议（类别 · detectorScore · SAM IoU） | 类别级观察 |
|---|---|---|
| eval-mirror-a | mirror 0.707 / glass 0.384 | 两面镜 → 1 个 mirror 命中；另一面镜被提为 glass（镜/玻璃混淆实例） |
| eval-mirror-b | mirror×2 (0.743, 0.698) + glass×3 (0.462, 0.448, 0.352) | 两面镜全命中；同物体重叠提出 glass 建议 |
| eval-mirror-c | mirror 0.670 + glass 0.427 | 镜柜命中；再次同物体 mirror/glass 重叠 |
| eval-glass-a | mirror 0.479 + glass 0.404 | 幕墙 → glass 命中；另提出 1 个 mirror 误检 |
| eval-glass-b | glass 0.352 | 命中但仅 1 个区域——大幕墙明显欠分割（阈值 0.35 限制召回） |
| eval-glass-c | mirror 0.398 + glass 0.369 | 橱窗 glass 命中；1 个 mirror 误检 |
| eval-none-b | 0 个建议 | 干净通过（无镜/无大玻璃面） |

## 耗时与显存

- 单张（3000px 长边）10.1—11.8 秒；none-b 11.8 秒。
- `peakCudaAllocatedBytes` 2.68 GiB（none-b 1.90 GiB）；6 GiB 显卡可单任务运行，但无余量跑并发。

## 主要行为结论（供阈值与产品决策参考，均未定验收结论）

1. 类别级召回（观察性）：7 张中镜/玻璃图全部有正确类别命中，负样本零建议。
2. **镜/玻璃混淆是系统性的**：同一物体常同时收到 mirror 与 glass 重叠建议。产品必须做去重/合并与人工确认，不能把类别分数当判定。
3. 大面积多窗格场景欠分割：阈值 0.35 只稳定命中 1 个区域。提高召回需降阈值或专项模型，代价是更多误检——待冻结集上量化。
4. 与 10 月 P0 一致：PhotoScan 级原图（4016×6016）与 3000px 缩略图行为无类别级差异。

## 阈值扫描（2026-10-28，开发集，`outputs/threshold-scan/`，日志 docs/threshold-scan.log）

box 阈值 0.25/0.30/0.35（text 恒 0.25），7 图逐张推理，区域数按类别统计：

| box | glass-b 大幕墙 glass 区域 | none-b 负样本区域 | mirror+glass 重叠图数 | glass-c 的 mirror 误检 |
|---|---|---|---|---|
| 0.35（产品默认） | 1 | **0（干净）** | 5/6 | 1 |
| 0.30 | 1 | **4（误检）** | 5/6 | 3 |
| 0.25 | 3 | **4（误检）** | 6/6 | 4 |

结论：
1. **0.35 是负样本纯度与召回的当前最优平衡**：降阈值改善大幕墙分割（0.25 时 3 区域）的代价是负样本出现 4 个误检——本开发集 n=1 的负样本都守不住，真实误检率必然更高。
2. **mirror/glass 重叠与阈值无关**（各档普遍存在）：产品层去重/合并 + 人工确认是必需设计，不是可选优化。
3. glass-c（橱窗）的 mirror 误检随阈值降低而增多（1→4），进一步支持 0.35。

方法学警示：本扫描用于观察权衡；**最终阈值必须在冻结集上一次性确定**，不得以本开发集扫描结果宣称"调优完成"。

## 未完成 / 下一步

- 人工逐框 GT 与冻结集划分（14 号要求：开发集调参、冻结集验收，禁止混用）。
- 阈值扫描（box 0.25/0.30/0.35/0.40）在冻结集上的召回/误检曲线。
- 专项候选模型调研仅在上述证据不足时启动；先核对许可与 Windows 可用性。
- 全部 UI、坐标不变量、导出与安装验收未开始；R01—R06 未通过。
