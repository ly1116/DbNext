import { Resvg } from '@resvg/resvg-js';
import { readFileSync, writeFileSync } from 'node:fs';

const svg = readFileSync('build/icon.svg', 'utf8');
const resvg = new Resvg(svg, {
  fitTo: { mode: 'width', value: 1024 },
  background: 'transparent',
});
const png = resvg.render();
writeFileSync('build/icon.png', png.asPng());
console.log('rendered build/icon.png', png.width, 'x', png.height);
