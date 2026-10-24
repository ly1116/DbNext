/* 实色版 D vs 透明版 D 并排对比（自包含，base64 内嵌） */
const fs = require('fs');
const path = require('path');
const { Resvg } = require('@resvg/resvg-js');

const ROOT = path.resolve(__dirname, '..');
const solid = fs.readFileSync(path.join(ROOT, 'design/icons/concept-d-flat.svg'));
const trans = fs.readFileSync(path.join(ROOT, 'design/icons/concept-d-transparent.svg'));

function render(svg, n) { return new Resvg(svg, { fitTo: { mode: 'width', value: n } }).render().asPng(); }
function uri(b) { return `data:image/png;base64,${b.toString('base64')}`; }

const S96 = { solid: render(solid, 96), trans: render(trans, 96) };
const LAD = [16, 24, 32, 48, 64, 128, 256];
const ladder = (svg) => LAD.map((s) => `<figure><img src="${uri(render(svg, s))}" width="${s}" height="${s}"><figcaption>${s}</figcaption></figure>`).join('');

function stages(v) {
  const u = uri(S96[v]);
  return `
  <div class="row">
    <div class="stage mac"><img class="ico mac" src="${u}"></div>
    <div class="stage win"><img class="ico win" src="${u}"></div>
    <div class="stage white"><img class="ico" src="${u}"></div>
    <div class="stage checker"><img class="ico" src="${u}"></div>
  </div>`;
}

const html = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>D 实色版 vs 透明版 对比</title>
<style>
  :root{ --ink:#1b2230; --dim:#6b7488; --panel:#fff; --line:#e6e8ec; }
  *{box-sizing:border-box;}
  body{margin:0;background:#f5f6f8;color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;}
  header{padding:28px 32px 8px;} h1{font-size:20px;margin:0 0 4px;font-weight:650;}
  .sub{color:var(--dim);font-size:13px;line-height:1.6;}
  .wrap{padding:16px 32px 60px;max-width:1000px;}
  .card{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:20px;margin-top:16px;}
  .card h2{font-size:15px;margin:0 0 4px;}
  .card .desc{font-size:12.5px;color:var(--dim);line-height:1.7;margin-bottom:14px;}
  .row{display:flex;gap:14px;flex-wrap:wrap;}
  .stage{padding:18px;border-radius:10px;display:flex;align-items:center;justify-content:center;flex:1;min-width:120px;}
  .stage.mac{background:linear-gradient(135deg,#3a3f4b,#23262e);}
  .stage.win{background:linear-gradient(135deg,#0e3a6b,#0a2540);}
  .stage.white{background:#fff;border:1px solid var(--line);}
  .stage.checker{background-image:linear-gradient(45deg,#d8dbe0 25%,transparent 25%),linear-gradient(-45deg,#d8dbe0 25%,transparent 25%),linear-gradient(45deg,transparent 75%,#d8dbe0 75%),linear-gradient(-45deg,transparent 75%,#d8dbe0 75%);background-size:20px 20px;background-position:0 0,0 10px,10px -10px,-10px 0;}
  .ico{width:88px;height:88px;}
  .ico.mac{border-radius:22%;} .ico.win{border-radius:14%;}
  .ladder{display:flex;align-items:flex-end;gap:14px;margin-top:16px;padding-top:14px;border-top:1px dashed var(--line);flex-wrap:wrap;}
  .ladder figure{margin:0;text-align:center;} .ladder img{display:block;margin:0 auto 4px;border-radius:6px;}
  .ladder figcaption{font-size:10px;color:var(--dim);}
  .verdict{background:#eef6ff;border:1px solid #bcd5f5;border-radius:10px;padding:12px 14px;margin-top:18px;font-size:12.5px;color:#1f3a5f;line-height:1.7;}
  .foot{color:var(--dim);font-size:12px;margin-top:18px;line-height:1.7;}
</style></head>
<body>
<header><h1>D · 实色版 vs 透明版 对比</h1>
<div class="sub">左：实色瓷砖版（适合应用图标）；右：透明版（适合 logo/favicon，但白底会露馅）。四格依次为 macOS / Windows / 纯白底 / 棋盘格（看透明度）。</div></header>
<div class="wrap">

  <div class="card">
    <h2>实色瓷砖版 D</h2>
    <div class="desc">indigo→cyan 渐变实色瓷砖 + 白扁平圆柱 + 细巢弧。在任何底色（含浅色任务栏/启动台）都完整可见，是桌面应用图标的标准做法。</div>
    ${stages('solid')}
    <div class="ladder">${ladder(solid)}</div>
  </div>

  <div class="card">
    <h2>透明背景版 D</h2>
    <div class="desc">仅保留标记（白圆柱 + 巢弧）。在深色/棋盘格上干净；但注意<b>纯白底那格</b>——白色圆柱几乎消失，只剩淡 indigo 分隔线，logo 在亮色场景会糊掉。</div>
    ${stages('trans')}
    <div class="ladder">${ladder(trans)}</div>
  </div>

  <div class="verdict">结论速览：<b>应用图标 → 用实色版</b>（macOS squircle / Windows 任务栏都稳）；<b>logo / favicon / 文档图标 → 用透明版</b>，但建议把标记改成亮暗自适配（圆柱给实色填充或外包容器），否则白底失效。两种我已分别生成在 build/candidates/ 与对应 showcase 页。</div>

  <div class="foot">实色版预览见 <span style="font-family:ui-monospace;">design/icons/showcase-v3.html</span>；透明版预览见 <span style="font-family:ui-monospace;">design/icons/showcase-d-transparent.html</span>。</div>
</div>
</body></html>`;

fs.writeFileSync(path.join(ROOT, 'design/icons/showcase-d-compare.html'), html);
console.log('wrote design/icons/showcase-d-compare.html');
