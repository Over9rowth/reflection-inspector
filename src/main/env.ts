// Copyright (C) 2026 Over9rowth
// SPDX-License-Identifier: GPL-3.0-only
// 运行环境与模型资源管理（ADR-G03 方案 A）。
//
// 三条硬约束：
//   1) 安装包不捆绑 PyTorch 与模型权重，权重按需下载到用户目录；
//   2) 下载必须在用户明确点击后才发起，逐文件校验 manifest 里的固定 SHA-256；
//   3) 没有 Python / 没有模型时，手动框选遮挡与导出必须照常可用 —— 见 fallbackExport。
import { app, nativeImage, net as electronNet } from 'electron';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { applyEdits } from '../domain/paint.mjs';
import { evaluate, planDownloads, summarizeManifest } from '../domain/env.mjs';

export type PythonInfo = { found: boolean; path: string; source: string; detail: string };

export type EnvStatus = {
  ready: boolean;
  mode: 'full' | 'manual';
  python: PythonInfo;
  models: {
    root: string;
    exists: boolean;
    ready: boolean;
    shaVerified: boolean;
    totalBytes: number;
    missingBytes: number;
    models: Array<{ id: string; revision: string; license: string; licenseUrl: string; fileCount: number; bytes: number; ready: boolean; missingBytes: number }>;
  };
  reason: string;
};

type Settings = { modelsRoot?: string };

function settingsFile(): string {
  return path.join(app.getPath('userData'), 'resources-settings.json');
}

function readSettings(): Settings {
  try {
    return JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) as Settings;
  } catch {
    return {};
  }
}

function writeSettings(next: Settings): void {
  try {
    fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
    fs.writeFileSync(settingsFile(), JSON.stringify(next, null, 2), 'utf8');
  } catch (error) {
    console.error('[env] 保存设置失败', error);
  }
}

/** 默认资源目录：%LOCALAPPDATA%\Over9rowth\ReflectionInspector\models（与 SPEC 一致）。 */
export function defaultModelsRoot(): string {
  const local = process.env.LOCALAPPDATA;
  if (local) return path.join(local, 'Over9rowth', 'ReflectionInspector', 'models');
  return path.join(app.getPath('userData'), 'models');
}

export function modelsRoot(): string {
  const configured = readSettings().modelsRoot;
  if (configured && fs.existsSync(configured)) return configured;
  // 开发机上权重就放在工程里，直接用它，免得重复下 1 GB。
  if (!app.isPackaged) {
    const bundled = path.join(app.getAppPath(), 'resources', 'models');
    if (fs.existsSync(bundled)) return bundled;
  }
  return defaultModelsRoot();
}

export function manifestPath(): string {
  // 打包后 resources/models 被 ignore 掉，但 model-manifest.json 在 resources 根，跟着 asar 外置目录走。
  const candidates = [
    path.join(app.getAppPath(), 'resources', 'model-manifest.json'),
    path.join(process.resourcesPath ?? '', 'resources', 'model-manifest.json'),
    path.join(process.resourcesPath ?? '', 'app', 'resources', 'model-manifest.json'),
  ];
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  return candidates[0];
}

export function readManifest(): { models?: Array<Record<string, unknown>> } {
  try {
    return JSON.parse(fs.readFileSync(manifestPath(), 'utf8'));
  } catch (error) {
    console.error('[env] 读不到资源清单', error);
    return { models: [] };
  }
}

function sha256File(file: string): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      const hash = crypto.createHash('sha256');
      const stream = fs.createReadStream(file);
      stream.on('data', (chunk) => hash.update(chunk));
      stream.on('error', () => resolve(null));
      stream.on('end', () => resolve(hash.digest('hex')));
    } catch {
      resolve(null);
    }
  });
}

function fileFacts(root: string, modelId: string, file: string, verify: boolean) {
  const full = path.join(root, modelId.replace('/', path.sep), file);
  try {
    const stat = fs.statSync(full);
    return { full, exists: stat.isFile(), bytes: stat.size };
  } catch {
    return { full, exists: false, bytes: 0 };
  }
}

/** 评估资源状态。verify=true 时逐个算 SHA-256（1 GB 量级约数秒，仅在向导打开/刷新时用）。 */
export async function status(verify = false): Promise<EnvStatus> {
  const manifest = readManifest();
  const root = modelsRoot();
  const summary = summarizeManifest(manifest);
  const facts = new Map<string, { exists: boolean; bytes: number; sha256: string | null }>();
  for (const model of manifest.models ?? []) {
    for (const entry of (model.files as Array<{ file: string; bytes: number }>) ?? []) {
      const fact = fileFacts(root, String(model.id), entry.file, verify);
      const sha = verify && fact.exists && fact.bytes === entry.bytes ? await sha256File(fact.full) : null;
      facts.set(`${model.id}\u0000${entry.file}`, { exists: fact.exists, bytes: fact.bytes, sha256: sha });
    }
  }
  const evaluated = evaluate(manifest, (modelId, file) => facts.get(`${modelId}\u0000${file}`) ?? { exists: false, bytes: 0, sha256: null });
  const python = detectPython();
  const modelsReady = evaluated.ready;
  const ready = python.found && modelsReady;
  const reason = !python.found
    ? '未检测到 Python 运行时：可继续使用纯手动遮挡与导出，自动建议需要先配置运行时。'
    : !modelsReady
      ? `模型资源未就绪，还需下载 ${(evaluated.totalMissingBytes / 1024 / 1024).toFixed(0)} MB。`
      : '';
  return {
    ready,
    mode: ready ? 'full' : 'manual',
    python,
    models: {
      root,
      exists: fs.existsSync(root),
      ready: modelsReady,
      shaVerified: evaluated.shaVerified,
      totalBytes: summary.totalBytes,
      missingBytes: evaluated.totalMissingBytes,
      models: (summary.models as Array<{ id: string; revision: string; license: string; licenseUrl: string; fileCount: number; bytes: number }>).map((model) => {
        const state = (evaluated.models as Array<{ id: string; ready: boolean; missingBytes: number }>).find((item) => item.id === model.id);
        return { ...model, ready: state?.ready ?? false, missingBytes: state?.missingBytes ?? model.bytes };
      }),
    },
    reason,
  };
}

export function detectPython(): PythonInfo {
  const fromEnv = process.env.RI_PYTHON;
  if (fromEnv && fs.existsSync(fromEnv)) return { found: true, path: fromEnv, source: '环境变量 RI_PYTHON', detail: '' };
  if (app.isPackaged) {
    const bundled = path.join(process.resourcesPath ?? '', 'python', 'python.exe');
    if (fs.existsSync(bundled)) return { found: true, path: bundled, source: '安装目录内运行时', detail: '' };
  }
  const venv = path.join(app.getAppPath(), '.venv', 'Scripts', 'python.exe');
  if (fs.existsSync(venv)) return { found: true, path: venv, source: '项目 .venv', detail: '' };
  return { found: false, path: '', source: '', detail: '未找到 python.exe（可用 RI_PYTHON 指定）' };
}

export type DownloadProgress = {
  stage: 'start' | 'file' | 'verify' | 'done' | 'error';
  file?: string;
  done: number;
  total: number;
  bytesDone: number;
  bytesTotal: number;
  message?: string;
};

function downloadOne(url: string, target: string, expectedSha: string, onBytes: (n: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const part = `${target}.part`;
    const file = fs.createWriteStream(part);
    const request = electronNet.request({ method: 'GET', url });
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      file.close(() => fs.promises.rm(part, { force: true }).catch(() => undefined));
      reject(error);
    };
    request.on('response', (response) => {
      if (response.statusCode !== 200) {
        fail(new Error(`HTTP ${response.statusCode}：${url}`));
        response.on('data', () => undefined); // 把响应体读空，释放连接
        return;
      }
      response.on('data', (chunk: Buffer) => {
        file.write(chunk);
        onBytes(chunk.length);
      });
      response.on('end', () => {
        file.end(async () => {
          if (settled) return;
          try {
            const hash = crypto.createHash('sha256');
            await new Promise<void>((done, bad) => {
              const stream = fs.createReadStream(part);
              stream.on('data', (chunk) => hash.update(chunk));
              stream.on('error', bad);
              stream.on('end', () => done());
            });
            const actual = hash.digest('hex');
            if (actual.toLowerCase() !== expectedSha.toLowerCase()) {
              await fs.promises.rm(part, { force: true });
              throw new Error(`SHA-256 校验失败：${path.basename(target)}（期望 ${expectedSha.slice(0, 12)}… 实际 ${actual.slice(0, 12)}…）`);
            }
            await fs.promises.rename(part, target);
            settled = true;
            resolve();
          } catch (error) {
            fail(error as Error);
          }
        });
      });
      response.on('error', (error: Error) => fail(error));
    });
    request.on('error', (error: Error) => fail(error));
    request.end();
  });
}

/** 按清单补齐缺失文件。只在用户点过按钮后调用。 */
export async function downloadMissing(onProgress: (progress: DownloadProgress) => void): Promise<EnvStatus> {
  const manifest = readManifest();
  const root = modelsRoot();
  // 下载前只按体积判断（不算 1 GB 的 SHA-256），反正下载后还会逐文件强校验。
  const facts = new Map<string, { exists: boolean; bytes: number; sha256: string | null }>();
  for (const model of manifest.models ?? []) {
    for (const entry of (model.files as Array<{ file: string; bytes: number }>) ?? []) {
      const fact = fileFacts(root, String(model.id), entry.file, false);
      facts.set(`${model.id}\u0000${entry.file}`, { exists: fact.exists, bytes: fact.bytes, sha256: null });
    }
  }
  const evaluated = evaluate(manifest, (modelId, file) =>
    facts.get(`${modelId}\u0000${file}`) ?? { exists: false, bytes: 0, sha256: null }
  );
  const plan = planDownloads(manifest, evaluated);
  const total = plan.reduce((sum, item) => sum + item.bytes, 0);
  onProgress({ stage: 'start', done: 0, total: plan.length, bytesDone: 0, bytesTotal: total });
  let bytesDone = 0;
  let index = 0;
  try {
    for (const item of plan) {
      index += 1;
      const target = path.join(root, item.modelId.replace('/', path.sep), item.file);
      onProgress({ stage: 'file', file: item.file, done: index - 1, total: plan.length, bytesDone, bytesTotal: total, message: `下载 ${item.file}` });
      let lastTick = 0;
      await downloadOne(item.url, target, item.sha256, (n) => {
        bytesDone += n;
        const now = Date.now();
        if (now - lastTick > 250) {
          lastTick = now;
          onProgress({ stage: 'file', file: item.file, done: index - 1, total: plan.length, bytesDone, bytesTotal: total, message: `下载 ${item.file}` });
        }
      });
      onProgress({ stage: 'verify', file: item.file, done: index, total: plan.length, bytesDone, bytesTotal: total, message: `已校验 ${item.file}` });
    }
  } catch (error) {
    onProgress({ stage: 'error', done: index, total: plan.length, bytesDone, bytesTotal: total, message: (error as Error).message });
    throw error;
  }
  const finalStatus = await status(true);
  onProgress({ stage: 'done', done: plan.length, total: plan.length, bytesDone, bytesTotal: total, message: '全部校验通过' });
  return finalStatus;
}

/** 导入已有的离线资源目录：只做校验与登记，不复制文件。 */
export async function importModels(dir: string): Promise<EnvStatus> {
  const manifest = readManifest();
  const probe = (modelId: string, file: string) => {
    const full = path.join(dir, modelId.replace('/', path.sep), file);
    try {
      const stat = fs.statSync(full);
      return { exists: stat.isFile(), bytes: stat.size, sha256: null };
    } catch {
      return { exists: false, bytes: 0, sha256: null };
    }
  };
  const evaluated = evaluate(manifest, probe);
  if (!evaluated.ready) {
    throw new Error(`该目录里的模型不完整：还缺 ${(evaluated.totalMissingBytes / 1024 / 1024).toFixed(0)} MB`);
  }
  writeSettings({ ...readSettings(), modelsRoot: dir });
  return status(true);
}

// ---------------------------------------------------------------- 无 Python 降级

export type FallbackProbe = {
  path: string;
  width: number;
  height: number;
  bytes: number;
  format: string;
  colorRule: string;
  orientationApplied: number;
};

export function fallbackProbe(filePath: string): FallbackProbe {
  const image = nativeImage.createFromPath(filePath);
  if (image.isEmpty()) throw new Error('这个文件读不出图像内容（支持 JPEG / PNG / WebP）');
  const size = image.getSize();
  const ext = path.extname(filePath).toLowerCase().replace('.', '');
  return {
    path: filePath,
    width: size.width,
    height: size.height,
    bytes: fs.statSync(filePath).size,
    format: ext === 'jpeg' ? 'jpg' : ext,
    colorRule: 'sRGB（纯手动模式）',
    orientationApplied: 0,
  };
}

export type FallbackExportResult = {
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

/** 不依赖 Python 的导出：解码 → 画遮挡 → 重编码。重编码天然丢掉 EXIF。 */
export async function fallbackExport(request: {
  imagePath: string;
  edits: unknown[];
  output: string;
  format: string;
  quality: number;
}): Promise<FallbackExportResult> {
  const image = nativeImage.createFromPath(request.imagePath);
  if (image.isEmpty()) throw new Error('这个文件读不出图像内容（支持 JPEG / PNG / WebP）');
  const size = image.getSize();
  const bitmap = image.toBitmap(); // BGRA
  const report = applyEdits(bitmap, size.width, size.height, request.edits as never[]);
  const painted = nativeImage.createFromBitmap(bitmap, { width: size.width, height: size.height });
  const format = request.format === 'jpeg' || request.format === 'jpg' ? 'jpeg' : 'png';
  const data = format === 'jpeg' ? painted.toJPEG(Math.round(request.quality ?? 92)) : painted.toPNG();
  await fs.promises.mkdir(path.dirname(request.output), { recursive: true });
  await fs.promises.writeFile(request.output, data);
  const sha256 = crypto.createHash('sha256').update(data).digest('hex');
  return {
    output: request.output,
    format,
    width: size.width,
    height: size.height,
    bytes: data.length,
    sha256,
    canonicalSize: [size.width, size.height],
    sourceColorRule: 'sRGB（纯手动模式）',
    metadataStripped: true,
    editedPixels: report.editedPixels,
    edits: report.applied,
    alphaPreserved: format === 'png',
    previewPngBase64: (format === 'png' ? data : painted.toPNG()).toString('base64'),
  };
}
