// Copyright (C) 2026 Over9rowth
// SPDX-License-Identifier: GPL-3.0-only
import { app, BrowserWindow, dialog, ipcMain, nativeImage, protocol, shell } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import net from 'node:net';
import readline from 'node:readline';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import type { ExportRequest, Probe, WorkerProgress } from '../contracts/model';
import {
  defaultModelsRoot,
  downloadMissing,
  fallbackExport,
  fallbackProbe,
  importModels,
  modelsRoot,
  status as envStatus,
} from './env';

/** 子进程只用 stdout 报端口、stderr 记日志，stdin 不参与协议。 */
type WorkerChild = ChildProcessByStdio<null, Readable, Readable>;

const SMOKE = process.argv.includes('--smoke');
/** 纯手动模式冒烟：不启动推理进程，只走本地解码 + 本地绘制的导出链路。 */
const SMOKE_MANUAL = process.argv.includes('--smoke-manual');
const ASSET_SCHEME = 'ri-asset';
const PRODUCT_NAME = '反光检查镜';

/**
 * Squirrel 安装事件：自己写快捷方式。
 *
 * 实测 Setup.exe 装完不会生成任何快捷方式（Update.exe --createShortcut 建出来的名字取自
 * exe 文件名，只能是 ASCII，开始菜单会显示 ReflectionInspector 而不是中文产品名）。
 * 这里直接写 .lnk：名字用产品名，目标指向版本无关的根级 stub，
 * 升级换 app-x.y.z 目录也不会失效。
 *
 * 注意不能匹配 --squirrel-firstrun——那是装完自动启动应用的事件，拦掉会导致装完打不开。
 */
function handleSquirrelEvent(): boolean {
  if (process.platform !== 'win32') return false;
  const event = [
    '--squirrel-install',
    '--squirrel-updated',
    '--squirrel-uninstall',
    '--squirrel-obsolete',
  ].find((name) => process.argv.includes(name));
  if (!event) return false;
  const removing = event === '--squirrel-uninstall' || event === '--squirrel-obsolete';
  try {
    const stub = path.join(path.resolve(path.dirname(process.execPath), '..'), path.basename(process.execPath));
    const links = [
      path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', `${PRODUCT_NAME}.lnk`),
      path.join(app.getPath('desktop'), `${PRODUCT_NAME}.lnk`),
    ];
    for (const link of links) {
      if (removing) {
        try {
          fs.unlinkSync(link);
        } catch {
          /* 本来就不存在 */
        }
      } else {
        shell.writeShortcutLink(link, 'create', {
          target: stub,
          args: '',
          icon: stub,
          iconIndex: 0,
          description: PRODUCT_NAME,
        });
      }
    }
  } catch (error) {
    console.error('[squirrel] 写快捷方式失败，退回 Update.exe', error);
    try {
      const updateExe = path.resolve(path.dirname(process.execPath), '..', 'Update.exe');
      spawn(updateExe, [removing ? '--removeShortcut' : '--createShortcut', path.basename(process.execPath)], {
        timeout: 20000,
        windowsHide: true,
        stdio: 'ignore',
        detached: false,
      });
    } catch {
      /* 尽力而为 */
    }
  }
  app.exit(0);
  return true;
}

protocol.registerSchemesAsPrivileged([
  {
    scheme: ASSET_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  },
]);

/** token → 用户授权过的绝对路径。渲染层拿不到任意路径，只能引用这里登记过的。 */
const assets = new Map<string, string>();

let win: BrowserWindow | null = null;

// ---------------------------------------------------------------- 推理进程

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  onProgress?: (progress: WorkerProgress) => void;
};

/**
 * 推理进程客户端。协议走 127.0.0.1 上的临时端口，不用 stdin/stdout ——
 * 原因见 worker/service.py 顶部：stdio 管道在本机 Windows 上会卡住扩展模块加载。
 * 启动时子进程把端口作为唯一一行 stdout 输出，这里读到后连过去。
 */
class WorkerClient {
  private child: WorkerChild | null = null;
  private socket: net.Socket | null = null;
  private buffer = '';
  private seq = 0;
  private pending = new Map<number, Pending>();
  private ready: Promise<void> | null = null;
  private root: string;
  pythonPath = '';
  pythonSource = '';
  lastError: string | null = null;

  constructor(root: string) {
    this.root = root;
  }

  private resolvePython(): { path: string; source: string } {
    const fromEnv = process.env.RI_PYTHON;
    if (fromEnv && fs.existsSync(fromEnv)) {
      return { path: fromEnv, source: '环境变量 RI_PYTHON' };
    }
    if (app.isPackaged) {
      const bundled = path.join(process.resourcesPath, 'python', 'python.exe');
      if (fs.existsSync(bundled)) return { path: bundled, source: '安装目录内运行时' };
    }
    const venv = path.join(this.root, '.venv', 'Scripts', 'python.exe');
    if (fs.existsSync(venv)) return { path: venv, source: '项目 .venv' };
    throw new Error(
      '找不到 Python 运行时。请设置环境变量 RI_PYTHON 指向 python.exe，或在项目目录创建 .venv。'
    );
  }

  private start(): Promise<void> {
    if (this.ready) return this.ready;
    this.ready = new Promise<void>((resolve, reject) => {
      let settled = false;
      const fail = (error: Error) => {
        if (!settled) {
          settled = true;
          reject(error);
        }
        this.failAll(error);
      };

      let resolved: { path: string; source: string };
      try {
        resolved = this.resolvePython();
      } catch (error) {
        fail(error as Error);
        return;
      }
      this.pythonPath = resolved.path;
      this.pythonSource = resolved.source;
      const script = path.join(this.root, 'worker', 'service.py');
      if (!fs.existsSync(script)) {
        fail(new Error(`找不到推理脚本 ${script}`));
        return;
      }

      const env: NodeJS.ProcessEnv = { ...process.env };
      // 从 IDE 终端启动时这两个变量会被继承，导致子进程以错误方式运行。
      delete env.ELECTRON_RUN_AS_NODE;
      delete env.NODE_OPTIONS;
      env.PYTHONIOENCODING = 'utf-8';
      env.PYTHONUTF8 = '1';
      env.PYTHONUNBUFFERED = '1';

      const child = spawn(this.pythonPath, ['-u', script], {
        cwd: this.root,
        env,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      this.child = child;

      const timer = setTimeout(() => fail(new Error('推理进程 30 秒内没有报告端口')), 30000);

      const lines = readline.createInterface({ input: child.stdout });
      lines.on('line', (line) => {
        const text = line.trim();
        if (!text.startsWith('{')) return;
        let message: Record<string, unknown>;
        try {
          message = JSON.parse(text);
        } catch {
          return;
        }
        if (message.event === 'ready' && typeof message.port === 'number') {
          clearTimeout(timer);
          lines.close();
          this.connect(message.port as number).then(
            () => {
              if (!settled) {
                settled = true;
                resolve();
              }
            },
            (error: Error) => fail(error)
          );
        }
      });

      child.stderr.setEncoding('utf-8');
      child.stderr.on('data', (chunk: string) => {
        const text = String(chunk).trim();
        if (text) console.error('[worker]', text);
      });
      child.on('error', (error) => fail(new Error(`推理进程启动失败：${error.message}`)));
      child.on('exit', (code, signal) => {
        clearTimeout(timer);
        this.child = null;
        this.socket?.destroy();
        this.socket = null;
        this.ready = null;
        const reason = `推理进程已退出（code=${code} signal=${signal}）`;
        this.lastError = reason;
        fail(new Error(reason));
      });
    });
    return this.ready;
  }

  private connect(port: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const socket = net.createConnection({ host: '127.0.0.1', port }, () => {
        this.socket = socket;
        resolve();
      });
      socket.setNoDelay(true);
      socket.setEncoding('utf-8');
      socket.on('data', (chunk: string) => this.onData(chunk));
      socket.on('error', (error) => reject(error));
      socket.on('close', () => {
        this.socket = null;
        this.failAll(new Error('推理连接已关闭'));
      });
    });
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let index = this.buffer.indexOf('\n');
    while (index >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      index = this.buffer.indexOf('\n');
      if (!line) continue;
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(line);
      } catch {
        console.error('[worker] 无法解析输出行', line.slice(0, 200));
        continue;
      }
      const id = message.id as number | undefined;
      if (typeof id !== 'number') continue;
      const entry = this.pending.get(id);
      if (!entry) continue;
      if (message.event === 'progress') {
        entry.onProgress?.({
          stage: String(message.stage ?? ''),
          fraction: Number(message.fraction ?? 0),
        });
        continue;
      }
      this.pending.delete(id);
      if (message.ok) entry.resolve(message.result);
      else {
        const error = message.error as { code?: string; message?: string } | undefined;
        const wrapped = new Error(error?.message ?? '推理失败');
        (wrapped as Error & { code?: string }).code = error?.code;
        entry.reject(wrapped);
      }
    }
  }

  private failAll(error: Error): void {
    for (const [, entry] of this.pending) entry.reject(error);
    this.pending.clear();
  }

  async request<T>(
    op: string,
    params: Record<string, unknown> = {},
    onProgress?: (progress: WorkerProgress) => void
  ): Promise<T> {
    await this.start();
    const socket = this.socket;
    if (!socket || socket.destroyed) throw new Error('推理进程不可用');
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        onProgress,
      });
      socket.write(JSON.stringify({ id, op, ...params }) + '\n');
    });
  }

  /** 强制取消：单线程服务在推理中收不到 cancel，只能终止进程。下次分析会重新加载模型。 */
  cancelAll(): void {
    if (!this.child) return;
    this.failAll(new Error('已取消'));
    const child = this.child;
    this.child = null;
    this.ready = null;
    this.socket?.destroy();
    this.socket = null;
    child.kill();
  }

  async stop(): Promise<void> {
    if (!this.child) return;
    try {
      this.socket?.write(JSON.stringify({ id: ++this.seq, op: 'shutdown' }) + '\n');
    } catch {
      /* 可能已退出 */
    }
    const child = this.child;
    this.child = null;
    this.ready = null;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill();
        resolve();
      }, 3000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    this.socket?.destroy();
    this.socket = null;
  }
}

let worker: WorkerClient;

// ---------------------------------------------------------------- 协议与窗口

function mimeFor(file: string): string {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  return 'image/jpeg';
}

function registerAssetProtocol(): void {
  protocol.handle(ASSET_SCHEME, async (request) => {
    const url = new URL(request.url);
    const token = decodeURIComponent(url.pathname.replace(/^\/+/, '')) || url.hostname;
    const file = assets.get(token);
    if (!file || !fs.existsSync(file)) {
      return new Response('未授权的资源', { status: 403 });
    }
    const data = await fs.promises.readFile(file);
    return new Response(new Uint8Array(data), {
      headers: { 'content-type': mimeFor(file), 'cache-control': 'no-store' },
    });
  });
}

function registerAsset(file: string): string {
  const token = randomUUID();
  assets.set(token, file);
  return token;
}

async function createWindow(): Promise<void> {
  win = new BrowserWindow({
    width: 1480,
    height: 940,
    minWidth: 1100,
    minHeight: 720,
    backgroundColor: '#0e1319',
    show: false,
    title: '反光检查镜',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.once('ready-to-show', () => {
    if (!SMOKE) win?.show();
  });
  if (SMOKE) {
    // 冒烟时把渲染层日志转出来，否则失败只能看到一句超时。
    win.webContents.on('console-message', (_event, level, message) => {
      console.log(`[renderer:${level}] ${message}`);
    });
  }
  const page = path.join(__dirname, '..', 'renderer', 'index.html');
  const query: Record<string, string> = {};
  if (SMOKE) {
    query.smoke = '1';
    query.fixture =
      process.env.RI_SMOKE_FIXTURE ??
      path.join(app.getAppPath(), 'tests', 'fixtures', 'mirror.jpg');
  }
  const openTarget = findOpenArgument();
  if (openTarget) query.open = openTarget;
  await win.loadFile(page, { query });
}

/** 命令行带一个图片路径就直接打开它：`ReflectionInspector.exe D:\a.jpg`。 */
function findOpenArgument(): string | null {
  const candidates = process.argv
    .slice(1)
    .filter((value) => !value.startsWith('-') && /\.(jpe?g|png|webp)$/i.test(value));
  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    if (fs.existsSync(resolved)) return resolved;
  }
  return null;
}

function fail(message: string): never {
  console.error('SMOKE FAIL: ' + message);
  app.exit(1);
  throw new Error(message);
}

/**
 * 读图元信息。
 *
 * 优先问推理进程（它能给出真实色彩规则与 EXIF 方向处理），
 * 但推理进程不可用时必须退回本地解码 —— ADR-G03 要求没有 Python 也能手动遮挡与导出。
 */
async function loadImage(filePath: string): Promise<Probe | null> {
  if (!filePath || !fs.existsSync(filePath)) throw new Error(`文件不存在：${filePath}`);
  let probe: {
    width: number;
    height: number;
    bytes: number;
    image: { format: string; colorRule: string; orientationApplied: number };
  };
  let degraded = false;
  try {
    probe = await worker.request('probe', { image: filePath });
  } catch (error) {
    const fallback = fallbackProbe(filePath);
    probe = {
      width: fallback.width,
      height: fallback.height,
      bytes: fallback.bytes,
      image: {
        format: fallback.format,
        colorRule: fallback.colorRule,
        orientationApplied: fallback.orientationApplied,
      },
    };
    degraded = true;
    console.error('[probe] 推理进程不可用，改用本地解码：' + (error as Error).message);
  }
  return {
    path: filePath,
    token: registerAsset(filePath),
    width: probe.width,
    height: probe.height,
    bytes: probe.bytes,
    format: probe.image.format,
    colorRule: probe.image.colorRule,
    orientationApplied: probe.image.orientationApplied,
    degraded,
  };
}

function wireIpc(): void {
  ipcMain.handle('app:hello', async () => {
    const env = await envStatus(false);
    try {
      const hello = await worker.request<Record<string, unknown>>('hello');
      return {
        ...hello,
        pythonPath: worker.pythonPath,
        pythonSource: worker.pythonSource,
        workerError: null,
        env,
      };
    } catch (error) {
      return {
        protocolVersion: 0,
        python: '',
        modelsPresent: {},
        modelsLoaded: false,
        device: null,
        pythonPath: worker.pythonPath,
        pythonSource: worker.pythonSource,
        workerError: (error as Error).message,
        env,
      };
    }
  });

  ipcMain.handle('image:pick', async () => {
    if (!win) return null;
    const picked = await dialog.showOpenDialog(win, {
      title: '选择照片',
      properties: ['openFile'],
      filters: [{ name: '图片', extensions: ['jpg', 'jpeg', 'png', 'webp'] }],
    });
    if (picked.canceled || !picked.filePaths[0]) return null;
    return loadImage(picked.filePaths[0]);
  });

  // 拖入或自动化测试用：仍然要经过 probe，不把任意路径直接交给渲染层。
  ipcMain.handle('image:load', async (_event, filePath: string) => loadImage(filePath));

  ipcMain.handle(
    'analyze:run',
    async (_event, params: { imagePath: string; boxThreshold: number; textThreshold: number }) =>
      worker.request(
        'analyze',
        {
          image: params.imagePath,
          boxThreshold: params.boxThreshold,
          textThreshold: params.textThreshold,
        },
        (progress) => win?.webContents.send('worker-progress', progress)
      )
  );

  ipcMain.handle('analyze:cancel', () => {
    worker.cancelAll();
    return { cancelled: true };
  });

  ipcMain.handle('export:run', async (_event, request: ExportRequest) => {
    if (!win) return null;
    const ext = request.format === 'jpeg' ? 'jpg' : request.format;
    const saved = await dialog.showSaveDialog(win, {
      title: '导出遮挡后的图片',
      defaultPath: path.join(path.dirname(request.imagePath), `${request.suggestedName}.${ext}`),
      filters: [{ name: ext.toUpperCase(), extensions: [ext] }],
    });
    if (saved.canceled || !saved.filePath) return null;
    try {
      return await worker.request('export', {
        image: request.imagePath,
        edits: request.edits,
        output: saved.filePath,
        format: request.format,
        quality: request.quality,
        background: request.background,
      });
    } catch (error) {
      // 推理进程不可用时退回本地绘制：纯手动遮挡不依赖 Python。
      console.error('[export] 推理进程不可用，改用本地绘制：' + (error as Error).message);
      return fallbackExport({
        imagePath: request.imagePath,
        edits: request.edits,
        output: saved.filePath,
        format: request.format,
        quality: request.quality,
      });
    }
  });

  // ------------------------------------------------------------ 资源管理向导（ADR-G03）
  ipcMain.handle('env:status', async (_event, verify: unknown) => envStatus(verify === true));

  ipcMain.handle('env:download', async () => {
    try {
      const next = await downloadMissing((progress) => win?.webContents.send('env-progress', progress));
      return { ok: true, status: next };
    } catch (error) {
      return { ok: false, error: (error as Error).message };
    }
  });

  ipcMain.handle('env:import', async () => {
    if (!win) return { ok: false, error: '窗口未就绪' };
    const picked = await dialog.showOpenDialog(win, {
      title: '选择离线模型资源目录',
      properties: ['openDirectory'],
      message: '目录里应包含 grounding-dino-tiny/ 与 sam-vit-base/ 两个子目录',
    });
    if (picked.canceled || !picked.filePaths[0]) return { ok: false, canceled: true };
    try {
      return { ok: true, status: await importModels(picked.filePaths[0]) };
    } catch (error) {
      return { ok: false, error: (error as Error).message };
    }
  });

  ipcMain.handle('env:paths', async () => ({
    modelsRoot: modelsRoot(),
    defaultRoot: defaultModelsRoot(),
  }));

  ipcMain.handle('env:openFolder', async () => {
    const root = modelsRoot();
    try {
      fs.mkdirSync(root, { recursive: true });
    } catch {
      /* 建不出来就让 shell 报错 */
    }
    const error = await shell.openPath(root);
    return error || null;
  });

  ipcMain.handle('shell:reveal', (_event, target: string) => {
    shell.showItemInFolder(target);
    return true;
  });

  if (SMOKE) {
    // 冒烟专用：不弹保存对话框，写到临时目录。生产构建里不存在这个通道。
    ipcMain.handle(
      'export:runAuto',
      async (_event, request: Omit<ExportRequest, 'suggestedName'>) => {
        const output = path.join(app.getPath('temp'), `ri-smoke-${Date.now()}.png`);
        return worker.request('export', {
          image: request.imagePath,
          edits: request.edits,
          output,
          format: request.format,
          quality: request.quality,
          background: request.background,
        });
      }
    );

    ipcMain.handle('smoke:result', (_event, payload: string) => {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(payload);
      } catch {
        return fail('冒烟结果不是合法 JSON');
      }
      if (parsed.error) return fail(`渲染层报告 ${parsed.error}`);
      const regions = Number(parsed.regionCount ?? 0);
      const accepted = Number(parsed.acceptedCount ?? 0);
      if (!Number.isFinite(regions)) return fail('缺少建议数量');
      if (accepted < 1) return fail('没有可接受的建议，导出链路无法验证');
      if (!parsed.export || typeof parsed.export !== 'object') return fail('缺少导出报告');
      const report = parsed.export as Record<string, unknown>;
      if (report.metadataStripped !== true) return fail('导出未声明剥离元数据');
      if (Number(report.editedPixels) <= 0) return fail('导出没有覆盖任何像素');
      console.log(
        `SMOKE PASS: 建议 ${regions} 条 / 接受 ${accepted} 条 / 导出 ${report.width}×${report.height} ` +
          `${report.bytes} 字节 / 覆盖 ${report.editedPixels} 像素 / sha256 ${String(report.sha256).slice(0, 16)}…`
      );
      app.exit(0);
      return true;
    });
  }
}

if (!handleSquirrelEvent()) {
  app.whenReady().then(async () => {
    if (SMOKE_MANUAL) {
      // 不启动 worker：验证「没有 Python / 没有模型时，手动遮挡与导出仍可用」（ADR-G03）。
      // 图片在内存里合成，不依赖 tests/fixtures —— 那个目录按 ignore 规则不会被打进安装包。
      const outFile = process.env.RI_SMOKE_OUT;
      const write = (payload: Record<string, unknown>) => {
        if (!outFile) return;
        try {
          fs.writeFileSync(outFile, JSON.stringify(payload, null, 2), 'utf8');
        } catch {
          /* 写不出结果不影响退出码 */
        }
      };
      try {
        const W = 240;
        const H = 160;
        const seed = Buffer.alloc(W * H * 4);
        for (let y = 0; y < H; y += 1) {
          for (let x = 0; x < W; x += 1) {
            const offset = (y * W + x) * 4;
            seed[offset] = (x * 3) % 256; // B
            seed[offset + 1] = (y * 5) % 256; // G
            seed[offset + 2] = (x + y) % 256; // R
            seed[offset + 3] = 255;
          }
        }
        const seedPng = nativeImage.createFromBitmap(seed, { width: W, height: H }).toPNG();
        const stamp = Date.now();
        const input = path.join(app.getPath('temp'), `ri-manual-in-${stamp}.png`);
        const output = path.join(app.getPath('temp'), `ri-manual-out-${stamp}.png`);
        fs.writeFileSync(input, seedPng);

        const probe = fallbackProbe(input);
        const report = await fallbackExport({
          imagePath: input,
          output,
          format: 'png',
          quality: 92,
          edits: [
            { x0: 10, y0: 10, x1: 60, y1: 50, cover: { kind: 'solid', color: [0, 0, 0], block: 12, expand: 1 } },
            { x0: 120, y0: 80, x1: 200, y1: 140, cover: { kind: 'mosaic', color: [0, 0, 0], block: 10, expand: 0 } },
          ],
        });
        const back = fallbackProbe(output);
        if (probe.width !== W || probe.height !== H) throw new Error(`本地解码尺寸不对：${probe.width}×${probe.height}`);
        if (back.width !== probe.width || back.height !== probe.height) throw new Error('导出尺寸与原图不一致');
        if (report.editedPixels <= 0) throw new Error('没有覆盖任何像素');
        if (!report.metadataStripped) throw new Error('未声明剥离元数据');
        // 真的去导出文件里读像素：纯色块中心必须变成 (0,0,0)，未编辑处必须还留着原渐变。
        const outBitmap = nativeImage.createFromPath(output).toBitmap();
        const at = (x: number, y: number) => {
          const offset = (y * W + x) * 4;
          return [outBitmap[offset + 2], outBitmap[offset + 1], outBitmap[offset], outBitmap[offset + 3]];
        };
        const solid = at(20, 20);
        if (solid[0] !== 0 || solid[1] !== 0 || solid[2] !== 0) throw new Error(`纯色块没画上：${solid.join(',')}`);
        if (solid[3] !== 255) throw new Error('纯色块破坏了 alpha 通道');
        const untouched = at(5, 5);
        const expected = [(5 + 5) % 256, (5 * 5) % 256, (5 * 3) % 256];
        if (untouched[0] !== expected[0] || untouched[1] !== expected[1] || untouched[2] !== expected[2]) {
          throw new Error(`未编辑区域被改动：${untouched.slice(0, 3).join(',')} vs 期望 ${expected.join(',')}`);
        }
        const summary = {
          ok: true,
          width: report.width,
          height: report.height,
          bytes: report.bytes,
          editedPixels: report.editedPixels,
          edits: report.edits,
          sha256: report.sha256,
        };
        write(summary);
        console.log(
          `SMOKE-MANUAL PASS: 本地解码 ${probe.width}×${probe.height} → 导出 ${report.width}×${report.height} ` +
            `${report.bytes} 字节 / 覆盖 ${report.editedPixels} 像素 / 编辑 ${report.edits} 条 / sha256 ${report.sha256.slice(0, 16)}…`
        );
        app.exit(0);
      } catch (error) {
        write({ ok: false, error: (error as Error).message });
        console.error('SMOKE-MANUAL FAIL: ' + (error as Error).message);
        app.exit(1);
      }
      return;
    }
    worker = new WorkerClient(app.getAppPath());
    registerAssetProtocol();
    wireIpc();
    await createWindow();
    if (SMOKE) {
      // 冒烟由渲染层驱动整条链路，这里只兜总超时，防止进程挂死。
      setTimeout(() => fail('冒烟 300 秒未完成'), 300000);
    }
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) void createWindow();
    });
  });

  app.on('window-all-closed', () => {
    app.quit();
  });

  app.on('before-quit', () => {
    void worker?.stop();
  });
}

process.on('uncaughtException', (error) => {
  console.error('[main] 未捕获异常', error);
});
