// Copyright (C) 2026 Over9rowth
// SPDX-License-Identifier: GPL-3.0-only
/** 主进程 / preload / 渲染层共用的类型。改这里要同时改 `worker/service.py` 的协议。 */

export type Rle = { w: number; h: number; start: number; counts: number[] };

export type CoverKind = 'solid' | 'mosaic';

/** 一条区域该用什么方式遮挡。实心优先于马赛克由 Python 侧统一决定，不在这里排序。 */
export type Cover = {
  kind: CoverKind;
  color: [number, number, number];
  block: number;
  expand: number;
};

export type RegionStatus = 'suggested' | 'accepted' | 'rejected';

export type Region = {
  id: string;
  category: 'mirror' | 'glass';
  label: string;
  detectorScore: number;
  samPredictedIoU: number;
  analysisBox: [number, number, number, number];
  canonicalBox: [number, number, number, number];
  maskRle: Rle;
  status: RegionStatus;
  cover: Cover;
};

export type ManualRect = {
  id: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  cover: Cover;
};

export type Probe = {
  path: string;
  token: string;
  width: number;
  height: number;
  bytes: number;
  format: string;
  colorRule: string;
  orientationApplied: number;
  /** true 表示这次探测走的是本地解码（推理进程不可用），界面要提示为纯手动模式。 */
  degraded?: boolean;
};

export type EnvProgress = {
  stage: 'start' | 'file' | 'verify' | 'done' | 'error';
  file?: string;
  done: number;
  total: number;
  bytesDone: number;
  bytesTotal: number;
  message?: string;
};

export type EnvModelSummary = {
  id: string;
  revision: string;
  license: string;
  licenseUrl: string;
  fileCount: number;
  bytes: number;
  ready: boolean;
  missingBytes: number;
};

export type EnvStatus = {
  ready: boolean;
  mode: 'full' | 'manual';
  python: { found: boolean; path: string; source: string; detail: string };
  models: {
    root: string;
    exists: boolean;
    ready: boolean;
    shaVerified: boolean;
    totalBytes: number;
    missingBytes: number;
    models: EnvModelSummary[];
  };
  reason: string;
};

export type Hello = {
  protocolVersion: number;
  python: string;
  modelsDir: string;
  modelsPresent: Record<string, boolean>;
  modelsLoaded: boolean;
  device: string | null;
  pythonPath: string;
  pythonSource: string;
  workerError: string | null;
  env?: EnvStatus;
};

export type AnalyzeResult = {
  status: 'complete-with-suggestions' | 'complete-no-suggestions';
  transform: {
    canonicalSize: [number, number];
    analysisSize: [number, number];
    scaleX: number;
    scaleY: number;
  };
  regions: Array<Omit<Region, 'id' | 'status' | 'cover'>>;
  seconds: number;
  modelLoadSeconds: number | null;
  peakCudaAllocatedBytes: number | null;
  device: string;
  thresholds: { box: number; text: number };
  image: { format: string; colorRule: string; orientationApplied: number };
};

export type ExportReport = {
  output: string;
  format: string;
  width: number;
  height: number;
  bytes: number;
  sha256: string;
  canonicalSize: [number, number];
  sourceColorRule: string;
  metadataStripped: boolean;
  editedPixels: number;
  edits: number;
  alphaPreserved: boolean;
  previewPngBase64: string;
};

export type WorkerProgress = { stage: string; fraction: number };

export type ExportRequest = {
  imagePath: string;
  edits: unknown[];
  format: 'png' | 'jpeg' | 'webp';
  quality: number;
  background: [number, number, number];
  suggestedName: string;
};
