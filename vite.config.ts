import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

/**
 * Vite 构建配置。
 *
 * - 渲染进程（React）由 Vite 负责开发与打包，输出到 `dist/`。
 * - Electron 主进程/预加载脚本单独打包（见 `src/main` 对应构建说明）。
 * - 路径别名 `@shared/*` `@main/*` `@renderer/*` 与 tsconfig 保持一致。
 *
 * 注意：Electron 环境下使用 `base: './'` 以便加载打包后的本地资源。
 */
export default defineConfig({
  base: './',
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      '@shared': fileURLToPath(new URL('./src/shared', import.meta.url)),
      '@main': fileURLToPath(new URL('./src/main', import.meta.url)),
      '@renderer': fileURLToPath(new URL('./src/renderer', import.meta.url)),
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // 渲染进程作为 Electron 渲染层，不需要代码分割到独立文件
    chunkSizeWarningLimit: 1500,
  },
  server: {
    // 显式绑定 IPv4，避免 Windows 上 localhost 解析为 IPv6(::1) 导致主进程连接失败
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
  },
});
