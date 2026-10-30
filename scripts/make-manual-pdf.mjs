// 生成《用户使用说明书.pdf》：resources/manual.html → printToPDF → 交付物/
//
// 为什么单独一个脚本：说明书是交付物的一部分，必须可复现；用应用里的
// 「导出说明书」按钮要人工点对话框，不适合自动化。
//
// 两个环境适配（只影响构建机）：
//   1) 用 data: URL 载入 HTML —— 工程路径含中文时 loadFile 会拼出
//      file:///<盘符>:\... 这种非法 URL 并报 ERR_FAILED。
//   2) 显式关掉 GPU —— 本机沙箱里 GPU 进程崩溃会把渲染进程一起带崩。
//
// 用法（需先 npm run build）：
//   npm run manual
import { app, BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const src = path.join(root, 'resources', 'manual.html');
const outDir = path.resolve(root, '..', '交付物');
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const out = path.join(outDir, `反光检查镜-${version}-用户使用说明书.pdf`);

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-gpu-sandbox');
app.commandLine.appendSwitch('no-sandbox');

app.whenReady().then(async () => {
  if (!fs.existsSync(src)) {
    console.error('找不到 resources/manual.html');
    app.exit(1);
    return;
  }
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
  try {
    const html = fs.readFileSync(src, 'utf8');
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    await new Promise((r) => setTimeout(r, 400));
    const pdf = await win.webContents.printToPDF({ preferCSSPageSize: true, printBackground: true });
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(out, pdf);
    console.log(`PDF: ${out}  ${pdf.length.toLocaleString()} 字节`);
    app.exit(0);
  } catch (e) {
    console.error('生成失败: ' + (e && e.message ? e.message : String(e)));
    app.exit(1);
  } finally {
    win.destroy();
  }
});
