// Copyright (C) 2026 Over9rowth
// SPDX-License-Identifier: GPL-3.0-only
// 运行环境与模型资源的判定逻辑（纯函数，可被 node 直接测试）。
// 主进程只负责「问文件系统要事实」，所有判断都在这里做，便于单测。

/** 文件状态：ok=大小与 SHA-256 都吻合；size-ok=大小吻合但本轮没算 SHA-256。 */
export const FILE_OK = 'ok';
export const FILE_SIZE_OK = 'size-ok';
export const FILE_MISSING = 'missing';
export const FILE_SIZE_MISMATCH = 'size-mismatch';
export const FILE_SHA_MISMATCH = 'sha-mismatch';

const OK_STATES = new Set([FILE_OK, FILE_SIZE_OK]);

/**
 * 把 resources/model-manifest.json 压成给用户看的清单。
 * @param {object} manifest
 */
export function summarizeManifest(manifest) {
  const models = (manifest?.models ?? []).map((model) => {
    const bytes = (model.files ?? []).reduce((sum, file) => sum + (file.bytes || 0), 0);
    return {
      id: model.id,
      revision: model.revision,
      license: model.license,
      licenseUrl: model.licenseUrl,
      fileCount: (model.files ?? []).length,
      bytes,
    };
  });
  return { models, totalBytes: models.reduce((sum, model) => sum + model.bytes, 0) };
}

/**
 * 评估当前资源状态。
 * @param {object} manifest 资源清单
 * @param {(modelId: string, file: string) => {exists: boolean, bytes: number, sha256: string | null}} probe
 * @returns {{ready: boolean, models: Array<object>, totalMissingBytes: number, shaVerified: boolean}}
 */
export function evaluate(manifest, probe) {
  const models = (manifest?.models ?? []).map((model) => {
    const files = (model.files ?? []).map((entry) => {
      const actual = probe(model.id, entry.file) ?? { exists: false, bytes: 0, sha256: null };
      let state;
      if (!actual.exists) state = FILE_MISSING;
      else if (actual.bytes !== entry.bytes) state = FILE_SIZE_MISMATCH;
      else if (actual.sha256 == null) state = FILE_SIZE_OK;
      else state = actual.sha256.toLowerCase() === String(entry.sha256).toLowerCase() ? FILE_OK : FILE_SHA_MISMATCH;
      return { file: entry.file, expectedBytes: entry.bytes, actualBytes: actual.exists ? actual.bytes : 0, state };
    });
    const missingBytes = files.reduce(
      (sum, file) => sum + (OK_STATES.has(file.state) ? 0 : file.expectedBytes),
      0
    );
    return {
      id: model.id,
      revision: model.revision,
      ready: files.every((file) => OK_STATES.has(file.state)),
      files,
      missingBytes,
    };
  });
  const allFiles = models.flatMap((model) => model.files);
  return {
    ready: models.length > 0 && models.every((model) => model.ready),
    models,
    totalMissingBytes: models.reduce((sum, model) => sum + model.missingBytes, 0),
    shaVerified: allFiles.length > 0 && allFiles.every((file) => file.state === FILE_OK),
  };
}

/**
 * 需要下载的文件清单。已经是 ok/size-ok 的跳过，size-mismatch / sha-mismatch 的要重下。
 * @param {object} manifest
 * @param {ReturnType<typeof evaluate>} status
 */
export function planDownloads(manifest, status) {
  const bad = new Set();
  for (const model of status?.models ?? []) {
    for (const file of model.files ?? []) {
      if (!OK_STATES.has(file.state)) bad.add(`${model.id}\u0000${file.file}`);
    }
  }
  const plan = [];
  for (const model of manifest?.models ?? []) {
    for (const entry of model.files ?? []) {
      if (!bad.has(`${model.id}\u0000${entry.file}`)) continue;
      plan.push({
        modelId: model.id,
        file: entry.file,
        bytes: entry.bytes,
        sha256: entry.sha256,
        url: entry.url,
      });
    }
  }
  return plan;
}

/** 人类可读体积。故意用 1024 进制，与资源管理器一致。 */
export function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let size = value / 1024;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  return `${size.toFixed(size >= 100 ? 0 : size >= 10 ? 1 : 2)} ${units[index]}`;
}
