// Copyright (C) 2026 Over9rowth
// SPDX-License-Identifier: GPL-3.0-only
import { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { paintRleScaled, rectRle } from '../domain/rle.mjs';
import { formatBytes } from '../domain/env.mjs';
import type {
  AnalyzeResult,
  Cover,
  EnvProgress,
  EnvStatus,
  ExportReport,
  Hello,
  ManualRect,
  Probe,
  Region,
} from '../contracts/model';
import './style.css';

declare global {
  interface Window {
    ri?: {
      hello(): Promise<Hello>;
      pick(): Promise<Probe | null>;
      load(filePath: string): Promise<Probe | null>;
      drop(file: File): Promise<Probe | null>;
      analyze(params: {
        imagePath: string;
        boxThreshold: number;
        textThreshold: number;
      }): Promise<AnalyzeResult>;
      cancel(): Promise<{ cancelled: boolean }>;
      exportImage(request: unknown): Promise<ExportReport | null>;
      reveal(target: string): Promise<boolean>;
      onProgress(callback: (progress: { stage: string; fraction: number }) => void): () => void;
      envStatus(verify?: boolean): Promise<EnvStatus>;
      envDownload(): Promise<{ ok: boolean; status?: EnvStatus; error?: string }>;
      envImport(): Promise<{ ok: boolean; status?: EnvStatus; error?: string; canceled?: boolean }>;
      envPaths(): Promise<{ modelsRoot: string; defaultRoot: string }>;
      envOpenFolder(): Promise<string | null>;
      onEnvProgress(callback: (progress: EnvProgress) => void): () => void;
      smoke?(payload: string): Promise<boolean>;
      exportAuto?(request: unknown): Promise<ExportReport>;
    };
  }
}

const OVERLAY_MAX = 1600;
const DEFAULT_COVER: Cover = { kind: 'solid', color: [0, 0, 0], block: 16, expand: 1 };
const CATEGORY_COLOR: Record<string, [number, number, number]> = {
  mirror: [106, 168, 232],
  glass: [127, 199, 164],
};
const CATEGORY_LABEL: Record<string, string> = { mirror: '镜子', glass: '玻璃' };

type Edit = Record<string, unknown>;

function buildEdits(regions: Region[], manual: ManualRect[], width: number, height: number): Edit[] {
  const edits: Edit[] = [];
  for (const region of regions) {
    if (region.status !== 'accepted') continue;
    edits.push({
      kind: region.cover.kind,
      rle: region.maskRle,
      color: region.cover.color,
      block: region.cover.block,
      expand: region.cover.expand,
    });
  }
  for (const rect of manual) {
    edits.push({
      kind: rect.cover.kind,
      rle: rectRle(width, height, rect.x0, rect.y0, rect.x1, rect.y1),
      color: rect.cover.color,
      block: rect.cover.block,
      expand: rect.cover.expand,
    });
  }
  return edits;
}

function hexToRgb(hex: string): [number, number, number] {
  const value = hex.replace('#', '');
  return [
    parseInt(value.slice(0, 2), 16),
    parseInt(value.slice(2, 4), 16),
    parseInt(value.slice(4, 6), 16),
  ];
}

function rgbToHex(rgb: [number, number, number]): string {
  return '#' + rgb.map((v) => v.toString(16).padStart(2, '0')).join('');
}

function App() {
  const [hello, setHello] = useState<Hello | null>(null);
  const [image, setImage] = useState<Probe | null>(null);
  const [regions, setRegions] = useState<Region[]>([]);
  const [manual, setManual] = useState<ManualRect[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [mode, setMode] = useState<'view' | 'rect'>('view');
  const [cover, setCover] = useState<Cover>(DEFAULT_COVER);
  const [boxThreshold, setBoxThreshold] = useState(0.35);
  const [status, setStatus] = useState('先选一张照片');
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ stage: string; fraction: number } | null>(null);
  const [analysis, setAnalysis] = useState<AnalyzeResult | null>(null);
  const [report, setReport] = useState<ExportReport | null>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [draft, setDraft] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  /** 运行环境与模型资源（ADR-G03）。env 为 null 表示还没探测完。 */
  const [env, setEnv] = useState<EnvStatus | null>(null);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [envBusy, setEnvBusy] = useState(false);
  const [envProgress, setEnvProgress] = useState<{ message?: string; bytesDone: number; bytesTotal: number } | null>(null);
  const [envError, setEnvError] = useState<string | null>(null);

  const stageRef = useRef<HTMLDivElement | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  /** 用户自己缩放过就不再自动适配，避免拖到一半被拉回去。 */
  const userAdjusted = useRef(false);
  const dragRef = useRef<{
    kind: 'pan' | 'rect';
    startX: number;
    startY: number;
    panX: number;
    panY: number;
  } | null>(null);

  const width = image?.width ?? 0;
  const height = image?.height ?? 0;

  // ---- 启动：握手 + 进度订阅
  useEffect(() => {
    let alive = true;
    void window.ri?.hello().then((payload) => {
      if (!alive) return;
      setHello(payload);
      if (payload.env) {
        setEnv(payload.env);
        // 首次启动环境不齐时自动弹出向导；用户点过「稍后再说」就不再打扰，但仍可从顶栏打开。
        const dismissed = window.localStorage.getItem('ri.wizardDismissed') === '1';
        if (!payload.env.ready && !dismissed) setWizardOpen(true);
      }
      if (payload.workerError) setStatus('推理进程不可用，见顶部提示');
    });
    const off = window.ri?.onProgress((payload) => setProgress(payload));
    const offEnv = window.ri?.onEnvProgress((payload) => setEnvProgress(payload));
    return () => {
      alive = false;
      off?.();
      offEnv?.();
    };
  }, []);

  const fitToStage = useCallback(
    (force = false) => {
      const stage = stageRef.current;
      if (!stage || !image) return;
      if (!force && userAdjusted.current) return;
      const rect = stage.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) return;
      const pad = 30;
      const next = Math.min(
        (rect.width - pad * 2) / image.width,
        (rect.height - pad * 2) / image.height
      );
      const zoomed = Number.isFinite(next) && next > 0 ? next : 1;
      setZoom(zoomed);
      setPan({
        x: (rect.width - image.width * zoomed) / 2,
        y: (rect.height - image.height * zoomed) / 2,
      });
    },
    [image]
  );

  useEffect(() => {
    if (!image) return;
    userAdjusted.current = false;
    const run = () => fitToStage(true);
    run();
    // 窗口从 1480×940 被系统夹到屏幕尺寸时，首帧量到的是夹之前的尺寸；
    // 下一帧再量一次，之后靠 ResizeObserver 跟随。
    const raf = requestAnimationFrame(run);
    const stage = stageRef.current;
    const observer = new ResizeObserver(run);
    if (stage) observer.observe(stage);
    window.addEventListener('resize', run);
    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
      window.removeEventListener('resize', run);
    };
  }, [image, fitToStage]);

  // ---- 叠加层：已接受区域的掩码 + 手动区域
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !image) return;
    const scale = Math.min(1, OVERLAY_MAX / Math.max(width, height));
    const ow = Math.max(1, Math.round(width * scale));
    const oh = Math.max(1, Math.round(height * scale));
    if (canvas.width !== ow || canvas.height !== oh) {
      canvas.width = ow;
      canvas.height = oh;
    }
    const context = canvas.getContext('2d');
    if (!context) return;
    context.clearRect(0, 0, ow, oh);
    const frame = context.createImageData(ow, oh);
    let painted = false;
    for (const region of regions) {
      if (region.status !== 'accepted') continue;
      paintRleScaled(frame, region.maskRle, CATEGORY_COLOR[region.category] ?? [238, 188, 83], 96);
      painted = true;
    }
    for (const rect of manual) {
      const rle = rectRle(width, height, rect.x0, rect.y0, rect.x1, rect.y1);
      paintRleScaled(frame, rle, [238, 188, 83], 96);
      painted = true;
    }
    if (painted) context.putImageData(frame, 0, 0);
  }, [regions, manual, image, width, height]);

  // ---- 选图
  const adoptImage = useCallback((probe: Probe | null) => {
    if (!probe) return;
    setImage(probe);
    setRegions([]);
    setManual([]);
    setSelected(null);
    setAnalysis(null);
    setReport(null);
    setMode('view');
    setStatus(
      `${probe.width}×${probe.height} · ${probe.format} · ${(probe.bytes / 1048576).toFixed(1)} MB · 色彩 ${probe.colorRule}`
    );
  }, []);

  const pick = useCallback(async () => {
    adoptImage((await window.ri?.pick()) ?? null);
  }, [adoptImage]);

  // 命令行带路径启动时直接打开（`ReflectionInspector.exe D:\a.jpg`）。
  useEffect(() => {
    const target = new URLSearchParams(location.search).get('open');
    if (!target) return;
    void window.ri
      ?.load(target)
      .then((probe) => adoptImage(probe ?? null))
      .catch((error) => setStatus(`打开失败：${(error as Error).message}`));
  }, [adoptImage]);

  // ---- 自动建议
  const analyze = useCallback(async () => {
    if (!image || !window.ri) return;
    setBusy(true);
    setProgress({ stage: '准备', fraction: 0 });
    setStatus('正在定位候选…');
    try {
      const result = await window.ri.analyze({
        imagePath: image.path,
        boxThreshold,
        textThreshold: 0.25,
      });
      setAnalysis(result);
      const next: Region[] = result.regions.map((region, index) => ({
        ...region,
        id: `r${index}`,
        status: 'suggested',
        cover: { ...cover },
      }));
      setRegions(next);
      setStatus(
        next.length === 0
          ? `未找到候选（${result.seconds.toFixed(1)}s）。可以手动框选，或降低检测阈值后重试`
          : `${next.length} 条建议 · ${result.seconds.toFixed(1)}s · ${result.device.toUpperCase()}。模型只提建议，需你确认`
      );
    } catch (error) {
      setStatus(`建议失败：${(error as Error).message}`);
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }, [image, boxThreshold, cover]);

  // ---- 导出
  const exportImage = useCallback(async () => {
    if (!image || !window.ri) return;
    const edits = buildEdits(regions, manual, width, height);
    if (!edits.length) {
      setStatus('没有已采用的区域，先接受建议或手动框选');
      return;
    }
    setBusy(true);
    setStatus('正在合成并写盘…');
    try {
      const stem = image.path.replace(/\.[^.\\/]+$/, '').split(/[\\/]/).pop() ?? 'export';
      const result = await window.ri.exportImage({
        imagePath: image.path,
        edits,
        format: 'png',
        quality: 92,
        background: [255, 255, 255],
        suggestedName: `${stem}-遮挡`,
      });
      if (result) {
        setReport(result);
        setStatus(`已导出 ${result.width}×${result.height} · ${(result.bytes / 1024).toFixed(0)} KB`);
      } else {
        setStatus('已取消导出');
      }
    } catch (error) {
      setStatus(`导出失败：${(error as Error).message}`);
    } finally {
      setBusy(false);
    }
  }, [image, regions, manual, width, height]);

  // ---- 指针交互
  const toCanonical = useCallback(
    (clientX: number, clientY: number) => {
      const element = imageRef.current;
      if (!element) return { x: 0, y: 0 };
      const rect = element.getBoundingClientRect();
      return {
        x: ((clientX - rect.left) / rect.width) * width,
        y: ((clientY - rect.top) / rect.height) * height,
      };
    },
    [width, height]
  );

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!image) return;
    (event.target as Element).setPointerCapture?.(event.pointerId);
    if (mode === 'rect') {
      const point = toCanonical(event.clientX, event.clientY);
      dragRef.current = { kind: 'rect', startX: point.x, startY: point.y, panX: 0, panY: 0 };
      setDraft({ x0: point.x, y0: point.y, x1: point.x, y1: point.y });
      return;
    }
    dragRef.current = {
      kind: 'pan',
      startX: event.clientX,
      startY: event.clientY,
      panX: pan.x,
      panY: pan.y,
    };
    userAdjusted.current = true;
    setDragging(true);
  };

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    if (drag.kind === 'pan') {
      setPan({
        x: drag.panX + (event.clientX - drag.startX),
        y: drag.panY + (event.clientY - drag.startY),
      });
      return;
    }
    const point = toCanonical(event.clientX, event.clientY);
    setDraft({ x0: drag.startX, y0: drag.startY, x1: point.x, y1: point.y });
  };

  const onPointerUp = () => {
    const drag = dragRef.current;
    dragRef.current = null;
    setDragging(false);
    if (drag?.kind !== 'rect') return;
    setDraft((current) => {
      if (current) {
        const w = Math.abs(current.x1 - current.x0);
        const h = Math.abs(current.y1 - current.y0);
        if (w >= 4 && h >= 4) {
          const rect: ManualRect = {
            id: `m${Date.now()}`,
            x0: Math.min(current.x0, current.x1),
            y0: Math.min(current.y0, current.y1),
            x1: Math.max(current.x0, current.x1),
            y1: Math.max(current.y0, current.y1),
            cover: { ...cover },
          };
          setManual((list) => [...list, rect]);
          setStatus(`手动区域 ${Math.round(w)}×${Math.round(h)} 像素已加入`);
        }
      }
      return null;
    });
  };

  const onWheel = (event: React.WheelEvent<HTMLDivElement>) => {
    if (!image) return;
    const stage = stageRef.current;
    if (!stage) return;
    const rect = stage.getBoundingClientRect();
    const px = event.clientX - rect.left;
    const py = event.clientY - rect.top;
    const factor = Math.exp(-event.deltaY * 0.0015);
    const next = Math.min(12, Math.max(0.02, zoom * factor));
    const anchorX = (px - pan.x) / zoom;
    const anchorY = (py - pan.y) / zoom;
    userAdjusted.current = true;
    setZoom(next);
    setPan({ x: px - anchorX * next, y: py - anchorY * next });
  };

  const setRegionStatus = (id: string, next: Region['status']) => {
    setRegions((list) => list.map((region) => (region.id === id ? { ...region, status: next } : region)));
  };

  const setRegionKind = (id: string, kind: Cover['kind']) => {
    setRegions((list) =>
      list.map((region) => (region.id === id ? { ...region, cover: { ...region.cover, kind } } : region))
    );
  };

  // ---- 资源管理向导（ADR-G03）：所有联网动作都必须由用户点击触发
  const refreshEnv = async (verify = true) => {
    const next = (await window.ri?.envStatus(verify)) as EnvStatus | undefined;
    if (next) setEnv(next);
    return next ?? null;
  };

  const downloadModels = async () => {
    setEnvBusy(true);
    setEnvError(null);
    setEnvProgress({ message: '准备下载…', bytesDone: 0, bytesTotal: 0 });
    try {
      const result = (await window.ri?.envDownload()) as { ok: boolean; status?: EnvStatus; error?: string };
      if (result?.status) setEnv(result.status);
      if (!result?.ok) setEnvError(result?.error ?? '下载失败');
      else setStatus('模型资源已就绪');
    } catch (error) {
      setEnvError((error as Error).message);
    } finally {
      setEnvBusy(false);
      setEnvProgress(null);
    }
  };

  const importModels = async () => {
    setEnvBusy(true);
    setEnvError(null);
    try {
      const result = (await window.ri?.envImport()) as { ok: boolean; status?: EnvStatus; error?: string; canceled?: boolean };
      if (result?.canceled) return;
      if (result?.status) setEnv(result.status);
      if (!result?.ok) setEnvError(result?.error ?? '导入失败');
      else setStatus('已切换到本地资源目录');
    } catch (error) {
      setEnvError((error as Error).message);
    } finally {
      setEnvBusy(false);
    }
  };

  const dismissWizard = () => {
    window.localStorage.setItem('ri.wizardDismissed', '1');
    setWizardOpen(false);
  };

  const accepted = regions.filter((region) => region.status === 'accepted').length;
  const editCount = accepted + manual.length;
  const workerBroken = Boolean(hello?.workerError);
  const manualMode = Boolean(env && !env.ready);

  return (
    <>
      <header>
        <strong>反光检查镜</strong>
        <span className="meta">
          {image ? image.path : '未载入照片'}
          {analysis ? ` · 建议 ${analysis.regions.length} 条 / ${analysis.seconds.toFixed(1)}s` : ''}
        </span>
        <span className="spacer" />
        <button className={manualMode ? 'warn' : ''} onClick={() => setWizardOpen(true)}>
          {manualMode ? '纯手动模式' : '运行环境'}
        </button>
        <button onClick={pick} disabled={busy}>
          选择照片
        </button>
        <button className="primary" onClick={analyze} disabled={!image || busy || workerBroken}>
          {busy && progress ? `${progress.stage} ${Math.round(progress.fraction * 100)}%` : '自动建议'}
        </button>
        <button className={mode === 'rect' ? 'active' : ''} onClick={() => setMode(mode === 'rect' ? 'view' : 'rect')} disabled={!image}>
          {mode === 'rect' ? '框选中（点击退出）' : '手动框选'}
        </button>
        <button className="primary" onClick={exportImage} disabled={!image || busy || editCount === 0}>
          导出遮挡图
        </button>
      </header>

      {manualMode && (
        <div className="banner">
          <span>
            纯手动模式：{env?.reason} 手动框选、马赛克与导出**照常可用**，不受影响。
          </span>
          <button onClick={() => setWizardOpen(true)}>运行环境与模型资源</button>
        </div>
      )}
      {workerBroken && (
        <div className="banner">推理进程不可用：{hello?.workerError}（手动框选与导出仍可用）</div>
      )}

      {wizardOpen && (
        <div className="wizard-mask" role="dialog" aria-modal="true">
          <div className="wizard">
            <h2>运行环境与模型资源</h2>
            <p className="wizard-lead">
              安装包不含 PyTorch 与模型权重（合计约 {formatBytes(env?.models.totalBytes ?? 0)}），
              需要时再下载。**下载只在你点击下面按钮后才会开始**，每个文件都会按固定 SHA-256 校验。
            </p>

            <div className="wizard-grid">
              <div>
                <span className="k">Python 运行时</span>
                <span className={env?.python.found ? 'ok' : 'bad'}>
                  {env?.python.found ? `已找到 · ${env.python.source}` : '未找到（自动建议不可用）'}
                </span>
              </div>
              <div>
                <span className="k">模型资源</span>
                <span className={env?.models.ready ? 'ok' : 'bad'}>
                  {env?.models.ready
                    ? `就绪${env.models.shaVerified ? '（SHA-256 已校验）' : '（仅校验体积）'}`
                    : `缺 ${formatBytes(env?.models.missingBytes ?? 0)}`}
                </span>
              </div>
              <div>
                <span className="k">资源目录</span>
                <span className="path">{env?.models.root ?? '探测中…'}</span>
              </div>
            </div>

            {(env?.models.models.length ?? 0) > 0 && (
              <table className="wizard-table">
                <thead>
                  <tr>
                    <th>模型</th>
                    <th>固定 revision</th>
                    <th>许可</th>
                    <th>体积</th>
                    <th>状态</th>
                  </tr>
                </thead>
                <tbody>
                  {env?.models.models.map((model) => (
                    <tr key={model.id}>
                      <td>{model.id}</td>
                      <td className="mono">{model.revision.slice(0, 10)}…</td>
                      <td>{model.license}</td>
                      <td>{formatBytes(model.bytes)}</td>
                      <td className={model.ready ? 'ok' : 'bad'}>{model.ready ? '就绪' : '缺失'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            {envProgress && (
              <div className="wizard-progress">
                <div className="bar">
                  <i
                    style={{
                      width:
                        envProgress.bytesTotal > 0
                          ? `${Math.min(100, (envProgress.bytesDone / envProgress.bytesTotal) * 100).toFixed(1)}%`
                          : '4%',
                    }}
                  />
                </div>
                <span>
                  {envProgress.message ?? '下载中'} · {formatBytes(envProgress.bytesDone)} /{' '}
                  {formatBytes(envProgress.bytesTotal)}
                </span>
              </div>
            )}

            {envError && <div className="wizard-error">{envError}</div>}

            <div className="wizard-actions">
              <button className="primary" onClick={downloadModels} disabled={envBusy}>
                {envBusy ? '处理中…' : '一键下载并校验模型资源'}
              </button>
              <button onClick={importModels} disabled={envBusy}>
                导入本地离线资源包
              </button>
              <button onClick={() => void window.ri?.envOpenFolder()} disabled={envBusy}>
                打开资源目录
              </button>
              <button onClick={() => void refreshEnv(true)} disabled={envBusy}>
                重新检测
              </button>
              <span className="spacer" />
              <button onClick={dismissWizard}>稍后再说（用纯手动模式）</button>
            </div>
            <p className="wizard-foot">
              许可：两个模型均为 Apache-2.0（IDEA-Research/grounding-dino-tiny、facebook/sam-vit-base）。
              离线导入请选择包含 <code>grounding-dino-tiny/</code> 与 <code>sam-vit-base/</code> 的目录。
            </p>
          </div>
        </div>
      )}

      <main>
        <div
          ref={stageRef}
          className={`stage ${mode === 'rect' ? 'drawing' : ''} ${dragging ? 'dragging' : ''}`}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onWheel={onWheel}
          onDoubleClick={() => {
            userAdjusted.current = false;
            fitToStage(true);
          }}
        >
          {image ? (
            <div
              className="scene"
              style={{
                width,
                height,
                transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
              }}
            >
              <img ref={imageRef} src={`ri-asset://img/${image.token}`} alt="" draggable={false} />
              <canvas ref={canvasRef} />
              {/* 线宽按当前缩放反算：SVG 的 1 单位 = 1 个原图像素，除以 zoom 才能保持屏幕上恒定的粗细。 */}
              <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none">
                {regions.map((region) => {
                  const [x0, y0, x1, y1] = region.canonicalBox;
                  const color = `rgb(${CATEGORY_COLOR[region.category].join(',')})`;
                  const dim = region.status === 'rejected';
                  return (
                    <rect
                      key={region.id}
                      x={x0}
                      y={y0}
                      width={Math.max(1, x1 - x0)}
                      height={Math.max(1, y1 - y0)}
                      fill="none"
                      stroke={color}
                      strokeWidth={(region.id === selected ? 2.2 : 1.5) / zoom}
                      strokeDasharray={dim ? `${6 / zoom} ${4 / zoom}` : undefined}
                      opacity={dim ? 0.35 : 1}
                    />
                  );
                })}
                {manual.map((rect) => (
                  <rect
                    key={rect.id}
                    x={rect.x0}
                    y={rect.y0}
                    width={Math.max(1, rect.x1 - rect.x0)}
                    height={Math.max(1, rect.y1 - rect.y0)}
                    fill="none"
                    stroke="#eebc53"
                    strokeWidth={1.8 / zoom}
                  />
                ))}
                {draft && (
                  <rect
                    x={Math.min(draft.x0, draft.x1)}
                    y={Math.min(draft.y0, draft.y1)}
                    width={Math.max(1, Math.abs(draft.x1 - draft.x0))}
                    height={Math.max(1, Math.abs(draft.y1 - draft.y0))}
                    fill="rgba(238,188,83,0.16)"
                    stroke="#eebc53"
                    strokeWidth={1.8 / zoom}
                    strokeDasharray={`${6 / zoom} ${4 / zoom}`}
                  />
                )}
              </svg>
            </div>
          ) : (
            <div className="empty">
              <b>拖入或选择一张照片</b>
              <span>JPEG / PNG / WebP 静态 SDR · 照片不会离开这台电脑</span>
              <span>自动建议只是候选，遮挡与否由你逐条确认</span>
            </div>
          )}
        </div>

        <aside>
          <section>
            <h3>遮挡方式</h3>
            <div className="row">
              <label>方式</label>
              <select
                value={cover.kind}
                onChange={(event) => setCover({ ...cover, kind: event.target.value as Cover['kind'] })}
              >
                <option value="solid">实心填充（推荐）</option>
                <option value="mosaic">马赛克</option>
              </select>
            </div>
            {cover.kind === 'solid' ? (
              <div className="row">
                <label>填充色</label>
                <input
                  type="color"
                  value={rgbToHex(cover.color)}
                  onChange={(event) => setCover({ ...cover, color: hexToRgb(event.target.value) })}
                />
                <span className="hint">外扩</span>
                <input
                  type="number"
                  min={0}
                  max={8}
                  value={cover.expand}
                  onChange={(event) => setCover({ ...cover, expand: Number(event.target.value) })}
                />
                <span className="hint">px</span>
              </div>
            ) : (
              <div className="row">
                <label>块大小</label>
                <input
                  type="number"
                  min={2}
                  max={128}
                  value={cover.block}
                  onChange={(event) => setCover({ ...cover, block: Number(event.target.value) })}
                />
                <span className="hint">原图像素</span>
              </div>
            )}
            <div className="hint">改动只作用于之后新增的区域；已加入的要单独调。</div>
          </section>

          <section>
            <h3>检测阈值</h3>
            <div className="row">
              <label>候选门槛</label>
              <input
                type="range"
                min={0.15}
                max={0.7}
                step={0.05}
                value={boxThreshold}
                onChange={(event) => setBoxThreshold(Number(event.target.value))}
              />
              <span className="hint">{boxThreshold.toFixed(2)}</span>
            </div>
            <div className="hint">调低会多给候选，也会多给误检。改完需重新点「自动建议」。</div>
          </section>

          <section className="grow">
            <h3>区域（{editCount} 条生效）</h3>
            {regions.length === 0 && manual.length === 0 && (
              <div className="hint">还没有区域。点「自动建议」拿候选，或用「手动框选」补屏幕、金属等模型不认的目标。</div>
            )}
            {regions.map((region) => (
              <div
                key={region.id}
                className={`region ${region.status === 'accepted' ? 'accepted' : ''} ${
                  region.status === 'rejected' ? 'rejected' : ''
                } ${region.id === selected ? 'sel' : ''}`}
                onClick={() => setSelected(region.id)}
              >
                <div className="top">
                  <span className={`badge ${region.category}`}>{CATEGORY_LABEL[region.category]}</span>
                  <span className="label">{region.label || region.category}</span>
                </div>
                <div className="scores">
                  检测 {region.detectorScore.toFixed(3)} · 分割 {region.samPredictedIoU.toFixed(3)} · 模型建议，待检查
                </div>
                <div className="actions">
                  <button onClick={() => setRegionStatus(region.id, 'accepted')}>采用</button>
                  <button onClick={() => setRegionStatus(region.id, 'rejected')}>排除</button>
                  <button onClick={() => setRegionStatus(region.id, 'suggested')}>待定</button>
                  <button onClick={() => setRegionKind(region.id, region.cover.kind === 'solid' ? 'mosaic' : 'solid')}>
                    {region.cover.kind === 'solid' ? '改马赛克' : '改实心'}
                  </button>
                </div>
              </div>
            ))}
            {manual.map((rect) => (
              <div key={rect.id} className="region accepted">
                <div className="top">
                  <span className="badge glass">手动</span>
                  <span className="label">
                    {Math.round(rect.x1 - rect.x0)}×{Math.round(rect.y1 - rect.y0)}
                  </span>
                </div>
                <div className="scores">
                  ({Math.round(rect.x0)}, {Math.round(rect.y0)}) · {rect.cover.kind === 'solid' ? '实心' : '马赛克'}
                </div>
                <div className="actions">
                  <button onClick={() => setManual((list) => list.filter((item) => item.id !== rect.id))}>
                    删除
                  </button>
                </div>
              </div>
            ))}
          </section>
        </aside>
      </main>

      <footer>
        <span>{status}</span>
        <span className="spacer" style={{ flex: 1 }} />
        {progress && <div className="progress"><i style={{ width: `${progress.fraction * 100}%` }} /></div>}
        {image && (
          <span>
            缩放 {(zoom * 100).toFixed(0)}% · 画面 {width}×{height}
          </span>
        )}
        {hello && (
          <span className={hello.workerError ? 'warn' : ''}>
            {hello.workerError
              ? '推理进程不可用'
              : `${hello.device ? `${hello.device.toUpperCase()} · ` : ''}Python ${hello.python} · ${hello.pythonSource}`}
          </span>
        )}
      </footer>

      {report && <ExportModal report={report} onClose={() => setReport(null)} />}
    </>
  );
}

function ExportModal({ report, onClose }: { report: ExportReport; onClose: () => void }) {
  return (
    <div className="modal" onClick={onClose}>
      <div className="card" onClick={(event) => event.stopPropagation()}>
        <header>
          <strong>导出结果</strong>
          <span className="spacer" style={{ flex: 1 }} />
          <button onClick={onClose}>关闭</button>
          <button onClick={() => void window.ri?.reveal(report.output)}>在文件夹中显示</button>
        </header>
        <div className="body">
          <img src={`data:image/png;base64,${report.previewPngBase64}`} alt="导出预览" />
          <div className="facts">
            {report.width}×{report.height} · {report.format} · {(report.bytes / 1024).toFixed(0)} KB · 覆盖{' '}
            {report.editedPixels.toLocaleString()} 像素 · {report.edits} 条编辑
            <br />
            元数据已剥离 · 预览由已落盘的字节解码
            <br />
            {report.output}
            <br />
            SHA-256 {report.sha256.slice(0, 32)}…
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- 冒烟

async function runSmoke(): Promise<void> {
  const api = window.ri;
  if (!api?.smoke) return;
  const report = (payload: Record<string, unknown>) => api.smoke!(JSON.stringify(payload));
  try {
    const fixture = new URLSearchParams(location.search).get('fixture');
    if (!fixture) throw new Error('缺少夹具路径');
    const probe = await api.load(fixture);
    if (!probe) throw new Error('载入失败');
    const result = await api.analyze({ imagePath: probe.path, boxThreshold: 0.35, textThreshold: 0.25 });
    const adopted: Region[] = result.regions.map((region, index) => ({
      ...region,
      id: `r${index}`,
      status: 'accepted',
      cover: { ...DEFAULT_COVER },
    }));
    const manual: ManualRect[] = [
      {
        id: 'm-smoke',
        x0: 8,
        y0: 8,
        x1: Math.max(24, probe.width - 8),
        y1: 40,
        cover: { ...DEFAULT_COVER },
      },
    ];
    const edits = buildEdits(adopted, manual, probe.width, probe.height);
    const exported = await api.exportAuto!({
      imagePath: probe.path,
      edits,
      format: 'png',
      quality: 92,
      background: [255, 255, 255],
    });
    await report({
      regionCount: adopted.length,
      acceptedCount: adopted.length,
      manualCount: manual.length,
      export: exported,
    });
  } catch (error) {
    await report({ error: (error as Error).message });
  }
}

createRoot(document.getElementById('root')!).render(<App />);
if (new URLSearchParams(location.search).get('smoke') === '1') {
  setTimeout(() => void runSmoke(), 600);
}
