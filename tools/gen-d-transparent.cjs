/* 生成 D 透明版资源 + 自包含棋盘格预览（透明底一眼可见） */
const fs = require('fs');
const path = require('path');
const { Resvg } = require('@resvg/resvg-js');

const ROOT = path.resolve(__dirname, '..');
const SVG = path.join(ROOT, process.env.SVG_PATH || 'design/icons/concept-d-transparent.svg');
const OUT = path.join(ROOT, process.env.OUT_DIR || 'build/candidates/d-transparent');
fs.mkdirSync(OUT, { recursive: true });

const svg = fs.readFileSync(SVG);

function render(n) {
  return new Resvg(svg, { fitTo: { mode: 'width', value: n }, background: 'transparent' }).render().asPng();
}
function b64(b) { return b.toString('base64'); }
function dataUri(b) { return `data:image/png;base64,${b64(b)}`; }
function pngSize(b) { return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) }; }

// ICO（带 alpha）
// ICONDIRENTRY 必须为 16 字节：w,h,colorCount,reserved,planes(2),bitCount(2),bytesInRes(4),imageOffset(4)
// 早期版本每项只写 12 字节、漏掉 imageOffset，导致目录错位、Electron 解析失败。
function buildIco(pngs) {
  const count = pngs.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type = icon
  header.writeUInt16LE(count, 4);
  const dirs = [];
  const datas = [];
  let offset = 6 + count * 16; // 目录结束位置 = 首张图偏移
  for (const p of pngs) {
    const de = Buffer.alloc(16);
    const sz = p.size >= 256 ? 0 : p.size; // 256 用 0 表示
    de.writeUInt8(sz, 0); // width
    de.writeUInt8(sz, 1); // height
    de.writeUInt8(0, 2); // color count（0=truecolor）
    de.writeUInt8(0, 3); // reserved
    de.writeUInt16LE(1, 4); // color planes
    de.writeUInt16LE(32, 6); // bits per pixel
    de.writeUInt32LE(p.bytes.length, 8); // image size
    de.writeUInt32LE(offset, 12); // image offset
    dirs.push(de);
    datas.push(p.bytes);
    offset += p.bytes.length;
  }
  return Buffer.concat([header, ...dirs, ...datas]);
}
// ICNS（带 alpha）—— 按 Apple 槽位规范：ic07=128, ic08=256, ic09=512, ic10=1024,
// ic11=32(16@2x), ic12=64(32@2x), ic13=256(128@2x), ic14=16
function buildIcns(bySize) {
  const SLOTS = [
    ['ic07', 128],
    ['ic08', 256],
    ['ic09', 512],
    ['ic10', 1024],
    ['ic11', 32],
    ['ic12', 64],
    ['ic13', 256],
    ['ic14', 16],
  ];
  const body = Buffer.concat(
    SLOTS.map(([type, size]) => {
      const p = bySize[size];
      if (!p) throw new Error(`icns 缺少 ${size}px 渲染结果`);
      const len = Buffer.alloc(4);
      len.writeUInt32BE(p.length + 8, 0);
      return Buffer.concat([Buffer.from(type, 'ascii'), len, p]);
    }),
  );
  const hdr = Buffer.from('icns', 'ascii');
  const total = Buffer.alloc(4);
  total.writeUInt32BE(body.length + 8, 0);
  return Buffer.concat([hdr, total, body]);
}

// 资源
const ALL_SIZES = [16, 24, 32, 48, 64, 128, 256, 512, 1024];
const bySize = {};
for (const s of ALL_SIZES) bySize[s] = render(s);

const ICO = [16, 24, 32, 48, 64, 128, 256].map((s) => ({ size: s, bytes: bySize[s] }));
fs.writeFileSync(path.join(OUT, 'd-icon.ico'), buildIco(ICO));

fs.writeFileSync(path.join(OUT, 'd-icon.icns'), buildIcns(bySize));

fs.writeFileSync(path.join(OUT, 'd-icon-1024.png'), bySize[1024]);
[16, 24, 32, 48, 64, 128, 256].forEach((s) => fs.writeFileSync(path.join(OUT, `d-${s}.png`), bySize[s]));
console.log('D-transparent assets written:', fs.readdirSync(OUT).join(' '));

// 自包含棋盘格预览
const big = render(256);
const stage96 = render(96);
const ladder = [16, 24, 32, 48, 64, 128, 256].map((s) => `<figure><img src="${dataUri(render(s))}" width="${s}" height="${s}"><figcaption>${s}</figcaption></figure>`).join('');

const html = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>DbNest 图标 D · 透明背景</title>
<style>
  :root{ --ink:#1b2230; --dim:#6b7488; --panel:#fff; --line:#e6e8ec; }
  *{box-sizing:border-box;}
  body{margin:0;background:#f5f6f8;color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;}
  header{padding:28px 32px 8px;} h1{font-size:20px;margin:0 0 4px;font-weight:650;}
  .sub{color:var(--dim);font-size:13px;line-height:1.6;}
  .wrap{padding:16px 32px 60px;max-width:920px;}
  .card{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:20px;margin-top:16px;}
  .desc{font-size:12.5px;color:var(--dim);line-height:1.7;margin-bottom:16px;}
  .checker{background-image:linear-gradient(45deg,#d8dbe0 25%,transparent 25%),linear-gradient(-45deg,#d8dbe0 25%,transparent 25%),linear-gradient(45deg,transparent 75%,#d8dbe0 75%),linear-gradient(-45deg,transparent 75%,#d8dbe0 75%);background-size:20px 20px;background-position:0 0,0 10px,10px -10px,-10px 0;}
  .stage{display:flex;gap:16px;align-items:center;justify-content:center;padding:24px;border-radius:10px;}
  .stage.mac{background:linear-gradient(135deg,#3a3f4b,#23262e);}
  .stage.win{background:linear-gradient(135deg,#0e3a6b,#0a2540);}
  .ico{width:96px;height:96px;}
  .ico.mac{border-radius:22%;}
  .ico.win{border-radius:14%;}
  .ladder{display:flex;align-items:flex-end;gap:16px;margin-top:18px;padding-top:16px;border-top:1px dashed var(--line);flex-wrap:wrap;}
  .ladder figure{margin:0;text-align:center;}
  .ladder img{display:block;margin:0 auto 4px;border-radius:6px;}
  .ladder figcaption{font-size:10px;color:var(--dim);}
  .note{background:#fff7e6;border:1px solid #f3d99a;border-radius:10px;padding:12px 14px;margin-top:14px;font-size:12px;color:#7a5a12;line-height:1.7;}
  .foot{color:var(--dim);font-size:12px;margin-top:20px;line-height:1.7;}
</style></head>
<body>
<header><h1>DbNest 图标 D · Flat Cylinder（透明背景）</h1>
<div class="sub">按你的要求改为 <b>透明背景</b>：只保留标记（彩色扁平圆柱 + 白色分隔线），去掉满铺底/投影/外框/下方巢弧。下方棋盘格用于直观显示透明度；mac/win 语境下也置于棋盘格上。</div></header>
<div class="wrap">
  <div class="card">
    <div class="desc">白扁平圆柱（indigo 分隔线）+ 极简白色「巢」弧，置于透明画布。作为 logo 可自由贴任意底色；作为 macOS/Windows 应用图标时请注意：透明区域会透出桌面/窗口（见下方说明）。</div>
    <div class="stage mac checker"><img class="ico mac" src="${dataUri(stage96)}" alt="mac"></div>
    <div class="stage win checker"><img class="ico win" src="${dataUri(stage96)}" alt="win"></div>
    <div class="ladder checker" style="padding:16px;border-radius:10px;">${ladder}</div>
  </div>
  <div class="note">⚠️ 透明底应用图标提示：macOS 应用图标为整块 squircle，透明处会露出桌面；Windows 任务栏透明 .ico 同样会透出后方。若用于「应用图标」建议仍用实色瓷砖版（showcase-v3 中的 D 实色版）；透明版更适合做 <b>品牌 logo / 文档图标 / 网页 favicon</b> 等自由贴底场景。</div>
  <div class="foot">资源已生成于 <span style="font-family:ui-monospace;">build/candidates/d-transparent/</span>：d-icon.ico（16/24/32/48/64/128/256，带 alpha）、d-icon.icns（32..1024，带 alpha）、d-icon-1024.png、及各小尺寸 PNG。</div>
</div>
</body></html>`;

const htmlPath = path.join(ROOT, process.env.HTML_PATH || 'design/icons/showcase-d-transparent.html');
fs.mkdirSync(path.dirname(htmlPath), { recursive: true });
fs.writeFileSync(htmlPath, html);
console.log('wrote', htmlPath, '(self-contained, checkerboard)');
