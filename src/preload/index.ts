// Copyright (C) 2026 Over9rowth
// SPDX-License-Identifier: GPL-3.0-only
import { contextBridge, ipcRenderer, webUtils } from 'electron';

const api = {
  hello: () => ipcRenderer.invoke('app:hello'),
  pick: () => ipcRenderer.invoke('image:pick'),
  load: (filePath: string) => ipcRenderer.invoke('image:load', filePath),
  drop: (file: File) => ipcRenderer.invoke('image:load', webUtils.getPathForFile(file)),
  analyze: (params: { imagePath: string; boxThreshold: number; textThreshold: number }) =>
    ipcRenderer.invoke('analyze:run', params),
  cancel: () => ipcRenderer.invoke('analyze:cancel'),
  exportImage: (request: unknown) => ipcRenderer.invoke('export:run', request),
  reveal: (target: string) => ipcRenderer.invoke('shell:reveal', target),
  envStatus: (verify?: boolean) => ipcRenderer.invoke('env:status', verify === true),
  envDownload: () => ipcRenderer.invoke('env:download'),
  envImport: () => ipcRenderer.invoke('env:import'),
  envPaths: () => ipcRenderer.invoke('env:paths'),
  envOpenFolder: () => ipcRenderer.invoke('env:openFolder'),
  onEnvProgress: (callback: (progress: unknown) => void) => {
    const listener = (_event: unknown, payload: unknown) => callback(payload);
    ipcRenderer.on('env-progress', listener);
    return () => ipcRenderer.removeListener('env-progress', listener);
  },
  onProgress: (callback: (progress: { stage: string; fraction: number }) => void) => {
    const listener = (_event: unknown, payload: { stage: string; fraction: number }) =>
      callback(payload);
    ipcRenderer.on('worker-progress', listener);
    return () => ipcRenderer.removeListener('worker-progress', listener);
  },
};

// `smoke` 总是暴露，但对应的 IPC 通道只在主进程以 --smoke 启动时注册，
// 生产构建里调用会直接被拒。不能靠 `process.argv` 判断：沙箱渲染进程里的
// process 是精简替身，没有 argv。
const bridge: Record<string, unknown> = {
  ...api,
  smoke: (payload: string) => ipcRenderer.invoke('smoke:result', payload),
  exportAuto: (request: unknown) => ipcRenderer.invoke('export:runAuto', request),
};
contextBridge.exposeInMainWorld('ri', bridge);
