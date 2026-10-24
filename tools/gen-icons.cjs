/* 图标资源生成器（Windows .ico / macOS .icns / 1024 PNG）
 * 用法: node tools/gen-icons.cjs [a|b|c|all]
 * 依赖: @resvg/resvg-js (SVG->PNG), png-to-ico (PNG->ICO)
 *
 * Windows 与 macOS 的图标尺寸集合不同：
 *  - Windows .ico 需要: 16/24/32/48/64/128/256（内嵌多分辨率，256 以 PNG 压缩）
 *  - macOS  .icns 需要: 32/64/128/256/512/1024（含 @2x 槽位，映射见 ICNS_MAP）
 */
const fs = require('fs');
const path = require('path');
const { Resvg } = require('@resvg/resvg-js');

const ROOT = path.resolve(__dirname, '..');
const SRC_DIR = path.join(ROOT, 'design', 'icons');
const OUT_DIR = path.join(ROOT, 'build', 'candidates');

// 渲染尺寸集合（合并去重后一次性渲染，按需复用）
const RENDER_SIZES = [16, 24, 32, 48, 64, 128, 256, 512, 1024];

// macOS .icns 槽位 -> 所需像素尺寸（@2x 槽位用更大像素承载）
const ICNS_MAP = [
  ['ic14', 32],
  ['ic11', 64],
  ['ic12', 128],
  ['ic07', 128],
  ['ic13', 256],
  ['ic08', 256],
  ['ic09', 512],
  ['ic10', 1024],
];

// Windows .ico 所需尺寸
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

const CONCEPTS = {
  d: { file: 'concept-d-flat.svg', name: 'Flat Cylinder' },
  e: { file: 'concept-e-nest.svg', name: 'Data Nest' },
  f: { file: 'concept-f-neon.svg', name: 'Neon Glass' },
};

function renderPng(svg, size) {
  const resvg = new Resvg(svg, {
    fitTo: { mode: 'width', value: size },
    background: 'transparent',
  });
  return resvg.render().asPng();
}

function buildIco(images) {
  // images: [{ size, buf }]  ->  PNG 直接内嵌（Vista+ Windows 支持 PNG 型 ICO）
  const count = images.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type=icon
  header.writeUInt16LE(count, 4);
  const dirs = [];
  const datas = [];
  let offset = 6 + count * 16;
  for (const img of images) {
    const de = Buffer.alloc(16);
    de.writeUInt8(img.size >= 256 ? 0 : img.size, 0); // 256 用 0 表示
    de.writeUInt8(img.size >= 256 ? 0 : img.size, 1);
    de.writeUInt8(0, 2); // color count
    de.writeUInt8(0, 3); // reserved
    de.writeUInt16LE(1, 4); // planes
    de.writeUInt16LE(32, 6); // bit count
    de.writeUInt32LE(img.buf.length, 8);
    de.writeUInt32LE(offset, 12);
    dirs.push(de);
    datas.push(img.buf);
    offset += img.buf.length;
  }
  return Buffer.concat([header, ...dirs, ...datas]);
}

function buildIcns(entries) {
  // entries: [{ type: 'ic07', png: Buffer }]
  const parts = [];
  for (const e of entries) {
    const type = Buffer.from(e.type, 'ascii');
    const len = Buffer.alloc(4);
    len.writeUInt32BE(e.png.length + 8, 0);
    parts.push(type, len, e.png);
  }
  const body = Buffer.concat(parts);
  const header = Buffer.concat([
    Buffer.from('icns', 'ascii'),
    (() => { const b = Buffer.alloc(4); b.writeUInt32BE(body.length + 8, 0); return b; })(),
  ]);
  return Buffer.concat([header, body]);
}

function genConcept(key) {
  const c = CONCEPTS[key];
  const svg = fs.readFileSync(path.join(SRC_DIR, c.file), 'utf8');
  const outDir = path.join(OUT_DIR, key);
  fs.mkdirSync(outDir, { recursive: true });

  // 1) 渲染所有尺寸 PNG
  const pngs = {};
  for (const s of RENDER_SIZES) pngs[s] = renderPng(svg, s);

  // 2) Windows .ico（多分辨率内嵌，PNG 型）
  const icoBuf = buildIco(ICO_SIZES.map((s) => ({ size: s, buf: pngs[s] })));
  fs.writeFileSync(path.join(outDir, `${key}-icon.ico`), icoBuf);

  // 3) macOS .icns（PNG 槽位打包）
  const icnsEntries = ICNS_MAP.map(([type, size]) => ({ type, png: pngs[size] }));
  fs.writeFileSync(path.join(outDir, `${key}-icon.icns`), buildIcns(icnsEntries));

  // 4) 1024 PNG（electron-builder / Linux / 安装包）
  fs.writeFileSync(path.join(outDir, `${key}-icon-1024.png`), pngs[1024]);

  // 5) 小尺寸预览 PNG（供 showcase 直接引用，呈现真实栅格化效果）
  for (const s of [16, 24, 32, 48, 64, 128, 256]) {
    fs.writeFileSync(path.join(outDir, `${key}-${s}.png`), pngs[s]);
  }
  console.log(`[${key}] ${c.name}: ico+icns+png 已生成 -> ${outDir}`);
}

const arg = process.argv[2] || 'all';
if (arg === 'all') Object.keys(CONCEPTS).forEach(genConcept);
else if (CONCEPTS[arg]) genConcept(arg);
else { console.error('用法: node tools/gen-icons.cjs [a|b|c|all]'); process.exit(1); }
