/* 生成 D 透明版 三套现代配色 + 自包含对比预览（零外链，棋盘格显示透明度） */
const fs = require('fs');
const path = require('path');
const { Resvg } = require('@resvg/resvg-js');

const ROOT = path.resolve(__dirname, '..');

// 现代配色方案：渐变上(c1)/下(c2)，顶面(top)，巢弧(arc)；分隔线固定白色 0.55 落在彩色圆柱上两种底皆可见
const SCHEMES = [
  { id: 'teal',   name: 'Teal→Emerald 青绿',   rec: true,  c1: '#14B8A6', c2: '#10B981', top: '#5EEAD4', arc: '#0D9488' },
  { id: 'violet', name: 'Violet→Fuchsia 紫粉', rec: false, c1: '#8B5CF6', c2: '#EC4899', top: '#C4B5FD', arc: '#D946EF' },
  { id: 'elec',   name: 'Cyan→Electric 电光',  rec: false, c1: '#06B6D4', c2: '#3B82F6', top: '#67E8F9', arc: '#2563EB' },
];

function svgFor(c) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs>
    <linearGradient id="mark" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${c.c1}"/>
      <stop offset="1" stop-color="${c.c2}"/>
    </linearGradient>
  </defs>
  <g transform="translate(512 512) scale(1.35) translate(-512 -512)">
    <path d="M336 372 V612 H688 V372 Z" fill="url(#mark)"/>
    <ellipse cx="512" cy="372" rx="176" ry="56" fill="${c.top}"/>
    <path d="M336 452 H688" fill="none" stroke="#ffffff" stroke-opacity="0.55" stroke-width="9"/>
    <path d="M336 532 H688" fill="none" stroke="#ffffff" stroke-opacity="0.55" stroke-width="9"/>
  </g>
</svg>`;
}

function render(svg, n) { return new Resvg(svg, { fitTo: { mode: 'width', value: n } }).render().asPng(); }
function dataUri(b) { return `data:image/png;base64,${b.toString('base64')}`; }
function pngSize(b) { return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) }; }

function buildIco(pngs) {
  const pHdr = Buffer.from([0, 0, 1, 0]);
  const cnt = Buffer.from([pngs.length, 0]);
  const entries = Buffer.concat(pngs.map((p) => {
    const sz = p.size >= 256 ? 0 : p.size;
    return Buffer.from([sz, sz, 0, 0, 0, 0, (p.bytes.length & 0xffff), (p.bytes.length >> 8) & 0xffff, (p.bytes.length >>> 0) & 0xff, (p.bytes.length >>> 8) & 0xff, (p.bytes.length >>> 16) & 0xff, (p.bytes.length >>> 24) & 0xff]);
  }));
  return Buffer.concat([pHdr, cnt, entries, Buffer.concat(pngs.map((p) => p.bytes))]);
}
function buildIcns(pngs) {
  const TYPES = ['ic07', 'ic08', 'ic09', 'ic10', 'ic11', 'ic12'];
  const body = Buffer.concat(pngs.map((p, i) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(p.bytes.length + 8, 0);
    return Buffer.concat([Buffer.from(TYPES[i], 'ascii'), len, p.bytes]);
  }));
  const hdr = Buffer.from('icns', 'ascii');
  const total = Buffer.alloc(4); total.writeUInt32BE(body.length + 8, 0);
  return Buffer.concat([hdr, total, body]);
}

const SIZES = [16, 24, 32, 48, 64, 128, 256];
const results = SCHEMES.map((c) => {
  const svg = svgFor(c);
  const outDir = path.join(ROOT, 'build/candidates', `d-color-${c.id}`);
  fs.mkdirSync(outDir, { recursive: true });
  const ico = SIZES.map((s) => { const b = render(svg, s); return { size: pngSize(b).w, bytes: b }; });
  fs.writeFileSync(path.join(outDir, 'd-icon.ico'), buildIco(ico));
  const icns = [32, 64, 128, 256, 512, 1024].map((s) => { const b = render(svg, s); return { size: pngSize(b).w, bytes: b }; });
  fs.writeFileSync(path.join(outDir, 'd-icon.icns'), buildIcns(icns));
  fs.writeFileSync(path.join(outDir, 'd-icon-1024.png'), render(svg, 1024));
  SIZES.forEach((s) => fs.writeFileSync(path.join(outDir, `d-${s}.png`), render(svg, s)));
  // 预览用资源
  const stage96 = render(svg, 96);
  const ladder = SIZES.map((s) => `<figure><img src="${dataUri(render(svg, s))}" width="${s}" height="${s}"><figcaption>${s}</figcaption></figure>`).join('');
  fs.writeFileSync(path.join(ROOT, 'design/icons', `concept-d-color-${c.id}.svg`), svg);
  return { c, stage96, ladder };
});
console.log('color schemes generated:', SCHEMES.map((c) => c.id).join(', '));

const cards = results.map(({ c, stage96, ladder }) => `
  <div class="scheme ${c.rec ? 'rec' : ''}">
    ${c.rec ? '<div class="ribbon">推荐</div>' : ''}
    <div class="sname">${c.name}</div>
    <div class="stage mac checker"><img class="ico mac" src="${dataUri(stage96)}" alt="mac"></div>
    <div class="stage win checker"><img class="ico win" src="${dataUri(stage96)}" alt="win"></div>
    <div class="ladder checker" style="padding:14px;border-radius:10px;">${ladder}</div>
    <div class="swatches">
      <span style="background:${c.c1}"></span><span style="background:${c.c2}"></span>
      <span style="background:${c.top}"></span>
    </div>
  </div>`).join('');

const html = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>DbNest 图标 D · 透明背景 · 现代配色三选一</title>
<style>
  :root{ --ink:#1b2230; --dim:#6b7488; --panel:#fff; --line:#e6e8ec; }
  *{box-sizing:border-box;}
  body{margin:0;background:#f5f6f8;color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;}
  header{padding:28px 32px 4px;} h1{font-size:20px;margin:0 0 4px;font-weight:650;}
  .sub{color:var(--dim);font-size:13px;line-height:1.6;}
  .wrap{padding:16px 32px 60px;max-width:1100px;}
  .grid{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin-top:16px;}
  .scheme{position:relative;background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:18px;overflow:hidden;}
  .scheme.rec{border-color:#14b8a6;box-shadow:0 0 0 2px rgba(20,184,166,.18);}
  .ribbon{position:absolute;top:12px;right:-30px;transform:rotate(45deg);background:#14b8a6;color:#fff;font-size:11px;padding:3px 36px;}
  .sname{font-size:14px;font-weight:600;margin-bottom:12px;}
  .checker{background-image:linear-gradient(45deg,#d8dbe0 25%,transparent 25%),linear-gradient(-45deg,#d8dbe0 25%,transparent 25%),linear-gradient(45deg,transparent 75%,#d8dbe0 75%),linear-gradient(-45deg,transparent 75%,#d8dbe0 75%);background-size:20px 20px;background-position:0 0,0 10px,10px -10px,-10px 0;}
  .stage{display:flex;align-items:center;justify-content:center;padding:20px;border-radius:10px;margin-bottom:10px;}
  .stage.mac{background:linear-gradient(135deg,#3a3f4b,#23262e);}
  .stage.win{background:linear-gradient(135deg,#0e3a6b,#0a2540);}
  .ico{width:92px;height:92px;}
  .ico.mac{border-radius:22%;}
  .ico.win{border-radius:14%;}
  .ladder{display:flex;align-items:flex-end;gap:14px;flex-wrap:wrap;margin-top:10px;}
  .ladder figure{margin:0;text-align:center;}
  .ladder img{display:block;margin:0 auto 4px;border-radius:6px;}
  .ladder figcaption{font-size:10px;color:var(--dim);}
  .swatches{display:flex;gap:6px;margin-top:12px;}
  .swatches span{width:26px;height:26px;border-radius:7px;border:1px solid rgba(0,0,0,.08);}
  .note{background:#eef7ff;border:1px solid #cfe6ff;border-radius:10px;padding:12px 14px;margin-top:18px;font-size:12px;color:#14507a;line-height:1.7;}
</style></head>
<body>
<header><h1>DbNest 图标 D · 透明背景 · 现代配色三选一</h1>
<div class="sub">标记保留：扁平圆柱 + 白色分隔线（已按反馈去掉原圆柱下方的弧线）。三套均为 2025–2026 主流 SaaS 配色，按你的「换一个颜色·现代化」要求重做。棋盘格用于直观显示透明度。</div></header>
<div class="wrap">
  <div class="grid">${cards}</div>
  <div class="note">三套均生成了 Windows（.ico 16–256 带 alpha）与 macOS（.icns 32–1024 带 alpha）资源，位于 <span style="font-family:ui-monospace;">build/candidates/d-color-{teal,violet,elec}/</span>。选定后我即提升为正式 <span style="font-family:ui-monospace;">build/icon.*</span> 并接回打包链路。透明底适合做 logo/favicon/文档图标；若作应用图标，建议搭配实色瓷砖版。</div>
</div>
</body></html>`;

fs.writeFileSync(path.join(ROOT, 'design/icons', 'showcase-d-colors.html'), html);
console.log('wrote design/icons/showcase-d-colors.html (self-contained)');
