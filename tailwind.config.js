/**
 * Tailwind 配置 —— 设计 token 与高保真原型 b.html 完全一致。
 * 集中定义颜色，避免在组件里硬编码十六进制，保证主题统一可维护。
 */
/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // 背景层级（由深到浅）—— 全部走 CSS 变量（RGB 通道三元组），支持 /透明度 修饰符
        bg: 'rgb(var(--c-bg) / <alpha-value>)',
        panel: 'rgb(var(--c-panel) / <alpha-value>)',
        panel2: 'rgb(var(--c-panel2) / <alpha-value>)',
        panel3: 'rgb(var(--c-panel3) / <alpha-value>)',
        // 描边
        line: 'rgb(var(--c-line) / <alpha-value>)',
        line2: 'rgb(var(--c-line2) / <alpha-value>)',
        // 文字
        fg: 'rgb(var(--c-fg) / <alpha-value>)',
        dim: 'rgb(var(--c-dim) / <alpha-value>)',
        dim2: 'rgb(var(--c-dim2) / <alpha-value>)',
        // 主题色（链接/选中/主操作）
        accent: 'rgb(var(--c-accent) / <alpha-value>)',
        accent2: 'rgb(var(--c-accent2) / <alpha-value>)',
        // 语义色
        prod: 'rgb(var(--c-prod) / <alpha-value>)',
        ok: 'rgb(var(--c-ok) / <alpha-value>)',
        warn: 'rgb(var(--c-warn) / <alpha-value>)',
        // 语法高亮（VS Code Dark+ 配色）
        purple: 'rgb(var(--c-purple) / <alpha-value>)',
        blue: 'rgb(var(--c-blue) / <alpha-value>)',
        str: 'rgb(var(--c-str) / <alpha-value>)',
        num: 'rgb(var(--c-num) / <alpha-value>)',
        fn: 'rgb(var(--c-fn) / <alpha-value>)',
        // 终端（保持固定深色，终端自身用 xterm 主题）
        term: '#0c0c0c',
        termfg: '#d4d4d4',
        // AI 紫
        ai: 'rgb(var(--c-ai) / <alpha-value>)',
        ai2: 'rgb(var(--c-ai2) / <alpha-value>)',
      },
      fontFamily: {
        mono: ['JetBrains Mono', 'SF Mono', 'Menlo', 'Consolas', 'monospace'],
        sans: [
          '-apple-system',
          'BlinkMacSystemFont',
          'Segoe UI',
          'PingFang SC',
          'Microsoft YaHei',
          'sans-serif',
        ],
      },
    },
  },
  plugins: [],
};
