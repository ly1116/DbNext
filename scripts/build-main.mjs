/**
 * 主进程打包脚本（esbuild）。
 *
 * 将 src/main/main.ts 与 src/main/preload.ts 打包为 CommonJS（.cjs）到 dist-electron/，
 * 供 Electron 运行。使用 .cjs 扩展名以规避 package.json 中 "type":"module" 导致
 * Node 把 .js 当作 ESM 解析、从而找不到 require 的问题。使用 esbuild 而非 tsc，以获得
 * 更快的打包与内置依赖外部化。
 *
 * 用法：node scripts/build-main.mjs
 *
 * @since 0.1.0
 */
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

/**
 * 外部化策略：
 * - electron 运行时模块（由 electron.exe 提供，打包进 bundle 会破坏其加载语义）
 * - node: 内置模块
 * - 所有第三方依赖（packages: 'external'）：ssh2/mysql2/pg/ioredis/openai 等带动态
 *   require / 可选原生模块的包，运行时由 electron 的 require 从 node_modules 真实解析，
 *   避免 esbuild 静态打包导致的运行时崩溃。@别名（@shared/@main/@renderer）仍会打包。
 */
const external = ['electron', 'node:*'];

/** 路径别名（与 tsconfig / vite 保持一致） */
const alias = {
  '@': resolve(root, 'src'),
  '@shared': resolve(root, 'src/shared'),
  '@main': resolve(root, 'src/main'),
  '@renderer': resolve(root, 'src/renderer'),
};

/** 依次打包 main 与 preload */
async function bundle(entry, outfile) {
  await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    external,
    packages: 'external',
    alias,
    sourcemap: true,
    logLevel: 'info',
  });
}

await bundle(resolve(root, 'src/main/main.ts'), resolve(root, 'dist-electron/main.cjs'));
await bundle(resolve(root, 'src/main/preload.ts'), resolve(root, 'dist-electron/preload.cjs'));

console.log('[build-main] 主进程与预加载脚本已打包至 dist-electron/');
