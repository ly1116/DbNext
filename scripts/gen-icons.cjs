/**
 * 图标生成脚本（一次性工具）：node scripts/gen-icons.js
 * 用 Electron 离屏渲染把 build/icon.svg 光栅化，重建 icon.png / icon.ico / icon.icns。
 *
 * 产物规格：
 * - icon.png  : 1024x1024 RGBA（源图）
 * - icon.ico  : 16/24/32/48/64/72/96/128/256 共 9 帧（PNG 压缩帧，Vista+ 全支持）
 * - icon.icns : icp4(16) icp5(32) ic07(128) ic08(256) ic09(512) ic10(1024)
 *               ic11(32@2x) ic12(64@2x) ic13(256@2x) ic14(512@2x)
 */
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SVG = path.join(ROOT, 'build/icon.svg');
const SIZES = [16, 24, 32, 48, 64, 72, 96, 128, 256, 512, 1024];

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-gpu-compositing');
app.commandLine.appendSwitch('in-process-gpu');

app.whenReady().then(async () => {
  const svg = fs.readFileSync(SVG, 'utf-8');
  const dataUrl = 'data:image/svg+xml;base64,' + Buffer.from(svg, 'utf-8').toString('base64');

  const win = new BrowserWindow({
    show: false,
    width: 1024,
    height: 1024,
    frame: false,
    transparent: true,
    webPreferences: { offscreen: true },
  });
  await win.loadURL(dataUrl);
  // 等一帧确保离屏合成完成
  await new Promise((r) => setTimeout(r, 300));
  const base = win.webContents.capturePage();
  const full = await base;
  win.destroy();

  // 1024 源
  const png1024 = full.toPNG();
  fs.writeFileSync(path.join(ROOT, 'build/icon.png'), png1024);

  // 各尺寸缩放
  const pngs = new Map(); // size -> Buffer
  for (const size of SIZES) {
    const img = size === 1024 ? full : full.resize({ width: size, height: size, quality: 'best' });
    pngs.set(size, img.toPNG());
    console.log(`render ${size}x${size}: ${pngs.get(size).length} bytes`);
  }

  // —— ICO：PNG 压缩帧 ——
  const icoSizes = [16, 24, 32, 48, 64, 72, 96, 128, 256];
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(icoSizes.length, 4);
  const dirSize = 6 + icoSizes.length * 16;
  let offset = dirSize;
  const dirEntries = [];
  const blobs = [];
  for (const size of icoSizes) {
    const png = pngs.get(size);
    const e = Buffer.alloc(16);
    e.writeUInt8(size >= 256 ? 0 : size, 0); // width (0 = 256)
    e.writeUInt8(size >= 256 ? 0 : size, 1); // height
    e.writeUInt8(0, 2); // palette
    e.writeUInt8(0, 3); // reserved
    e.writeUInt16LE(1, 4); // planes
    e.writeUInt16LE(32, 6); // bpp
    e.writeUInt32LE(png.length, 8);
    e.writeUInt32LE(offset, 12);
    dirEntries.push(e);
    blobs.push(png);
    offset += png.length;
  }
  fs.writeFileSync(path.join(ROOT, 'build/icon.ico'), Buffer.concat([header, ...dirEntries, ...blobs]));

  // —— ICNS ——
  // OSType -> 像素尺寸
  const icnsMap = [
    ['icp4', 16],
    ['icp5', 32],
    ['ic07', 128],
    ['ic08', 256],
    ['ic09', 512],
    ['ic10', 1024],
    ['ic11', 32],
    ['ic12', 64],
    ['ic13', 256],
    ['ic14', 512],
  ];
  const chunks = [];
  let total = 8;
  for (const [ost, size] of icnsMap) {
    const png = pngs.get(size);
    if (!png) continue;
    const c = Buffer.alloc(8);
    c.write(ost, 0, 'ascii');
    c.writeUInt32BE(png.length + 8, 4);
    chunks.push(c, png);
    total += png.length + 8;
  }
  const head = Buffer.alloc(8);
  head.write('icns', 0, 'ascii');
  head.writeUInt32BE(total, 4);
  fs.writeFileSync(path.join(ROOT, 'build/icon.icns'), Buffer.concat([head, ...chunks]));

  console.log('icon.png / icon.ico / icon.icns regenerated.');
  app.quit();
});
