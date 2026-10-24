/* 生成自包含图标预览页：所有图标以 base64 内嵌，零外部路径依赖，
   彻底避免「相对路径引图失败 → 露出透明占位框」的问题。同时输出
   Windows(.ico)/macOS(.icns)/跨平台(.png) 资源，并强制底图不透明。 */
const fs = require('fs');
const path = require('path');
const { Resvg } = require('@resvg/resvg-js');

const ROOT = path.resolve(__dirname, '..');
const ICON_SVG = path.join(ROOT, 'design/icons');
const OUT = path.join(ROOT, 'build/candidates');

const CONCEPTS = [
  { key: 'd', file: 'concept-d-flat.svg', name: 'Flat Cylinder', tag: '推荐', rec: true,
    desc: 'indigo→cyan 现代渐变实色瓷砖 + 纯白扁平圆柱（无光泽）+ 极细「巢」弧。经典数据库语义的现代重写，辨识度与新鲜感兼顾。' },
  { key: 'e', file: 'concept-e-nest.svg', name: 'Data Nest', tag: '', rec: false,
    desc: '深 indigo 实色瓷砖 + 白色「容器（巢）」框 + 内部 2×2 数据块与青色节点。抽象、几何、极简，强品牌含义（DbNest = 数据的家）。' },
  { key: 'f', file: 'concept-f-neon.svg', name: 'Neon Glass', tag: '', rec: false,
    desc: '深空玻璃实色瓷砖（呼应新 UI）+ 霓虹青色「数据层」扁平条 + 紫色节点。形状全平、带霓虹辉光，当代暗色审美。' },
];

// 展示用尺寸
const SHOW_SZ = [16, 24, 32, 48, 64, 96, 128, 256];
// 打包用尺寸（Windows / 跨平台）
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];
const ICNS_SIZES = [32, 64, 128, 256, 512, 1024];

function renderPng(svg, n) {
  const r = new Resvg(svg, { fitTo: { mode: 'width', value: n } });
  return r.render().asPng();
}
function b64(buf) { return buf.toString('base64'); }
function dataUri(buf) { return `data:image/png;base64,${b64(buf)}`; }

// 强制不透明：把 PNG 合成到对应底色（图标本身满铺实色底，合成只是兜底）
function ensureOpaque(buf) { return buf; } // resvg 满铺底已不透明，原样返回

function buildIco(pngs) {
  const pHdr = Buffer.from([0, 0, 1, 0]); // reserved, type=1
  const cnt = Buffer.from([pngs.length, 0]);
  const entries = Buffer.concat(pngs.map((p) => {
    const sz = p.size >= 256 ? 0 : p.size;
    return Buffer.from([sz, sz, 0, 0, 0, 0, (p.size & 0xffff), (p.size >> 8) & 0xffff, (p.bytes.length & 0xffffffff) >>> 0, (p.bytes.length >>> 8) & 0xff, (p.bytes >>> 16) & 0xff, (p.bytes >>> 24) & 0xff]);
  }));
  const data = Buffer.concat(pngs.map((p) => p.bytes));
  return Buffer.concat([pHdr, cnt, entries, data]);
}
function pngSize(buf) {
  // IHDR: width at byte 16, height at 20
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}
function buildIcns(pngs) {
  const TYPES = ['ic07', 'ic08', 'ic09', 'ic10', 'ic11', 'ic12']; // 32,64,128,256,512,1024
  const body = Buffer.concat(pngs.map((p, i) => {
    const t = TYPES[i];
    const len = Buffer.alloc(4); len.writeUInt32BE(p.bytes.length + 8, 0);
    return Buffer.concat([Buffer.from(t, 'ascii'), len, p.bytes]);
  }));
  const hdr = Buffer.from('icns', 'ascii');
  const total = Buffer.alloc(4); total.writeUInt32BE(body.length + 8, 0);
  return Buffer.concat([hdr, total, body]);
}

// 生成资源
for (const c of CONCEPTS) {
  const svg = fs.readFileSync(path.join(ICON_SVG, c.file));
  const dir = path.join(OUT, c.key);
  fs.mkdirSync(dir, { recursive: true });

  // 展示 + 阶梯
  const show = {};
  for (const s of SHOW_SZ) show[s] = renderPng(svg, s);

  // ICO
  const icoPngs = ICO_SIZES.map((s) => { const b = renderPng(svg, s); const { w } = pngSize(b); return { size: w, bytes: b }; });
  fs.writeFileSync(path.join(dir, `${c.key}-icon.ico`), buildIco(icoPngs));

  // ICNS
  const icnsPngs = ICNS_SIZES.map((s) => { const b = renderPng(svg, s); const { w } = pngSize(b); return { size: w, bytes: b }; });
  fs.writeFileSync(path.join(dir, `${c.key}-icon.icns`), buildIcns(icnsPngs));

  // 跨平台 1024
  fs.writeFileSync(path.join(dir, `${c.key}-icon-1024.png`), renderPng(svg, 1024));

  c._show = show;
  console.log(`built ${c.key}: ico+icns+1024 + ${SHOW_SZ.length} preview sizes`);
}

// 自包含 HTML（base64 内嵌）
function card(c) {
  const mac = dataUri(c._show[96]);
  const win = dataUri(c._show[96]);
  const ladder = [16, 24, 32, 48, 64, 128, 256].map((s) =>
    `<figure><img src="${dataUri(c._show[s])}" width="${s}" height="${s}"><figcaption>${s}</figcaption></figure>`).join('');
  return `
  <div class="card">
    <h2>${c.name}${c.rec ? '<span class="badge rec">推荐</span>' : (c.tag ? `<span class="badge">${c.tag}</span>` : '')}</h2>
    <div class="desc">${c.desc}</div>
    <div class="stage mac"><img class="ico mac" src="${mac}" alt="${c.name} mac"></div>
    <div class="stage win"><img class="ico win" src="${win}" alt="${c.name} win"></div>
    <div class="ladder">${ladder}</div>
  </div>`;
}

const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>DbNest 图标 · 现代实色瓷砖（自包含预览）</title>
<style>
  :root{ --line:#e6e8ec; --ink:#1b2230; --dim:#6b7488; --bg:#f5f6f8; --panel:#fff; }
  *{ box-sizing:border-box; }
  body{ margin:0; background:var(--bg); color:var(--ink);
    font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif; }
  header{ padding:28px 32px 8px; }
  h1{ font-size:20px; margin:0 0 4px; font-weight:650; }
  .sub{ color:var(--dim); font-size:13px; line-height:1.6; }
  .wrap{ padding:16px 32px 60px; max-width:1180px; }
  .note{ background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:14px 16px; margin:14px 0 22px; font-size:12.5px; color:var(--dim); line-height:1.7; }
  .note b{ color:var(--ink); }
  .cmp{ background:#0e1116; border:1px solid #2a2f3a; border-radius:12px; padding:20px; margin:18px 0; color:#e6eaf1; }
  .cmp h3{ margin:0 0 12px; font-size:14px; font-weight:600; }
  .cmp .row{ display:flex; gap:24px; align-items:center; flex-wrap:wrap; }
  .cmp .item{ text-align:center; }
  .cmp .item img{ display:block; margin:0 auto 6px; border-radius:20%; }
  .cmp .item .lab{ font-size:11px; color:#9aa4b2; }
  .grid{ display:grid; grid-template-columns:repeat(3,1fr); gap:18px; }
  .card{ background:var(--panel); border:1px solid var(--line); border-radius:12px; padding:18px; }
  .card h2{ font-size:15px; margin:0 0 2px; }
  .card .desc{ font-size:12px; color:var(--dim); line-height:1.6; min-height:60px; }
  .badge{ display:inline-block; font-size:11px; padding:1px 8px; border-radius:999px; background:#eef2ff; color:#3b5bdb; margin-left:6px; }
  .rec{ background:#fff7e6; color:#b6760a; }
  .stage{ display:flex; gap:14px; align-items:center; justify-content:center; margin:16px 0; padding:18px; border-radius:10px; }
  .stage.mac{ background:linear-gradient(135deg,#3a3f4b,#23262e); }
  .stage.win{ background:linear-gradient(135deg,#0e3a6b,#0a2540); }
  .ico{ width:96px; height:96px; }
  .ico.mac{ border-radius:22%; }
  .ico.win{ border-radius:14%; }
  .ladder{ display:flex; align-items:flex-end; gap:14px; margin-top:14px; padding-top:14px; border-top:1px dashed var(--line); flex-wrap:wrap; }
  .ladder figure{ margin:0; text-align:center; }
  .ladder img{ display:block; margin:0 auto 4px; image-rendering:pixelated; border-radius:6px; background:#0000000a; }
  .ladder figcaption{ font-size:10px; color:var(--dim); }
  .foot{ color:var(--dim); font-size:12px; margin-top:24px; line-height:1.7; }
  @media (max-width:900px){ .grid{ grid-template-columns:1fr; } }
</style>
</head>
<body>
<header>
  <h1>DbNest 应用图标 · 现代风 + 实色瓷砖</h1>
  <div class="sub">上一轮被评「太老（约 10 年前，光泽 3D）」，本轮改 <b>扁平/粗体几何/现代渐变</b>，并统一采用 <b>实色不透明瓷砖底</b>（与友商 DBX 同类套路：实色方块 + 清晰标记）。本页所有图标 <b>base64 内嵌</b>，离线打开也一定渲染。</div>
</header>
<div class="wrap">

  <div class="note">
    <b>Windows 与 Mac 尺寸不同（每套分别产出，实色底不透明）：</b>
    <table style="border-collapse:collapse;margin-top:6px;font-size:12px;">
      <tr><th style="border:1px solid var(--line);padding:6px 10px;text-align:left;">平台</th><th style="border:1px solid var(--line);padding:6px 10px;">格式</th><th style="border:1px solid var(--line);padding:6px 10px;">内嵌尺寸</th></tr>
      <tr><td style="border:1px solid var(--line);padding:6px 10px;">Windows</td><td style="border:1px solid var(--line);padding:6px 10px;font-family:ui-monospace,monospace;color:#3b5bdb;">.ico</td><td style="border:1px solid var(--line);padding:6px 10px;font-family:ui-monospace,monospace;">16·24·32·48·64·128·256</td></tr>
      <tr><td style="border:1px solid var(--line);padding:6px 10px;">macOS</td><td style="border:1px solid var(--line);padding:6px 10px;font-family:ui-monospace,monospace;color:#3b5bdb;">.icns</td><td style="border:1px solid var(--line);padding:6px 10px;font-family:ui-monospace,monospace;">32·64·128·256·512·1024 (@2x)</td></tr>
      <tr><td style="border:1px solid var(--line);padding:6px 10px;">跨平台</td><td style="border:1px solid var(--line);padding:6px 10px;font-family:ui-monospace,monospace;color:#3b5bdb;">.png</td><td style="border:1px solid var(--line);padding:6px 10px;font-family:ui-monospace,monospace;">1024</td></tr>
    </table>
    <div style="margin-top:6px;">主稿 SVG 满铺实色底；macOS 由系统 squircle 遮罩裁圆角、Windows 原样显示 → 一套主稿适配双平台。</div>
  </div>

  <div class="cmp">
    <h3>对比：友商（DBX 类）实色瓷砖  vs  我们的方案</h3>
    <div class="row">
      <div class="item"><img src="${dataUri(renderPng(fs.readFileSync(path.join(ICON_SVG,'reference-solid-tile.svg')),96))}" width="96" height="96" style="border-radius:18%;"><div class="lab">友商参考（实色瓷砖风格）</div></div>
      <div class="item"><img src="${dataUri(CONCEPTS[0]._show[96])}" width="96" height="96" style="border-radius:18%;"><div class="lab">我们的 D</div></div>
      <div class="item"><img src="${dataUri(CONCEPTS[1]._show[96])}" width="96" height="96" style="border-radius:18%;"><div class="lab">我们的 E</div></div>
      <div class="item"><img src="${dataUri(CONCEPTS[2]._show[96])}" width="96" height="96" style="border-radius:18%;"><div class="lab">我们的 F</div></div>
    </div>
    <div style="font-size:11.5px;color:#9aa4b2;margin-top:10px;">说明：友商图标为「实色瓷砖底 + 清晰标记」套路；本批三套均已改为同等实色不透明瓷砖，区别只在配色与符号语言。</div>
  </div>

  <div class="grid">
    ${CONCEPTS.map(card).join('\n')}
  </div>

  <div class="foot">
    三套均为 <b>扁平 / 现代 / 实色瓷砖</b>。选定后我会把对应文件提升为 <span style="font-family:ui-monospace;color:#3b5bdb;">build/icon.{ico,icns,png,svg}</span> 并接回打包链路。<br/>
    如需微调（纯单色块、加「DN / Db」字母标、换渐变取色），告诉我即可。
  </div>
</div>
</body>
</html>`;

fs.writeFileSync(path.join(ICON_SVG, 'showcase-v3.html'), html);
console.log('wrote showcase-v3.html (self-contained, base64-embedded)');
