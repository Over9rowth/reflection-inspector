// 资源判定与下载计划的单测。纯逻辑，不碰文件系统。
// 运行：node --test tests/env.test.cjs
const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');

const MODULE = pathToFileURL(path.join(__dirname, '..', 'src', 'domain', 'env.mjs')).href;

const MANIFEST = {
  models: [
    {
      id: 'tiny',
      revision: 'rev-1',
      license: 'Apache-2.0',
      files: [
        { file: 'config.json', bytes: 10, sha256: 'aa', url: 'https://example.invalid/tiny/config.json' },
        { file: 'model.safetensors', bytes: 1000, sha256: 'bb', url: 'https://example.invalid/tiny/model.safetensors' },
      ],
    },
    {
      id: 'base',
      revision: 'rev-2',
      license: 'Apache-2.0',
      files: [{ file: 'config.json', bytes: 20, sha256: 'cc', url: 'https://example.invalid/base/config.json' }],
    },
  ],
};

function probeFrom(files) {
  return (modelId, file) => files[`${modelId}/${file}`] ?? { exists: false, bytes: 0, sha256: null };
}

test('summarizeManifest 汇总每个模型的体积与总字节数', async () => {
  const { summarizeManifest, formatBytes } = await import(MODULE);
  const summary = summarizeManifest(MANIFEST);
  assert.equal(summary.models.length, 2);
  assert.equal(summary.models[0].bytes, 1010);
  assert.equal(summary.models[0].fileCount, 2);
  assert.equal(summary.totalBytes, 1030);
  assert.equal(formatBytes(1030), '1.01 KB');
  assert.equal(formatBytes(689359096), '657 MB');
});

test('全部文件大小与 SHA-256 都吻合时 ready=true', async () => {
  const { evaluate, FILE_OK } = await import(MODULE);
  const status = evaluate(
    MANIFEST,
    probeFrom({
      'tiny/config.json': { exists: true, bytes: 10, sha256: 'aa' },
      'tiny/model.safetensors': { exists: true, bytes: 1000, sha256: 'bb' },
      'base/config.json': { exists: true, bytes: 20, sha256: 'cc' },
    })
  );
  assert.equal(status.ready, true);
  assert.equal(status.totalMissingBytes, 0);
  assert.equal(status.shaVerified, true);
  assert.equal(status.models[0].files[0].state, FILE_OK);
});

test('没算 SHA-256 但大小吻合时算 size-ok，不阻塞 ready', async () => {
  const { evaluate, FILE_SIZE_OK } = await import(MODULE);
  const status = evaluate(
    MANIFEST,
    probeFrom({
      'tiny/config.json': { exists: true, bytes: 10, sha256: null },
      'tiny/model.safetensors': { exists: true, bytes: 1000, sha256: null },
      'base/config.json': { exists: true, bytes: 20, sha256: null },
    })
  );
  assert.equal(status.ready, true);
  assert.equal(status.shaVerified, false);
  assert.equal(status.models[1].files[0].state, FILE_SIZE_OK);
});

test('缺文件时该模型不 ready，并累计缺失字节', async () => {
  const { evaluate, planDownloads, FILE_MISSING } = await import(MODULE);
  const files = {
    'tiny/config.json': { exists: true, bytes: 10, sha256: 'aa' },
    'base/config.json': { exists: true, bytes: 20, sha256: 'cc' },
  };
  const status = evaluate(MANIFEST, probeFrom(files));
  assert.equal(status.ready, false);
  assert.equal(status.models[0].ready, false);
  assert.equal(status.models[0].files[1].state, FILE_MISSING);
  assert.equal(status.totalMissingBytes, 1000);
  const plan = planDownloads(MANIFEST, status);
  assert.equal(plan.length, 1);
  assert.equal(plan[0].file, 'model.safetensors');
  assert.equal(plan[0].bytes, 1000);
});

test('大小不符与 SHA 不符都要重下，且都算缺失字节', async () => {
  const { evaluate, planDownloads, FILE_SIZE_MISMATCH, FILE_SHA_MISMATCH } = await import(MODULE);
  const status = evaluate(
    MANIFEST,
    probeFrom({
      'tiny/config.json': { exists: true, bytes: 9, sha256: null },
      'tiny/model.safetensors': { exists: true, bytes: 1000, sha256: 'ff' },
      'base/config.json': { exists: true, bytes: 20, sha256: 'cc' },
    })
  );
  assert.equal(status.models[0].files[0].state, FILE_SIZE_MISMATCH);
  assert.equal(status.models[0].files[1].state, FILE_SHA_MISMATCH);
  assert.equal(status.ready, false);
  assert.equal(status.totalMissingBytes, 1010);
  assert.deepEqual(
    planDownloads(MANIFEST, status).map((item) => item.file),
    ['config.json', 'model.safetensors']
  );
});

test('空清单不会误判为 ready', async () => {
  const { evaluate } = await import(MODULE);
  const status = evaluate({ models: [] }, () => ({ exists: true, bytes: 0, sha256: null }));
  assert.equal(status.ready, false);
  assert.equal(status.models.length, 0);
  assert.equal(status.totalMissingBytes, 0);
});

test('evaluate 对 probe 返回缺失不崩溃', async () => {
  const { evaluate } = await import(MODULE);
  const status = evaluate(MANIFEST, () => undefined);
  assert.equal(status.ready, false);
  assert.equal(status.models[0].files[0].state, 'missing');
});
